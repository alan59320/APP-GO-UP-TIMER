const API="https://vent-timer-production.up.railway.app/api/timer";

let data=null;
let lastFetch=0;

const $=id=>document.getElementById(id);

function pad(n){return String(Math.max(0,n)).padStart(2,"0")}

function duration(ms, withHours=true){
  ms=Math.max(0,ms);
  const s=Math.floor(ms/1000);
  const h=Math.floor(s/3600);
  const m=Math.floor((s%3600)/60);
  const sec=s%60;
  return withHours
    ? `${pad(h)}:${pad(m)}:${pad(sec)}`
    : `${pad(m)}:${pad(sec)}`;
}

function eventDate(ms){
  return ms ? new Date(ms) : null;
}

function render(){
  if(!data) return;

  const now=Date.now();
  const live=data.live?.[0];
  const next=data.next;

  // =========================
  // ÉVÉNEMENT EN DIRECT
  // =========================

  // Affiche uniquement un événement qui existe
  // et dont l'heure de fin n'est pas dépassée.
  if(
    live &&
    live.end &&
    Number(live.end)>now
  ){
    $("liveCard").classList.remove("hidden");
    $("liveEmoji").textContent=live.emoji||"🎯";
    $("liveName").textContent=live.displayName||live.name;
    $("liveCountdown").textContent=
      duration(Number(live.end)-now,false);
  }else{
    // L'événement est terminé : on masque
    // immédiatement la carte même si l'API n'a
    // pas encore été actualisée.
    $("liveCard").classList.add("hidden");
    $("liveEmoji").textContent="";
    $("liveName").textContent="";
    $("liveCountdown").textContent="";
  }

  // =========================
  // PROCHAIN ÉVÉNEMENT
  // =========================

  if(
    next &&
    next.next &&
    Number(next.next)>now
  ){
    $("nextEmoji").textContent=next.emoji||"🎯";
    $("nextName").textContent=next.displayName||next.name;
    $("nextCountdown").textContent=
      duration(Number(next.next)-now,true);
    $("nextTime").textContent=`à ${next.time||"--:--"}`;
  }else{
    $("nextEmoji").textContent="";
    $("nextName").textContent="Aucun événement";
    $("nextCountdown").textContent="--:--:--";
    $("nextTime").textContent="";
  }

  // =========================
  // LISTE DES ÉVÉNEMENTS
  // =========================

  const list=data.upcoming||[];

  $("events").innerHTML=list.map(e=>{
    const date=eventDate(e.next);

    return `<div class="row">
      <span>${e.emoji||"🎯"}</span>
      <span class="name">${escapeHtml(e.displayName||e.name)}</span>
      <span class="time">${
        date
          ? date.toLocaleTimeString("fr-FR",{
              hour:"2-digit",
              minute:"2-digit"
            })
          : "--:--"
      }</span>
    </div>`;
  }).join("");

  $("updated").textContent=
    "Dernière mise à jour : "+
    new Date().toLocaleTimeString("fr-FR",{
      hour:"2-digit",
      minute:"2-digit",
      second:"2-digit"
    });
}

