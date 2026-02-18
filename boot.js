console.log("BOOT FILE LOADED");

const API_BASE = "https://starks-backend-m4tl.onrender.com";

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

  log("Connecting to backend...", "#00ff88");

  try {
    const res = await fetch(`${API_BASE}/api/board`);
    const data = await res.json();

    if (data.ok) {
      log("Backend Connected", "#00ff88");
      log(`Rows Received: ${data.rows.length}`, "#00ff88");
      log("Sportsbook Live", "#00ff88");
    } else {
      log("Backend Error", "red");
    }
  } catch (err) {
    log("Connection Failed", "red");
    console.error(err);
  }
}

boot();
