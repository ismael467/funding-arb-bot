import { useState, useCallback } from "react";

const HL_API    = "https://api.hyperliquid.xyz/info";
const ASTER_API = "https://fapi.asterdex.com";
const EXT_API   = "https://api.starknet.extended.exchange/api/v1/info/markets";

// Tokens crypto activos en Extended (verificados en vivo)
const EXT_CRYPTO_TOKENS = [
  "ENA","SUI","WIF","HYPE","WLFI","XRP","AAVE","AVAX","LTC",
  "KAITO","MELANIA","CAKE","MEGA","AZTEC","SPX","BTC","ETH","SOL",
  "DOGE","LINK","UNI","ARB","OP","MATIC","ATOM","DOT","ADA",
  "NEAR","FTM","INJ","TIA","SEI","STRK","JUP","PYTH","WLD",
  "BLUR","GMX","SNX","CRV","LDO","COMP","MKR","PENDLE","ENA",
  "RESOLV","TRUMP"
];

function calcScore({ fundingDiff, spreadPct, slippage, impact, vol, oi }) {
  const fs = Math.min(Math.abs(fundingDiff) / 0.0005, 1) * 25;
  const ss = Math.max(0, 1 - spreadPct / 0.001) * 20;
  const sl = Math.max(0, 1 - slippage / 0.001) * 20;
  const is = Math.max(0, 1 - impact / 0.05) * 20;
  const vs = Math.min(Math.log10(Math.max(vol, 1)) / 7, 1) * 10;
  const os = Math.min(Math.log10(Math.max(oi, 1)) / 7, 1) * 5;
  return Math.min(100, Math.max(0, Math.round(fs + ss + sl + is + vs + os)));
}

function getClassification(score) {
  if (score >= 80) return { label: "TOP",   color: "#00ff88", emoji: "🔥" };
  if (score >= 65) return { label: "GOOD",  color: "#44ff44", emoji: "🟢" };
  if (score >= 50) return { label: "OK",    color: "#ffcc00", emoji: "🟡" };
  return              { label: "AVOID", color: "#ff4444", emoji: "🔴" };
}

async function fetchHLAll() {
  const res = await fetch(HL_API, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" })
  });
  const json = await res.json();
  const meta = json[0]?.universe || [];
  const ctxs = json[1] || [];
  const midRes = await fetch(HL_API, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" })
  });
  const mids = await midRes.json();
  const map = {};
  meta.forEach((a, i) => {
    const ctx   = ctxs[i];
    const price = parseFloat(mids[a.name] || ctx?.markPx || 0);
    map[a.name] = {
      fundingApr: parseFloat(ctx?.funding || 0) * 3 * 365 * 100,
      price,
      vol24h:     parseFloat(ctx?.dayNtlVlm || 0),
      oi:         parseFloat(ctx?.openInterest || 0) * price,
      impactBid:  parseFloat(ctx?.impactPxs?.[0] || price * 0.999),
      impactAsk:  parseFloat(ctx?.impactPxs?.[1] || price * 1.001),
      spreadPct:  price > 0 ? (parseFloat(ctx?.impactPxs?.[1] || price * 1.001) - parseFloat(ctx?.impactPxs?.[0] || price * 0.999)) / price : 0,
    };
  });
  return map;
}

async function fetchExtAll() {
  const res  = await fetch(EXT_API);
  const json = await res.json();
  const markets = json.data || json.markets || json || [];
  const map = {};
  markets.filter(m => m.status === "ACTIVE").forEach(m => {
    const sym   = m.assetName || m.name?.replace("-USD", "").replace("-PERP", "");
    const price = parseFloat(m.marketStats?.markPrice || m.markPrice || 0);
    const fr1h  = parseFloat(m.marketStats?.fundingRate || m.fundingRate || 0);
    const bid   = parseFloat(m.marketStats?.bidPrice || m.bidPrice || price * 0.999);
    const ask   = parseFloat(m.marketStats?.askPrice || m.askPrice || price * 1.001);
    map[sym] = {
      fundingApr: fr1h * 24 * 365 * 100,
      price,
      vol24h:    parseFloat(m.marketStats?.dailyVolume || m.dailyVolume || 0),
      oi:        parseFloat(m.marketStats?.openInterest || m.openInterest || 0),
      spreadPct: price > 0 ? (ask - bid) / price : 0,
    };
  });
  return map;
}

