import { useState, useCallback, useEffect } from "react";

const PROXY     = "https://cors-proxy.munichbro69.workers.dev";
const HL_API    = "https://api.hyperliquid.xyz/info";
const ASTER_API = "https://fapi.asterdex.com";
const BACK_API  = "https://api.backpack.exchange/api/v1";

const T = {
  bg: "#f0f2f5", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", subtle: "#94a3b8",
  green: "#10b981", greenBg: "#d1fae5",
  red: "#ef4444", redBg: "#fee2e2",
  yellow: "#f59e0b", blue: "#3b82f6", accent: "#6366f1",
};

const MIN_VOL_PER_DEX = 300000;
const CACHE_KEY  = "fundingArb_ranking30d_v2";
const CACHE_TTL  = 6 * 3600 * 1000;
const TOP_N      = 20;
const TIMEFRAMES = ["24h", "3d", "7d", "15d", "31d"];

// ─── Score helpers ────────────────────────────────────────────────────────────

function getCls(score) {
  if (score >= 80) return { label: "TOP",   color: T.green,  bg: T.greenBg };
  if (score >= 65) return { label: "GOOD",  color: T.green,  bg: T.greenBg };
  if (score >= 50) return { label: "OK",    color: T.yellow, bg: "#fef3c7" };
  return              { label: "AVOID", color: T.red,    bg: T.redBg   };
}

// 40% media APR · 35% % días positivos · 25% estabilidad (inverso stdDev)
function calcHistoricalScore(avgApr, pctPositive, stdDev) {
  const aprScore  = Math.min(Math.max(avgApr, 0) / 100, 1) * 40;
  const pctScore  = pctPositive * 35;
  const stabScore = Math.max(0, 1 - stdDev / 100) * 25;
  return Math.min(100, Math.max(0, Math.round(aprScore + pctScore + stabScore)));
}

// spreads[i] = hlApr_i - otherFundingApr
// Se orienta para que "positivo" siempre signifique "la estrategia gana"
function calcHistoricalMetrics(hlHistory, otherFundingApr) {
  if (!hlHistory || hlHistory.length < 5) return null;
  const raw = hlHistory.map(d =>
    parseFloat(d.fundingRate) * 3 * 365 * 100 - otherFundingApr
  );
  const n      = raw.length;
  const rawAvg = raw.reduce((a, b) => a + b, 0) / n;
  const hlIsShort = rawAvg >= 0;
  const s      = hlIsShort ? raw : raw.map(v => -v);
  const avgApr = Math.abs(rawAvg);
  const pctPos = s.filter(v => v > 0).length / n;
  const stdDev = Math.sqrt(s.reduce((a, v) => a + (v - avgApr) ** 2, 0) / n);
  let consec = 0;
  for (let i = s.length - 1; i >= 0; i--) { if (s[i] > 0) consec++; else break; }
  return { avgApr, pctPositive: pctPos, stdDev, consecutiveDays: Math.floor(consec / 3), n, hlIsShort };
}

// ─── Cache ───────────────────────────────────────────────────────────────────

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return { ts, data };
  } catch { return null; }
}
function saveCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

// ─── Network ─────────────────────────────────────────────────────────────────

