import { useState, useCallback, useEffect, useMemo } from "react";

const PROXY          = "https://cors-proxy.munichbro69.workers.dev";
const HL_API         = "https://api.hyperliquid.xyz/info";
const ASTER_API      = "https://fapi.asterdex.com";
const DYDX_API       = "https://indexer.dydx.trade";
const ASTER_COMP_URL = "https://www.asterdex.com/bapi/future/v1/public/future/aster/marketing/funding-rate-comparison";

const PERIOD_TO_ANNUAL = { "1Y": 1, "1M": 12, "1W": 52, "1D": 365, "8h": 1095, "4h": 2190 };
const FIXED_TOKENS     = ["WLFI", "ETH", "BTC", "SOL"];
const CACHE_KEY        = "fundingArb_rates_v5";
const CACHE_TTL        = 15 * 60 * 1000;

const T = {
  bg: "#f0f2f5", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", subtle: "#94a3b8",
  green: "#10b981", greenBg: "#d1fae5",
  red: "#ef4444", redBg: "#fee2e2",
  yellow: "#f59e0b", blue: "#3b82f6", accent: "#6366f1",
};

// ─── Network ──────────────────────────────────────────────────────────────────

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

// ─── DEX fetchers ─────────────────────────────────────────────────────────────

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
      vol24h: parseFloat(ctx?.dayNtlVlm || 0),
      oi:     parseFloat(ctx?.openInterest || 0) * price,
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
    const lastRate    = parseFloat(p.lastFundingRate || 0);
    const premium     = idxPx > 0 ? (markPx - idxPx) / idxPx : 0;
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

async function fetchDydx() {
  try {
    const res  = await fetch(`${DYDX_API}/v4/perpetualMarkets`);
    if (!res.ok) return {};
    const data    = await res.json();
    const markets = data.markets || data;
    if (typeof markets !== "object" || Array.isArray(markets)) return {};
    const map = {};
    for (const [key, m] of Object.entries(markets)) {
      if (!key.includes("-")) continue;
      const sym   = key.replace(/-USD[C]?$/, "");
      const price = parseFloat(m.oraclePrice || m.indexPrice || m.markPrice || 0);
      if (!price) continue;
      map[sym] = {
        fundingApr: parseFloat(m.nextFundingRate || m.fundingRate || 0) * 24 * 365 * 100,
        price,
        vol24h: parseFloat(m.volume24H || m.volume24h || m.volume || 0),
        oi: parseFloat(m.openInterest || 0) * price,
      };
    }
    console.log(`[dYdX] ${Object.keys(map).length} markets`);
    return map;
  } catch { return {}; }
}

