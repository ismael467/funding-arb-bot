import { useState, useCallback, useEffect } from "react";

const PROXY = "https://cors-proxy.munichbro69.workers.dev";
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

const MIN_VOL = 500000;
const TIMEFRAMES = ["24h", "3d", "7d", "15d", "31d"];

function getCls(score) {
  if (score >= 80) return { label: "TOP",   color: T.green,  bg: T.greenBg, emoji: "🔥" };
  if (score >= 65) return { label: "GOOD",  color: T.green,  bg: T.greenBg, emoji: "🟢" };
  if (score >= 50) return { label: "OK",    color: T.yellow, bg: "#fef3c7", emoji: "🟡" };
  return              { label: "AVOID", color: T.red,    bg: T.redBg,   emoji: "🔴" };
}

function calcScore({ spreadApr, spreadPct, vol, oi }) {
  const fs = Math.min(Math.abs(spreadApr) / 100, 1) * 40;
  const ss = Math.max(0, 1 - spreadPct / 0.005) * 20;
  const vs = Math.min(Math.log10(Math.max(vol, 1)) / 8, 1) * 25;
  const os = Math.min(Math.log10(Math.max(oi, 1)) / 8, 1) * 15;
  return Math.min(100, Math.max(0, Math.round(fs + ss + vs + os)));
}

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
      dex: "HL",
      fundingApr: parseFloat(ctx?.funding || 0) * 3 * 365 * 100,
      price,
      vol24h:    parseFloat(ctx?.dayNtlVlm || 0),
      oi:        parseFloat(ctx?.openInterest || 0) * price,
      spreadPct: price > 0 ? (parseFloat(ctx?.impactPxs?.[1] || price*1.001) - parseFloat(ctx?.impactPxs?.[0] || price*0.999)) / price : 0,
    };
  });
  return map;
}

