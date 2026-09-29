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

  const live=data.live?.[0];
  const next=data.next;

  if(live && live.end){
    $("liveCard").classList.remove("hidden");
    $("liveEmoji").textContent=live.emoji||"🎯";
    $("liveName").textContent=live.displayName||live.name;
    $("liveCountdown").textContent=duration(live.end-Date.now(),false);
  }else{
    $("liveCard").classList.add("hidden");
  }

  if(next){
    $("nextEmoji").textContent=next.emoji||"🎯";
    $("nextName").textContent=next.displayName||next.name;
    $("nextCountdown").textContent=next.next
      ? duration(next.next-Date.now(),true)
      : "--:--:--";
    $("nextTime").textContent=`à ${next.time||"--:--"}`;
  }

  const list=data.upcoming||[];
  $("events").innerHTML=list.map(e=>{
    const date=eventDate(e.next);
    return `<div class="row">
      <span>${e.emoji||"🎯"}</span>
      <span class="name">${escapeHtml(e.displayName||e.name)}</span>
      <span class="time">${date?date.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}):"--:--"}</span>
    </div>`;
  }).join("");

  $("updated").textContent="Dernière mise à jour : "+new Date().toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
}

function escapeHtml(value){
  return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}

async function load(){
  $("status").textContent="Actualisation…";
  try{
    const res=await fetch(API,{cache:"no-store"});
    if(!res.ok) throw new Error("API HTTP "+res.status);
    data=await res.json();
    if(!data.success) throw new Error("API indisponible");
    lastFetch=Date.now();
    $("status").textContent="● API connectée";
    $("status").classList.remove("error");
    render();
  }catch(e){
    $("status").textContent="API inaccessible — nouvelle tentative automatique";
    $("status").classList.add("error");
  }
}

$("refresh").addEventListener("click",load);

load();
setInterval(render,1000);
setInterval(load,60000);

document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState==="visible" && Date.now()-lastFetch>15000) load();
});