async function proxyGet(url) {
  const res = await fetch(`${PROXY}?url=${encodeURIComponent(url)}`);
  return res.json();
}
async function proxyPost(url, body) {
  const res = await fetch(`${PROXY}?url=${encodeURIComponent(url)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function fetchHL() {
  const [meta, mids] = await Promise.all([
    proxyPost(HL_API, { type: "metaAndAssetCtxs" }),
    proxyPost(HL_API, { type: "allMids" }),
  ]);
  const map = {};
  const universe = meta[0]?.universe || [];
  const ctxs     = meta[1] || [];
  universe.forEach((a, i) => {
    const ctx   = ctxs[i];
    const price = parseFloat(mids[a.name] || ctx?.markPx || 0);
    if (!price) return;
    map[a.name] = {
      fundingApr: parseFloat(ctx?.funding || 0) * 3 * 365 * 100,
      price,
      vol24h:    parseFloat(ctx?.dayNtlVlm || 0),
      oi:        parseFloat(ctx?.openInterest || 0) * price,
    };
  });
  return map;
}

async function fetchAster() {
  const [prem, tickers] = await Promise.all([
    proxyGet(`${ASTER_API}/fapi/v1/premiumIndex`),
    proxyGet(`${ASTER_API}/fapi/v1/ticker/24hr`),
  ]);
  const premMap = {};
  (Array.isArray(prem) ? prem : []).forEach(p => { if (p.symbol) premMap[p.symbol] = p; });
  const map = {};
  (Array.isArray(tickers) ? tickers : []).forEach(t => {
    if (!t.symbol) return;
    const sym    = t.symbol.replace(/USDT$/, "").replace(/BUSD$/, "");
    const p      = premMap[t.symbol] || {};
    const markPx = parseFloat(p.markPrice || p.p || t.lastPrice || t.weightedAvgPrice || 0);
    const idxPx  = parseFloat(p.indexPrice || p.indexPx || 0);
    if (!markPx) return;
    const lastRate   = parseFloat(p.lastFundingRate || 0);
    const premium    = idxPx > 0 ? (markPx - idxPx) / idxPx : 0;
    const fundingRate = lastRate !== 0 ? lastRate : Math.max(-0.0075, Math.min(0.0075, premium));
    map[sym] = {
      fundingApr: fundingRate * 6 * 365 * 100,
      price: markPx,
      vol24h: parseFloat(t.quoteVolume || 0),
      oi: parseFloat(p.openInterest || 0) * markPx,
    };
  });
  return map;
}

async function fetchBackpack() {
  try {
    const [tickerRes, fundingRes] = await Promise.all([
      proxyGet(`${BACK_API}/tickers`),
      proxyGet(`${BACK_API}/fundingRates`).catch(() => []),
    ]);
    const fundingMap = {};
    (Array.isArray(fundingRes) ? fundingRes : []).forEach(f => { if (f.symbol) fundingMap[f.symbol] = f; });
    const map = {};
    (Array.isArray(tickerRes) ? tickerRes : []).forEach(t => {
      if (!t.symbol?.endsWith("_PERP")) return;
      const sym   = t.symbol.replace(/_USDC_PERP$/, "").replace(/_USDT_PERP$/, "");
      const price = parseFloat(t.lastPrice || 0);
      if (!price) return;
      const fr = fundingMap[t.symbol] || {};
      map[sym] = {
        fundingApr: parseFloat(fr.fundingRate || fr.lastFundingRate || 0) * 3 * 365 * 100,
        price,
        vol24h: parseFloat(t.quoteVolume) || parseFloat(t.volume || 0) * price,
        oi: 0,
      };
    });
    return map;
  } catch { return {}; }
}

// Histórico simple para el gráfico de detalle (sin paginación, variable timeframe)
async function fetchHLHistory(symbol, days) {
  try {
    const start   = Date.now() - days * 86400000;
    const candles = await proxyPost(HL_API, { type: "fundingHistory", coin: symbol, startTime: start });
    return Array.isArray(candles) ? candles : [];
  } catch { return []; }
}

// Histórico 30d con paginación para el ranking
async function fetchHLHistory30d(symbol) {
  const now = Date.now(), start = now - 30 * 86400000;
  let all = [], cursor = start;
  for (let page = 0; page < 10; page++) {
    const batch = await proxyPost(HL_API, { type: "fundingHistory", coin: symbol, startTime: cursor });
    if (!Array.isArray(batch) || !batch.length) break;
    all = all.concat(batch);
    if (batch.length < 500) break;
    cursor = batch[batch.length - 1].time + 1;
    if (cursor >= now) break;
  }
  return all;
}

// ─── SpreadChart ──────────────────────────────────────────────────────────────

function SpreadChart({ symbol, shortDex, otherFundingApr }) {
  const [tf, setTf]           = useState("7d");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback((newTf) => {
    setTf(newTf); setLoading(true);
    const days = newTf === "24h" ? 1 : newTf === "3d" ? 3 : newTf === "7d" ? 7 : newTf === "15d" ? 15 : 31;
    fetchHLHistory(symbol, days).then(data => {
      const other = otherFundingApr ?? 0;
      const points = data.map(d => {
        const hlApr = parseFloat(d.fundingRate) * 3 * 365 * 100;
        return {
          ts: d.time,
          spreadApr: shortDex === "HL" ? hlApr - other : other - hlApr,
        };
      }).filter(p => !isNaN(p.spreadApr));
      setHistory(points);
      setLoading(false);
    });
  }, [symbol, shortDex, otherFundingApr]);

  useEffect(() => { load(tf); }, [symbol, shortDex, otherFundingApr]);

  const W = 580, H = 180;
  const PAD = { top: 12, right: 12, bottom: 28, left: 44 };
  const IW = W - PAD.left - PAD.right;
  const IH = H - PAD.top - PAD.bottom;
  const vals = history.map(h => h.spreadApr);
  const avg  = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const max  = vals.length ? Math.max(...vals, 0) : 100;
  const min  = vals.length ? Math.min(...vals, 0) : 0;
  const yMax = max + Math.abs(max - min) * 0.15 + 5;
  const yMin = Math.min(min - 2, 0);
  const toY  = v => PAD.top + IH - ((v - yMin) / (yMax - yMin)) * IH;
  const barW = Math.max(2, IW / Math.max(history.length, 1) - 1);
  const avgY = toY(avg);

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {TIMEFRAMES.map(t => (
          <button key={t} onClick={() => load(t)} style={{
            background: tf === t ? T.green : T.bg,
            border: `1px solid ${tf === t ? T.green : T.border}`,
            color: tf === t ? "#fff" : T.muted,
            borderRadius: 6, padding: "4px 10px",
            cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
          }}>{t}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 20, marginBottom: 12, flexWrap: "wrap" }}>
        <div><div style={{ color: T.subtle, fontSize: 10 }}>Media APR</div><div style={{ color: T.blue, fontSize: 18, fontWeight: 800 }}>{avg.toFixed(1)}%</div></div>
        <div><div style={{ color: T.subtle, fontSize: 10 }}>Máximo</div><div style={{ color: T.green, fontSize: 18, fontWeight: 800 }}>{max.toFixed(1)}%</div></div>
        <div><div style={{ color: T.subtle, fontSize: 10 }}>Mínimo</div><div style={{ color: T.red, fontSize: 18, fontWeight: 800 }}>{min.toFixed(1)}%</div></div>
        <div><div style={{ color: T.subtle, fontSize: 10 }}>% positivos</div><div style={{ color: T.text, fontSize: 18, fontWeight: 800 }}>{vals.length ? (vals.filter(v => v > 0).length / vals.length * 100).toFixed(0) : 0}%</div></div>
      </div>
      {loading ? (
        <div style={{ color: T.subtle, fontSize: 13, textAlign: "center", padding: 20 }}>Cargando histórico...</div>
      ) : history.length === 0 ? (
        <div style={{ color: T.subtle, fontSize: 13, textAlign: "center", padding: 20 }}>Sin datos históricos</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <svg width={W} height={H} style={{ display: "block" }}>
            {[0, 25, 50, 75, 100].map(p => {
              const v = yMin + (yMax - yMin) * p / 100, y = toY(v);
              return <g key={p}><line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke={T.border} strokeWidth={1}/><text x={PAD.left - 6} y={y + 4} fill={T.subtle} fontSize={9} textAnchor="end">{v.toFixed(0)}%</text></g>;
            })}
            {history.map((h, i) => {
              const v = h.spreadApr;
              const x = PAD.left + (i / history.length) * IW;
              const barTop = toY(Math.max(v, 0)), barBot = toY(Math.min(v, 0));
              const barH = Math.max(Math.abs(barBot - barTop), 2);
              const color = v >= 50 ? T.green : v >= 20 ? "#34d399" : v > 0 ? "#6ee7b7" : T.red;
              return <rect key={i} x={x} y={barTop} width={barW} height={barH} fill={color} rx={1} opacity={0.85}/>;
            })}
            <line x1={PAD.left} y1={avgY} x2={W - PAD.right} y2={avgY} stroke={T.blue} strokeWidth={2} strokeDasharray="8,5"/>
            <rect x={W - PAD.right - 48} y={avgY - 10} width={44} height={16} rx={4} fill="#dbeafe"/>
            <text x={W - PAD.right - 26} y={avgY + 2} fill={T.blue} fontSize={9} textAnchor="middle" fontWeight="700">{avg.toFixed(1)}%</text>
            {[0, Math.floor(history.length / 2), history.length - 1].map(i => i < history.length && (
              <text key={i} x={PAD.left + (i / history.length) * IW + barW / 2} y={H - PAD.bottom + 14} fill={T.subtle} fontSize={8} textAnchor="middle">
                {new Date(history[i].ts).toLocaleDateString([], { month: "short", day: "numeric" })}
              </text>
            ))}
          </svg>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RankingTab({ config }) {
  const [results, setResults]     = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [lastScan, setLastScan]   = useState(null);
  const [selected, setSelected]   = useState(null);
  const [dexStatus, setDexStatus] = useState({});
  const [progress, setProgress]   = useState({ step: 0, total: 0, current: "" });
  const [cacheTime, setCacheTime] = useState(null);
  const [discarded, setDiscarded] = useState([]);

  const runScan = useCallback(async (forceRefresh = false) => {
    setLoading(true); setError(null); setSelected(null);
    setProgress({ step: 0, total: 0, current: "Cargando datos de DEX..." });

    try {
      // Siempre cargar datos actuales (vol, spread hoy, confirmar par activo)
      const [hlMap, asterMap, backMap] = await Promise.allSettled([
        fetchHL(), fetchAster(), fetchBackpack(),
      ]).then(r => r.map(x => x.status === "fulfilled" ? x.value : {}));

      setDexStatus({
        HL:       Object.keys(hlMap).length,
        Aster:    Object.keys(asterMap).length,
        Backpack: Object.keys(backMap).length,
      });

      // Intentar caché (evita re-descargar 30d de histórico)
      if (!forceRefresh) {
        const cached = loadCache();
        if (cached) {
          // Actualizar spread hoy y vol actuales sobre el histórico cacheado
          const updated = cached.data.map(r => {
            const hlVol    = hlMap[r.symbol]?.vol24h   || 0;
            const otherVol = r.otherDex === "Aster"
              ? asterMap[r.symbol]?.vol24h || 0
              : backMap[r.symbol]?.vol24h  || 0;
            const hlApr  = hlMap[r.symbol]?.fundingApr    || 0;
            const othApr = r.otherDex === "Aster"
              ? asterMap[r.symbol]?.fundingApr || 0
              : backMap[r.symbol]?.fundingApr  || 0;
            const currentSpread = r.shortDex === "HL" ? hlApr - othApr : othApr - hlApr;
            return { ...r, hlVol, otherVol, vol: Math.min(hlVol, otherVol), currentSpread, currentHlApr: hlApr, otherFundingApr: othApr };
          }).filter(r => r.hlVol >= MIN_VOL_PER_DEX && r.otherVol >= MIN_VOL_PER_DEX);

          setResults(updated.sort((a, b) => b.score - a.score));
          setLastScan(new Date());
          setCacheTime(new Date(cached.ts));
          return;
        }
      }

      // Top 20 HL por vol 24h
      const top20 = Object.entries(hlMap)
        .sort((a, b) => b[1].vol24h - a[1].vol24h)
        .slice(0, TOP_N)
        .map(([sym]) => sym);

      setProgress({ step: 0, total: top20.length, current: "" });

      const results     = [];
      const discardedList = [];

      for (let i = 0; i < top20.length; i++) {
        const sym = top20[i];
        setProgress({ step: i + 1, total: top20.length, current: sym });

        const hlVol = hlMap[sym]?.vol24h || 0;

        // DEX contrapartes con vol suficiente
        const candidates = [];
        if ((asterMap[sym]?.vol24h || 0) >= MIN_VOL_PER_DEX)  candidates.push({ name: "Aster",    ...asterMap[sym] });
        if ((backMap[sym]?.vol24h  || 0) >= MIN_VOL_PER_DEX)  candidates.push({ name: "Backpack", ...backMap[sym] });

        if (candidates.length === 0) {
          const lowDex = asterMap[sym] ? ["Aster", asterMap[sym]] : backMap[sym] ? ["Backpack", backMap[sym]] : null;
          if (lowDex) {
            const [dex, d] = lowDex;
            discardedList.push({ symbol: sym, reason: `Vol insuf. en ${dex} ($${((d.vol24h || 0) / 1000).toFixed(0)}K)` });
          }
          continue;
        }

        // Descargar histórico 30d de HL una sola vez por token
        const hlHistory = await fetchHLHistory30d(sym);
        if (hlHistory.length < 10) {
          discardedList.push({ symbol: sym, reason: "Sin histórico HL suficiente" });
          continue;
        }

        // Evaluar cada par (HL × Aster, HL × Backpack)
        const pairsWithMetrics = [];
        for (const other of candidates) {
          const metrics = calcHistoricalMetrics(hlHistory, other.fundingApr);
          if (!metrics) continue;

          // Filtros duros históricos
          if (metrics.avgApr      < 5)    continue;
          if (metrics.pctPositive < 0.60) continue;

          const shortDex      = metrics.hlIsShort ? "HL" : other.name;
          const longDex       = metrics.hlIsShort ? other.name : "HL";
          const hlCurApr      = hlMap[sym]?.fundingApr || 0;
          const currentSpread = metrics.hlIsShort ? hlCurApr - other.fundingApr : other.fundingApr - hlCurApr;
          const score         = calcHistoricalScore(metrics.avgApr, metrics.pctPositive, metrics.stdDev);

          pairsWithMetrics.push({
            shortDex, longDex, otherDex: other.name,
            otherFundingApr: other.fundingApr, otherVol24h: other.vol24h,
            currentSpread, currentHlApr: hlCurApr,
            score, ...metrics,
          });
        }

        if (pairsWithMetrics.length === 0) {
          discardedList.push({ symbol: sym, reason: "Media APR < 5% o positivos < 60% en 30d" });
          continue;
        }

        const winner    = pairsWithMetrics.reduce((b, p) => p.score > b.score ? p : b, pairsWithMetrics[0]);
        const stabRatio = Math.max(0, 1 - winner.stdDev / 100);

        results.push({
          symbol: sym,
          shortDex: winner.shortDex, longDex: winner.longDex, otherDex: winner.otherDex,
          avgApr: winner.avgApr, pctPositive: winner.pctPositive, stdDev: winner.stdDev,
          consecutiveDays: winner.consecutiveDays, n: winner.n,
          currentSpread: winner.currentSpread, currentHlApr: winner.currentHlApr,
          otherFundingApr: winner.otherFundingApr,
          hlVol, otherVol: winner.otherVol24h,
          vol: Math.min(hlVol, winner.otherVol24h),
          score: winner.score,
          stability: stabRatio > 0.7 ? "Alta" : stabRatio > 0.4 ? "Media" : "Baja",
          stabilityColor: stabRatio > 0.7 ? T.green : stabRatio > 0.4 ? T.yellow : T.red,
          allPairs: pairsWithMetrics,
          allDex: [
            { name: "HL",       fundingApr: hlMap[sym]?.fundingApr,  vol24h: hlVol,            price: hlMap[sym]?.price },
            ...candidates.map(c => ({ name: c.name, fundingApr: c.fundingApr, vol24h: c.vol24h, price: c.price })),
          ],
        });
      }

      saveCache(results);
      setCacheTime(null);
      setDiscarded(discardedList.sort((a, b) => a.symbol.localeCompare(b.symbol)));
      setResults(results.sort((a, b) => b.score - a.score));
      setLastScan(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setProgress({ step: 0, total: 0, current: "" });
    }
  }, []);

  const progressPct = progress.total > 0 ? (progress.step / progress.total) * 100 : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ color: T.subtle, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            RANKING HISTÓRICO 30d · HL × ASTER × BACKPACK
          </div>
          {lastScan && (
            <div style={{ color: T.subtle, fontSize: 12, marginTop: 4 }}>
              Spread actual: {lastScan.toLocaleTimeString()} · {results.length} tokens
              {Object.entries(dexStatus).map(([dex, n]) => (
                <span key={dex} style={{ marginLeft: 8, color: n > 0 ? T.green : T.red }}>
                  {n > 0 ? "✓" : "✗"}{dex}({n})
                </span>
              ))}
            </div>
          )}
          {cacheTime && (
            <div style={{ fontSize: 11, color: T.subtle, marginTop: 2 }}>
              Histórico calculado: {cacheTime.toLocaleString()} ·{" "}
              <button onClick={() => runScan(true)} disabled={loading} style={{
                background: "none", border: "none", color: T.accent, cursor: "pointer",
                fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: 0,
              }}>↺ Recalcular historial</button>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {results.length > 0 && !cacheTime && (
            <button onClick={() => runScan(false)} disabled={loading} style={{
              background: "#f1f5f9", border: `1px solid ${T.border}`,
              color: T.muted, borderRadius: 10, padding: "10px 18px",
              cursor: loading ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
            }}>↻ Actualizar spread hoy</button>
          )}
          <button onClick={() => runScan(false)} disabled={loading} style={{
            background: loading ? "#f1f5f9" : "#6366f120",
            border: `1px solid ${loading ? T.border : "#6366f144"}`,
            color: loading ? T.subtle : T.accent,
            borderRadius: 10, padding: "10px 28px",
            cursor: loading ? "not-allowed" : "pointer",
            fontFamily: "inherit", fontSize: 14, fontWeight: 700,
          }}>
            {loading ? "Analizando..." : results.length === 0 ? "▶ Analizar 30d" : "↻ Refrescar"}
          </button>
        </div>
      </div>

      {/* ── Nota informativa ── */}
      <div style={{
        background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10,
        padding: "10px 14px", fontSize: 12, color: "#0369a1",
      }}>
        Score basado en histórico 30d de HL — el spread de hoy puede ser diferente.
        La tasa de Aster/Backpack se usa como referencia fija para estimar el spread histórico.
      </div>

      {/* ── Error ── */}
      {error && (
        <div style={{ background: T.redBg, border: "1px solid #fca5a5", borderRadius: 12, padding: 16, color: T.red, fontSize: 14 }}>
          Error: {error}
        </div>
      )}

      {/* ── Progress ── */}
      {loading && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 24 }}>
          {progress.total === 0 ? (
            <div style={{ color: T.accent, fontSize: 15, fontWeight: 700, textAlign: "center" }}>
              Cargando datos de DEX...
            </div>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ color: T.text, fontSize: 14, fontWeight: 700 }}>
                  Analizando {progress.current}...
                </span>
                <span style={{ color: T.muted, fontSize: 13 }}>
                  {progress.step}/{progress.total} tokens
                </span>
              </div>
              <div style={{ background: T.border, borderRadius: 6, height: 8 }}>
                <div style={{
                  background: `linear-gradient(90deg, ${T.accent}, ${T.green})`,
                  borderRadius: 6, height: 8,
                  width: `${progressPct}%`,
                  transition: "width 0.4s ease",
                }} />
              </div>
              <div style={{ color: T.subtle, fontSize: 11, marginTop: 8, textAlign: "center" }}>
                Descargando 30 días de histórico de HL · Vol mín $300K/DEX
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Empty states ── */}
      {!loading && results.length === 0 && !error && lastScan && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>📊</div>
          <div style={{ color: T.muted, fontSize: 15 }}>Sin tokens que pasen los filtros históricos (APR ≥ 5% · Positivos ≥ 60%)</div>
        </div>
      )}
      {!loading && results.length === 0 && !error && !lastScan && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 60, textAlign: "center" }}>
          <div style={{ fontSize: 36, marginBottom: 16 }}>📈</div>
          <div style={{ color: T.muted, fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Ranking basado en histórico real 30d</div>
          <div style={{ color: T.subtle, fontSize: 13, marginBottom: 6 }}>Top 20 tokens HL por vol · Histórico HL vs tasa actual Aster/Backpack</div>
          <div style={{ color: T.subtle, fontSize: 13 }}>Filtros: media APR ≥ 5% · % positivos ≥ 60% · Vol ≥ $300K/DEX</div>
        </div>
      )}

      {/* ── Tabla de resultados ── */}
      {results.length > 0 && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
          {/* Header */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "28px 76px 110px 90px 80px 70px 60px 80px",
            padding: "12px 16px", borderBottom: `1px solid ${T.border}`, background: "#f8fafc",
          }}>
            {["#", "TOKEN", "PAR (30d)", "MEDIA APR", "% POSITIVOS", "ESTAB.", "SCORE", "HOY"].map(h => (
              <div key={h} style={{ color: T.subtle, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em" }}>{h}</div>
            ))}
          </div>

          {results.map((r, i) => {
            const c = getCls(r.score);
            const isSelect = selected?.symbol === r.symbol;
            const todayColor = r.currentSpread >= r.avgApr * 0.5 ? T.green : r.currentSpread > 0 ? T.yellow : T.red;

            return (
              <div key={r.symbol}>
                <div onClick={() => setSelected(isSelect ? null : r)} style={{
                  display: "grid",
                  gridTemplateColumns: "28px 76px 110px 90px 80px 70px 60px 80px",
                  padding: "13px 16px", borderBottom: `1px solid ${T.border}`,
                  background: isSelect ? "#f8fafc" : "white", cursor: "pointer",
                }}>
                  {/* # */}
                  <div style={{ color: T.subtle, fontSize: 12 }}>{i + 1}</div>

                  {/* TOKEN */}
                  <div style={{ color: T.text, fontWeight: 800, fontSize: 14 }}>{r.symbol}</div>

                  {/* PAR (30d) */}
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: T.text }}>
                      {r.shortDex} → {r.longDex}
                    </div>
                    <div style={{ fontSize: 10, color: T.subtle }}>n={r.n} períodos</div>
                  </div>

                  {/* MEDIA APR */}
                  <div style={{ color: T.green, fontSize: 14, fontWeight: 800 }}>
                    +{r.avgApr.toFixed(1)}%
                  </div>

                  {/* % POSITIVOS */}
                  <div style={{ color: r.pctPositive >= 0.75 ? T.green : r.pctPositive >= 0.60 ? T.yellow : T.red, fontSize: 13, fontWeight: 700 }}>
                    {(r.pctPositive * 100).toFixed(0)}%
                  </div>

                  {/* ESTAB. */}
                  <div style={{ color: r.stabilityColor, fontSize: 12, fontWeight: 700 }}>
                    {r.stability}
                  </div>

                  {/* SCORE */}
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: c.color }} />
                    <span style={{ color: c.color, fontSize: 13, fontWeight: 700 }}>{r.score}</span>
                  </div>

                  {/* HOY */}
                  <div style={{ color: todayColor, fontSize: 12, fontWeight: 700 }}>
                    {r.currentSpread >= 0 ? "+" : ""}{r.currentSpread.toFixed(1)}%
                  </div>
                </div>

                {/* ── Detalle expandido ── */}
                {isSelect && (
                  <div style={{ padding: "20px", background: "#f8fafc", borderBottom: `1px solid ${T.border}` }}>

                    {/* Métricas históricas principales */}
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                      {[
                        { label: "Media APR 30d",       value: `+${r.avgApr.toFixed(2)}%`,              color: T.green },
                        { label: "% Períodos positivos", value: `${(r.pctPositive * 100).toFixed(1)}%`, color: r.pctPositive >= 0.75 ? T.green : T.yellow },
                        { label: "Desv. estándar",       value: `${r.stdDev.toFixed(1)}%`,               color: T.muted },
                        { label: "Días consec. positivos", value: `${r.consecutiveDays}d`,               color: r.consecutiveDays >= 7 ? T.green : T.muted },
                        { label: "Spread hoy (referencia)", value: `${r.currentSpread >= 0 ? "+" : ""}${r.currentSpread.toFixed(2)}%`, color: r.currentSpread > 0 ? T.blue : T.red },
                      ].map(({ label, value, color }) => (
                        <div key={label} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", minWidth: 130 }}>
                          <div style={{ color: T.subtle, fontSize: 10, marginBottom: 3 }}>{label}</div>
                          <div style={{ color, fontSize: 18, fontWeight: 800 }}>{value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Datos actuales por DEX */}
                    <div style={{ color: T.subtle, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 8 }}>
                      DATOS ACTUALES POR DEX
                    </div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
                      {r.allDex.map(d => (
                        <div key={d.name} style={{
                          background: d.name === r.shortDex ? T.redBg : d.name === r.longDex ? T.greenBg : "#f1f5f9",
                          border: `1px solid ${d.name === r.shortDex ? "#fca5a5" : d.name === r.longDex ? "#6ee7b7" : T.border}`,
                          borderRadius: 10, padding: "10px 14px", minWidth: 120,
                        }}>
                          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>{d.name}</div>
                          <div style={{ color: d.fundingApr > 0 ? T.red : T.green, fontSize: 15, fontWeight: 800 }}>
                            {d.fundingApr > 0 ? "+" : ""}{d.fundingApr?.toFixed(2)}%
                          </div>
                          <div style={{ color: T.subtle, fontSize: 10 }}>Vol ${(d.vol24h / 1e6).toFixed(1)}M</div>
                          {d.name === r.shortDex && <div style={{ color: T.red,   fontSize: 10, fontWeight: 700, marginTop: 4 }}>← SHORT (hoy)</div>}
                          {d.name === r.longDex  && <div style={{ color: T.green, fontSize: 10, fontWeight: 700, marginTop: 4 }}>← LONG (hoy)</div>}
                        </div>
                      ))}
                    </div>

                    {/* Comparativa de pares si hay varios */}
                    {r.allPairs.length > 1 && (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ color: T.subtle, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 8 }}>
                          COMPARATIVA DE PARES — score histórico 30d
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {[...r.allPairs].sort((a, b) => b.score - a.score).map((p, pi) => {
                            const isWinner = p.shortDex === r.shortDex && p.longDex === r.longDex;
                            return (
                              <div key={pi} style={{
                                background: isWinner ? T.greenBg : "#f1f5f9",
                                border: `1px solid ${isWinner ? T.green : T.border}`,
                                borderRadius: 8, padding: "8px 12px", minWidth: 190,
                              }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: isWinner ? T.green : T.muted }}>
                                  {p.shortDex} → {p.longDex} {isWinner ? "✓ GANADOR" : ""}
                                </div>
                                <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                                  <span style={{ fontSize: 10, color: T.muted }}>Score: <b style={{ color: isWinner ? T.green : T.text }}>{p.score}</b></span>
                                  <span style={{ fontSize: 10, color: T.muted }}>APR: <b>+{p.avgApr.toFixed(1)}%</b></span>
                                  <span style={{ fontSize: 10, color: T.muted }}>Pos: <b>{(p.pctPositive * 100).toFixed(0)}%</b></span>
                                  <span style={{ fontSize: 10, color: T.muted }}>σ: <b>{p.stdDev.toFixed(0)}%</b></span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Gráfico histórico */}
                    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 }}>
                      <div style={{ color: T.muted, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                        FUNDING DELTA (APR) — {r.symbol} · {r.shortDex} SHORT / {r.longDex} LONG
                      </div>
                      <div style={{ color: T.subtle, fontSize: 11, marginBottom: 4 }}>
                        HL histórico vs tasa actual {r.otherDex} ({r.otherFundingApr?.toFixed(2)}% fija como referencia)
                      </div>
                      <SpreadChart
                        symbol={r.symbol}
                        shortDex={r.shortDex}
                        otherFundingApr={r.otherFundingApr}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {results.length > 0 && (
        <div style={{ color: T.subtle, fontSize: 12, textAlign: "center" }}>
          {results.length} tokens · score histórico 30d · vol ≥ $300K/DEX · Clic en fila para detalle
        </div>
      )}

      {/* ── Panel de descartados ── */}
      {discarded.length > 0 && (
        <details style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
          <summary style={{
            padding: "12px 16px", cursor: "pointer", listStyle: "none",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            background: "#fff7ed", borderBottom: `1px solid #fed7aa`,
          }}>
            <span style={{ color: "#92400e", fontSize: 12, fontWeight: 700 }}>
              ❌ {discarded.length} tokens descartados por liquidez o histórico insuficiente
            </span>
            <span style={{ color: "#92400e", fontSize: 11 }}>▼ ver detalle</span>
          </summary>
          <div style={{ padding: "12px 16px", display: "flex", flexWrap: "wrap", gap: 8 }}>
            {discarded.map(d => (
              <div key={d.symbol} style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: "6px 10px" }}>
                <span style={{ color: T.text, fontSize: 12, fontWeight: 700 }}>{d.symbol}</span>
                <span style={{ color: "#92400e", fontSize: 11, marginLeft: 6 }}>❌ {d.reason}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