async function fetchAster() {
  const [prem, tickers] = await Promise.all([
    proxyGet(`${ASTER_API}/fapi/v1/premiumIndex`),
    proxyGet(`${ASTER_API}/fapi/v1/ticker/24hr`),
  ]);
  const tickerMap = {};
  (Array.isArray(tickers) ? tickers : []).forEach(t => { if (t.symbol) tickerMap[t.symbol] = t; });

  const premMap = {};
  (Array.isArray(prem) ? prem : []).forEach(p => { if (p.symbol) premMap[p.symbol] = p; });

  const map = {};
  (Array.isArray(tickers) ? tickers : []).forEach(t => {
    if (!t.symbol) return;
    const sym     = t.symbol.replace(/USDT$/, "").replace(/BUSD$/, "");
    const p       = premMap[t.symbol] || {};
    const markPx  = parseFloat(p.markPrice  || p.p || t.lastPrice || t.weightedAvgPrice || 0);
    const indexPx = parseFloat(p.indexPrice || p.indexPx || 0);
    if (!markPx) return;

    // lastFundingRate is the real per-period rate; fundingRate / interestRate fields
    // on Binance-fork DEXes contain only the fixed interest component (0.0001),
    // so we avoid them as fallback. When lastFundingRate is absent, estimate from
    // mark-index premium (clamp to ±0.75% per period, Binance default cap).
    const lastRate = parseFloat(p.lastFundingRate || 0);
    const premium  = indexPx > 0 ? (markPx - indexPx) / indexPx : 0;
    const fundingRate = lastRate !== 0
      ? lastRate
      : Math.max(-0.0075, Math.min(0.0075, premium));

    const bid = parseFloat(t.bidPrice || markPx * 0.999);
    const ask = parseFloat(t.askPrice || markPx * 1.001);
    map[sym] = {
      dex: "Aster",
      fundingApr: fundingRate * 3 * 365 * 100,
      price:     markPx,
      vol24h:    parseFloat(t.quoteVolume || 0),
      oi:        0,
      spreadPct: markPx > 0 ? (ask - bid) / markPx : 0,
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
    (Array.isArray(fundingRes) ? fundingRes : []).forEach(f => {
      if (f.symbol) fundingMap[f.symbol] = f;
    });
    const map = {};
    (Array.isArray(tickerRes) ? tickerRes : []).forEach(t => {
      if (!t.symbol?.endsWith("_PERP")) return;
      const sym   = t.symbol.replace(/_USDC_PERP$/, "").replace(/_USDT_PERP$/, "");
      const price = parseFloat(t.lastPrice || 0);
      if (!price) return;
      const fr = fundingMap[t.symbol] || {};
      map[sym] = {
        dex: "Backpack",
        fundingApr: parseFloat(fr.fundingRate || fr.lastFundingRate || 0) * 3 * 365 * 100,
        price,
        vol24h: parseFloat(t.quoteVolume) || parseFloat(t.volume || 0) * parseFloat(t.lastPrice || 0),
        oi:     0,
        spreadPct: 0,
      };
    });
    return map;
  } catch { return {}; }
}

async function fetchHLHistory(symbol, days) {
  try {
    const now   = Date.now();
    const start = now - days * 86400000;
    const candles = await proxyPost(HL_API, {
      type: "fundingHistory",
      coin: symbol,
      startTime: start,
    });
    return Array.isArray(candles) ? candles : [];
  } catch { return []; }
}

function SpreadChart({ symbol, shortDex, hlMap, asterMap, backMap }) {
  const [tf, setTf]           = useState("7d");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const days = tf === "24h" ? 1 : tf === "3d" ? 3 : tf === "7d" ? 7 : tf === "15d" ? 15 : 31;
    fetchHLHistory(symbol, days).then(data => {
      const otherFunding = shortDex === "HL"
        ? (asterMap[symbol]?.fundingApr || backMap[symbol]?.fundingApr || 0)
        : (hlMap[symbol]?.fundingApr || 0);
      const points = data.map(d => ({
        ts:        d.time,
        spreadApr: parseFloat(d.fundingRate) * 3 * 365 * 100 - (shortDex === "HL" ? otherFunding : -otherFunding),
      })).filter(p => !isNaN(p.spreadApr));
      setHistory(points);
      setLoading(false);
    });
  }, [symbol, tf]);

  const W = 580, H = 180;
  const PAD = { top: 12, right: 12, bottom: 28, left: 44 };
  const IW = W - PAD.left - PAD.right;
  const IH = H - PAD.top - PAD.bottom;
  const vals  = history.map(h => h.spreadApr);
  const avg   = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const max   = vals.length > 0 ? Math.max(...vals, 0) : 100;
  const min   = vals.length > 0 ? Math.min(...vals, 0) : 0;
  const yMax  = max + Math.abs(max - min) * 0.15 + 5;
  const yMin  = Math.min(min - 2, 0);
  const toY   = v => PAD.top + IH - ((v - yMin) / (yMax - yMin)) * IH;
  const barW  = Math.max(2, IW / Math.max(history.length, 1) - 1);
  const avgY  = toY(avg);

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {TIMEFRAMES.map(t => (
          <button key={t} onClick={() => setTf(t)} style={{
            background: tf === t ? T.green : T.bg,
            border: `1px solid ${tf === t ? T.green : T.border}`,
            color: tf === t ? "#fff" : T.muted,
            borderRadius: 6, padding: "4px 10px",
            cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600
          }}>{t}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 20, marginBottom: 12, flexWrap: "wrap" }}>
        <div><div style={{ color: T.subtle, fontSize: 10 }}>Media APR</div><div style={{ color: T.blue, fontSize: 18, fontWeight: 800 }}>{avg.toFixed(1)}%</div></div>
        <div><div style={{ color: T.subtle, fontSize: 10 }}>Máximo</div><div style={{ color: T.green, fontSize: 18, fontWeight: 800 }}>{max.toFixed(1)}%</div></div>
        <div><div style={{ color: T.subtle, fontSize: 10 }}>Mínimo</div><div style={{ color: T.red, fontSize: 18, fontWeight: 800 }}>{min.toFixed(1)}%</div></div>
        <div><div style={{ color: T.subtle, fontSize: 10 }}>% positivos</div><div style={{ color: T.text, fontSize: 18, fontWeight: 800 }}>{vals.length > 0 ? (vals.filter(v => v > 0).length / vals.length * 100).toFixed(0) : 0}%</div></div>
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
              return <g key={p}><line x1={PAD.left} y1={y} x2={W-PAD.right} y2={y} stroke={T.border} strokeWidth={1}/><text x={PAD.left-6} y={y+4} fill={T.subtle} fontSize={9} textAnchor="end">{v.toFixed(0)}%</text></g>;
            })}
            {history.map((h, i) => {
              const v = h.spreadApr;
              const x = PAD.left + (i / history.length) * IW;
              const barTop = toY(Math.max(v, 0)), barBot = toY(Math.min(v, 0));
              const barH = Math.max(Math.abs(barBot - barTop), 2);
              const color = v >= 50 ? T.green : v >= 20 ? "#34d399" : v > 0 ? "#6ee7b7" : T.red;
              return <rect key={i} x={x} y={barTop} width={barW} height={barH} fill={color} rx={1} opacity={0.85}/>;
            })}
            <line x1={PAD.left} y1={avgY} x2={W-PAD.right} y2={avgY} stroke={T.blue} strokeWidth={2} strokeDasharray="8,5"/>
            <rect x={W-PAD.right-48} y={avgY-10} width={44} height={16} rx={4} fill="#dbeafe"/>
            <text x={W-PAD.right-26} y={avgY+2} fill={T.blue} fontSize={9} textAnchor="middle" fontWeight="700">{avg.toFixed(1)}%</text>
            {[0, Math.floor(history.length/2), history.length-1].map(i => i < history.length && (
              <text key={i} x={PAD.left+(i/history.length)*IW+barW/2} y={H-PAD.bottom+14} fill={T.subtle} fontSize={8} textAnchor="middle">
                {new Date(history[i].ts).toLocaleDateString([],{month:"short",day:"numeric"})}
              </text>
            ))}
          </svg>
        </div>
      )}
    </div>
  );
}

