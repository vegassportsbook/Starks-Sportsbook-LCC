console.log("BOOT FILE LOADED — BADASS VEGAS SKIN LAYER");

const API_BASE = "https://starks-backend-m4tl.onrender.com";
const REFRESH_MS = 15000;

// Keep your existing drift + movement system
const DEMO_DRIFT_ENABLED = true;
const DRIFT_MAX_POINTS = 6;
const DRIFT_CHANCE = 0.70;
const STEAM_WINDOW = 4;
const STEAM_MIN_STREAK = 2;

// ---------- Helpers ----------
function toNumber(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }

function americanToDecimal(american){
  const a = toNumber(american);
  if (a === null || a === 0) return null;
  if (a > 0) return 1 + (a / 100);
  return 1 + (100 / Math.abs(a));
}
function americanToImpliedProb(american){
  const a = toNumber(american);
  if (a === null || a === 0) return null;
  if (a > 0) return 100 / (a + 100);
  return Math.abs(a) / (Math.abs(a) + 100);
}

function fmtPct(p){ if (p == null) return "—"; return (p*100).toFixed(1) + "%"; }
function fmtMoney(n){ if (!Number.isFinite(n)) return "—"; return "$" + n.toFixed(2); }

function esc(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;");
}

function rowKey(r){
  return [r.sport, r.start, r.matchup, r.market, r.line, r.book]
    .map(x => String(x ?? "")).join("|");
}

function heatClassEdge(edgePct){
  const e = toNumber(edgePct);
  if (e == null) return "bad";
  if (e >= 3) return "good";
  if (e >= 2) return "warn";
  return "bad";
}

function safeUpper(s){ return String(s ?? "").toUpperCase(); }

// ---------- State ----------
let state = {
  rows: [],
  filtered: [],
  slip: [],

  mode: "single",
  stake: 25,
  bankroll: 10000,

  backendOk: false,
  lastUpdated: null,

  previousOddsMap: {},
  moveHistoryMap: {},
  lastMoveTick: [],

  filters: {
    sport: "ALL",
    q: "",
    minEdge: 0,
    minSignal: 0,
    sort: "signal_desc",
  },

  activeTab: "highlights",
  activeNav: "sportsbook",
};

const el = (id) => document.getElementById(id);

// ---------- Normalization ----------
function normalizeRow(r){
  const odds = toNumber(r.odds);
  const impliedP = odds != null ? americanToImpliedProb(odds) : null;
  const dec = odds != null ? americanToDecimal(odds) : null;

  const edgePct = toNumber(r.edge);

  // signal can be signal_score OR signalScore OR signal
  const signal = toNumber(r.signal_score ?? r.signalScore ?? r.signal ?? 0) ?? 0;
  const label = String(r.signal_label ?? r.signalLabel ?? "").trim();
  const steamDetected = !!(r.steam_detected ?? r.steamDetected ?? false);

  // simple modelP based on implied + edge (existing behavior)
  const modelP = (impliedP != null && edgePct != null)
    ? Math.max(0, Math.min(1, impliedP + (edgePct / 100)))
    : null;

  return {
    ...r,
    sport: r.sport ?? "—",
    start: r.start ?? "—",
    matchup: r.matchup ?? "—",
    market: r.market ?? "—",
    line: r.line ?? "—",
    book: r.book ?? "—",

    odds,
    impliedP,
    dec,
    edge: edgePct,

    signal_score: signal,
    signal_label: label || (signal >= 70 ? "SHARP WATCH" : signal >= 55 ? "INTEREST" : "NOISE"),
    steam_detected: steamDetected,

    previousOdds: null,
    moveDir: 0,
    steam: false,
  };
}

