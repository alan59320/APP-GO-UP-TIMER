const express = require("express");
const path = require("path");
const webpush = require("web-push");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const API_URL =
  process.env.TIMER_API_URL ||
  "https://vent-timer-production.up.railway.app/api/timer";

const REMINDER_MINUTES = 10;
const CHECK_INTERVAL_MS = 30 * 1000;

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL manquante. Ajoute PostgreSQL à ton projet Railway.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
});

pool.on("error", (error) => {
  console.error("❌ PostgreSQL pool error:", error.message);
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminder_deliveries (
      event_key TEXT PRIMARY KEY,
      event_name TEXT,
      event_time BIGINT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("🗄️ PostgreSQL connecté et tables vérifiées.");
}

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log("🔔 Web Push activé.");
} else {
  console.warn(
    "⚠️ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquantes : les notifications push sont désactivées."
  );
}

function pushEnabled() {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

function subscriptionToDb(subscription) {
  return {
    endpoint: subscription?.endpoint || "",
    p256dh: subscription?.keys?.p256dh || "",
    auth: subscription?.keys?.auth || ""
  };
}

function dbToSubscription(row) {
  return {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth
    }
  };
}

async function countSubscriptions() {
  const result = await pool.query("SELECT COUNT(*)::int AS count FROM push_subscriptions");
  return result.rows[0].count;
}

async function saveSubscription(subscription) {
  const value = subscriptionToDb(subscription);

  if (!value.endpoint || !value.p256dh || !value.auth) return false;

  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (endpoint)
     DO UPDATE SET p256dh = EXCLUDED.p256dh,
                   auth = EXCLUDED.auth,
                   updated_at = NOW()`,
    [value.endpoint, value.p256dh, value.auth]
  );

  console.log(`🔔 Abonnement Push enregistré.`);
  return true;
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

async function getSubscriptions() {
  const result = await pool.query(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions"
  );
  return result.rows.map(dbToSubscription);
}

async function sendPush(payload) {
  if (!pushEnabled()) return { sent: 0, removed: 0 };

  const subscriptions = await getSubscriptions();
  if (subscriptions.length === 0) return { sent: 0, removed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;

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
          await removeSubscription(subscription.endpoint);
          removed += 1;
          console.log("🗑️ Abonnement Push supprimé (expiré/invalide).");
        } else {
          console.error("❌ Erreur Push:", status || error.message);
        }
      }
    })
  );

  return { sent, removed };
}

// Réserve une notification dans PostgreSQL avant son envoi.
// Cela évite qu'un redémarrage ou plusieurs workers envoient deux fois le même rappel.
async function claimReminder(eventKey, eventName, eventTime) {
  const result = await pool.query(
    `INSERT INTO reminder_deliveries (event_key, event_name, event_time)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING event_key`,
    [eventKey, eventName, eventTime]
  );

  return result.rowCount === 1;
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
      message: "Notifications activées"
    });
  } catch (error) {
    console.error("❌ Enregistrement Push:", error.message);
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
    console.error("❌ Suppression Push:", error.message);
    res.status(500).json({ success: false });
  }
});

app.get("/api/push/status", async (req, res) => {
  try {
    res.json({
      success: true,
      configured: pushEnabled(),
      database: true,
      subscribers: await countSubscriptions(),
      reminderMinutes: REMINDER_MINUTES
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      database: false,
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

    const name = event.displayName || event.name || "Événement";
    const emoji = event.emoji || "🎯";

    try {
      const claimed = await claimReminder(key, name, eventTime);
      if (!claimed) {
        console.log(`ℹ️ Rappel déjà envoyé : ${emoji} ${name}`);
        return;
      }

      console.log(`🔔 Rappel -10 min : ${emoji} ${name}`);

      const result = await sendPush({
        title: "⏰ GO UP TIMER",
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

      console.log(`📨 Push : ${result.sent} envoyé(s), ${result.removed} supprimé(s).`);
    } catch (error) {
      console.error("❌ Rappel Push:", error.message);
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
    console.error("⚠️ Vérification des événements impossible:", error.message);
  }
}

async function start() {
  try {
    await initDatabase();
  } catch (error) {
    console.error("❌ Impossible d'initialiser PostgreSQL:", error);
    process.exit(1);
  }

  checkEventsAndSchedule();
  setInterval(checkEventsAndSchedule, CHECK_INTERVAL_MS);

  app.use((req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`GO UP TIMER WebApp running on port ${PORT}`);
    console.log(`API événements : ${API_URL}`);
  });
}

async function shutdown(signal) {
  console.log(`🛑 ${signal} reçu, arrêt propre...`);
  for (const timeout of scheduled.values()) clearTimeout(timeout);
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();