export default function RankingTab({ config }) {
  const [results, setResults]     = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [lastScan, setLastScan]   = useState(null);
  const [selected, setSelected]   = useState(null);
  const [dexStatus, setDexStatus] = useState({});
  const [maps, setMaps]           = useState({});
  const [debugInfo, setDebugInfo] = useState("");

  const runScan = useCallback(async () => {
    setLoading(true); setError(null); setSelected(null); setDebugInfo("");
    try {
      const [hlMap, asterMap, backMap] = await Promise.allSettled([
        fetchHL(), fetchAster(), fetchBackpack()
      ]).then(r => r.map(x => x.status === "fulfilled" ? x.value : {}));

      setMaps({ hlMap, asterMap, backMap });

      const hlSample   = ["BTC","ETH","SOL"].map(s => hlMap[s]   ? `${s}:$${(hlMap[s].vol24h/1e6).toFixed(1)}M fr${hlMap[s].fundingApr.toFixed(2)}%`   : `${s}:miss`).join(" ");
      const backSample = ["BTC","ETH","SOL"].map(s => backMap[s] ? `${s}:$${(backMap[s].vol24h/1e6).toFixed(1)}M fr${backMap[s].fundingApr.toFixed(2)}%` : `${s}:miss`).join(" ");
      const asterCount = Object.keys(asterMap).length;
      setDebugInfo(`HL: ${hlSample} | BP: ${backSample} | Aster:${asterCount}`);

      setDexStatus({
        HL:       Object.keys(hlMap).length,
        Aster:    Object.keys(asterMap).length,
        Backpack: Object.keys(backMap).length,
      });

      const allDexMaps = [
        { name: "HL",       map: hlMap },
        { name: "Aster",    map: asterMap },
        { name: "Backpack", map: backMap },
      ];

      const results = [];
      let filteredByVol = 0;

      for (const sym of Object.keys(hlMap)) {
        const available = allDexMaps
          .filter(d => d.map[sym])
          .map(d => ({ name: d.name, ...d.map[sym] }));
        if (available.length < 2) continue;

        let shortDex = available[0], longDex = available[0];
        for (const d of available) {
          if (d.fundingApr > shortDex.fundingApr) shortDex = d;
          if (d.fundingApr < longDex.fundingApr)  longDex  = d;
        }
        if (shortDex.name === longDex.name) continue;

        const spreadApr = shortDex.fundingApr - longDex.fundingApr;
        if (spreadApr < 1) continue;

        const priceDiff = shortDex.price > 0 && longDex.price > 0
          ? Math.abs((shortDex.price - longDex.price) / shortDex.price) * 100 : 99;
        if (priceDiff > 2) continue;

        const vol = Math.min(shortDex.vol24h, longDex.vol24h);

        if (vol < MIN_VOL) { filteredByVol++; continue; }

        const spreadPct = Math.max(shortDex.spreadPct || 0, longDex.spreadPct || 0);
        const oi        = Math.min(shortDex.oi || 0, longDex.oi || 0);
        const score     = calcScore({ spreadApr, spreadPct, vol, oi });

        results.push({
          symbol: sym,
          shortDex: shortDex.name, longDex: longDex.name,
          shortFunding: shortDex.fundingApr, longFunding: longDex.fundingApr,
          shortPrice: shortDex.price, longPrice: longDex.price,
          spreadApr, priceDiff, spreadPct, vol, oi, score,
          dexCount: available.length,
          allDex: available,
        });
      }

      setDebugInfo(prev => `${prev} | Filtrados por vol: ${filteredByVol} | Resultado: ${results.length}`);
      setResults(results.sort((a, b) => b.spreadApr - a.spreadApr));
      setLastScan(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ color: T.subtle, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            RANKING · HL × ASTER × BACKPACK · VOL MÍN $500K
          </div>
          {lastScan && (
            <div style={{ color: T.subtle, fontSize: 12, marginTop: 4 }}>
              {lastScan.toLocaleTimeString()} · {results.length} pares
              {Object.entries(dexStatus).map(([dex, n]) => (
                <span key={dex} style={{ marginLeft: 8, color: n > 0 ? T.green : T.red }}>
                  {n > 0 ? "✓" : "✗"}{dex}({n})
                </span>
              ))}
            </div>
          )}
          {debugInfo && <div style={{ color: T.subtle, fontSize: 11, marginTop: 2 }}>{debugInfo}</div>}
        </div>
        <button onClick={runScan} disabled={loading} style={{
          background: loading ? "#f1f5f9" : "#6366f120",
          border: `1px solid ${loading ? T.border : "#6366f144"}`,
          color: loading ? T.subtle : T.accent,
          borderRadius: 10, padding: "10px 28px",
          cursor: loading ? "not-allowed" : "pointer",
          fontFamily: "inherit", fontSize: 14, fontWeight: 700
        }}>
          {loading ? "Escaneando..." : "▶ Escanear ahora"}
        </button>
      </div>

      {error && <div style={{ background: T.redBg, border: "1px solid #fca5a5", borderRadius: 12, padding: 16, color: T.red, fontSize: 14 }}>Error: {error}</div>}

      {loading && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 40, textAlign: "center" }}>
          <div style={{ color: T.accent, fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Escaneando DEX...</div>
          <div style={{ color: T.subtle, fontSize: 13 }}>HL · Aster · Backpack · Filtrando vol &gt; $500K</div>
        </div>
      )}

      {!loading && results.length === 0 && !error && lastScan && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>🔍</div>
          <div style={{ color: T.muted, fontSize: 15 }}>Sin oportunidades con vol &gt; $500K ahora mismo</div>
          <div style={{ color: T.subtle, fontSize: 13, marginTop: 6 }}>{debugInfo}</div>
        </div>
      )}

      {!loading && results.length === 0 && !error && !lastScan && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 60, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
          <div style={{ color: T.muted, fontSize: 15 }}>Pulsa "Escanear ahora"</div>
          <div style={{ color: T.subtle, fontSize: 13, marginTop: 6 }}>Solo muestra tokens con vol &gt; $500K en ambos DEX</div>
        </div>
      )}

      {results.length > 0 && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "36px 90px 64px 110px 110px 90px 90px 60px", padding: "12px 16px", borderBottom: `1px solid ${T.border}`, background: "#f8fafc" }}>
            {["#", "TOKEN", "SCORE", "SHORT", "LONG", "SPREAD APR", "VOL MÍN", "DEX"].map(h => (
              <div key={h} style={{ color: T.subtle, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em" }}>{h}</div>
            ))}
          </div>
          {results.map((r, i) => {
            const c = getCls(r.score);
            const isSelect = selected?.symbol === r.symbol;
            return (
              <div key={r.symbol}>
                <div onClick={() => setSelected(isSelect ? null : r)} style={{
                  display: "grid", gridTemplateColumns: "36px 90px 64px 110px 110px 90px 90px 60px",
                  padding: "13px 16px", borderBottom: `1px solid ${T.border}`,
                  background: isSelect ? "#f8fafc" : "white", cursor: "pointer",
                }}>
                  <div style={{ color: T.subtle, fontSize: 12 }}>{i + 1}</div>
                  <div style={{ color: T.text, fontWeight: 800, fontSize: 14 }}>{r.symbol}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: c.color }} />
                    <span style={{ color: c.color, fontSize: 13, fontWeight: 700 }}>{r.score}</span>
                  </div>
                  <div>
                    <div style={{ color: T.red, fontSize: 12, fontWeight: 700 }}>{r.shortDex}</div>
                    <div style={{ color: T.red, fontSize: 10 }}>{r.shortFunding?.toFixed(1)}%</div>
                  </div>
                  <div>
                    <div style={{ color: T.green, fontSize: 12, fontWeight: 700 }}>{r.longDex}</div>
                    <div style={{ color: T.green, fontSize: 10 }}>{r.longFunding?.toFixed(1)}%</div>
                  </div>
                  <div style={{ color: T.yellow, fontSize: 16, fontWeight: 800 }}>{r.spreadApr?.toFixed(1)}%</div>
                  <div style={{ color: T.green, fontSize: 12, fontWeight: 600 }}>${(r.vol/1000).toFixed(0)}K</div>
                  <div style={{ color: T.subtle, fontSize: 11 }}>{r.dexCount}</div>
                </div>
                {isSelect && (
                  <div style={{ padding: "20px", background: "#f8fafc", borderBottom: `1px solid ${T.border}` }}>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
                      {r.allDex.map(d => (
                        <div key={d.name} style={{
                          background: d.name === r.shortDex ? T.redBg : d.name === r.longDex ? T.greenBg : "#f1f5f9",
                          border: `1px solid ${d.name === r.shortDex ? "#fca5a5" : d.name === r.longDex ? "#6ee7b7" : T.border}`,
                          borderRadius: 10, padding: "10px 14px", minWidth: 120
                        }}>
                          <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>{d.name}</div>
                          <div style={{ color: d.fundingApr > 0 ? T.red : T.green, fontSize: 16, fontWeight: 800 }}>
                            {d.fundingApr > 0 ? "+" : ""}{d.fundingApr?.toFixed(2)}%
                          </div>
                          <div style={{ color: T.subtle, fontSize: 10 }}>${d.price?.toFixed(4)}</div>
                          <div style={{ color: T.subtle, fontSize: 10 }}>Vol ${(d.vol24h/1000).toFixed(0)}K</div>
                          {d.name === r.shortDex && <div style={{ color: T.red, fontSize: 10, fontWeight: 700, marginTop: 4 }}>← SHORT</div>}
                          {d.name === r.longDex  && <div style={{ color: T.green, fontSize: 10, fontWeight: 700, marginTop: 4 }}>← LONG</div>}
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: T.muted, marginBottom: 16 }}>
                      <span>Price parity: <b style={{ color: r.priceDiff < 0.5 ? T.green : T.red }}>{r.priceDiff?.toFixed(3)}%</b></span>
                      <span>Spread mercado: <b>{(r.spreadPct*100).toFixed(3)}%</b></span>
                      <span>OI: <b>${(r.oi/1000).toFixed(0)}K</b></span>
                    </div>
                    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 }}>
                      <div style={{ color: T.muted, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>FUNDING DELTA (APR) — {r.symbol}</div>
                      <SpreadChart symbol={r.symbol} shortDex={r.shortDex} longDex={r.longDex}
                        hlMap={maps.hlMap || {}} asterMap={maps.asterMap || {}} backMap={maps.backMap || {}} />
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
          {results.length} tokens · vol &gt; $500K en ambos DEX · Clic en fila para historial
        </div>
      )}
    </div>
  );
}