// ---------- Drift ----------
function applyDemoDrift(rows){
  if (!DEMO_DRIFT_ENABLED) return rows;
  return rows.map(r => {
    if (r.odds == null) return r;
    if (Math.random() > DRIFT_CHANCE) return r;

    const magnitude = Math.floor(Math.random() * DRIFT_MAX_POINTS) + 1;
    const direction = Math.random() > 0.5 ? 1 : -1;
    let next = r.odds;

    if (next < 0) next = next + (direction * -magnitude); // -110 -> -108 vs -112
    else next = next + (direction * magnitude);           // +135 -> +140 vs +130

    if (next > 500) next = 500;
    if (next < -500) next = -500;
    if (next === 0) next = r.odds;

    return { ...r, odds: next };
  });
}

// ---------- Movement + Steam ----------
function updateMovement(rows){
  const tickerEvents = [];

  rows.forEach(r => {
    const key = rowKey(r);
    const prev = state.previousOddsMap[key];

    r.previousOdds = prev ?? null;
    r.moveDir = 0;

    if (r.odds != null && prev != null && r.odds !== prev) {
      const better =
        (prev < 0 && r.odds > prev) ||
        (prev > 0 && r.odds > prev);

      r.moveDir = better ? -1 : +1;

      const arrow = better ? "▼" : "▲";
      tickerEvents.push(`${r.matchup} ${prev}→${r.odds} ${arrow} (${r.book})`);

      if (!state.moveHistoryMap[key]) state.moveHistoryMap[key] = [];
      state.moveHistoryMap[key].push(r.moveDir);
      if (state.moveHistoryMap[key].length > STEAM_WINDOW) state.moveHistoryMap[key].shift();

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

  if (tickerEvents.length) state.lastMoveTick = [...tickerEvents, ...state.lastMoveTick].slice(0, 10);
}

// ---------- Backend ----------
async function pingBackend(){
  try{
    const res = await fetch(`${API_BASE}/`, { cache: "no-store" });
    const data = await res.json();
    state.backendOk = !!data.ok;
  }catch{
    state.backendOk = false;
  }
}

async function loadBoard(){
  await pingBackend();

  setStatus();

  if (!state.backendOk){
    state.rows = [];
    state.filtered = [];
    state.lastUpdated = Date.now();
    renderAll();
    setTicker("Backend not reachable • check Render service • try Reload");
    return;
  }

  try{
    const res = await fetch(`${API_BASE}/api/board`, { cache: "no-store" });
    const data = await res.json();

    let rows = Array.isArray(data.rows) ? data.rows.map(normalizeRow) : [];

    // drift + movement
    rows = applyDemoDrift(rows);
    updateMovement(rows);

    // Phase 2: default sort by signal desc
    rows.sort((a,b) => (toNumber(b.signal_score) ?? 0) - (toNumber(a.signal_score) ?? 0));

    state.rows = rows;
    state.lastUpdated = Date.now();

    applyFilters();
    renderAll();
    setTicker(buildTickerText());
  }catch(err){
    console.error(err);
    state.rows = [];
    state.filtered = [];
    state.lastUpdated = Date.now();
    renderAll();
    setTicker("Board fetch failed • open backend /api/board to verify");
  }
}

// ---------- Filters / Sorting ----------
function applyFilters(){
  const { sport, q, minEdge, minSignal, sort } = state.filters;
  const qx = (q || "").trim().toLowerCase();

  let out = [...state.rows];

  if (sport && sport !== "ALL"){
    out = out.filter(r => safeUpper(r.sport) === safeUpper(sport));
  }

  if (qx){
    out = out.filter(r => {
      const hay = `${r.matchup} ${r.book} ${r.line} ${r.market} ${r.sport}`.toLowerCase();
      return hay.includes(qx);
    });
  }

  out = out.filter(r => (toNumber(r.edge) ?? 0) >= (toNumber(minEdge) ?? 0));
  out = out.filter(r => (toNumber(r.signal_score) ?? 0) >= (toNumber(minSignal) ?? 0));

  // sorting
  if (sort === "signal_desc"){
    out.sort((a,b) => (toNumber(b.signal_score) ?? 0) - (toNumber(a.signal_score) ?? 0));
  } else if (sort === "edge_desc"){
    out.sort((a,b) => (toNumber(b.edge) ?? 0) - (toNumber(a.edge) ?? 0));
  } else if (sort === "start_asc"){
    out.sort((a,b) => String(a.start).localeCompare(String(b.start)));
  } else if (sort === "sport_asc"){
    out.sort((a,b) => String(a.sport).localeCompare(String(b.sport)));
  }

  state.filtered = out;

  // keep slip synced (don’t drop if odds changed)
  const keys = new Set(state.filtered.map(rowKey));
  state.slip = state.slip.filter(s => keys.has(s.key));
  state.slip = state.slip.map(s => {
    const match = state.filtered.find(r => rowKey(r) === s.key);
    return match ? { ...match, key: s.key } : s;
  });
}

// ---------- Risk / EV ----------
function computeParlay(stake, picks){
  let dec = 1, implied = 1, model = 1;
  let anyDec=false, anyImp=false, anyModel=false;

  for (const p of picks){
    const d = p.dec;
    const ip = p.impliedP;
    const mp = p.modelP;
    if (d != null){ dec *= d; anyDec=true; }
    if (ip != null){ implied *= ip; anyImp=true; }
    if (mp != null){ model *= mp; anyModel=true; }
  }

  const toWin = anyDec ? stake * dec : null;
  const impliedP = anyImp ? implied : null;
  const modelP = anyModel ? model : null;
  const ev = (anyDec && anyModel) ? (stake * (dec * modelP - 1)) : null;

  return { dec: anyDec ? dec : null, impliedP, modelP, toWin, ev };
}

// Simple “risk score” heuristic (0–100) using slip size + avg signal + volatility proxy
function calcSlipRisk(){
  const picks = state.slip;
  if (!picks.length) return { score: 0, label: "EMPTY", ev: null };

  const avgSignal = picks.reduce((a,p)=>a+(toNumber(p.signal_score)??0),0) / picks.length;
  const avgEdge = picks.reduce((a,p)=>a+(toNumber(p.edge)??0),0) / picks.length;

  // volatility proxy: more legs => more risk; steam increases volatility slightly
  const steamCount = picks.filter(p => p.steam || p.steam_detected).length;

  let base = 50;
  base += (picks.length-1) * 10;          // more legs, more risk
  base += steamCount * 4;                 // steam = movement = volatility
  base -= Math.min(20, avgSignal/5);      // higher signal reduces risk
  base -= Math.min(10, avgEdge*2);        // higher edge reduces risk

  const score = Math.max(0, Math.min(100, Math.round(base)));

  const label =
    score >= 80 ? "HIGH VOLATILITY" :
    score >= 60 ? "MODERATE RISK" :
    score >= 35 ? "CONTROLLED" :
    "LOW RISK";

  // EV estimate (single = sum of each pick EV, parlay = parlay EV)
  const stake = Math.max(1, toNumber(state.stake) ?? 25);

  let ev = null;
  if (state.mode === "single"){
    let sum = 0;
    let any = false;
    for (const p of picks){
      if (p.dec != null && p.modelP != null){
        sum += (stake * (p.dec * p.modelP - 1));
        any = true;
      }
    }
    ev = any ? sum : null;
  } else {
    const par = computeParlay(stake, picks);
    ev = par.ev;
  }

  return { score, label, ev };
}

// ---------- Rendering ----------
function setStatus(){
  const dot = el("statusDot");
  const text = el("statusText");
  if (!dot || !text) return;

  if (state.backendOk){
    dot.classList.add("ok");
    text.textContent = "Backend OK";
  } else {
    dot.classList.remove("ok");
    text.textContent = "Backend Issue";
  }
}

function setTicker(t){
  const tick = el("ticker");
  if (tick) tick.textContent = t;
}

function buildTickerText(){
  const rows = state.filtered;
  const mode = state.mode.toUpperCase();
  const moves = state.lastMoveTick.length ? ` • MOVES: ${state.lastMoveTick.join(" • ")}` : "";
  return `VEGAS LIVE • ${rows.length} markets • ${mode} math online • Signal + steam armed${moves}`;
}

function updateKpis(){
  el("kpiMarkets").textContent = String(state.filtered.length);
  el("kpiSlip").textContent = String(state.slip.length);

  const top = state.filtered.reduce((m,r)=>Math.max(m, toNumber(r.signal_score)??0), 0);
  el("kpiTopSignal").textContent = top ? String(top) : "—";

  const last = state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString() : "—";
  el("lastUpdated").textContent = `Last updated: ${last}`;

  el("heroMode").textContent = state.mode.toUpperCase();
  el("heroDrift").textContent = DEMO_DRIFT_ENABLED ? "ON" : "OFF";
  el("heroRefresh").textContent = `${Math.round(REFRESH_MS/1000)}s`;

  el("drawerCount").textContent = String(state.slip.length);
  el("drawerMode").textContent = state.mode.toUpperCase();
}

function renderSportOptions(){
  const sel = el("sportFilter");
  if (!sel) return;

  const sports = Array.from(new Set(state.rows.map(r => safeUpper(r.sport))))
    .filter(Boolean)
    .sort((a,b)=>a.localeCompare(b));

  const current = state.filters.sport ?? "ALL";

  sel.innerHTML = `<option value="ALL">ALL</option>` + sports.map(s => {
    const selected = (s === safeUpper(current)) ? "selected" : "";
    return `<option value="${esc(s)}" ${selected}>${esc(s)}</option>`;
  }).join("");
}

function renderSlate(){
  const wrap = el("slate");
  if (!wrap) return;

  if (!state.filtered.length){
    wrap.innerHTML = `
      <div style="padding:12px; border-radius:18px; border:1px solid rgba(255,255,255,.10); background:rgba(0,0,0,.18); color:rgba(233,240,255,.65)">
        No markets match your filters. Try lowering Min Signal / Min Edge.
      </div>
    `;
    return;
  }

  // group by sport
  const groups = {};
  for (const r of state.filtered){
    const s = safeUpper(r.sport);
    if (!groups[s]) groups[s] = [];
    groups[s].push(r);
  }

  const sportOrder = Object.keys(groups).sort((a,b)=>a.localeCompare(b));

  wrap.innerHTML = sportOrder.map(sport => {
    const rows = groups[sport];

    // group by matchup+start so we can show “events”
    const eventsMap = {};
    for (const r of rows){
      const eid = `${r.matchup}__${r.start}`;
      if (!eventsMap[eid]) eventsMap[eid] = [];
      eventsMap[eid].push(r);
    }

    const events = Object.keys(eventsMap).map(k => eventsMap[k]);

    return `
      <div class="sportSection">
        <div class="sportHd">
          <div class="sportName">🏁 ${esc(sport)}</div>
          <div class="sportCount">${events.length} games • ${rows.length} markets</div>
        </div>
        <div class="events">
          ${events.map(mkts => renderEvent(mkts)).join("")}
        </div>
      </div>
    `;
  }).join("");

  // bind tile clicks after render
  document.querySelectorAll("[data-pick]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const key = btn.getAttribute("data-pick");
      togglePickByKey(key, btn);
      e.stopPropagation();
    });
  });
}

