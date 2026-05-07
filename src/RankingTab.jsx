import { useState, useCallback } from "react";

const HL_API  = "https://api.hyperliquid.xyz/info";
const EXT_API = "https://api.starknet.extended.exchange/api/v1/info/markets";

function calcScore({ fundingDiff, spreadPct, slippage, impact, vol, oi }) {
  const fs = Math.min(Math.abs(fundingDiff) / 0.0005, 1) * 25;
  const ss = Math.max(0, 1 - spreadPct / 0.001) * 20;
  const sl = Math.max(0, 1 - slippage / 0.001) * 20;
  const is = Math.max(0, 1 - impact / 0.05) * 20;
  const vs = Math.min(Math.log10(Math.max(vol, 1)) / 7, 1) * 10;
  const os = Math.min(Math.log10(Math.max(oi, 1)) / 7, 1) * 5;
  return Math.min(100, Math.max(0, Math.round(fs + ss + sl + is + vs + os)));
}

function getCls(score) {
  if (score >= 80) return { label: "TOP",   color: "#10b981", bg: "#d1fae5", emoji: "🔥" };
  if (score >= 65) return { label: "GOOD",  color: "#10b981", bg: "#d1fae5", emoji: "🟢" };
  if (score >= 50) return { label: "OK",    color: "#f59e0b", bg: "#fef3c7", emoji: "🟡" };
  return              { label: "AVOID", color: "#ef4444", bg: "#fee2e2", emoji: "🔴" };
}

async function fetchHLAll() {
  const [metaRes, midRes] = await Promise.all([
    fetch(HL_API, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" })
    }),
    fetch(HL_API, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" })
    })
  ]);
  const metaJson = await metaRes.json();
  const mids     = await midRes.json();
  const meta = metaJson[0]?.universe || [];
  const ctxs = metaJson[1] || [];
  const map  = {};
  meta.forEach((a, i) => {
    const ctx   = ctxs[i];
    const price = parseFloat(mids[a.name] || ctx?.markPx || 0);
    if (!price) return;
    map[a.name] = {
      fundingApr: parseFloat(ctx?.funding || 0) * 3 * 365 * 100,
      price,
      vol24h:    parseFloat(ctx?.dayNtlVlm || 0),
      oi:        parseFloat(ctx?.openInterest || 0) * price,
      impactBid: parseFloat(ctx?.impactPxs?.[0] || price * 0.999),
      impactAsk: parseFloat(ctx?.impactPxs?.[1] || price * 1.001),
      spreadPct: price > 0
        ? (parseFloat(ctx?.impactPxs?.[1] || price*1.001) - parseFloat(ctx?.impactPxs?.[0] || price*0.999)) / price
        : 0,
    };
  });
  return map;
}

async function fetchExtAll() {
  const res    = await fetch(EXT_API);
  const json   = await res.json();
  const markets = json.data || json.markets || json || [];
  const map = {};
  markets
    .filter(m => m.status === "ACTIVE" && m.category === "Crypto")
    .forEach(m => {
      const sym   = m.assetName || m.name?.split("-")[0];
      if (!sym) return;
      const stats = m.marketStats || m;
      const price = parseFloat(stats.markPrice || stats.indexPrice || 0);
      if (!price) return;
      const fr1h  = parseFloat(stats.fundingRate || 0);
      const bid   = parseFloat(stats.bidPrice || price * 0.999);
      const ask   = parseFloat(stats.askPrice || price * 1.001);
      map[sym] = {
        fundingApr: fr1h * 24 * 365 * 100,
        price,
        vol24h:    parseFloat(stats.dailyVolume || 0),
        oi:        parseFloat(stats.openInterest || 0),
        spreadPct: price > 0 ? (ask - bid) / price : 0,
      };
    });
  return map;
}

