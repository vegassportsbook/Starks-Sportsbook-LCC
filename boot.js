console.log("BOOT FILE LOADED — HYBRID SPORTSBOOK UI");

const API_BASE = "https://starks-backend-m4tl.onrender.com";
const REFRESH_MS = 15000;

// Visual demo drift (keeps your “alive” feel)
const DEMO_DRIFT_ENABLED = true;
const DRIFT_MAX_POINTS = 6;
const DRIFT_CHANCE = 0.70;

const STEAM_WINDOW = 4;
const STEAM_MIN_STREAK = 2;

const app = document.getElementById("app");

// ---------- Helpers ----------
function toNumber(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }
function esc(s){
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function americanToDecimal(a){
  const n = toNumber(a);
  if (n === null || n === 0) return null;
  if (n > 0) return 1 + (n/100);
  return 1 + (100/Math.abs(n));
}
function americanToImpliedProb(a){
  const n = toNumber(a);
  if (n === null || n === 0) return null;
  if (n > 0) return 100/(n+100);
  return Math.abs(n)/(Math.abs(n)+100);
}
function fmtMoney(n){
  if (!Number.isFinite(n)) return "—";
  return "$" + n.toFixed(2);
}
function fmtPct(p){
  if (p === null) return "—";
  return (p*100).toFixed(1) + "%";
}

function rowKey(r){
  return [r.sport, r.start, r.matchup, r.market, r.line, r.book]
    .map(x => String(x ?? "")).join("|");
}

function signalTier(score){
  const s = toNumber(score) ?? 0;
  if (s >= 81) return {cls:"sigElite", short:"ELITE"};
  if (s >= 61) return {cls:"sigSharp", short:"SHARP"};
  if (s >= 31) return {cls:"sigInt", short:"INT"};
  return {cls:"sigNoise", short:"NOISE"};
}

// ---------- State ----------
let state = {
  backendOk: false,
  lastUpdated: null,

  rows: [],
  grouped: [],

  // movement memory
  previousOddsMap: {},
  moveHistoryMap: {},
  lastMoveTick: [],

  // filters/sort
  sport: "ALL",
  search: "",
  minEdge: 0,
  minSignal: 0,
  steamOnly: false,
  sortMode: "signal", // signal | edge | start

  // slip
  mode: "parlay", // parlay | single
  stake: 25,
  bankroll: 10000,
  slip: [],

  // performance
  perf: {
    total_tickets: 0,
    settled_tickets: 0,
    wins: 0,
    losses: 0,
    winrate: 0,
    profit: 0,
    cost: 0,
    roi: 0,
    profit_30d: 0
  },

  ticker: "STARKS Edge OS • Hybrid Sportsbook + Risk Desk • Loading…"
};

// ---------- Normalization ----------
function normalizeRow(r){
  const odds = toNumber(r.odds);
  const edge = toNumber(r.edge);
  const signal = toNumber(r.signal_score) ?? 0;

  const impliedP = odds != null ? americanToImpliedProb(odds) : null;
  const dec = odds != null ? americanToDecimal(odds) : null;

  const modelP = (impliedP != null && edge != null)
    ? Math.max(0, Math.min(1, impliedP + (edge/100)))
    : null;

  return {
    ...r,
    odds,
    edge,
    signal_score: signal,
    impliedP,
    modelP,
    dec,

    // movement UI
    previousOdds: null,
    moveDir: 0,      // -1 better / +1 worse
    steam: false
  };
}

// ---------- Demo drift ----------
function applyDemoDrift(rows){
  if (!DEMO_DRIFT_ENABLED) return rows;
  return rows.map(r => {
    if (r.odds == null) return r;
    if (Math.random() > DRIFT_CHANCE) return r;

    const magnitude = Math.floor(Math.random() * DRIFT_MAX_POINTS) + 1;
    const direction = Math.random() > 0.5 ? 1 : -1;

    let next = r.odds;

    if (next < 0) next = next + (direction * -magnitude);
    else next = next + (direction * magnitude);

    if (next > 500) next = 500;
    if (next < -500) next = -500;
    if (next === 0) next = r.odds;

    return { ...r, odds: next };
  });
}

// ---------- Movement + steam ----------
function updateMovement(rows){
  const tickerEvents = [];

  rows.forEach(r => {
    const key = rowKey(r);
    const prev = state.previousOddsMap[key];

    r.previousOdds = prev ?? null;
    r.moveDir = 0;

    if (r.odds != null && prev != null && r.odds !== prev){
      const better =
        (prev < 0 && r.odds > prev) ||  // -110 -> -108
        (prev > 0 && r.odds > prev);    // +135 -> +140

      r.moveDir = better ? -1 : +1;

      const arrow = better ? "▼" : "▲";
      tickerEvents.push(`${r.matchup} ${prev} → ${r.odds} ${arrow} (${r.book || "Book"})`);

      if (!state.moveHistoryMap[key]) state.moveHistoryMap[key] = [];
      state.moveHistoryMap[key].push(r.moveDir);
      if (state.moveHistoryMap[key].length > STEAM_WINDOW) state.moveHistoryMap[key].shift();

      const hist = state.moveHistoryMap[key];
      const last = hist[hist.length - 1];
      let streak = 1;
      for (let i = hist.length - 2; i >= 0; i--){
        if (hist[i] === last) streak++;
        else break;
      }
      r.steam = streak >= STEAM_MIN_STREAK;
    } else {
      r.steam = false;
      if (state.moveHistoryMap[key] && state.moveHistoryMap[key].length > STEAM_WINDOW){
        state.moveHistoryMap[key] = state.moveHistoryMap[key].slice(-STEAM_WINDOW);
      }
    }

    if (r.odds != null) state.previousOddsMap[key] = r.odds;
  });

  if (tickerEvents.length){
    state.lastMoveTick = [...tickerEvents, ...state.lastMoveTick].slice(0, 10);
  }
}

// ---------- Group slate like sportsbook ----------
function buildSlate(rows){
  // group by sport -> matchup/start
  const bySport = new Map();

  for (const r of rows){
    const sport = r.sport || "OTHER";
    const gKey = `${sport}|${r.start || ""}|${r.matchup || ""}`;

    if (!bySport.has(sport)) bySport.set(sport, new Map());
    const m = bySport.get(sport);

    if (!m.has(gKey)){
      m.set(gKey, {
        sport,
        start: r.start,
        matchup: r.matchup,
        markets: []
      });
    }
    m.get(gKey).markets.push(r);
  }

  // convert to arrays, sort markets (ML, SPREAD, TOTAL)
  const sportBlocks = [];
  for (const [sport, gamesMap] of bySport.entries()){
    const games = Array.from(gamesMap.values()).map(g => {
      g.markets.sort((a,b) => {
        const order = (x) => x.market === "ML" ? 0 : x.market === "SPREAD" ? 1 : x.market === "TOTAL" ? 2 : 9;
        return order(a) - order(b);
      });
      return g;
    });

    // sort games by best signal in game (desc)
    games.sort((a,b) => {
      const aTop = Math.max(...a.markets.map(x => toNumber(x.signal_score) ?? 0));
      const bTop = Math.max(...b.markets.map(x => toNumber(x.signal_score) ?? 0));
      return bTop - aTop;
    });

    sportBlocks.push({ sport, games });
  }

  // sport order
  const sportOrder = ["NBA","NCAAB","NFL","MLB","NHL"];
  sportBlocks.sort((a,b) => {
    const ia = sportOrder.indexOf(a.sport);
    const ib = sportOrder.indexOf(b.sport);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  return sportBlocks;
}

// ---------- Filters/sorting pipeline ----------
function applyFilters(rows){
  let out = rows.slice();

  if (state.sport !== "ALL"){
    out = out.filter(r => (r.sport || "") === state.sport);
  }

  const q = state.search.trim().toLowerCase();
  if (q){
    out = out.filter(r => String(r.matchup || "").toLowerCase().includes(q) ||
                          String(r.book || "").toLowerCase().includes(q) ||
                          String(r.market || "").toLowerCase().includes(q));
  }

  out = out.filter(r => (toNumber(r.edge) ?? 0) >= (toNumber(state.minEdge) ?? 0));
  out = out.filter(r => (toNumber(r.signal_score) ?? 0) >= (toNumber(state.minSignal) ?? 0));

  if (state.steamOnly){
    out = out.filter(r => !!(r.steam_detected || r.steam));
  }

  // sort rows
  if (state.sortMode === "edge"){
    out.sort((a,b) => (toNumber(b.edge) ?? 0) - (toNumber(a.edge) ?? 0));
  } else if (state.sortMode === "start"){
    out.sort((a,b) => String(a.start||"").localeCompare(String(b.start||"")));
  } else {
    out.sort((a,b) => (toNumber(b.signal_score) ?? 0) - (toNumber(a.signal_score) ?? 0));
  }

  return out;
}

// ---------- Backend calls ----------
async function pingBackend(){
  try{
    const res = await fetch(`${API_BASE}/`);
    const data = await res.json();
    state.backendOk = !!data.ok;
  } catch {
    state.backendOk = false;
  }
}

async function loadPerformance(){
  try{
    const res = await fetch(`${API_BASE}/api/performance`);
    const data = await res.json();
    if (data?.ok) state.perf = data;
  } catch {}
}

async function loadBoard(){
  await pingBackend();

  if (!state.backendOk){
    state.rows = [];
    state.grouped = [];
    state.lastUpdated = Date.now();
    state.ticker = "Backend not reachable • check Render • try Reload";
    render();
    return;
  }

  try{
    const res = await fetch(`${API_BASE}/api/board`);
    const data = await res.json();

    let rows = Array.isArray(data.rows) ? data.rows.map(normalizeRow) : [];
    rows = applyDemoDrift(rows);
    updateMovement(rows);

    // apply filters/sort then group to slate blocks
    const filtered = applyFilters(rows);
    state.rows = filtered;
    state.grouped = buildSlate(filtered);

    state.lastUpdated = Date.now();
    state.ticker = `EDGE OS LIVE • ${filtered.length} markets • ${state.mode.toUpperCase()} slip • Sort: ${state.sortMode.toUpperCase()} • 🔥 Steam active`;

    // keep slip synced
    const currentKeys = new Set(rows.map(rowKey));
    state.slip = state.slip.filter(s => currentKeys.has(s.key));

    state.slip = state.slip.map(s => {
      const match = rows.find(r => rowKey(r) === s.key);
      return match ? { ...normalizeRow(match), key: s.key } : s;
    });

    await loadPerformance();
    render();
  } catch (err){
    console.error(err);
    state.rows = [];
    state.grouped = [];
    state.lastUpdated = Date.now();
    state.ticker = "Board fetch failed • check /api/board";
    render();
  }
}

// ---------- Slip logic ----------
function addToSlip(row){
  const key = rowKey(row);
  const idx = state.slip.findIndex(x => x.key === key);
  if (idx >= 0){
    state.slip.splice(idx, 1);
    state.ticker = "Removed pick from slip.";
  } else {
    state.slip.push({ ...normalizeRow(row), key });
    state.ticker = "Added pick to slip.";
  }
  render();
}

function clearSlip(){
  state.slip = [];
  state.ticker = "Slip cleared.";
  render();
}

function computeParlay(stake, picks){
  let dec = 1, implied=1, model=1;
  let anyDec=false, anyImp=false, anyModel=false;

  for (const p of picks){
    if (p.dec != null){ dec *= p.dec; anyDec=true; }
    if (p.impliedP != null){ implied *= p.impliedP; anyImp=true; }
    if (p.modelP != null){ model *= p.modelP; anyModel=true; }
  }

  const decimal = anyDec ? dec : null;
  const impliedP = anyImp ? implied : null;
  const modelP = anyModel ? model : null;
  const cost = stake;
  const toWin = decimal != null ? stake * decimal : null;
  const ev = (decimal != null && modelP != null) ? (stake * (decimal * modelP - 1)) : null;
  const edgeDelta = (impliedP != null && modelP != null) ? (modelP - impliedP) : null;

  return { decimal, impliedP, modelP, cost, toWin, ev, edgeDelta };
}

async function logTicket(){
  if (!state.slip.length) return;

  const stake = Math.max(1, toNumber(state.stake) ?? 25);
  const bankroll = Math.max(0, toNumber(state.bankroll) ?? 10000);

  // build legs payload (use normalized slip entries)
  const legs = state.slip.map(p => ({
    sport: p.sport,
    start: p.start,
    matchup: p.matchup,
    market: p.market,
    line: String(p.line ?? ""),
    odds: p.odds,
    book: p.book,
    edge: p.edge,
    signal_score: p.signal_score,
    signal_label: p.signal_label,
    steam_detected: !!p.steam_detected
  }));

  const payload = {
    mode: state.mode,
    stake,
    bankroll,
    legs,
    meta: {
      source: "EdgeOS",
      sortMode: state.sortMode,
      filters: {
        sport: state.sport,
        minEdge: state.minEdge,
        minSignal: state.minSignal,
        steamOnly: state.steamOnly
      }
    }
  };

  try{
    const res = await fetch(`${API_BASE}/api/tickets`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data?.ok){
      state.ticker = `Ticket logged ✅ (${data.created_ticket_ids.length} ticket(s))`;
      await loadPerformance();
    } else {
      state.ticker = `Ticket log failed: ${data?.error || "unknown"}`;
    }
  } catch(e){
    state.ticker = "Ticket log failed • backend unreachable";
  }

  render();
}

// CSV export
function downloadText(filename, content){
  const blob = new Blob([content], {type:"text/plain;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportSlipCSV(){
  if (!state.slip.length) return;
  const cols = ["sport","start","matchup","market","line","odds","book","edge","signal_score","signal_label","steam_detected"];
  const lines = [cols.join(",")];
  for (const p of state.slip){
    const row = cols.map(c => {
      const v = p[c];
      const s = (v === null || v === undefined) ? "" : String(v);
      return `"${s.replaceAll('"','""')}"`;
    });
    lines.push(row.join(","));
  }
  downloadText(`starks_slip_${Date.now()}.csv`, lines.join("\n"));
  state.ticker = "Slip exported CSV ✅";
  render();
}

async function exportTicketsCSV(){
  try{
    const res = await fetch(`${API_BASE}/api/tickets?limit=200`);
    const data = await res.json();
    if (!data?.ok) return;

    const cols = ["ticket_id","created_at","mode","stake","cost","decimal_odds","implied_prob","model_prob","ev_profit","status","result","profit"];
    const lines = [cols.join(",")];

    for (const t of data.tickets){
      const row = [
        t.id, t.created_at, t.mode, t.stake, t.cost,
        t.decimal_odds ?? "", t.implied_prob ?? "", t.model_prob ?? "", t.ev_profit ?? "",
        t.status, t.result ?? "", t.profit ?? ""
      ].map(x => `"${String(x).replaceAll('"','""')}"`);
      lines.push(row.join(","));
    }

    downloadText(`starks_tickets_${Date.now()}.csv`, lines.join("\n"));
    state.ticker = "Ticket history exported CSV ✅";
    render();
  } catch {}
}

// ---------- UI ----------
function render(){
  const last = state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString() : "—";
  const dotCls = state.backendOk ? "dot ok" : "dot";

  const sportSet = new Set(state.rows.map(r => r.sport).filter(Boolean));
  const sportOptions = ["ALL", ...Array.from(sportSet).sort()];

  // performance
  const p = state.perf || {};
  const roiPct = (toNumber(p.roi) ?? 0) * 100;
  const wrPct = (toNumber(p.winrate) ?? 0) * 100;

  // slip stats
  const stake = Math.max(1, toNumber(state.stake) ?? 25);
  const slipCount = state.slip.length;

  let slipSummary = "";
  if (!slipCount){
    slipSummary = `<div class="kv"><span>Slip</span><b>Empty</b></div>`;
  } else if (state.mode === "parlay"){
    const par = computeParlay(stake, state.slip);
    slipSummary = `
      <div class="kv"><span>Slip</span><b>${slipCount} legs</b></div>
      <div class="kv"><span>Parlay Decimal</span><b>${par.decimal ? par.decimal.toFixed(3) : "—"}</b></div>
      <div class="kv"><span>Implied</span><b>${par.impliedP != null ? fmtPct(par.impliedP) : "—"}</b></div>
      <div class="kv"><span>Model</span><b>${par.modelP != null ? fmtPct(par.modelP) : "—"}</b></div>
      <div class="kv"><span>EV</span><b>${par.ev != null ? fmtMoney(par.ev) : "—"}</b></div>
    `;
  } else {
    slipSummary = `
      <div class="kv"><span>Slip</span><b>${slipCount} singles</b></div>
      <div class="kv"><span>Stake / ticket</span><b>${fmtMoney(stake)}</b></div>
    `;
  }

  app.innerHTML = `
    <div class="app">
      <div class="rail">
        <div class="logo">
          <div class="logoDot"></div>
          <div class="logoTxt">STARKS<br/>EDGE OS</div>
        </div>
        <div class="railNav">
          <div class="navBtn active" data-nav="today"><div class="navIco">🏟️</div></div>
          <div class="navBtn" data-nav="live"><div class="navIco">⚡</div></div>
          <div class="navBtn" data-nav="lab"><div class="navIco">📈</div></div>
          <div class="navBtn" data-nav="settings"><div class="navIco">⚙️</div></div>
        </div>
      </div>

      <div class="main">
        <div class="top">
          <div class="hero">
            <div class="heroIn">
              <div>
                <div class="heroTitle">Starks Sportsbook LLC — Hybrid Intelligence Terminal</div>
                <div class="heroSub">Euro sportsbook slate + Vegas risk desk • Edge Tracker • AI Brain • Mobile-ready</div>
              </div>
              <div class="chips">
                <div class="chip"><div class="${dotCls}"></div>${state.backendOk ? "Backend OK" : "Backend Issue"}</div>
                <div class="chip">Last <b style="color:var(--text)">${esc(last)}</b></div>
                <div class="chip">Auto <b style="color:var(--text)">${Math.round(REFRESH_MS/1000)}s</b></div>
                <div class="chip">Mode <b style="color:var(--text)">${esc(state.mode.toUpperCase())}</b></div>
              </div>
            </div>
          </div>
        </div>

        <!-- CENTER: BOARD -->
        <div class="panel">
          <div class="panelHd">
            <div>
              <div class="panelTitle">TODAY'S SLATE</div>
              <div class="panelSub">Grouped by sport • click odds tiles to build slip • sorted by ${esc(state.sortMode.toUpperCase())}</div>
            </div>
            <div class="btnRow">
              <button class="btn" id="btnReload">Reload</button>
              <button class="btn" id="btnExportTickets">Export Tickets CSV</button>
            </div>
          </div>
          <div class="panelBd">
            <div class="controls">
              <div class="field">
                <div class="label">Sport</div>
                <select class="select" id="sportSel">
                  ${sportOptions.map(s => `<option value="${esc(s)}" ${s===state.sport ? "selected":""}>${esc(s)}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <div class="label">Search</div>
                <input class="input" id="search" placeholder="Team, matchup, book…" value="${esc(state.search)}" />
              </div>

              <div class="field">
                <div class="label">Min Edge %</div>
                <input class="input" id="minEdge" type="number" step="0.1" value="${esc(state.minEdge)}" />
              </div>
              <div class="field">
                <div class="label">Min Signal</div>
                <input class="input" id="minSignal" type="number" step="1" value="${esc(state.minSignal)}" />
              </div>
            </div>

            <div class="pillRow">
              <div class="pill ${state.steamOnly ? "active":""}" id="steamOnly">🔥 Steam Only</div>
              <div class="pill ${state.sortMode==="signal" ? "active":""}" data-sort="signal">Sort: Signal</div>
              <div class="pill ${state.sortMode==="edge" ? "active":""}" data-sort="edge">Sort: Edge</div>
              <div class="pill ${state.sortMode==="start" ? "active":""}" data-sort="start">Sort: Start</div>
            </div>

            <div class="hr"></div>

            <div class="slate">
              ${state.grouped.length ? state.grouped.map(block => {
                const games = block.games || [];
                return `
                  <div class="league">
                    <div class="leagueHd">
                      <div class="leagueName">${esc(block.sport)}</div>
                      <div class="leagueMeta">${games.length} games • ${state.rows.filter(r => r.sport===block.sport).length} markets</div>
                    </div>
                    ${games.map(g => {
                      // top tags from best market
                      const bestSig = Math.max(...g.markets.map(m => toNumber(m.signal_score) ?? 0));
                      const bestEdge = Math.max(...g.markets.map(m => toNumber(m.edge) ?? 0));
                      const tier = signalTier(bestSig);

                      const tagSig = bestSig >= 81 ? "good" : bestSig >= 61 ? "good" : bestSig >= 31 ? "warn" : "";
                      const tagEdge = bestEdge >= 3 ? "good" : bestEdge >= 2 ? "warn" : "bad";

                      return `
                        <div class="game">
                          <div class="gLeft">
                            <div class="mu">${esc(g.matchup || "—")}</div>
                            <div class="sub">
                              <span>${esc(g.start || "—")}</span>
                              <span class="tag ${tagEdge}">Edge max ${bestEdge.toFixed(2)}%</span>
                              <span class="tag ${tagSig}">Signal max ${bestSig}</span>
                            </div>
                          </div>
                          <div class="tileRow">
                            ${g.markets.map(m => {
                              const s = toNumber(m.signal_score) ?? 0;
                              const t = signalTier(s);
                              const steamOn = !!(m.steam_detected || m.steam);
                              const flash = (m.moveDir === -1) ? "flashUp" : (m.moveDir === +1) ? "flashDown" : "";
                              const pillCls = `${t.cls} sigPill`;

                              return `
                                <div class="tile ${flash}" data-pick="${esc(rowKey(m))}">
                                  <div class="tTop">
                                    <span><b>${esc(m.market || "")}</b></span>
                                    <span class="${pillCls}">${esc(t.short)} ${esc(String(s))}${steamOn ? " 🔥" : ""}</span>
                                  </div>
                                  <div class="tMid">
                                    <span class="ln">${esc(String(m.line ?? ""))}</span>
                                    <span class="od">${esc(String(m.odds ?? ""))}</span>
                                  </div>
                                  <div class="tBot">
                                    <span>${esc(m.book || "—")}</span>
                                    <span>Edge ${esc(String(m.edge ?? "—"))}%</span>
                                  </div>
                                </div>
                              `;
                            }).join("")}
                          </div>
                        </div>
                      `;
                    }).join("")}
                  </div>
                `;
              }).join("") : `
                <div style="color:rgba(234,240,255,.65); padding:10px;">
                  No markets match your filters.
                </div>
              `}
            </div>

            <div class="ticker">
              ${esc(state.ticker)}
              ${state.lastMoveTick.length ? "<br/>MOVES: " + esc(state.lastMoveTick.join(" • ")) : ""}
            </div>
          </div>
        </div>

        <!-- RIGHT: AI / RISK -->
        <div class="panel">
          <div class="panelHd">
            <div>
              <div class="panelTitle">AI BRAIN + RISK ROOM</div>
              <div class="panelSub">Slip builder • ticket logging • performance lab</div>
            </div>
            <div class="btnRow">
              <button class="btn" id="btnExportSlip">Export Slip CSV</button>
              <button class="btn danger" id="btnClearSlip">Clear</button>
            </div>
          </div>

          <div class="panelBd">
            <div class="stack">
              <div class="kv"><span>Performance (30-day lab)</span><b>${fmtMoney(toNumber(p.profit_30d) ?? 0)}</b></div>
              <div class="kv"><span>Total tickets</span><b>${esc(String(p.total_tickets ?? 0))}</b></div>
              <div class="kv"><span>Win rate</span><b>${wrPct.toFixed(1)}%</b></div>
              <div class="kv"><span>ROI</span><b>${roiPct.toFixed(2)}%</b></div>

              <div class="hr"></div>

              <div class="row2">
                <div class="field" style="flex:1">
                  <div class="label">Mode</div>
                  <select class="select" id="modeSel">
                    <option value="parlay" ${state.mode==="parlay"?"selected":""}>PARLAY</option>
                    <option value="single" ${state.mode==="single"?"selected":""}>SINGLES</option>
                  </select>
                </div>
                <div class="field" style="flex:1">
                  <div class="label">Stake</div>
                  <input class="input" id="stake" type="number" min="1" step="1" value="${esc(state.stake)}" />
                </div>
              </div>

              <div class="field">
                <div class="label">Bankroll</div>
                <input class="input" id="bankroll" type="number" min="0" step="1" value="${esc(state.bankroll)}" />
              </div>

              ${slipSummary}

              <div class="btnRow">
                <button class="btn primary" id="btnLog">Log Ticket</button>
                <button class="btn" id="btnRefreshPerf">Refresh Perf</button>
              </div>

              <div class="hr"></div>

              <div class="panelTitle" style="margin-bottom:8px;">Slip Legs</div>
              ${state.slip.length ? state.slip.map(p => {
                const s = toNumber(p.signal_score) ?? 0;
                const t = signalTier(s);
                return `
                  <div class="kv" style="align-items:flex-start;">
                    <span>
                      <b style="color:var(--text)">${esc(p.matchup || "")}</b><br/>
                      <span style="color:var(--muted2)">${esc(p.market || "")} • ${esc(String(p.line ?? ""))} • ${esc(String(p.odds ?? ""))} • ${esc(p.book || "—")}</span>
                    </span>
                    <b class="${t.cls}" style="padding:2px 8px; border-radius:999px; border:1px solid rgba(255,255,255,.12); background: rgba(0,0,0,.20);">
                      ${esc(t.short)} ${esc(String(s))}
                    </b>
                  </div>
                `;
              }).join("") : `<div style="color:rgba(234,240,255,.65)">Slip empty — click odds tiles.</div>`}
            </div>
          </div>
        </div>
      </div>

      <!-- mobile drawer -->
      <div class="drawer">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
          <div style="font-weight:900;">Slip: ${slipCount} ${state.mode==="parlay"?"legs":"singles"}</div>
          <div style="display:flex; gap:8px;">
            <button class="btn primary" id="btnLog2" style="height:38px;">Log</button>
            <button class="btn" id="btnClearSlip2" style="height:38px;">Clear</button>
          </div>
        </div>
        <div style="margin-top:8px; color:rgba(234,240,255,.65); font-size:12px;">
          Tap tiles to add/remove picks • Export and performance are in the right panel on desktop.
        </div>
      </div>
    </div>
  `;

  bindUI();
}

// ---------- Bind UI ----------
function bindUI(){
  document.getElementById("btnReload")?.addEventListener("click", () => loadBoard());
  document.getElementById("btnExportSlip")?.addEventListener("click", () => exportSlipCSV());
  document.getElementById("btnExportTickets")?.addEventListener("click", () => exportTicketsCSV());
  document.getElementById("btnClearSlip")?.addEventListener("click", () => clearSlip());
  document.getElementById("btnClearSlip2")?.addEventListener("click", () => clearSlip());
  document.getElementById("btnLog")?.addEventListener("click", () => logTicket());
  document.getElementById("btnLog2")?.addEventListener("click", () => logTicket());
  document.getElementById("btnRefreshPerf")?.addEventListener("click", async () => { await loadPerformance(); render(); });

  document.getElementById("sportSel")?.addEventListener("change", (e) => {
    state.sport = e.target.value;
    loadBoard();
  });
  document.getElementById("search")?.addEventListener("input", (e) => {
    state.search = e.target.value;
    loadBoard();
  });
  document.getElementById("minEdge")?.addEventListener("change", (e) => {
    state.minEdge = toNumber(e.target.value) ?? 0;
    loadBoard();
  });
  document.getElementById("minSignal")?.addEventListener("change", (e) => {
    state.minSignal = toNumber(e.target.value) ?? 0;
    loadBoard();
  });

  document.getElementById("steamOnly")?.addEventListener("click", () => {
    state.steamOnly = !state.steamOnly;
    loadBoard();
  });

  document.querySelectorAll("[data-sort]")?.forEach(el => {
    el.addEventListener("click", () => {
      state.sortMode = el.getAttribute("data-sort") || "signal";
      loadBoard();
    });
  });

  document.getElementById("modeSel")?.addEventListener("change", (e) => {
    state.mode = e.target.value;
    render();
  });
  document.getElementById("stake")?.addEventListener("change", (e) => {
    state.stake = Math.max(1, toNumber(e.target.value) ?? 25);
    render();
  });
  document.getElementById("bankroll")?.addEventListener("change", (e) => {
    state.bankroll = Math.max(0, toNumber(e.target.value) ?? 10000);
    render();
  });

  // tile click to add/remove
  document.querySelectorAll("[data-pick]")?.forEach(el => {
    el.addEventListener("click", () => {
      const key = el.getAttribute("data-pick");
      const row = state.rows.find(r => rowKey(r) === key);
      if (row) addToSlip(row);
    });
  });
}

// ---------- Boot ----------
async function boot(){
  render();
  await loadBoard();
  setInterval(loadBoard, REFRESH_MS);
}

boot();
