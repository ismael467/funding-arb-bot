import { useState, useCallback } from "react";

const PROXY = "https://cors-proxy.munichbro69.workers.dev";
const HL_API    = "https://api.hyperliquid.xyz/info";
const ASTER_API = "https://fapi.asterdex.com";
const EDGEX_API = "https://api.edgex.exchange/api/v1/public";
const BACK_API  = "https://api.backpack.exchange/api/v1";

const T = {
  bg: "#f0f2f5", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", subtle: "#94a3b8",
  green: "#10b981", greenBg: "#d1fae5",
  red: "#ef4444", redBg: "#fee2e2",
  yellow: "#f59e0b", blue: "#3b82f6", accent: "#6366f1",
};

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
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  const map = {};
  (Array.isArray(prem) ? prem : []).forEach(p => {
    if (!p.symbol) return;
    const sym   = p.symbol.replace("USDT", "").replace("BUSD", "");
    const price = parseFloat(p.markPrice || p.p || 0);
    if (!price) return;
    const t = tickerMap[p.symbol] || {};
    const bid = parseFloat(t.bidPrice || price * 0.999);
    const ask = parseFloat(t.askPrice || price * 1.001);
    map[sym] = {
      dex: "Aster",
      fundingApr: parseFloat(p.lastFundingRate || p.r || 0) * 3 * 365 * 100,
      price,
      vol24h:    parseFloat(t.quoteVolume || 0),
      oi:        0,
      spreadPct: price > 0 ? (ask - bid) / price : 0,
    };
  });
  return map;
}

async function fetchEdgeX() {
  try {
    const json = await proxyGet(`${EDGEX_API}/funding/getLatestFundingRate`);
    const rates = json.data || json || [];
    const map = {};
    rates.forEach(r => {
      const sym   = r.contractId?.replace("USDT", "").replace("-PERP", "") || r.symbol?.replace("USDT", "");
      if (!sym) return;
      map[sym] = {
        dex: "edgeX",
        fundingApr: parseFloat(r.fundingRate || 0) * 3 * 365 * 100,
        price:  parseFloat(r.markPrice || r.indexPrice || 0),
        vol24h: parseFloat(r.volume24h || r.turnover24h || 0),
        oi:     parseFloat(r.openInterest || 0),
        spreadPct: 0,
      };
    });
    return map;
  } catch { return {}; }
}

async function fetchBackpack() {
  try {
    const json = await proxyGet(`${BACK_API}/markPrices`);
    const markets = Array.isArray(json) ? json : [];
    const map = {};
    markets.forEach(m => {
      if (!m.symbol?.includes("PERP")) return;
      const sym   = m.symbol.replace("_USDC_PERP", "").replace("_USDT_PERP", "");
      const price = parseFloat(m.markPrice || 0);
      if (!price) return;
      map[sym] = {
        dex: "Backpack",
        fundingApr: parseFloat(m.fundingRate || 0) * 3 * 365 * 100,
        price,
        vol24h: parseFloat(m.volume24h || 0),
        oi:     parseFloat(m.openInterest || 0) * price,
        spreadPct: 0,
      };
    });
    return map;
  } catch { return {}; }
}

async function scanAll(positionSize = 150) {
  const [hlMap, asterMap, edgeMap, backMap] = await Promise.allSettled([
    fetchHL(), fetchAster(), fetchEdgeX(), fetchBackpack()
  ]).then(r => r.map(x => x.status === "fulfilled" ? x.value : {}));

  const allDexMaps = [
    { name: "HL",       map: hlMap },
    { name: "Aster",    map: asterMap },
    { name: "edgeX",    map: edgeMap },
    { name: "Backpack", map: backMap },
  ];

  const dexsAvailable = allDexMaps.filter(d => Object.keys(d.map).length > 0);
  const results = [];

  // Tokens en HL como base
  for (const sym of Object.keys(hlMap)) {
    const available = dexsAvailable
      .filter(d => d.map[sym])
      .map(d => ({ name: d.name, ...d.map[sym] }));

    if (available.length < 2) continue;

    // Mejor par
    let shortDex = available[0], longDex = available[0];
    for (const d of available) {
      if (d.fundingApr > shortDex.fundingApr) shortDex = d;
      if (d.fundingApr < longDex.fundingApr)  longDex  = d;
    }
    if (shortDex.name === longDex.name) continue;

    const spreadApr  = shortDex.fundingApr - longDex.fundingApr;
    if (spreadApr < 1) continue;

    const priceDiff = shortDex.price > 0 && longDex.price > 0
      ? Math.abs((shortDex.price - longDex.price) / shortDex.price) * 100 : 99;
    if (priceDiff > 2) continue;

    const spreadPct = Math.max(shortDex.spreadPct || 0, longDex.spreadPct || 0);
    const vol       = Math.min(shortDex.vol24h, longDex.vol24h);
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
      passes: vol >= 50000 && spreadApr > 5,
    });
  }

  return results.sort((a, b) => b.spreadApr - a.spreadApr);
}