async function scanAll(positionSize = 150) {
  const [hlMap, extMap] = await Promise.all([fetchHLAll(), fetchExtAll()]);

  const results = [];

  // Tokens que están en AMBOS DEX
  const common = Object.keys(hlMap).filter(sym => extMap[sym]);

  for (const sym of common) {
    const hl  = hlMap[sym];
    const ext = extMap[sym];

    // Detectar dirección
    const hlFunding  = hl.fundingApr;
    const extFunding = ext.fundingApr;
    const spreadApr  = hlFunding - extFunding;

    // Si el spread es 0 o negativo no hay oportunidad en esta dirección
    // Tomamos el valor absoluto y asignamos la dirección correcta
    const abSpread = Math.abs(spreadApr);
    if (abSpread < 0.1) continue; // mínimo 0.1% APR de spread

    const shortDex     = spreadApr > 0 ? "HL"       : "Extended";
    const longDex      = spreadApr > 0 ? "Extended" : "HL";
    const shortFunding = spreadApr > 0 ? hlFunding  : extFunding;
    const longFunding  = spreadApr > 0 ? extFunding : hlFunding;

    const priceDiff = hl.price > 0
      ? Math.abs((hl.price - ext.price) / hl.price) * 100 : 99;

    const spreadPct = Math.max(hl.spreadPct || 0, ext.spreadPct || 0);
    const slippage  = spreadPct * 0.5;
    const vol       = Math.min(hl.vol24h, ext.vol24h);
    const oi        = Math.min(hl.oi || 0, ext.oi || 0);
    const liquidity = vol * 0.01;
    const impact    = liquidity > 0 ? positionSize / liquidity : 1;
    const maxSize   = liquidity * 0.03;
    const fundingDiff = abSpread / 100;

    const score = calcScore({ fundingDiff, spreadPct, slippage, impact, vol, oi });

    const passes = vol >= 30000 && priceDiff < 1.0 && abSpread > 1;

    results.push({
      symbol: sym,
      shortDex, longDex, shortFunding, longFunding,
      spreadApr: abSpread, priceDiff, spreadPct, slippage,
      impact, liquidity, maxSize, vol, oi, score, passes,
      hlPrice: hl.price, extPrice: ext.price,
      hlVol: hl.vol24h, extVol: ext.vol24h,
    });
  }

  return results.sort((a, b) => b.spreadApr - a.spreadApr);
}

const T = {
  bg: "#f0f2f5", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", subtle: "#94a3b8",
  green: "#10b981", red: "#ef4444", yellow: "#f59e0b", blue: "#3b82f6",
  accent: "#6366f1",
};