function renderEvent(markets){
  // markets = array for same matchup/start
  // create 3 tiles: prefer ML, SPREAD, TOTAL; else first 3
  const sorted = [...markets].sort((a,b)=>{
    const pr = (m)=>{
      const t = safeUpper(m.market);
      if (t === "ML") return 0;
      if (t === "SPREAD") return 1;
      if (t === "TOTAL") return 2;
      return 9;
    };
    return pr(a)-pr(b);
  });

  const shown = sorted.slice(0,3);

  const topSig = shown.reduce((m,r)=>Math.max(m, toNumber(r.signal_score)??0), 0);
  const maxEdge = shown.reduce((m,r)=>Math.max(m, toNumber(r.edge)??0), 0);

  const sigTag =
    topSig >= 70 ? `<span class="tag good">🧠 SIGNAL <b>${esc(topSig)}</b></span>` :
    topSig >= 55 ? `<span class="tag warn">📡 INTEREST <b>${esc(topSig)}</b></span>` :
    `<span class="tag">NOISE <b>${esc(topSig||0)}</b></span>`;

  const edgeTag =
    maxEdge >= 3 ? `<span class="tag good">📈 EDGE <b>${esc(maxEdge.toFixed(2))}%</b></span>` :
    maxEdge >= 2 ? `<span class="tag warn">📈 EDGE <b>${esc(maxEdge.toFixed(2))}%</b></span>` :
    `<span class="tag">📈 EDGE <b>${esc((maxEdge||0).toFixed(2))}%</b></span>`;

  const steamAny = markets.some(m => m.steam || m.steam_detected);
  const steamTag = steamAny ? `<span class="tag ice">🔥 STEAM</span>` : "";

  const r0 = markets[0];
  const matchup = r0.matchup;
  const start = r0.start;
  const book = r0.book;

  return `
    <div class="event">
      <div class="meta">
        <div class="match">${esc(matchup)} ${steamTag}</div>
        <div class="small">${esc(start)} • ${esc(book)}</div>
        <div class="badges">
          ${sigTag}
          ${edgeTag}
          <span class="tag">📘 ${esc(safeUpper(r0.sport))}</span>
        </div>
      </div>

      <div class="markets">
        ${shown.map(r => renderTile(r)).join("")}
      </div>
    </div>
  `;
}