export default function RankingTab({ config }) {
  const [results, setResults]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [lastScan, setLastScan] = useState(null);
  const [selected, setSelected] = useState(null);
  const [dexStatus, setDexStatus] = useState({});

  const runScan = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [hlMap, asterMap, edgeMap, backMap] = await Promise.allSettled([
        fetchHL(), fetchAster(), fetchEdgeX(), fetchBackpack()
      ]).then(r => r.map(x => x.status === "fulfilled" ? x.value : {}));

      setDexStatus({
        HL:       Object.keys(hlMap).length,
        Aster:    Object.keys(asterMap).length,
        edgeX:    Object.keys(edgeMap).length,
        Backpack: Object.keys(backMap).length,
      });

      const res = await scanAll(config?.positionSize || 150);
      setResults(res);
      setLastScan(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [config?.positionSize]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ color: T.subtle, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            RANKING MULTI-TOKEN · HL × ASTER × EDGEX × BACKPACK
          </div>
          {lastScan && (
            <div style={{ color: T.subtle, fontSize: 12, marginTop: 4 }}>
              {lastScan.toLocaleTimeString()} · {results.length} pares encontrados
              {Object.entries(dexStatus).map(([dex, n]) => n > 0
                ? <span key={dex} style={{ marginLeft: 8, color: T.green }}>✓{dex}({n})</span>
                : <span key={dex} style={{ marginLeft: 8, color: T.red }}>✗{dex}</span>
              )}
            </div>
          )}
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

      {error && (
        <div style={{ background: T.redBg, border: "1px solid #fca5a5", borderRadius: 12, padding: 16, color: T.red, fontSize: 14 }}>
          Error: {error}
        </div>
      )}

      {loading && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 40, textAlign: "center" }}>
          <div style={{ color: T.accent, fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Escaneando 4 DEX...</div>
          <div style={{ color: T.subtle, fontSize: 13 }}>HL · Aster · edgeX · Backpack · ~20 segundos</div>
        </div>
      )}

      {!loading && results.length === 0 && !error && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 60, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
          <div style={{ color: T.muted, fontSize: 15 }}>Pulsa "Escanear ahora" para buscar oportunidades</div>
          <div style={{ color: T.subtle, fontSize: 13, marginTop: 6 }}>Cruza HL × Aster × edgeX × Backpack en tiempo real</div>
        </div>
      )}

      {results.length > 0 && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "36px 90px 64px 110px 110px 90px 70px 60px", padding: "12px 16px", borderBottom: `1px solid ${T.border}`, background: "#f8fafc" }}>
            {["#", "TOKEN", "SCORE", "SHORT", "LONG", "SPREAD APR", "VOL", "DEX"].map(h => (
              <div key={h} style={{ color: T.subtle, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em" }}>{h}</div>
            ))}
          </div>

          {results.slice(0, 30).map((r, i) => {
            const c = getCls(r.score);
            const isSelect = selected?.symbol === r.symbol;
            return (
              <div key={r.symbol}>
                <div onClick={() => setSelected(isSelect ? null : r)} style={{
                  display: "grid", gridTemplateColumns: "36px 90px 64px 110px 110px 90px 70px 60px",
                  padding: "13px 16px", borderBottom: `1px solid ${T.border}`,
                  background: isSelect ? "#f8fafc" : r.passes ? "white" : "#fffbeb",
                  cursor: "pointer",
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
                  <div style={{ color: T.subtle, fontSize: 11 }}>${(r.vol/1000).toFixed(0)}K</div>
                  <div style={{ color: T.subtle, fontSize: 11 }}>{r.dexCount}</div>
                </div>

                {isSelect && (
                  <div style={{ padding: "16px 20px", background: "#f8fafc", borderBottom: `1px solid ${T.border}` }}>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
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
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: T.muted }}>
                      <span>Price parity: <b style={{ color: r.priceDiff < 0.5 ? T.green : T.red }}>{r.priceDiff?.toFixed(3)}%</b></span>
                      <span>Spread mercado: <b style={{ color: T.text }}>{(r.spreadPct*100).toFixed(3)}%</b></span>
                      <span>OI: <b style={{ color: T.text }}>${(r.oi/1000).toFixed(0)}K</b></span>
                      {!r.passes && <span style={{ color: T.yellow, fontWeight: 600 }}>⚠ Vol o spread insuficiente</span>}
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
          {results.filter(r => r.passes).length} oportunidades sólidas · {results.length} total · Clic en fila para detalles
        </div>
      )}
    </div>
  );
}