// Aster comparison API — todos los tokens×períodos en una respuesta plana con paginación.
// Devuelve: { WLFI: { "1D": item, "1M": item, "1Y": item }, ... }
async function fetchAsterComp() {
  const TARGET_PERIODS = new Set(["1D", "1M", "1Y"]);

  // Soporta múltiples estructuras de respuesta bapi
  const extractItems = json => {
    if (Array.isArray(json))                    return json;
    if (Array.isArray(json?.data))              return json.data;
    if (Array.isArray(json?.data?.rows))        return json.data.rows;
    if (Array.isArray(json?.data?.list))        return json.data.list;
    if (Array.isArray(json?.rows))              return json.rows;
    if (Array.isArray(json?.list))              return json.list;
    if (Array.isArray(json?.result))            return json.result;
    return [];
  };
  const extractTotal = json =>
    json?.data?.total ?? json?.data?.count ?? json?.total ?? json?.count ?? 0;

  // Fetch directo con fallback a proxy CORS
  const doFetch = async url => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch {
      return proxyGet(url); // fallback proxy
    }
  };

  let firstJson;
  try {
    firstJson = await doFetch(ASTER_COMP_URL);
  } catch (e) {
    console.error("[AsterComp] error fetch inicial:", e.message);
    return {};
  }

  // Log diagnóstico completo de la estructura raíz
  console.log("[AsterComp] claves raíz:", Object.keys(firstJson ?? {}));
  console.log("[AsterComp] raw (800 chars):", JSON.stringify(firstJson).slice(0, 800));

  const firstBatch = extractItems(firstJson);
  const total      = extractTotal(firstJson);
  console.log(`[AsterComp] primer batch: ${firstBatch.length} items, total declarado: ${total}`);
  if (firstBatch[0]) console.log("[AsterComp] primer item:", JSON.stringify(firstBatch[0]).slice(0, 400));

  const allItems = [...firstBatch];

  // Paginación si la API declara más registros
  if (total > firstBatch.length && firstBatch.length > 0) {
    const pageSize = firstBatch.length;
    const pages    = Math.ceil(total / pageSize);
    console.log(`[AsterComp] paginando ${pages} páginas × ${pageSize}`);
    for (let page = 2; page <= pages; page++) {
      try {
        const res = await doFetch(`${ASTER_COMP_URL}?pageNum=${page}&pageSize=${pageSize}`);
        allItems.push(...extractItems(res));
      } catch (e) {
        console.warn(`[AsterComp] error página ${page}:`, e.message);
        break;
      }
    }
  }

  console.log(`[AsterComp] total items: ${allItems.length}`);

  // Agrupar por símbolo y período (solo 1D, 1M, 1Y)
  const bySymbol = {};
  for (const item of allItems) {
    if (!item?.pair || !item.period) continue;
    if (!TARGET_PERIODS.has(item.period)) continue;
    const sym = item.pair.replace(/USDT$/, "").replace(/BUSD$/, "");
    if (!bySymbol[sym]) bySymbol[sym] = {};
    bySymbol[sym][item.period] = item;
  }

  console.log(`[AsterComp] ${Object.keys(bySymbol).length} tokens con 1D/1M/1Y`);
  console.log("[AsterComp] WLFI:", JSON.stringify(bySymbol["WLFI"] ?? "NO ENCONTRADO"));
  return bySymbol;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > CACHE_TTL) return null;
    return parsed;
  } catch { return null; }
}
function saveCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), ...data })); } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtApr(v, digits = 1) {
  if (v == null || isNaN(v)) return "N/D";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}
