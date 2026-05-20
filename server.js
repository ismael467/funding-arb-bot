const express = require("express");
const cron    = require("node-cron");
const fs      = require("fs");
const path    = require("path");

const app     = express();
const PORT    = process.env.PORT || 3001;
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "daily.json");
const MAX_LOGS = 365;

const ASTER_COMP_URL = "https://www.asterdex.com/bapi/future/v1/public/future/aster/marketing/funding-rate-comparison";
const HL_API         = "https://api.hyperliquid.xyz/info";
const DYDX_API       = "https://indexer.dydx.trade/v4/perpetualMarkets";

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.use(express.json());

// ─── Persistent log (file-backed, falls back to memory on error) ──────────────
function loadLogs() {
  try {
    if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch (e) {
    console.error("[log] Load error:", e.message);
  }
  return [];
}

function saveLogs(logs) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs));
  } catch (e) {
    console.error("[log] Save error:", e.message);
  }
}

let dailyLogs = loadLogs();
console.log(`[server] Loaded ${dailyLogs.length} existing daily logs`);

// ─── Fetch helpers ─────────────────────────────────────────────────────────────
async function fetchAsterComp() {
  const WANT = new Set(["1D", "1M", "1Y"]);
  const extract = j => Array.isArray(j?.data?.details) ? j.data.details : [];

  const first = await fetch(ASTER_COMP_URL).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const batch = extract(first);
  const total = first?.data?.total ?? 0;
  const all   = [...batch];

  if (total > batch.length && batch.length > 0) {
    const ps = batch.length, pages = Math.ceil(total / ps);
    for (let pg = 2; pg <= pages; pg++) {
      try {
        const j = await fetch(`${ASTER_COMP_URL}?pageNum=${pg}&pageSize=${ps}`).then(r => r.json());
        all.push(...extract(j));
      } catch { break; }
    }
  }

  const by = {};
  for (const it of all) {
    if (!it?.pair || !WANT.has(it.period)) continue;
    const sym = it.pair.replace(/USDT$|BUSD$/i, "");
    if (!by[sym]) by[sym] = {};
    by[sym][it.period] = {
      asterBybitComparison: it.asterBybitComparison,
      asterHlComparison:    it.asterHlComparison,
      asterFundingRate:     it.asterFundingRate,
      bybitFundingRate:     it.bybitFundingRate,
    };
  }
  console.log(`[aster] Fetched ${Object.keys(by).length} tokens`);
  return by;
}

async function fetchHL() {
  const json = await fetch(HL_API, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ type: "metaAndAssetCtxs" }),
  }).then(r => r.json());
  const meta = json[0]?.universe || [];
  const ctxs = json[1] || [];
  const map  = {};
  for (let i = 0; i < meta.length; i++) {
    map[meta[i].name] = {
      fundingApr: parseFloat(ctxs[i]?.funding || 0) * 3 * 365 * 100,
      vol24h:     parseFloat(ctxs[i]?.dayNtlVlm || 0),
    };
  }
  return map;
}

async function fetchDydx() {
  const json = await fetch(DYDX_API).then(r => r.json());
  const mkts  = json?.markets ?? {};
  const map   = {};
  for (const [key, m] of Object.entries(mkts)) {
    const sym = key.replace(/-USD$|-PERP$/, "");
    const rate = parseFloat(m.nextFundingRate ?? m.fundingRate ?? 0);
    map[sym] = { fundingApr: rate * 24 * 365 * 100, vol24h: parseFloat(m.volume24H ?? 0) };
  }
  return map;
}

// ─── Daily snapshot ────────────────────────────────────────────────────────────
async function takeSnapshot(reason = "scheduled") {
  console.log(`[snapshot] Start (${reason}) ${new Date().toISOString()}`);
  try {
    const [asterComp, hlMap, dydxMap] = await Promise.all([
      fetchAsterComp().catch(e => { console.error("[aster]", e.message); return {}; }),
      fetchHL()       .catch(e => { console.error("[hl]",    e.message); return {}; }),
      fetchDydx()     .catch(e => { console.error("[dydx]",  e.message); return {}; }),
    ]);

    const FIXED   = ["WLFI", "ETH", "BTC", "SOL"];
    const allSyms = [...new Set([...FIXED, ...Object.keys(asterComp), ...Object.keys(hlMap)])];

    const tokens = {};
    for (const sym of allSyms.slice(0, 50)) {
      const comp = asterComp[sym];
      const hl   = hlMap[sym];
      const dy   = dydxMap[sym];
      if (!comp && !hl) continue;
      tokens[sym] = {
        aster_d1:   comp?.["1D"]  ?? null,
        aster_m1:   comp?.["1M"]  ?? null,
        aster_y1:   comp?.["1Y"]  ?? null,
        hl_funding: hl?.fundingApr ?? null,
        hl_vol:     hl?.vol24h    ?? null,
        dy_funding: dy?.fundingApr ?? null,
        dy_vol:     dy?.vol24h    ?? null,
      };
    }

    const date = new Date().toISOString().slice(0, 10);
    const snapshot = { ts: Date.now(), date, reason, tokenCount: Object.keys(tokens).length, tokens };

    dailyLogs = dailyLogs.filter(l => l.date !== date);
    dailyLogs.push(snapshot);
    if (dailyLogs.length > MAX_LOGS) dailyLogs = dailyLogs.slice(-MAX_LOGS);
    saveLogs(dailyLogs);

    console.log(`[snapshot] OK — ${snapshot.tokenCount} tokens saved for ${date}`);
    return snapshot;
  } catch (e) {
    console.error("[snapshot] Fatal:", e.message);
    throw e;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, logs: dailyLogs.length, latest: dailyLogs.at(-1)?.date ?? null, uptime: Math.round(process.uptime()) });
});

app.get("/logs/daily", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, MAX_LOGS);
  res.json({ ok: true, count: dailyLogs.length, logs: dailyLogs.slice(-limit) });
});

app.get("/logs/today", (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const entry = dailyLogs.find(l => l.date === today) ?? null;
  res.json({ ok: true, date: today, snapshot: entry });
});

app.post("/logs/snapshot", async (_req, res) => {
  try {
    const snap = await takeSnapshot("manual");
    res.json({ ok: true, snapshot: { date: snap.date, tokenCount: snap.tokenCount, ts: snap.ts } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Scheduler: 23:59 UTC every day ──────────────────────────────────────────
cron.schedule("59 23 * * *", () => takeSnapshot("scheduled"), { timezone: "UTC" });
console.log("[cron] Scheduled: 23:59 UTC daily");

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  // Startup snapshot to verify pipeline works
  takeSnapshot("startup").catch(console.error);
});