async function fetchAsterAll() {
  try {
    const res    = await fetch(`${ASTER_API}/fapi/v1/premiumIndex`);
    const json   = await res.json();
    const tRes   = await fetch(`${ASTER_API}/fapi/v1/ticker/24hr`);
    const tJson  = await tRes.json();
    const tickerMap = {};
    (Array.isArray(tJson) ? tJson : [tJson]).forEach(t => {
      if (t.symbol) tickerMap[t.symbol] = t;
    });
    const map = {};
    (Array.isArray(json) ? json : [json]).forEach(p => {
      if (!p.symbol) return;
      const sym   = p.symbol.replace("USDT", "").replace("BUSD", "");
      const price = parseFloat(p.markPrice || p.p || 0);
      const t     = tickerMap[p.symbol] || {};
      const bid   = parseFloat(t.bidPrice || price * 0.999);
      const ask   = parseFloat(t.askPrice || price * 1.001);
      map[sym] = {
        fundingApr: parseFloat(p.lastFundingRate || p.r || 0) * 3 * 365 * 100,
        price,
        vol24h:    parseFloat(t.quoteVolume || 0),
        oi:        0, // se añade por separado si se necesita
        spreadPct: price > 0 ? (ask - bid) / price : 0,
      };
    });
    return map;
  } catch { return {}; }
}

