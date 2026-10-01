const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const webpush = require("web-push");

const app = express();
const PORT = process.env.PORT || 3000;

const API_URL =
  process.env.TIMER_API_URL ||
  "https://vent-timer-production.up.railway.app/api/timer";

const REMINDER_MINUTES = 10;
const CHECK_INTERVAL_MS = 30 * 1000;

function normalizeBase64Url(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || "")
  .trim()
  .replace(/Public\s*Key\s*:/gi, "")
  .replace(/[\s"'`]/g, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/g, "");

const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || "")
  .trim()
  .replace(/Private\s*Key\s*:/gi, "")
  .replace(/[\s"'`]/g, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/g, "");

const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || "").trim();

const preferredDataDir = process.env.DATA_DIR || "/data";
const fallbackDataDir = path.join(__dirname, "data");
let DATA_DIR = preferredDataDir;

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    DATA_DIR = fallbackDataDir;
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

ensureDataDir();

const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subscriptions.json");
const REMINDERS_FILE = path.join(DATA_DIR, "reminder-deliveries.json");

let subscriptions = [];
let reminderDeliveries = {};
let storageWriteQueue = Promise.resolve();

async function loadJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function queueWrite(file, data) {
  storageWriteQueue = storageWriteQueue.then(async () => {
    const temp = `${file}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(temp, file);
  }).catch((error) => {
    console.error(`â Ãcriture stockage ${file}:`, error.message);
  });

  return storageWriteQueue;
}

async function initStorage() {
  subscriptions = await loadJson(SUBSCRIPTIONS_FILE, []);
  reminderDeliveries = await loadJson(REMINDERS_FILE, {});

  if (!Array.isArray(subscriptions)) subscriptions = [];
  if (!reminderDeliveries || typeof reminderDeliveries !== "object") {
    reminderDeliveries = {};
  }

  await queueWrite(SUBSCRIPTIONS_FILE, subscriptions);
  await queueWrite(REMINDERS_FILE, reminderDeliveries);

  console.log(`ð¾ Stockage local activÃ© : ${DATA_DIR}`);
  console.log(`ð ${subscriptions.length} abonnement(s) Push chargÃ©(s).`);
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log("ð Web Push activÃ©.");
} else {
  console.warn(
    "â ï¸ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquantes : les notifications Push sont dÃ©sactivÃ©es."
  );
}

function pushEnabled() {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

function subscriptionToStored(subscription) {
  return {
    endpoint: subscription?.endpoint || "",
    keys: {
      p256dh: subscription?.keys?.p256dh || "",
      auth: subscription?.keys?.auth || ""
    },
    updatedAt: new Date().toISOString()
  };
}

async function saveSubscription(subscription) {
  const value = subscriptionToStored(subscription);

  if (!value.endpoint || !value.keys.p256dh || !value.keys.auth) return false;

  const index = subscriptions.findIndex((item) => item.endpoint === value.endpoint);

  if (index >= 0) {
    subscriptions[index] = value;
  } else {
    subscriptions.push(value);
  }

  await queueWrite(SUBSCRIPTIONS_FILE, subscriptions);
  console.log("ð Abonnement Push enregistrÃ©.");
  return true;
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  subscriptions = subscriptions.filter((item) => item.endpoint !== endpoint);
  await queueWrite(SUBSCRIPTIONS_FILE, subscriptions);
}

async function sendPush(payload) {
  if (!pushEnabled()) return { sent: 0, removed: 0 };
  if (subscriptions.length === 0) return { sent: 0, removed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;
  const expired = [];

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, body, {
          TTL: 300,
          urgency: "high"
        });
        sent += 1;
      } catch (error) {
        const status = error?.statusCode;

        if (status === 404 || status === 410) {
          expired.push(subscription.endpoint);
          removed += 1;
          console.log("ðï¸ Abonnement Push supprimÃ© (expirÃ©/invalide).");
        } else {
          console.error("â Erreur Push:", status || error.message);
        }
      }
    })
  );

  if (expired.length) {
    const expiredSet = new Set(expired);
    subscriptions = subscriptions.filter((item) => !expiredSet.has(item.endpoint));
    await queueWrite(SUBSCRIPTIONS_FILE, subscriptions);
  }

  return { sent, removed };
}

async function claimReminder(eventKey, eventName, eventTime) {
  if (reminderDeliveries[eventKey]) return false;

  reminderDeliveries[eventKey] = {
    eventName,
    eventTime,
    claimedAt: new Date().toISOString()
  };

  await queueWrite(REMINDERS_FILE, reminderDeliveries);
  return true;
}

async function cleanupReminders() {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  let changed = false;

  for (const [key, value] of Object.entries(reminderDeliveries)) {
    if (Number(value?.eventTime) < cutoff) {
      delete reminderDeliveries[key];
      changed = true;
    }
  }

  if (changed) await queueWrite(REMINDERS_FILE, reminderDeliveries);
}

app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

app.get("/api/push/public-key", (req, res) => {
  if (!pushEnabled()) {
    return res.status(503).json({
      success: false,
      error: "Push notifications not configured"
    });
  }

  res.json({
    success: true,
    publicKey: VAPID_PUBLIC_KEY
  });
});

app.post("/api/push/subscribe", async (req, res) => {
  if (!pushEnabled()) {
    return res.status(503).json({
      success: false,
      error: "Push notifications not configured"
    });
  }

  try {
    const subscription = req.body;

    if (
      !subscription?.endpoint ||
      !subscription?.keys?.p256dh ||
      !subscription?.keys?.auth
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid push subscription"
      });
    }

    await saveSubscription(subscription);

    res.json({
      success: true,
      message: "Notifications activÃ©es"
    });
  } catch (error) {
    console.error("â Enregistrement Push:", error.message);
    res.status(500).json({
      success: false,
      error: "Impossible d'enregistrer l'abonnement"
    });
  }
});

app.post("/api/push/unsubscribe", async (req, res) => {
  try {
    await removeSubscription(req.body?.endpoint);
    res.json({ success: true });
  } catch (error) {
    console.error("â Suppression Push:", error.message);
    res.status(500).json({ success: false });
  }
});

app.get("/api/push/status", async (req, res) => {
  res.json({
    success: true,
    configured: pushEnabled(),
    storage: true,
    storagePath: DATA_DIR,
    subscribers: subscriptions.length,
    reminderMinutes: REMINDER_MINUTES
  });
});

// ð§ª TEST MANUEL D'UNE NOTIFICATION PUSH
app.get("/api/push/test", async (req, res) => {
  try {
    const result = await sendPush({
      title: "ð GO UP TIMER",
      body: "ð Test de notification rÃ©ussi !",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "go-up-test",
      renotify: true,
      data: {
        url: "/"
      }
    });

    console.log(
      `ð§ª TEST PUSH : ${result.sent} envoyÃ©(s), ${result.removed} supprimÃ©(s).`
    );

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error("â Test Push :", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const scheduled = new Map();

function eventKey(event) {
  return `${event.name || event.displayName || "event"}:${event.next}`;
}

function getEvents(apiData) {
  const events = [];

  if (apiData?.next?.next) {
    events.push(apiData.next);
  }

  for (const event of apiData?.upcoming || []) {
    if (event?.next) events.push(event);
  }

  const unique = new Map();
  for (const event of events) {
    unique.set(eventKey(event), event);
  }

  return [...unique.values()];
}

function scheduleEventReminder(event) {
  if (!event?.next) return;

  const eventTime = Number(event.next);
  if (!Number.isFinite(eventTime)) return;

  const key = eventKey(event);
  const reminderAt = eventTime - REMINDER_MINUTES * 60 * 1000;
  const delay = reminderAt - Date.now();

  if (delay < -60 * 1000 || delay > 7 * 24 * 60 * 60 * 1000) return;
  if (scheduled.has(key)) return;

  const timeout = setTimeout(async () => {
    scheduled.delete(key);

    const name = event.displayName || event.name || "ÃvÃ©nement";
    const emoji = event.emoji || "ð¯";

    try {
      const claimed = await claimReminder(key, name, eventTime);
      if (!claimed) {
        console.log(`â¹ï¸ Rappel dÃ©jÃ  envoyÃ© : ${emoji} ${name}`);
        return;
      }

      console.log(`ð Rappel -10 min : ${emoji} ${name}`);

      const result = await sendPush({
        title: "â° GO UP TIMER",
        body: `${emoji} ${name} dans 10 minutes !`,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: `go-up-${key}`,
        renotify: true,
        data: {
          url: "/",
          eventName: name,
          eventTime
        }
      });

      console.log(`ð¨ Push : ${result.sent} envoyÃ©(s), ${result.removed} supprimÃ©(s).`);
    } catch (error) {
      console.error("â Rappel Push:", error.message);
    }
  }, Math.max(0, delay));

  scheduled.set(key, timeout);
}

async function checkEventsAndSchedule() {
  try {
    const response = await fetch(API_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`API HTTP ${response.status}`);
    }

    const data = await response.json();

    for (const event of getEvents(data)) {
      scheduleEventReminder(event);
    }
  } catch (error) {
    console.error("â ï¸ VÃ©rification des Ã©vÃ©nements impossible:", error.message);
  }
}

async function start() {
  await initStorage();
  await cleanupReminders();

  checkEventsAndSchedule();
  setInterval(checkEventsAndSchedule, CHECK_INTERVAL_MS);
  setInterval(cleanupReminders, 6 * 60 * 60 * 1000);

  app.use((req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`GO UP TIMER WebApp running on port ${PORT}`);
    console.log(`API Ã©vÃ©nements : ${API_URL}`);
    console.log(`â° Rappels : ${REMINDER_MINUTES} minutes avant`);
  });
}

async function shutdown(signal) {
  console.log(`ð ${signal} reÃ§u, arrÃªt propre...`);
  for (const timeout of scheduled.values()) clearTimeout(timeout);
  await storageWriteQueue;
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((error) => {
  console.error("â Erreur de dÃ©marrage:", error);
  process.exit(1);
});