export default function RankingTab({ config }) {
  const [results, setResults]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [lastScan, setLastScan] = useState(null);
  const [selected, setSelected] = useState(null);

  const runScan = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await scanAll(config?.positionSize || 150);
      setResults(res);
      setLastScan(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [config?.positionSize]);

  const passing = results.filter(r => r.passes);
  const all     = results;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ color: T.subtle, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            RANKING MULTI-TOKEN · HL × EXTENDED
          </div>
          {lastScan && <div style={{ color: T.subtle, fontSize: 12, marginTop: 4 }}>Último scan: {lastScan.toLocaleTimeString()} · {all.length} tokens encontrados · {passing.length} pasan filtros</div>}
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
        <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 12, padding: 16, color: T.red, fontSize: 14 }}>
          Error: {error}
        </div>
      )}

      {loading && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 40, textAlign: "center" }}>
          <div style={{ color: T.accent, fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Escaneando tokens...</div>
          <div style={{ color: T.subtle, fontSize: 13 }}>Consultando HL + Extended · puede tardar 15-20 segundos</div>
        </div>
      )}

      {!loading && results.length === 0 && !error && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 60, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
          <div style={{ color: T.muted, fontSize: 15 }}>Pulsa "Escanear ahora" para buscar oportunidades</div>
          <div style={{ color: T.subtle, fontSize: 13, marginTop: 6 }}>Analiza todos los tokens comunes entre HL y Extended</div>
        </div>
      )}

      {/* Tabla */}
      {results.length > 0 && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
          {/* Header tabla */}
          <div style={{ display: "grid", gridTemplateColumns: "40px 90px 70px 100px 100px 90px 80px 80px", padding: "12px 20px", borderBottom: `1px solid ${T.border}`, background: "#f8fafc" }}>
            {["#", "TOKEN", "SCORE", "SHORT", "LONG", "SPREAD APR", "MAX $", "VOL"].map(h => (
              <div key={h} style={{ color: T.subtle, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em" }}>{h}</div>
            ))}
          </div>

          {results.map((r, i) => {
            const c        = getCls(r.score);
            const isSelect = selected?.symbol === r.symbol;
            return (
              <div key={r.symbol}>
                <div
                  onClick={() => setSelected(isSelect ? null : r)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "40px 90px 70px 100px 100px 90px 80px 80px",
                    padding: "14px 20px",
                    borderBottom: `1px solid ${T.border}`,
                    background: isSelect ? "#f8fafc" : r.passes ? "white" : "#fffbeb",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ color: T.subtle, fontSize: 13 }}>{i + 1}</div>
                  <div style={{ color: T.text, fontWeight: 800, fontSize: 14 }}>{r.symbol}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: c.color }} />
                    <span style={{ color: c.color, fontSize: 14, fontWeight: 700 }}>{r.score}</span>
                  </div>
                  <div>
                    <span style={{ color: T.red, fontSize: 12, fontWeight: 700 }}>{r.shortDex}</span>
                    <div style={{ color: T.red, fontSize: 11 }}>{r.shortFunding?.toFixed(1)}%</div>
                  </div>
                  <div>
                    <span style={{ color: T.green, fontSize: 12, fontWeight: 700 }}>{r.longDex}</span>
                    <div style={{ color: T.green, fontSize: 11 }}>{r.longFunding?.toFixed(1)}%</div>
                  </div>
                  <div style={{ color: T.yellow, fontSize: 16, fontWeight: 800 }}>{r.spreadApr?.toFixed(1)}%</div>
                  <div style={{ color: r.maxSize > 50 ? T.green : T.subtle, fontSize: 13, fontWeight: 600 }}>${r.maxSize?.toFixed(0)}</div>
                  <div style={{ color: T.subtle, fontSize: 12 }}>${(r.vol/1000).toFixed(0)}K</div>
                </div>

                {/* Detalle expandible */}
                {isSelect && (
                  <div style={{ padding: "16px 20px", background: "#f8fafc", borderBottom: `1px solid ${T.border}` }}>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                      {[
                        { name: r.shortDex, funding: r.shortFunding, price: r.shortDex === "HL" ? r.hlPrice : r.extPrice, vol: r.shortDex === "HL" ? r.hlVol : r.extVol, side: "SHORT" },
                        { name: r.longDex,  funding: r.longFunding,  price: r.longDex  === "HL" ? r.hlPrice : r.extPrice, vol: r.longDex  === "HL" ? r.hlVol : r.extVol, side: "LONG"  },
                      ].map(d => (
                        <div key={d.name} style={{
                          background: d.side === "SHORT" ? "#fee2e2" : "#d1fae5",
                          border: `1px solid ${d.side === "SHORT" ? "#fca5a5" : "#6ee7b7"}`,
                          borderRadius: 10, padding: "12px 16px", minWidth: 140
                        }}>
                          <div style={{ color: d.side === "SHORT" ? T.red : T.green, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>{d.side} · {d.name}</div>
                          <div style={{ color: T.text, fontSize: 18, fontWeight: 800 }}>{d.funding?.toFixed(2)}% APR</div>
                          <div style={{ color: T.muted, fontSize: 12, marginTop: 2 }}>${d.price?.toFixed(4)} · Vol ${(d.vol/1000).toFixed(0)}K</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 12, color: T.muted }}>
                      <span>Spread mercado: <b style={{ color: T.text }}>{(r.spreadPct*100).toFixed(3)}%</b></span>
                      <span>Impact: <b style={{ color: r.impact < 0.05 ? T.green : T.red }}>{(r.impact*100).toFixed(2)}%</b></span>
                      <span>Price parity: <b style={{ color: r.priceDiff < 0.15 ? T.green : T.red }}>{r.priceDiff?.toFixed(3)}%</b></span>
                      <span>OI Extended: <b style={{ color: T.text }}>${(r.oi/1000).toFixed(0)}K</b></span>
                      {!r.passes && <span style={{ color: T.yellow, fontWeight: 600 }}>⚠ No pasa todos los filtros</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
