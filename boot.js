console.log("BOOT FILE LOADED");

import CONFIG from "./config.js";

const app = document.getElementById("app");

function log(msg, color = "#00ff88") {
  const p = document.createElement("div");
  p.style.color = color;
  p.textContent = msg;
  app.appendChild(p);
}

async function boot() {
  app.innerHTML = "";
  log("BOOT STARTED", "#ffffff");

  if (!CONFIG || !CONFIG.GAS_WEBAPP_URL) {
    log("CONFIG ERROR", "red");
    return;
  }

  log("Connecting to backend...", "#00ff88");

  try {
    const res = await fetch(`${CONFIG.GAS_WEBAPP_URL}?route=health`);
    const data = await res.json();

    if (data.ok) {
      log("Backend Connected", "#00ff88");
      log("Risk Engine Online", "#00ff88");
    } else {
      log("Backend Error", "red");
    }
  } catch (err) {
    log("Connection Failed", "red");
    console.error(err);
  }
}

boot();