function renderTile(r){
  const key = rowKey(r);
  const picked = state.slip.some(s => s.key === key);
  const odds = r.odds != null ? (r.odds > 0 ? `+${r.odds}` : `${r.odds}`) : "—";

  const heat = heatClassEdge(r.edge);
  const heatText = r.edge != null ? `${r.edge.toFixed(2)}%` : "—";

  const signal = toNumber(r.signal_score) ?? 0;
  const label = r.signal_label || "";

  // flash class if moved
  const flash = r.moveDir === -1 ? "flashUp" : r.moveDir === +1 ? "flashDown" : "";

  return `
    <div class="oddBtn ${picked ? "picked" : ""} ${flash}" data-pick="${esc(key)}" title="${esc(label)} • Signal ${signal}">
      <div class="oddTop">
        <div class="mkt">${esc(safeUpper(r.market))}</div>
        <div class="odds">${esc(odds)}</div>
      </div>
      <div class="oddMid">
        <div class="lineTxt">${esc(String(r.line ?? ""))}</div>
        <div class="heat ${heat}">${esc(heatText)}</div>
      </div>
      <div class="small">Signal ${esc(signal)} • ${esc(label)}</div>
    </div>
  `;
}

function renderWatchlist(){
  const box = el("watchlist");
  if (!box) return;

  const top = [...state.filtered]
    .sort((a,b)=> (toNumber(b.signal_score)??0) - (toNumber(a.signal_score)??0))
    .slice(0,5);

  if (!top.length){
    box.innerHTML = `<div class="small">No watchlist yet.</div>`;
    return;
  }

  box.innerHTML = top.map(r => {
    const sig = toNumber(r.signal_score) ?? 0;
    const cls = sig >= 70 ? "good" : sig >= 55 ? "warn" : "bad";
    return `
      <div class="li">
        <div class="a">${esc(r.matchup)}</div>
        <div class="b ${cls}">${esc(sig)}</div>
      </div>
    `;
  }).join("");
}