function fmtMoney(v) {
  if (!v || isNaN(v)) return "N/D";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${(v / 1000).toFixed(0)}K`;
}
function spreadColor(v) {
  if (v == null || isNaN(v)) return T.subtle;
  const a = Math.abs(v);
  if (a >= 50) return T.green;
  if (a >= 20) return "#34d399";
  if (a > 5)   return T.yellow;
  return T.red;
}
function dirLabel(spread, dex1, dex2) {
  if (spread == null || isNaN(spread)) return "—";
  // spread > 0 → dex1 paga más → SHORT dex1 / LONG dex2
  return spread >= 0
    ? `SHORT ${dex1} / LONG ${dex2}`
    : `SHORT ${dex2} / LONG ${dex1}`;
}

// ─── TokenCard ────────────────────────────────────────────────────────────────

function TokenCard({ sym, asterComp, hlMap, asterMap, dydxMap, isAuto }) {
  const hl    = hlMap[sym]    || {};
  const aster = asterMap[sym] || {};
  const dydx  = dydxMap[sym]  || {};
  const comp  = asterComp[sym] || {};

  // Aster×ByBit spread per period (from comparison API)
  const abSpread = period => {
    const item = comp[period];
    if (!item || item.asterBybitComparison == null || item.bybitFundingRate == null) return null;
    return parseFloat(item.asterBybitComparison) * PERIOD_TO_ANNUAL[period] * 100;
  };
  // ByBit implied APR from 1D period (used to compute live spread)
  const bybitApr1D = (() => {
    const item = comp["1D"];
    if (!item || item.bybitFundingRate == null) return null;
    return parseFloat(item.bybitFundingRate) * PERIOD_TO_ANNUAL["1D"] * 100;
  })();

  // Live spreads (current instantaneous rates)
  const abLive      = (aster.fundingApr != null && bybitApr1D != null) ? aster.fundingApr - bybitApr1D : abSpread("1D");
  const asterHlLive = (aster.fundingApr != null && hl.fundingApr != null) ? aster.fundingApr - hl.fundingApr : null;
  const hlDydxLive  = (hl.fundingApr != null && dydx.fundingApr != null) ? hl.fundingApr - dydx.fundingApr : null;

  const pairs = [
    {
      label: "Aster × ByBit",
      live:  abLive,
      d1:    abSpread("1D"),
      m1:    abSpread("1M"),
      y1:    abSpread("1Y"),
      dir:   dirLabel(abSpread("1Y") ?? abLive, "Aster", "ByBit"),
    },
    {
      label: "Aster × HL",
      live:  asterHlLive,
      d1:    null,
      m1:    null,
      y1:    null,
      dir:   dirLabel(asterHlLive, "Aster", "HL"),
    },
    {
      label: "HL × dYdX",
      live:  hlDydxLive,
      d1:    null,
      m1:    null,
      y1:    null,
      dir:   dirLabel(hlDydxLive, "HL", "dYdX"),
    },
  ];

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: 16, overflow: "hidden", marginBottom: 16,
      boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
    }}>
      {/* Token header */}
      <div style={{
        background: isAuto ? "#f0f9ff" : "#f8fafc",
        borderBottom: `1px solid ${T.border}`,
        padding: "14px 20px",
        display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18, fontWeight: 800, color: T.text }}>{sym}</span>
          {isAuto && (
            <span style={{
              background: "#dbeafe", color: "#1d4ed8",
              fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
            }}>AUTO</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: T.muted }}>
            HL Vol <b style={{ color: T.text }}>{fmtMoney(hl.vol24h)}</b>
          </span>
          <span style={{ fontSize: 11, color: T.muted }}>
            HL OI <b style={{ color: T.text }}>{fmtMoney(hl.oi)}</b>
          </span>
          <span style={{ fontSize: 11, color: T.muted }}>
            Aster Vol <b style={{ color: T.text }}>{fmtMoney(aster.vol24h)}</b>
          </span>
          <span style={{ fontSize: 11, color: T.muted }}>
            HL APR <b style={{ color: (hl.fundingApr || 0) >= 0 ? T.red : T.green }}>{fmtApr(hl.fundingApr, 2)}</b>
          </span>
          <span style={{ fontSize: 11, color: T.muted }}>
            Aster APR <b style={{ color: (aster.fundingApr || 0) >= 0 ? T.red : T.green }}>{fmtApr(aster.fundingApr, 2)}</b>
          </span>
          {dydx.fundingApr != null && (
            <span style={{ fontSize: 11, color: T.muted }}>
              dYdX APR <b style={{ color: (dydx.fundingApr || 0) >= 0 ? T.red : T.green }}>{fmtApr(dydx.fundingApr, 2)}</b>
            </span>
          )}
        </div>
      </div>

      {/* Spreads table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              {["PAR", "LIVE", "1D avg", "1M avg", "1Y avg", "DIRECCIÓN"].map(h => (
                <th key={h} style={{
                  padding: "8px 16px", textAlign: "left",
                  color: T.subtle, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
                  borderBottom: `1px solid ${T.border}`,
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pairs.map((p, i) => (
              <tr key={p.label} style={{ borderBottom: i < pairs.length - 1 ? `1px solid ${T.border}` : "none" }}>
                <td style={{ padding: "13px 16px", fontWeight: 700, color: T.text, whiteSpace: "nowrap" }}>{p.label}</td>
                <td style={{ padding: "13px 16px", fontWeight: 800, fontSize: 14, color: spreadColor(p.live), whiteSpace: "nowrap" }}>
                  {fmtApr(p.live)}
                </td>
                <td style={{ padding: "13px 16px", fontWeight: p.d1 != null ? 700 : 400, color: p.d1 != null ? spreadColor(p.d1) : T.subtle }}>
                  {fmtApr(p.d1)}
                </td>
                <td style={{ padding: "13px 16px", fontWeight: p.m1 != null ? 700 : 400, color: p.m1 != null ? spreadColor(p.m1) : T.subtle }}>
                  {fmtApr(p.m1)}
                </td>
                <td style={{ padding: "13px 16px", fontWeight: p.y1 != null ? 700 : 400, color: p.y1 != null ? spreadColor(p.y1) : T.subtle }}>
                  {fmtApr(p.y1)}
                </td>
                <td style={{ padding: "13px 16px", color: T.muted, fontSize: 11, whiteSpace: "nowrap" }}>
                  {p.dir}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RankingTab({ config }) {
  const [state, setState]         = useState({ asterComp: {}, hlMap: {}, asterMap: {}, dydxMap: {} });
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [fromCache, setFromCache]   = useState(false);

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true); setError(null);
    try {
      if (!forceRefresh) {
        const cached = loadCache();
        if (cached) {
          setState({
            asterComp: cached.asterComp || {},
            hlMap:     cached.hlMap     || {},
            asterMap:  cached.asterMap  || {},
            dydxMap:   cached.dydxMap   || {},
          });
          setLastUpdate(new Date(cached.ts));
          setFromCache(true);
          return;
        }
      }
      const [asterComp, hlMap, asterMap, dydxMap] = await Promise.all([
        fetchAsterComp(),
        fetchHL().catch(() => ({})),
        fetchAster().catch(() => ({})),
        fetchDydx().catch(() => ({})),
      ]);
      const data = { asterComp, hlMap, asterMap, dydxMap };
      saveCache(data);
      setState(data);
      setLastUpdate(new Date());
      setFromCache(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Mejor token auto: mayor spread 1Y Aster×ByBit fuera de los tokens fijos
  const autoToken = useMemo(() => {
    const { asterComp, hlMap } = state;
    return Object.entries(asterComp)
      .filter(([sym]) => !FIXED_TOKENS.includes(sym))
      .filter(([sym, periods]) =>
        periods["1Y"]?.asterBybitComparison != null &&
        (hlMap[sym]?.vol24h || 0) >= 100_000
      )
      .map(([sym, periods]) => ({
        sym,
        spread: Math.abs(parseFloat(periods["1Y"].asterBybitComparison) * PERIOD_TO_ANNUAL["1Y"] * 100),
      }))
      .sort((a, b) => b.spread - a.spread)[0]?.sym || null;
  }, [state]);

  const tokens = useMemo(() =>
    [...FIXED_TOKENS, ...(autoToken ? [autoToken] : [])],
    [autoToken]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 20,
      }}>
        <div>
          <div style={{ color: T.subtle, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            FUNDING ARB · WLFI · ETH · BTC · SOL · AUTO
          </div>
          <div style={{ color: T.subtle, fontSize: 11, marginTop: 2 }}>
            Aster × ByBit · Aster × HL · HL × dYdX
          </div>
          {lastUpdate && (
            <div style={{ color: T.subtle, fontSize: 12, marginTop: 6 }}>
              {fromCache ? "Caché" : "Actualizado"}: {lastUpdate.toLocaleTimeString()}
              {fromCache && (
                <button onClick={() => load(true)} style={{
                  background: "none", border: "none", color: T.accent,
                  cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                  fontWeight: 600, padding: "0 0 0 8px",
                }}>↺ Refrescar ahora</button>
              )}
            </div>
          )}
        </div>
        <button
          onClick={() => load(true)}
          disabled={loading}
          style={{
            background: loading ? "#f1f5f9" : "#6366f120",
            border: `1px solid ${loading ? T.border : "#6366f144"}`,
            color: loading ? T.subtle : T.accent,
            borderRadius: 10, padding: "10px 24px",
            cursor: loading ? "not-allowed" : "pointer",
            fontFamily: "inherit", fontSize: 14, fontWeight: 700,
          }}
        >
          {loading ? "Cargando..." : "↻ Refrescar"}
        </button>
      </div>

      {/* Info note */}
      <div style={{
        background: "#f0f9ff", border: "1px solid #bae6fd",
        borderRadius: 10, padding: "10px 14px", fontSize: 12, color: "#0369a1", marginBottom: 20,
      }}>
        Spreads <b>Aster×ByBit</b> de la API de comparación de Aster (1D / 1M / 1Y avg).
        Spreads <b>Aster×HL</b> y <b>HL×dYdX</b> calculados en vivo con tasas actuales. APR anualizado.
        Token AUTO = mayor spread 1Y en Aster×ByBit con vol HL &gt; $100K.
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: T.redBg, border: "1px solid #fca5a5", borderRadius: 12, padding: 16, color: T.red, fontSize: 14, marginBottom: 16 }}>
          Error: {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: 16, padding: 40, textAlign: "center",
          color: T.accent, fontSize: 15, fontWeight: 700,
        }}>
          Cargando datos de Aster, HL y dYdX...
        </div>
      )}

      {/* Token cards */}
      {!loading && tokens.map(sym => (
        <TokenCard
          key={sym}
          sym={sym}
          asterComp={state.asterComp}
          hlMap={state.hlMap}
          asterMap={state.asterMap}
          dydxMap={state.dydxMap}
          isAuto={sym === autoToken}
        />
      ))}

      {!loading && tokens.length === 0 && !error && (
        <div style={{
          background: T.card, border: `1px solid ${T.border}`,
          borderRadius: 16, padding: 40, textAlign: "center", color: T.muted,
        }}>
          Sin datos. Pulsa Refrescar.
        </div>
      )}
    </div>
  );
}