async function scanAllTokens(positionSize = 150) {
  const [hlMap, extMap, asterMap] = await Promise.all([
    fetchHLAll(),
    fetchExtAll(),
    fetchAsterAll(),
  ]);

  const results = [];
  // Todos los tokens que están en HL
  const allSymbols = Object.keys(hlMap);

  for (const sym of allSymbols) {
    const hl  = hlMap[sym];
    const ext = extMap[sym];
    const ast = asterMap[sym];

    // Necesitamos al menos HL + otro DEX
    const available = [
      hl  ? { name: "HL",       ...hl  } : null,
      ext ? { name: "Extended", ...ext } : null,
      ast ? { name: "Aster",    ...ast } : null,
    ].filter(Boolean);

    if (available.length < 2) continue;

    // Encontrar mejor par long/short
    let shortDex = available[0];
    let longDex  = available[0];
    for (const d of available) {
      if (d.fundingApr > shortDex.fundingApr) shortDex = d;
      if (d.fundingApr < longDex.fundingApr)  longDex  = d;
    }

    if (shortDex.name === longDex.name) continue;

    const spreadApr  = shortDex.fundingApr - longDex.fundingApr;
    if (spreadApr <= 0) continue;

    const fundingDiff = spreadApr / 100;
    const priceDiff   = shortDex.price > 0 && longDex.price > 0
      ? Math.abs((shortDex.price - longDex.price) / shortDex.price) * 100 : 99;
    const spreadPct   = Math.max(shortDex.spreadPct || 0, longDex.spreadPct || 0);
    const slippage    = spreadPct * 0.5;
    const liquidity   = Math.min(
      shortDex.vol24h * 0.01 || 0,
      longDex.vol24h  * 0.01 || 0
    );
    const impact  = liquidity > 0 ? positionSize / liquidity : 1;
    const maxSize = liquidity * 0.03;
    const vol     = Math.min(shortDex.vol24h, longDex.vol24h);
    const oi      = Math.min(shortDex.oi || 0, longDex.oi || 0);

    const score = calcScore({ fundingDiff, spreadPct, slippage, impact, vol, oi });

    // Filtros duros
    const passes = vol >= 30000 && spreadPct < 0.005 && impact < 0.5 && priceDiff < 1.0;

    results.push({
      symbol: sym,
      shortDex: shortDex.name,
      longDex:  longDex.name,
      shortFunding: shortDex.fundingApr,
      longFunding:  longDex.fundingApr,
      spreadApr, priceDiff, spreadPct, slippage,
      impact, liquidity, maxSize, vol, oi,
      score, passes,
      dexCount: available.length,
      allDex: available,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 30);
}

export default function RankingTab({ config }) {
  const [results, setResults]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [lastScan, setLastScan] = useState(null);
  const [selected, setSelected] = useState(null);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await scanAllTokens(config?.positionSize || 150);
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
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ color: "#555", fontSize: 11, letterSpacing: 1 }}>RANKING MULTI-TOKEN · HL × ASTER × EXTENDED</div>
          {lastScan && <div style={{ color: "#333", fontSize: 11, marginTop: 4 }}>Último scan: {lastScan.toLocaleTimeString()}</div>}
        </div>
        <button onClick={runScan} disabled={loading} style={{
          background: loading ? "#111" : "#00ff8820",
          border: `1px solid ${loading ? "#222" : "#00ff8844"}`,
          color: loading ? "#333" : "#00ff88",
          borderRadius: 8, padding: "10px 24px",
          cursor: loading ? "not-allowed" : "pointer",
          fontFamily: "inherit", fontSize: 13, fontWeight: 700
        }}>
          {loading ? "Escaneando..." : "▶ Escanear ahora"}
        </button>
      </div>

      {error && (
        <div style={{ background: "#ff444410", border: "1px solid #ff444433", borderRadius: 10, padding: 14, color: "#ff6666", fontSize: 13 }}>
          Error: {error}
        </div>
      )}

      {loading && (
        <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 10, padding: 30, textAlign: "center" }}>
          <div style={{ color: "#00ff88", fontSize: 13, marginBottom: 8 }}>Consultando APIs...</div>
          <div style={{ color: "#333", fontSize: 11 }}>HL + Aster + Extended · puede tardar 15-30 segundos</div>
        </div>
      )}

      {!loading && results.length === 0 && !error && (
        <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 10, padding: 40, textAlign: "center", color: "#333", fontSize: 13 }}>
          Pulsa "Escanear ahora" para buscar oportunidades en todos los tokens
        </div>
      )}

      {/* Tabla resultados */}
      {results.length > 0 && (
        <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 10, overflow: "hidden" }}>
          {/* Header tabla */}
          <div style={{
            display: "grid", gridTemplateColumns: "40px 80px 70px 1fr 1fr 80px 80px 70px",
            padding: "10px 16px", borderBottom: "1px solid #1a1a1a",
            color: "#444", fontSize: 10, letterSpacing: 1
          }}>
            <div>#</div>
            <div>TOKEN</div>
            <div>SCORE</div>
            <div>SHORT DEX</div>
            <div>LONG DEX</div>
            <div>SPREAD</div>
            <div>MAX SIZE</div>
            <div>DEX</div>
          </div>

          {results.map((r, i) => {
            const cls      = getClassification(r.score);
            const isSelect = selected?.symbol === r.symbol;
            return (
              <div key={r.symbol}>
                <div
                  onClick={() => setSelected(isSelect ? null : r)}
                  style={{
                    display: "grid", gridTemplateColumns: "40px 80px 70px 1fr 1fr 80px 80px 70px",
                    padding: "12px 16px", borderBottom: "1px solid #0f0f0f",
                    background: isSelect ? "#1a1a1a" : r.passes ? "transparent" : "#ff44440a",
                    cursor: "pointer", transition: "background 0.2s"
                  }}
                >
                  <div style={{ color: "#444", fontSize: 12 }}>{i + 1}</div>
                  <div style={{ color: "#fff", fontWeight: 700, fontSize: 13 }}>{r.symbol}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: cls.color, flexShrink: 0 }} />
                    <span style={{ color: cls.color, fontSize: 13, fontWeight: 700 }}>{r.score}</span>
                  </div>
                  <div>
                    <span style={{ color: "#ff6666", fontSize: 11, fontWeight: 700 }}>{r.shortDex}</span>
                    <span style={{ color: "#444", fontSize: 10 }}> {r.shortFunding?.toFixed(1)}%</span>
                  </div>
                  <div>
                    <span style={{ color: "#00ff88", fontSize: 11, fontWeight: 700 }}>{r.longDex}</span>
                    <span style={{ color: "#444", fontSize: 10 }}> {r.longFunding?.toFixed(1)}%</span>
                  </div>
                  <div style={{ color: "#ffcc00", fontSize: 12, fontWeight: 700 }}>{r.spreadApr?.toFixed(1)}%</div>
                  <div style={{ color: r.maxSize > 100 ? "#00ff88" : "#555", fontSize: 12 }}>${r.maxSize?.toFixed(0)}</div>
                  <div style={{ color: "#555", fontSize: 11 }}>{r.dexCount} DEX</div>
                </div>

                {/* Detalle expandible */}
                {isSelect && (
                  <div style={{ padding: "16px 20px", background: "#0f0f0f", borderBottom: "1px solid #1a1a1a" }}>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                      {r.allDex.map(d => (
                        <div key={d.name} style={{
                          background: "#111", border: `1px solid ${d.name === r.shortDex ? "#ff444433" : d.name === r.longDex ? "#00ff8833" : "#1e1e1e"}`,
                          borderRadius: 8, padding: "10px 14px", minWidth: 120
                        }}>
                          <div style={{ color: "#555", fontSize: 10, marginBottom: 4 }}>{d.name}</div>
                          <div style={{ color: d.fundingApr > 0 ? "#ff6666" : "#66ff66", fontSize: 14, fontWeight: 700 }}>{d.fundingApr?.toFixed(2)}%</div>
                          <div style={{ color: "#444", fontSize: 10, marginTop: 2 }}>${d.price?.toFixed(4)}</div>
                          <div style={{ color: "#333", fontSize: 10 }}>Vol ${(d.vol24h/1000).toFixed(0)}K</div>
                          {d.name === r.shortDex && <div style={{ color: "#ff4444", fontSize: 10, marginTop: 4, fontWeight: 700 }}>← SHORT</div>}
                          {d.name === r.longDex  && <div style={{ color: "#00ff88", fontSize: 10, marginTop: 4, fontWeight: 700 }}>← LONG</div>}
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 11, color: "#555" }}>
                      <span>Spread mercado: <b style={{ color: "#aaa" }}>{(r.spreadPct * 100).toFixed(3)}%</b></span>
                      <span>Slippage: <b style={{ color: "#aaa" }}>{(r.slippage * 100).toFixed(3)}%</b></span>
                      <span>Impact: <b style={{ color: r.impact < 0.05 ? "#00ff88" : "#ff4444" }}>{(r.impact * 100).toFixed(2)}%</b></span>
                      <span>Price parity: <b style={{ color: r.priceDiff < 0.15 ? "#00ff88" : "#ff4444" }}>{r.priceDiff?.toFixed(3)}%</b></span>
                      <span>Vol mín: <b style={{ color: "#aaa" }}>${(r.vol/1000).toFixed(0)}K</b></span>
                      {!r.passes && <span style={{ color: "#ff4444" }}>⚠ No pasa filtros duros</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {results.length > 0 && (
        <div style={{ color: "#333", fontSize: 11, textAlign: "center" }}>
          {results.filter(r => r.passes).length} oportunidades pasan filtros duros · {results.length} total escaneadas
        </div>
      )}
    </div>
  );
}