function escapeHtml(value){
  return String(value).replace(
    /[&<>"']/g,
    c=>({
      "&":"&amp;",
      "<":"&lt;",
      ">":"&gt;",
      '"':"&quot;",
      "'":"&#039;"
    }[c])
  );
}

async function load(){
  $("status").textContent="Actualisation…";

  try{
    const res=await fetch(API,{cache:"no-store"});

    if(!res.ok){
      throw new Error("API HTTP "+res.status);
    }

    data=await res.json();

    if(!data.success){
      throw new Error("API indisponible");
    }

    lastFetch=Date.now();

    $("status").textContent="BY 🍁𝔸𝕝𝕒𝕟🍁";
    $("status").classList.remove("error");

    render();

  }catch(e){
    $("status").textContent=
      "API inaccessible — nouvelle tentative automatique";

    $("status").classList.add("error");
  }
}

/* =========================
   WEB PUSH NOTIFICATIONS
   ========================= */

let pushSubscription=null;

function supportsPush(){
  return "serviceWorker" in navigator &&
         "PushManager" in window &&
         "Notification" in window;
}

function urlBase64ToUint8Array(base64String){
  const padding="=".repeat(
    (4-(base64String.length%4))%4
  );

  const base64=(base64String+padding)
    .replace(/-/g,"+")
    .replace(/_/g,"/");

  const rawData=window.atob(base64);

  return Uint8Array.from(
    [...rawData].map(char=>char.charCodeAt(0))
  );
}

async function registerServiceWorker(){
  if(!("serviceWorker" in navigator)) return null;

  const registration=
    await navigator.serviceWorker.register("/sw.js",{
      scope:"/"
    });

  await navigator.serviceWorker.ready;

  return registration;
}

async function getPublicVapidKey(){
  const response=await fetch(
    "/api/push/public-key",
    {cache:"no-store"}
  );

  if(!response.ok){
    throw new Error("Push non configuré sur le serveur.");
  }

  const result=await response.json();

  if(!result.success || !result.publicKey){
    throw new Error("Clé Push indisponible.");
  }

  return result.publicKey;
}

async function updatePushUI(){
  const button=$("pushButton");
  const status=$("pushStatus");

  if(!button || !status) return;

  if(!supportsPush()){
    button.disabled=true;
    button.textContent="🔕 Notifications non disponibles";
    status.textContent=
      "Ton navigateur ne prend pas en charge les notifications push.";
    return;
  }

  try{
    const registration=await navigator.serviceWorker.ready;

    pushSubscription=
      await registration.pushManager.getSubscription();

    if(pushSubscription){
      button.classList.add("enabled");
      button.textContent="🟢 NOTIFICATIONS ACTIVÉES";
      status.textContent=
        "Tu recevras les alertes 10 minutes avant les événements.";
    }else{
      button.classList.remove("enabled");
      button.textContent="🔔 ACTIVER LES NOTIFICATIONS";
      status.textContent=
        "Active les alertes GO UP 10 minutes avant chaque événement.";
    }

  }catch(error){
    console.error(error);

    button.textContent="🔔 ACTIVER LES NOTIFICATIONS";
    status.textContent=
      "Impossible de vérifier les notifications.";
  }
}

async function enablePush(){
  const button=$("pushButton");
  const status=$("pushStatus");

  if(!supportsPush()) return;

  try{
    button.disabled=true;
    button.textContent="Activation…";

    const permission=
      await Notification.requestPermission();

    if(permission!=="granted"){
      status.textContent=
        "Les notifications ont été refusées dans les réglages du navigateur.";

      button.disabled=false;

      await updatePushUI();

      return;
    }

    const registration=
      await registerServiceWorker();

    const publicKey=
      await getPublicVapidKey();

    pushSubscription=
      await registration.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:
          urlBase64ToUint8Array(publicKey)
      });

    const response=await fetch(
      "/api/push/subscribe",
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json"
        },
        body:JSON.stringify(
          pushSubscription.toJSON()
        )
      }
    );

    if(!response.ok){
      throw new Error(
        "Impossible d'enregistrer l'abonnement."
      );
    }

    status.textContent=
      "Notifications activées avec succès.";

    await updatePushUI();

  }catch(error){
    console.error("Push:",error);

    status.textContent=
      error.message ||
      "Activation des notifications impossible.";

    button.disabled=false;

    await updatePushUI();
  }
}

async function disablePush(){
  try{
    if(!pushSubscription){
      const registration=
        await navigator.serviceWorker.ready;

      pushSubscription=
        await registration.pushManager.getSubscription();
    }

    if(!pushSubscription){
      await updatePushUI();
      return;
    }

    const endpoint=
      pushSubscription.endpoint;

    await fetch(
      "/api/push/unsubscribe",
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json"
        },
        body:JSON.stringify({endpoint})
      }
    );

    await pushSubscription.unsubscribe();

    pushSubscription=null;

    $("pushStatus").textContent=
      "Notifications désactivées.";

    await updatePushUI();

  }catch(error){
    console.error("Disable Push:",error);

    $("pushStatus").textContent=
      "Impossible de désactiver les notifications.";
  }
}

async function setupPush(){
  if(!supportsPush()) return;

  try{
    await registerServiceWorker();
    await updatePushUI();

  }catch(error){
    console.error("Service Worker:",error);

    $("pushStatus").textContent=
      "Le système de notifications n'est pas disponible.";
  }
}

$("refresh").addEventListener("click",load);

$("pushButton")?.addEventListener(
  "click",
  async()=>{
    if(pushSubscription){
      await disablePush();
    }else{
      await enablePush();
    }
  }
);

load();
setupPush();

// Mise à jour visuelle du compteur chaque seconde.
setInterval(render,1000);

// API actualisée toutes les 10 secondes au lieu
// de toutes les 60 secondes.
setInterval(load,10000);

document.addEventListener(
  "visibilitychange",
  ()=>{
    if(
      document.visibilityState==="visible" &&
      Date.now()-lastFetch>15000
    ){
      load();
    }
  }
);