function renderRisk(){
  const { score, label, ev } = calcSlipRisk();

  el("riskScore").textContent = `${score} • ${label}`;
  el("riskMode").textContent = state.mode.toUpperCase();
  el("riskPicks").textContent = String(state.slip.length);
  el("riskEv").textContent = ev != null ? fmtMoney(ev) : "—";

  // bar width (0–100)
  el("riskBar").style.width = `${Math.max(5, Math.min(100, score))}%`;

  // AI text (lightweight “brain” copy)
  const picks = state.slip.length;
  let text = "Watching slate for steam + signal spikes. Build a slip and I’ll grade it (risk, EV, volatility).";

  if (picks){
    const avgSig = Math.round(state.slip.reduce((a,p)=>a+(toNumber(p.signal_score)??0),0)/picks);
    const steam = state.slip.filter(p=>p.steam||p.steam_detected).length;
    if (state.mode === "parlay"){
      text = `Parlay armed: ${picks} legs • avg signal ${avgSig}. ${steam ? `Steam legs: ${steam}.` : ""} Risk score ${score}. If EV is negative, trim legs with lowest signal/edge first.`;
    } else {
      text = `Singles armed: ${picks} picks • avg signal ${avgSig}. ${steam ? `Steam flags: ${steam}.` : ""} Risk score ${score}. Consider staking heavier on highest signal + edge combos.`;
    }
  }

  el("aiText").textContent = text;

  // drawer KPIs
  el("drawerCount").textContent = String(state.slip.length);
  el("drawerMode").textContent = state.mode.toUpperCase();
  el("kpiSlip").textContent = String(state.slip.length);
}

