console.log("BOOT FILE LOADED");

const API_BASE = "https://starks-backend-m4tl.onrender.com";
const REFRESH_MS = 15000; // 15s live terminal cadence

// DEMO MODE: if true, we add small drift to odds so movement effects show even with static backend data
const DEMO_DRIFT_ENABLED = true;

// Drift parameters (Vegas-style tiny moves)
const DRIFT_MAX_POINTS = 6;      // max move in a refresh, e.g. 6 points
const DRIFT_CHANCE = 0.70;       // 70% chance a row drifts each refresh
const STEAM_WINDOW = 4;          // how many recent moves we consider for "steam"
const STEAM_MIN_STREAK = 2;      // 2+ moves same direction => STEAM badge

const app = document.getElementById("app");

// ---------- Helpers ----------
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function americanToDecimal(american) {
  const a = toNumber(american);
  if (a === null || a === 0) return null;
  if (a > 0) return 1 + (a / 100);
  return 1 + (100 / Math.abs(a));
}

function americanToImpliedProb(american) {
  const a = toNumber(american);
  if (a === null || a === 0) return null;
  if (a > 0) return 100 / (a + 100);
  return Math.abs(a) / (Math.abs(a) + 100);
}

function fmtPct(p) {
  if (p === null) return "—";
  return (p * 100).toFixed(1) + "%";
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return "—";
  return "$" + n.toFixed(2);
}

