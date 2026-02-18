export function mountUI() {
  const root = document.getElementById("app");

  root.innerHTML = `
    <div class="terminal-shell">
      <header class="terminal-header">
        <div class="terminal-title">
          <span class="dot dot-green"></span>
          <span class="dot dot-amber"></span>
          <span class="dot dot-red"></span>
          <span class="title-text">STARKS SPORTSBOOK LLC — RISK ROOM</span>
        </div>

        <div class="terminal-status">
          <span class="pill" id="pillApi">API: INIT</span>
          <span class="pill" id="pillLatency">LAT: —</span>
        </div>
      </header>

      <main class="terminal-main">
        <section class="panel">
          <div class="panel-title">TRADING GRID</div>
          <div class="panel-body">Layer 3 loading...</div>
        </section>

        <section class="panel">
          <div class="panel-title">EDGE BOARD</div>
          <div class="panel-body">Layer 3 loading...</div>
        </section>

        <section class="panel">
          <div class="panel-title">PARLAY DESK</div>
          <div class="panel-body">Layer 3 loading...</div>
        </section>
      </main>

      <div class="toast-stack" id="toastStack"></div>
    </div>
  `;
}

export function setStatus({ api, latency }) {
  const pillApi = document.getElementById("pillApi");
  const pillLatency = document.getElementById("pillLatency");

  if (pillApi && api) pillApi.textContent = `API: ${api}`;
  if (pillLatency)
    pillLatency.textContent =
      latency !== null ? `LAT: ${latency}ms` : "LAT: —";
}

export function toast(message, type = "info") {
  const stack = document.getElementById("toastStack");
  const el = document.createElement("div");

  el.className = `toast ${type}`;
  el.textContent = message;

  stack.appendChild(el);

  setTimeout(() => el.remove(), 3000);
}