function renderAll(){
  renderSportOptions();
  updateKpis();
  renderSlate();
  renderWatchlist();
  renderRisk();
  setStatus();
}

// ---------- Slip ----------
function togglePickByKey(key, btnEl){
  const idx = state.slip.findIndex(s => s.key === key);
  if (idx >= 0){
    state.slip.splice(idx, 1);
  } else {
    const row = state.filtered.find(r => rowKey(r) === key);
    if (row) state.slip.push({ ...row, key });
  }
  applyFilters();
  renderAll();
  setTicker(buildTickerText());
}

function clearSlip(){
  state.slip = [];
  renderAll();
  setTicker(buildTickerText());
}

// ---------- Export ----------
function exportCsv(){
  const rows = state.filtered;
  if (!rows.length){
    setTicker("Nothing to export • board is empty.");
    return;
  }

  const headers = [
    "sport","start","matchup","market","line","odds","book",
    "edge","signal_score","signal_label","steam"
  ];

  const csv = [
    headers.join(","),
    ...rows.map(r => headers.map(h => {
      let v;
      if (h === "steam") v = (r.steam || r.steam_detected) ? "true" : "false";
      else v = r[h];
      const s = String(v ?? "");
      // quote if commas
      return s.includes(",") ? `"${s.replaceAll('"','""')}"` : s;
    }).join(","))
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `starks_board_${new Date().toISOString().slice(0,19).replaceAll(":","-")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setTicker("Exported CSV from current filtered board.");
}

// ---------- Simulate Ticket ----------
function simulateTicket(){
  const stake = Math.max(1, toNumber(state.stake) ?? 25);
  const picks = state.slip;

  if (!picks.length){
    setTicker("Slip empty • add picks first.");
    return;
  }

  let cost = 0;
  if (state.mode === "single") cost = stake * picks.length;
  else cost = stake;

  if ((toNumber(state.bankroll) ?? 0) < cost){
    setTicker("Insufficient bankroll for this ticket.");
    return;
  }

  state.bankroll = Math.max(0, (toNumber(state.bankroll) ?? 0) - cost);
  renderAll();
  setTicker(`Ticket simulated • Cost ${fmtMoney(cost)} • Bankroll now ${fmtMoney(state.bankroll)}`);
}

// ---------- Slip Modal ----------
function openSlipModal(){
  const modal = el("slipModal");
  const body = el("slipBody");
  if (!modal || !body) return;

  const stake = Math.max(1, toNumber(state.stake) ?? 25);
  const picks = state.slip;

  if (!picks.length){
    body.innerHTML = "Slip is empty.";
    modal.showModal();
    return;
  }

  let html = `<div style="margin-bottom:10px;"><b>Mode:</b> ${esc(state.mode.toUpperCase())} • <b>Picks:</b> ${picks.length} • <b>Stake:</b> ${fmtMoney(stake)}</div>`;

  if (state.mode === "single"){
    let sumEv = 0;
    let any = false;
    html += picks.map(p => {
      const dec = p.dec;
      const mp = p.modelP;
      const ev = (dec != null && mp != null) ? (stake * (dec * mp - 1)) : null;
      if (ev != null){ sumEv += ev; any = true; }
      return `
        <div style="padding:10px; border:1px solid rgba(255,255,255,.10); border-radius:14px; background:rgba(255,255,255,.05); margin-bottom:8px;">
          <div style="font-weight:900">${esc(p.matchup)}</div>
          <div style="opacity:.75; font-size:12px;">${esc(p.market)} • ${esc(p.line)} • <b>${esc(p.odds)}</b> • ${esc(p.book)}</div>
          <div style="opacity:.75; font-size:12px;">Edge: <b>${esc((p.edge??0).toFixed(2))}%</b> • Signal: <b>${esc(String(p.signal_score??0))}</b></div>
          <div style="font-weight:950; margin-top:6px;">EV (profit): ${ev != null ? fmtMoney(ev) : "—"}</div>
        </div>
      `;
    }).join("");

    html += `<div style="margin-top:10px; font-weight:950;">Estimated Total EV: ${any ? fmtMoney(sumEv) : "—"}</div>`;
  } else {
    const par = computeParlay(stake, picks);
    html += picks.map(p => `
      <div style="padding:10px; border:1px solid rgba(255,255,255,.10); border-radius:14px; background:rgba(255,255,255,.05); margin-bottom:8px;">
        <div style="font-weight:900">${esc(p.matchup)}</div>
        <div style="opacity:.75; font-size:12px;">${esc(p.market)} • ${esc(p.line)} • <b>${esc(p.odds)}</b> • ${esc(p.book)}</div>
        <div style="opacity:.75; font-size:12px;">Edge: <b>${esc((p.edge??0).toFixed(2))}%</b> • Signal: <b>${esc(String(p.signal_score??0))}</b></div>
      </div>
    `).join("");

    html += `
      <div style="margin-top:10px; padding:10px; border:1px solid rgba(255,255,255,.10); border-radius:14px; background:rgba(0,0,0,.20)">
        <div><b>Parlay Decimal:</b> ${par.dec != null ? par.dec.toFixed(3) : "—"}</div>
        <div><b>To Win:</b> ${par.toWin != null ? fmtMoney(par.toWin) : "—"}</div>
        <div><b>EV (profit):</b> ${par.ev != null ? fmtMoney(par.ev) : "—"}</div>
      </div>
    `;
  }

  body.innerHTML = html;
  modal.showModal();
}

// ---------- Demo ----------
function loadDemo(){
  let demo = [
    { sport:"NCAAB", start:"02/18, 10:18 PM", matchup:"KANSAS @ BAYLOR", market:"ML", line:"KANSAS", odds:-135, book:"DraftKings", edge:3.12, signal_score:72, signal_label:"SHARP WATCH", steam_detected:true },
    { sport:"NBA", start:"02/18, 8:57 PM", matchup:"BOS @ MIA", market:"SPREAD", line:"BOS -2.5", odds:-110, book:"Circa", edge:1.42, signal_score:19, signal_label:"NOISE", steam_detected:false },
    { sport:"NFL", start:"02/18, 10:37 PM", matchup:"KC @ CIN", market:"TOTAL", line:"O 47.5", odds:-108, book:"FanDuel", edge:1.61, signal_score:55, signal_label:"INTEREST", steam_detected:true },
  ].map(normalizeRow);

  demo = applyDemoDrift(demo);
  updateMovement(demo);

  state.backendOk = true;
  state.rows = demo;
  state.lastUpdated = Date.now();
  applyFilters();
  renderAll();
  setTicker("DEMO MODE • Vegas skin online • Click odds tiles to build slip.");
}

// ---------- UI Bind ----------
function bindUI(){
  // buttons
  el("btnPing")?.addEventListener("click", async () => { await pingBackend(); setStatus(); setTicker(buildTickerText()); });
  el("btnReload")?.addEventListener("click", () => loadBoard());
  el("btnDemo")?.addEventListener("click", () => loadDemo());
  el("btnExport")?.addEventListener("click", () => exportCsv());
  el("btnClearSlip")?.addEventListener("click", () => clearSlip());
  el("btnSim")?.addEventListener("click", () => simulateTicket());
  el("btnOpenSlip")?.addEventListener("click", () => openSlipModal());

  el("drawerOpen")?.addEventListener("click", () => openSlipModal());

  el("btnCloseSlip")?.addEventListener("click", () => {
    const modal = el("slipModal");
    modal?.close();
  });

  // mode chips
  document.querySelectorAll("[data-mode]").forEach(ch => {
    ch.addEventListener("click", () => {
      document.querySelectorAll("[data-mode]").forEach(x => x.classList.remove("active"));
      ch.classList.add("active");
      state.mode = ch.getAttribute("data-mode") || "single";
      renderRisk();
      updateKpis();
      setTicker(buildTickerText());
    });
  });

  // tabs
  document.querySelectorAll("[data-tab]").forEach(t => {
    t.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      state.activeTab = t.getAttribute("data-tab");
      // For Phase B: tabs are aesthetic; later we’ll wire real views.
      setTicker(`Tab: ${state.activeTab.toUpperCase()} • (Phase C wires AI deep scan + performance history)`);
    });
  });

  // left nav (aesthetic for now)
  document.querySelectorAll("[data-nav]").forEach(n => {
    n.addEventListener("click", () => {
      document.querySelectorAll("[data-nav]").forEach(x => x.classList.remove("active"));
      n.classList.add("active");
      state.activeNav = n.getAttribute("data-nav");
      setTicker(`Nav: ${safeUpper(state.activeNav)} • (Phase C expands modules)`);
    });
  });

  // filters
  el("sportFilter")?.addEventListener("change", (e) => {
    state.filters.sport = e.target.value || "ALL";
    applyFilters(); renderAll(); setTicker(buildTickerText());
  });

  el("search")?.addEventListener("input", (e) => {
    state.filters.q = e.target.value || "";
    applyFilters(); renderAll(); setTicker(buildTickerText());
  });

  el("minEdge")?.addEventListener("change", (e) => {
    state.filters.minEdge = toNumber(e.target.value) ?? 0;
    applyFilters(); renderAll(); setTicker(buildTickerText());
  });

  el("minSignal")?.addEventListener("change", (e) => {
    state.filters.minSignal = toNumber(e.target.value) ?? 0;
    applyFilters(); renderAll(); setTicker(buildTickerText());
  });

  el("sortBy")?.addEventListener("change", (e) => {
    state.filters.sort = e.target.value || "signal_desc";
    applyFilters(); renderAll(); setTicker(buildTickerText());
  });

  // stake/bankroll
  el("stake")?.addEventListener("change", (e) => {
    state.stake = Math.max(1, toNumber(e.target.value) ?? 25);
    renderRisk(); setTicker(buildTickerText());
  });

  el("bankroll")?.addEventListener("change", (e) => {
    state.bankroll = Math.max(0, toNumber(e.target.value) ?? 10000);
    renderRisk(); setTicker(buildTickerText());
  });
}

// ---------- Boot ----------
async function boot(){
  bindUI();
  await loadBoard();
  setInterval(loadBoard, REFRESH_MS);
}

boot();