function edgeClass(edgePct) {
  const e = toNumber(edgePct);
  if (e === null) return "edge-bad";
  if (e >= 3) return "edge-good";
  if (e >= 2) return "edge-warn";
  return "edge-bad";
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rowKey(r) {
  return [
    r.sport, r.start, r.matchup, r.market, r.line, r.book
  ].map(x => String(x ?? "")).join("|");
}

// ---------- Phase 2: Signal helpers ----------
function signalTier(score) {
  const s = toNumber(score) ?? 0;
  if (s >= 81) return "signal-elite";
  if (s >= 61) return "signal-sharp";
  if (s >= 31) return "signal-interest";
  return "signal-noise";
}

function signalLabel(score, label) {
  if (label) return String(label);
  const s = toNumber(score) ?? 0;
  if (s >= 81) return "ELITE";
  if (s >= 61) return "SHARP";
  if (s >= 31) return "INTEREST";
  return "NOISE";
}

function ensureSignalStyles() {
  if (document.getElementById("signal-style-v2")) return;
  const style = document.createElement("style");
  style.id = "signal-style-v2";
  style.textContent = `
    /* Phase 2 signal styling (injected by boot.js) */
    .signal-elite {
      background: rgba(25,245,166,.10);
      box-shadow: inset 0 0 0 1px rgba(25,245,166,.35);
    }
    .signal-sharp {
      background: rgba(59,130,246,.10);
      box-shadow: inset 0 0 0 1px rgba(59,130,246,.35);
    }
    .signal-interest {
      background: rgba(250,204,21,.08);
      box-shadow: inset 0 0 0 1px rgba(250,204,21,.22);
    }
    .signal-noise { opacity: .78; }
    .sigpill{
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,.18);
      background: rgba(0,0,0,.25);
      letter-spacing: .3px;
      opacity: .95;
      line-height: 1.4;
    }
    .sigwrap{
      display:flex;
      align-items:center;
      gap:8px;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
}

// ---------- State ----------
let state = {
  rows: [],
  slip: [],

  mode: "single",
  stake: 25,
  bankroll: 10000,

  lastUpdated: null,
  backendOk: false,

  // Vegas movement memory
  previousOddsMap: {},          // key -> last odds (number)
  moveHistoryMap: {},           // key -> array of directions: +1 or -1
  lastMoveTick: [],             // array of strings for ticker

  ticker: "STARKS Terminal Ready • Click any row to add it to the slip • EV + implied prob live • Parlay math online",
};

// ---------- Normalization ----------
function normalizeRow(r) {
  const odds = toNumber(r.odds);
  const impliedP = odds != null ? americanToImpliedProb(odds) : null;
  const dec = odds != null ? americanToDecimal(odds) : null;

  const edgePct = toNumber(r.edge);
  const modelP = (impliedP != null && edgePct != null)
    ? Math.max(0, Math.min(1, impliedP + (edgePct / 100)))
    : null;

  return {
    ...r,

    // Normalize odds/math fields
    odds,
    impliedP,
    modelP,
    dec,

    // Movement fields
    previousOdds: null,
    moveDir: 0,          // +1 (worse) / -1 (better) / 0 (no move)
    steam: false,        // steam streak badge (frontend)
  };
}

// ---------- Vegas drift simulation ----------
function applyDemoDrift(rows) {
  if (!DEMO_DRIFT_ENABLED) return rows;

  return rows.map(r => {
    if (r.odds == null) return r;

    // Chance to drift
    if (Math.random() > DRIFT_CHANCE) return r;

    const magnitude = Math.floor(Math.random() * DRIFT_MAX_POINTS) + 1; // 1..max
    const direction = Math.random() > 0.5 ? 1 : -1;

    let next = r.odds;

    if (next < 0) {
      // -110 -> -112 (worse) if direction=+1, or -108 (better) if direction=-1
      next = next + (direction * -magnitude);
    } else {
      // +135 -> +140 (better payout) if direction=+1; +130 if direction=-1
      next = next + (direction * magnitude);
    }

    // Keep it within sane range
    if (next > 500) next = 500;
    if (next < -500) next = -500;
    if (next === 0) next = r.odds;

    return { ...r, odds: next };
  });
}

// ---------- Movement detection + steam ----------
function updateMovement(rows) {
  const tickerEvents = [];

  rows.forEach(r => {
    const key = rowKey(r);
    const prev = state.previousOddsMap[key];

    r.previousOdds = prev ?? null;
    r.moveDir = 0;

    if (r.odds != null && prev != null && r.odds !== prev) {
      const better =
        (prev < 0 && r.odds > prev) ||  // -110 -> -108
        (prev > 0 && r.odds > prev);    // +135 -> +140

      r.moveDir = better ? -1 : +1;

      const arrow = better ? "▼" : "▲";
      const evStr = `${r.matchup} ${prev} → ${r.odds} ${arrow} (${r.book || "Book"})`;
      tickerEvents.push(evStr);

      if (!state.moveHistoryMap[key]) state.moveHistoryMap[key] = [];
      state.moveHistoryMap[key].push(r.moveDir);
      if (state.moveHistoryMap[key].length > STEAM_WINDOW) {
        state.moveHistoryMap[key].shift();
      }

      const hist = state.moveHistoryMap[key];
      const last = hist[hist.length - 1];
      let streak = 1;
      for (let i = hist.length - 2; i >= 0; i--) {
        if (hist[i] === last) streak++;
        else break;
      }
      r.steam = streak >= STEAM_MIN_STREAK;
    } else {
      if (state.moveHistoryMap[key] && state.moveHistoryMap[key].length > STEAM_WINDOW) {
        state.moveHistoryMap[key] = state.moveHistoryMap[key].slice(-STEAM_WINDOW);
      }
      r.steam = false;
    }

    if (r.odds != null) state.previousOddsMap[key] = r.odds;
  });

  if (tickerEvents.length) {
    state.lastMoveTick = [...tickerEvents, ...state.lastMoveTick].slice(0, 10);
  }
}

// ---------- UI ----------
function render() {
  ensureSignalStyles();

  const last = state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString() : "—";

  app.innerHTML = `
    <div class="shell">
      <div class="topbar">
        <div class="brand">
          <div class="badge"></div>
          <div>
            <div class="brand-title">STARKS SPORTSBOOK LLC</div>
            <div class="brand-sub">Vegas Terminal • Live Board • Risk Room</div>
          </div>
        </div>

        <div class="statusline">
          <div class="dot ${state.backendOk ? "ok" : "bad"}"></div>
          <div>${state.backendOk ? "Backend OK" : "Backend Issue"}</div>
          <div>•</div>
          <div>Last: ${esc(last)}</div>
          <div>•</div>
          <div>Auto: ${Math.round(REFRESH_MS/1000)}s</div>
        </div>

        <div class="actions">
          <div class="btn" id="btnPing">Ping</div>
          <div class="btn primary" id="btnReload">Reload Board</div>
          <div class="btn" id="btnDemo">Demo Data</div>
        </div>
      </div>

      <div class="grid">
        <!-- Left -->
        <div class="panel">
          <div class="panel-hd">
            <div>
              <div class="panel-title">BOARD CONTROLS</div>
              <div class="panel-sub">Filters + session controls</div>
            </div>
            <div class="chip">Mode: <b style="color:var(--good)">&nbsp;${esc(state.mode.toUpperCase())}</b></div>
          </div>

          <div class="panel-bd">
            <div class="kv"><span>Refresh</span><b>${(REFRESH_MS/1000)}s</b></div>
            <div class="kv"><span>Rows</span><b>${state.rows.length}</b></div>
            <div class="kv"><span>Demo Drift</span><b>${DEMO_DRIFT_ENABLED ? "ON" : "OFF"}</b></div>

            <div class="hr"></div>

            <div class="row">
              <div style="flex:1">
                <div class="small">Stake</div>
                <input class="input" id="stake" type="number" min="1" step="1" value="${state.stake}">
              </div>
              <div style="flex:1">
                <div class="small">Bankroll</div>
                <input class="input" id="bankroll" type="number" min="0" step="1" value="${state.bankroll}">
              </div>
            </div>

            <div class="pillrow" style="margin-top:12px;">
              <div class="pill ${state.mode==="single" ? "active" : ""}" data-mode="single">SINGLE</div>
              <div class="pill ${state.mode==="parlay" ? "active" : ""}" data-mode="parlay">PARLAY</div>
            </div>

            <div class="hr"></div>

            <div class="small">Vegas tip: Watch odds flashes for movement. 🔥 = steam. Signal ranks top-down.</div>
          </div>
        </div>

        <!-- Middle: Board -->
        <div class="panel">
          <div class="panel-hd">
            <div>
              <div class="panel-title">LIVE BETTING BOARD</div>
              <div class="panel-sub">Click a row to add to slip</div>
            </div>
            <div class="chip">Signal: <b class="${state.rows.length ? "edge-good" : "edge-warn"}">&nbsp;${state.rows.length ? "LIVE" : "EMPTY"}</b></div>
          </div>

          <div class="panel-bd" style="padding:0;">
            <table class="table" id="boardTable">
              <thead>
                <tr>
                  <th>SPORT</th>
                  <th>START</th>
                  <th>MATCHUP</th>
                  <th>MARKET</th>
                  <th>LINE</th>
                  <th>ODDS</th>
                  <th>BOOK</th>
                  <th>EDGE</th>
                  <th>SIGNAL</th>
                </tr>
              </thead>
              <tbody>
                ${state.rows.length ? state.rows.map(r => {
                  const key = rowKey(r);
                  const picked = state.slip.some(s => s.key === key);

                  const oddsClass =
                    r.moveDir === -1 ? "move-up" : r.moveDir === +1 ? "move-down" : "";

                  const oddsArrow =
                    r.moveDir === -1 ? " ▼" : r.moveDir === +1 ? " ▲" : "";

                  // Existing frontend steam streak + backend steam_detected
                  const steamOn = !!(r.steam_detected || r.steam);
                  const steamBadge = steamOn ? `<span class="steam">🔥 STEAM</span>` : "";

                  const sigScore = (toNumber(r.signal_score) ?? 0);
                  const sigLabel = signalLabel(r.signal_score, r.signal_label);
                  const sigClass = signalTier(sigScore);

                  return `
                    <tr class="tr" data-key="${esc(key)}" style="${picked ? "background:rgba(25,245,166,.06)" : ""}">
                      <td>${esc(r.sport)}</td>
                      <td class="small">${esc(r.start || "—")}</td>
                      <td><b>${esc(r.matchup)}</b> ${steamBadge}</td>
                      <td>${esc(r.market)}</td>
                      <td>${esc(String(r.line ?? ""))}</td>
                      <td class="${oddsClass}">
                        <b>${esc(String(r.odds ?? ""))}</b>${oddsArrow}
                        ${r.previousOdds != null && r.odds != null && r.odds !== r.previousOdds
                          ? `<div class="small">was ${esc(String(r.previousOdds))}</div>`
                          : `<div class="small">&nbsp;</div>`}
                      </td>
                      <td class="small">${esc(r.book || "—")}</td>
                      <td class="${edgeClass(r.edge)}"><b>${esc(String(r.edge ?? "—"))}${r.edge!=null ? "%" : ""}</b></td>

                      <td class="${sigClass}">
                        <div class="sigwrap">
                          <b>${esc(String(sigScore))}</b>
                          <span class="sigpill">${esc(sigLabel)}</span>
                          ${steamOn ? `<span class="steam">🔥</span>` : ``}
                        </div>
                      </td>
                    </tr>
                  `;
                }).join("") : `<tr><td colspan="9" style="padding:14px;color:rgba(234,240,255,.65)">No board data. Click Demo Data or Reload Board.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Right: Risk Room -->
        <div class="panel">
          <div class="panel-hd">
            <div>
              <div class="panel-title">RISK ROOM</div>
              <div class="panel-sub">Slip math + EV</div>
            </div>
            <div class="chip">${esc(state.mode.toUpperCase())} • <b>&nbsp;${state.slip.length} picks</b></div>
          </div>

          <div class="panel-bd">
            ${renderSlip()}
            <div class="hr"></div>
            <div class="btn primary" id="btnSim">Simulate Ticket</div>
            <div style="height:8px"></div>
            <div class="btn" id="btnClear">Clear Slip</div>
          </div>
        </div>
      </div>

      <div class="ticker">
        <span>
          ${esc(state.ticker)}
          ${state.lastMoveTick.length ? " • MOVES: " + esc(state.lastMoveTick.join(" • ")) : ""}
        </span>
      </div>
    </div>
  `;

  bindUI();
}

// ---------- Slip render ----------
function renderSlip() {
  if (!state.slip.length) {
    return `<div class="small">Slip is empty. Click a board row to add picks.</div>`;
  }

  const stake = Math.max(1, toNumber(state.stake) ?? 25);

  if (state.mode === "single") {
    const blocks = state.slip.map(p => {
      const implied = p.impliedP;
      const model = p.modelP;
      const dec = p.dec;

      const toWin = dec ? stake * dec : null;
      const ev = (dec && model != null) ? (stake * (dec * model - 1)) : null;
      const edgeDelta = (model != null && implied != null) ? (model - implied) : null;

      return `
        <div style="border:1px solid rgba(120,180,255,.12); background:rgba(7,10,18,.42); border-radius:14px; padding:10px; margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
            <div>
              <div style="font-weight:800">${esc(p.matchup)}</div>
              <div class="small">${esc(p.market)} • ${esc(String(p.line ?? ""))} • <b>${esc(String(p.odds))}</b> • ${esc(p.book || "—")}</div>
            </div>
            <div class="btn" data-remove="${esc(p.key)}" style="padding:6px 10px; font-size:11px;">Remove</div>
          </div>

          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:10px;">
            <div class="kv"><span>Implied</span><b>${fmtPct(implied)}</b></div>
            <div class="kv"><span>Model</span><b>${fmtPct(model)}</b></div>

            <div class="kv"><span>Edge Δ</span><b class="${
              edgeDelta!=null && edgeDelta*100>=2 ? "edge-good" : edgeDelta!=null && edgeDelta*100>=1 ? "edge-warn" : "edge-bad"
            }">${edgeDelta==null ? "—" : (edgeDelta*100).toFixed(2)+"%"}</b></div>

            <div class="kv"><span>Decimal</span><b>${dec ? dec.toFixed(3) : "—"}</b></div>

            <div class="kv"><span>To Win</span><b>${toWin ? fmtMoney(toWin) : "—"}</b></div>
            <div class="kv"><span>EV (profit)</span><b class="${ev!=null && ev>=0 ? "edge-good" : "edge-bad"}">${ev!=null ? fmtMoney(ev) : "—"}</b></div>
          </div>
        </div>
      `;
    }).join("");

    return `
      <div class="kv"><span>Stake per ticket</span><b>${fmtMoney(stake)}</b></div>
      <div class="small">Singles mode: each pick is its own ticket estimate.</div>
      <div style="height:10px"></div>
      ${blocks}
    `;
  }

  const parlay = computeParlay(stake, state.slip);
  return `
    <div class="kv"><span>Stake</span><b>${fmtMoney(stake)}</b></div>
    <div class="small">Parlay mode: odds + probabilities multiply.</div>
    <div style="height:10px"></div>

    <div style="border:1px solid rgba(120,180,255,.12); background:rgba(7,10,18,.42); border-radius:14px; padding:10px;">
      ${state.slip.map(p => `
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:center; padding:6px 0; border-bottom:1px solid rgba(120,180,255,.08)">
          <div>
            <div style="font-weight:800">${esc(p.matchup)}</div>
            <div class="small">${esc(p.market)} • ${esc(String(p.line ?? ""))} • <b>${esc(String(p.odds))}</b></div>
          </div>
          <div class="btn" data-remove="${esc(p.key)}" style="padding:6px 10px; font-size:11px;">Remove</div>
        </div>
      `).join("")}

      <div style="margin-top:10px; display:grid; grid-template-columns:1fr 1fr; gap:8px;">
        <div class="kv"><span>Parlay Decimal</span><b>${parlay.decimal ? parlay.decimal.toFixed(3) : "—"}</b></div>
        <div class="kv"><span>Implied Prob</span><b>${parlay.impliedP != null ? fmtPct(parlay.impliedP) : "—"}</b></div>

        <div class="kv"><span>Model Prob</span><b>${parlay.modelP != null ? fmtPct(parlay.modelP) : "—"}</b></div>
        <div class="kv"><span>Edge Δ</span><b class="${
          parlay.edgeDelta!=null && parlay.edgeDelta*100>=2 ? "edge-good" : parlay.edgeDelta!=null && parlay.edgeDelta*100>=1 ? "edge-warn" : "edge-bad"
        }">${parlay.edgeDelta==null ? "—" : (parlay.edgeDelta*100).toFixed(2)+"%"}</b></div>

        <div class="kv"><span>To Win</span><b>${parlay.toWin != null ? fmtMoney(parlay.toWin) : "—"}</b></div>
        <div class="kv"><span>EV (profit)</span><b class="${parlay.ev!=null && parlay.ev>=0 ? "edge-good" : "edge-bad"}">${parlay.ev != null ? fmtMoney(parlay.ev) : "—"}</b></div>
      </div>
    </div>
  `;
}

function computeParlay(stake, picks) {
  let dec = 1;
  let implied = 1;
  let model = 1;

  let anyDec = false;
  let anyImp = false;
  let anyModel = false;

  for (const p of picks) {
    if (p.dec != null) { dec *= p.dec; anyDec = true; }
    if (p.impliedP != null) { implied *= p.impliedP; anyImp = true; }
    if (p.modelP != null) { model *= p.modelP; anyModel = true; }
  }

  const toWin = anyDec ? stake * dec : null;
  const impliedP = anyImp ? implied : null;
  const modelP = anyModel ? model : null;

  const ev = (anyDec && anyModel) ? (stake * (dec * modelP - 1)) : null;
  const edgeDelta = (impliedP != null && modelP != null) ? (modelP - impliedP) : null;

  return { decimal: anyDec ? dec : null, toWin, impliedP, modelP, ev, edgeDelta };
}

// ---------- Data ----------
async function pingBackend() {
  try {
    const res = await fetch(`${API_BASE}/`);
    const data = await res.json();
    state.backendOk = !!data.ok;
  } catch {
    state.backendOk = false;
  }
}

async function loadBoard() {
  await pingBackend();

  if (!state.backendOk) {
    state.rows = [];
    state.lastUpdated = Date.now();
    state.ticker = "Backend not reachable • check Render service • try Reload Board";
    render();
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/board`);
    const data = await res.json();

    let rows = Array.isArray(data.rows) ? data.rows.map(normalizeRow) : [];

    // DEMO drift so movement shows even with static backend
    rows = applyDemoDrift(rows);

    // Update movement info + steam + ticker feed
    updateMovement(rows);

    // -----------------------------
    // Phase 2: Auto-sort by Signal Score (desc)
    // -----------------------------
    rows.sort((a, b) => {
      const sa = toNumber(a.signal_score) ?? 0;
      const sb = toNumber(b.signal_score) ?? 0;
      return sb - sa;
    });

    state.rows = rows;
    state.lastUpdated = Date.now();
    state.ticker = `VEGAS LIVE • ${rows.length} markets • ${state.mode.toUpperCase()} math online • EV live • Flash = line move • Sorted by SIGNAL`;

    // Keep slip updated: match by key (NOTE: key excludes odds so slip survives line moves)
    const currentKeys = new Set(rows.map(rowKey));
    state.slip = state.slip.filter(s => currentKeys.has(s.key));

    state.slip = state.slip.map(s => {
      const match = rows.find(r => rowKey(r) === s.key);
      return match ? { ...normalizeRow(match), key: s.key } : s;
    });

    render();
  } catch (err) {
    console.error(err);
    state.rows = [];
    state.lastUpdated = Date.now();
    state.ticker = "Board fetch failed • check /api/board • open backend URL directly to verify";
    render();
  }
}

function loadDemo() {
  let demo = [
    { sport:"NCAAB", start:"02/18, 10:18 PM", matchup:"KANSAS @ BAYLOR", market:"ML", line:"KANSAS", odds:-135, book:"DraftKings", edge:2.4, signal_score: 72, signal_label: "SHARP WATCH", steam_detected: true },
    { sport:"NBA", start:"02/18, 8:57 PM", matchup:"BOS @ MIA", market:"SPREAD", line:"BOS -2.5", odds:-110, book:"Circa", edge:2.2, signal_score: 58, signal_label: "INTEREST", steam_detected: false },
    { sport:"NFL", start:"02/18, 10:37 PM", matchup:"KC @ CIN", market:"TOTAL", line:"O 47.5", odds:-108, book:"FanDuel", edge:1.7, signal_score: 24, signal_label: "NOISE", steam_detected: false },
  ].map(normalizeRow);

  demo = applyDemoDrift(demo);
  updateMovement(demo);

  demo.sort((a, b) => (toNumber(b.signal_score) ?? 0) - (toNumber(a.signal_score) ?? 0));

  state.backendOk = true;
  state.rows = demo;
  state.lastUpdated = Date.now();
  state.ticker = "DEMO MODE • Vegas drift ON • Signal column live • Sorted by SIGNAL";
  render();
}

// ---------- Events ----------
function bindUI() {
  const btnReload = document.getElementById("btnReload");
  const btnPing = document.getElementById("btnPing");
  const btnDemo = document.getElementById("btnDemo");
  const btnSim = document.getElementById("btnSim");
  const btnClear = document.getElementById("btnClear");

  btnReload?.addEventListener("click", () => loadBoard());
  btnPing?.addEventListener("click", async () => { await pingBackend(); render(); });
  btnDemo?.addEventListener("click", () => loadDemo());
  btnClear?.addEventListener("click", () => { state.slip = []; render(); });

  btnSim?.addEventListener("click", () => {
    const stake = Math.max(1, toNumber(state.stake) ?? 25);
    if (!state.slip.length) return;

    let cost = 0;
    if (state.mode === "single") cost = stake * state.slip.length;
    else cost = stake;

    if (state.bankroll < cost) {
      state.ticker = "Insufficient bankroll for this ticket.";
      render();
      return;
    }

    state.bankroll = Math.max(0, state.bankroll - cost);
    state.ticker = `Ticket simulated • Cost ${fmtMoney(cost)} • Bankroll now ${fmtMoney(state.bankroll)}`;
    render();
  });

  const stakeInput = document.getElementById("stake");
  const bankrollInput = document.getElementById("bankroll");
  stakeInput?.addEventListener("change", (e) => {
    state.stake = Math.max(1, toNumber(e.target.value) ?? 25);
    render();
  });
  bankrollInput?.addEventListener("change", (e) => {
    state.bankroll = Math.max(0, toNumber(e.target.value) ?? 10000);
    render();
  });

  document.querySelectorAll("[data-mode]").forEach(el => {
    el.addEventListener("click", () => {
      state.mode = el.getAttribute("data-mode");
      state.ticker = `${state.mode.toUpperCase()} mode armed • Slip math recalculated`;
      render();
    });
  });

  document.querySelectorAll("tr[data-key]").forEach(tr => {
    tr.addEventListener("click", () => {
      const key = tr.getAttribute("data-key");
      const row = state.rows.find(r => rowKey(r) === key);
      if (!row) return;

      const idx = state.slip.findIndex(s => s.key === key);
      if (idx >= 0) {
        state.slip.splice(idx, 1);
        state.ticker = "Removed pick from slip.";
      } else {
        state.slip.push({ ...normalizeRow(row), key });
        state.ticker = "Added pick to slip.";
      }
      render();
    });
  });

  document.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = btn.getAttribute("data-remove");
      state.slip = state.slip.filter(s => s.key !== key);
      state.ticker = "Removed pick from slip.";
      render();
    });
  });
}

// ---------- Boot ----------
async function boot() {
  render();
  await loadBoard();
  setInterval(loadBoard, REFRESH_MS);
}

boot();
