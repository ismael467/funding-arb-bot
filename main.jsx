import { useState, useEffect, useRef } from "react";

const HL_API    = "https://api.hyperliquid.xyz/info";
const ASTER_API = "https://fapi.asterdex.com";
const EXT_API   = "https://api.starknet.extended.exchange/api/v1/info/markets";

// ─── CLASIFICACIÓN ───────────────────────────────────────────
export function getClassification(score) {
  if (score >= 80) return { label: "TOP",   color: "#00ff88", emoji: "🔥" };
  if (score >= 65) return { label: "GOOD",  color: "#44ff44", emoji: "🟢" };
  if (score >= 50) return { label: "OK",    color: "#ffcc00", emoji: "🟡" };
  return              { label: "AVOID", color: "#ff4444", emoji: "🔴" };
}

// ─── SCORE 6 FACTORES ────────────────────────────────────────
function calcScore({ fundingDiff, spreadPct, slippage, impact, vol, oi }) {
  const funding_score  = Math.min(Math.abs(fundingDiff) / 0.0005, 1) * 25;
  const spread_score   = Math.max(0, 1 - spreadPct / 0.001) * 20;
  const slippage_score = Math.max(0, 1 - slippage / 0.001) * 20;
  const impact_score   = Math.max(0, 1 - impact / 0.05) * 20;
  const volume_score   = Math.min(Math.log10(Math.max(vol, 1)) / 7, 1) * 10;
  const oi_score       = Math.min(Math.log10(Math.max(oi, 1)) / 7, 1) * 5;
  const total = funding_score + spread_score + slippage_score + impact_score + volume_score + oi_score;
  return Math.min(100, Math.max(0, Math.round(total)));
}

// ─── FILTROS DUROS ───────────────────────────────────────────
function passesHardFilters(data, config) {
  const reasons = [];
  if (data.longVol  < config.minLongVol)    reasons.push(`Vol ${data.longDex} $${(data.longVol/1000).toFixed(0)}K < mín $${(config.minLongVol/1000).toFixed(0)}K`);
  if (data.shortVol < config.minShortVol)   reasons.push(`Vol ${data.shortDex} $${(data.shortVol/1000).toFixed(0)}K < mín $${(config.minShortVol/1000).toFixed(0)}K`);
  if (data.spreadPct > 0.001)               reasons.push(`Spread ${(data.spreadPct*100).toFixed(3)}% > 0.1%`);
  if (data.impact > 0.05)                   reasons.push(`Impact ${(data.impact*100).toFixed(1)}% > 5%`);
  if (Math.abs(data.fundingDiff) < 0.0002)  reasons.push(`Funding diff ${(Math.abs(data.fundingDiff)*100).toFixed(4)}% < 0.02%`);
  if (data.priceDiff > config.maxPriceDiff) reasons.push(`Price parity ${data.priceDiff.toFixed(3)}% > ${config.maxPriceDiff}%`);
  return { passes: reasons.length === 0, reasons };
}

// ─── FETCH HYPERLIQUID ───────────────────────────────────────
async function fetchHL(symbol = "KAITO") {
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
  const meta     = metaJson[0]?.universe || [];
  const ctxs     = metaJson[1] || [];
  const idx      = meta.findIndex(a => a.name === symbol);
  if (idx === -1) throw new Error(`${symbol} not found in HL`);

  const ctx         = ctxs[idx];
  const fundingRate = parseFloat(ctx.funding); // per 8h
  const fundingApr  = fundingRate * 3 * 365 * 100;
  const price       = parseFloat(mids[symbol] || ctx.markPx || 0);
  const vol24h      = parseFloat(ctx.dayNtlVlm || 0);
  const oi          = parseFloat(ctx.openInterest || 0) * price;
  const impactBid   = parseFloat(ctx.impactPxs?.[0] || price * 0.999);
  const impactAsk   = parseFloat(ctx.impactPxs?.[1] || price * 1.001);
  const spreadPct   = price > 0 ? (impactAsk - impactBid) / price : 0;

  // Orderbook liquidez real ±0.5%
  let liquidity = 0;
  try {
    const bookRes = await fetch(HL_API, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin: symbol })
    });
    const book      = await bookRes.json();
    const bids      = book?.levels?.[0] || [];
    const asks      = book?.levels?.[1] || [];
    const threshold = price * 0.005;
    const bidLiq    = bids.filter(l => price - parseFloat(l.px) <= threshold)
                          .reduce((s, l) => s + parseFloat(l.px) * parseFloat(l.sz), 0);
    const askLiq    = asks.filter(l => parseFloat(l.px) - price <= threshold)
                          .reduce((s, l) => s + parseFloat(l.px) * parseFloat(l.sz), 0);
    liquidity = bidLiq + askLiq;
  } catch { liquidity = vol24h * 0.01; }

  return { name: "Hyperliquid", fundingApr, price, vol24h, oi, spreadPct, liquidity };
}

// ─── FETCH ASTER ─────────────────────────────────────────────
async function fetchAster(symbol = "KAITO") {
  const sym = `${symbol}USDT`;

  const [premRes, tickerRes] = await Promise.all([
    fetch(`${ASTER_API}/fapi/v1/premiumIndex?symbol=${sym}`),
    fetch(`${ASTER_API}/fapi/v1/ticker/24hr?symbol=${sym}`)
  ]);

  const prem   = await premRes.json();
  const ticker = await tickerRes.json();

  // premiumIndex devuelve objeto o array — normalizamos
  const premData   = Array.isArray(prem) ? prem[0] : prem;
  const tickerData = Array.isArray(ticker) ? ticker[0] : ticker;

  const fundingRate8h = parseFloat(premData?.lastFundingRate || premData?.r || 0);
  const fundingApr    = fundingRate8h * 3 * 365 * 100; // per 8h → APR
  const price         = parseFloat(premData?.markPrice || premData?.p || 0);
  const vol24h        = parseFloat(tickerData?.quoteVolume || tickerData?.volume || 0);
  const bidPrice      = parseFloat(tickerData?.bidPrice || price * 0.999);
  const askPrice      = parseFloat(tickerData?.askPrice || price * 1.001);
  const spreadPct     = price > 0 ? (askPrice - bidPrice) / price : 0;

  // Orderbook liquidez real ±0.5%
  let liquidity = 0;
  let oi = 0;
  try {
    const [bookRes, oiRes] = await Promise.all([
      fetch(`${ASTER_API}/fapi/v1/depth?symbol=${sym}&limit=20`),
      fetch(`${ASTER_API}/fapi/v1/openInterest?symbol=${sym}`)
    ]);
    const book    = await bookRes.json();
    const oiData  = await oiRes.json();
    oi            = parseFloat(oiData?.openInterest || 0) * price;

    const threshold = price * 0.005;
    const bids      = (book?.bids || []).map(b => ({ px: parseFloat(b[0]), sz: parseFloat(b[1]) }));
    const asks      = (book?.asks || []).map(a => ({ px: parseFloat(a[0]), sz: parseFloat(a[1]) }));
    const bidLiq    = bids.filter(b => price - b.px <= threshold).reduce((s, b) => s + b.px * b.sz, 0);
    const askLiq    = asks.filter(a => a.px - price <= threshold).reduce((s, a) => s + a.px * a.sz, 0);
    liquidity       = bidLiq + askLiq;
  } catch { liquidity = vol24h * 0.01; }

  return { name: "Aster", fundingApr, price, vol24h, oi, spreadPct, liquidity };
}

// ─── FETCH EXTENDED (fallback / referencia) ──────────────────
async function fetchExtended(symbol = "KAITO") {
  const res    = await fetch(EXT_API);
  const json   = await res.json();
  const markets = json.markets || json.data || json || [];
  const market  = markets.find(m =>
    m.name === `${symbol}-PERP` || m.name === symbol ||
    (m.name && m.name.toUpperCase().includes(symbol))
  );
  if (!market) throw new Error(`${symbol} not found in Extended`);

  const fundingRate1h = parseFloat(market.fundingRate || 0);
  const fundingApr    = fundingRate1h * 24 * 365 * 100;
  const price         = parseFloat(market.markPrice || market.indexPrice || 0);
  const vol24h        = parseFloat(market.dailyVolume || 0);
  const oi            = parseFloat(market.openInterest || 0);
  const bidPrice      = parseFloat(market.bidPrice || price * 0.999);
  const askPrice      = parseFloat(market.askPrice || price * 1.001);
  const spreadPct     = price > 0 ? (askPrice - bidPrice) / price : 0;
  const liquidity     = oi * 0.05;

  return { name: "Extended", fundingApr, price, vol24h, oi, spreadPct, liquidity };
}

// ─── DETECTAR MEJOR PAR LONG/SHORT ──────────────────────────
function findBestPair(dexList) {
  // Encontrar DEX con funding más alto (SHORT aquí)
  // y DEX con funding más bajo (LONG aquí)
  let shortDex = dexList[0];
  let longDex  = dexList[0];

  for (const dex of dexList) {
    if (dex.fundingApr > shortDex.fundingApr) shortDex = dex;
    if (dex.fundingApr < longDex.fundingApr)  longDex  = dex;
  }

  return { shortDex, longDex };
}

// ─── HOOK PRINCIPAL ──────────────────────────────────────────
export default function useMarket(config) {
  const [state, setState] = useState({
    data: null, loading: true, error: null, lastFetch: null
  });
  const timerRef = useRef(null);
  const POSITION_SIZE = config.positionSize || 150;

  const fetchData = async () => {
    try {
      // Fetch los 3 DEX en paralelo — si Aster falla, continuamos con HL+Extended
      const results = await Promise.allSettled([
        fetchHL("KAITO"),
        fetchAster("KAITO"),
        fetchExtended("KAITO"),
      ]);

      const dexList = results
        .filter(r => r.status === "fulfilled")
        .map(r => r.value);

      if (dexList.length < 2) throw new Error("Menos de 2 DEX disponibles");

      // ── Mejor par Long/Short ──
      const { shortDex, longDex } = findBestPair(dexList);

      // ── Métricas del par óptimo ──
      const fundingDiff = (shortDex.fundingApr - longDex.fundingApr) / 100;
      const spreadApr   = shortDex.fundingApr - longDex.fundingApr;
      const priceDiff   = shortDex.price > 0
        ? Math.abs((shortDex.price - longDex.price) / shortDex.price) * 100 : 0;

      // Spread = peor de los dos DEX
      const spreadPct = Math.max(shortDex.spreadPct, longDex.spreadPct);
      const slippage  = spreadPct * 0.5;

      // Liquidez = cuello de botella (mínimo de los dos)
      const liquidity = Math.min(shortDex.liquidity, longDex.liquidity);
      const impact    = liquidity > 0 ? POSITION_SIZE / liquidity : 1;
      const maxSize   = liquidity * 0.03;

      // Vol y OI del lado más limitado
      const vol = Math.min(shortDex.vol24h, longDex.vol24h);
      const oi  = Math.min(shortDex.oi || 0, longDex.oi || 0);

      // Beneficio neto estimado por 8h
      const fundingPer8h = spreadApr / (365 * 3) / 100;
      const costPer8h    = spreadPct * 2 + slippage * 2;
      const netBenefit   = fundingPer8h - costPer8h;

      const raw = {
        // Par óptimo
        shortDex: shortDex.name,
        longDex:  longDex.name,
        shortFunding: shortDex.fundingApr,
        longFunding:  longDex.fundingApr,
        shortPrice:   shortDex.price,
        longPrice:    longDex.price,
        shortVol:     shortDex.vol24h,
        longVol:      longDex.vol24h,

        // Métricas combinadas
        spreadApr, fundingDiff, priceDiff,
        spreadPct, slippage, impact, liquidity, maxSize, netBenefit,
        vol, oi,

        // Todos los DEX (para mostrar tabla comparativa)
        allDex: dexList,

        // Compat con versiones anteriores
        hlFunding:  dexList.find(d => d.name === "Hyperliquid")?.fundingApr ?? 0,
        extFunding: dexList.find(d => d.name === "Extended")?.fundingApr ?? 0,
        hlVol:      dexList.find(d => d.name === "Hyperliquid")?.vol24h ?? 0,
        extVol:     dexList.find(d => d.name === "Extended")?.vol24h ?? 0,
        extOI:      dexList.find(d => d.name === "Extended")?.oi ?? 0,
        hlPrice:    dexList.find(d => d.name === "Hyperliquid")?.price ?? 0,
        extPrice:   dexList.find(d => d.name === "Extended")?.price ?? 0,

        timestamp: Date.now(),
      };

      const { passes, reasons } = passesHardFilters({
        ...raw,
        longVol:  longDex.vol24h,
        shortVol: shortDex.vol24h,
      }, {
        ...config,
        minLongVol:  config.minHlVol  || 100000,
        minShortVol: config.minExtVol || 30000,
      });

      const score = passes
        ? calcScore(raw)
        : Math.min(calcScore(raw), 45);

      setState({
        data: { ...raw, score, passes, filterReasons: reasons },
        loading: false, error: null, lastFetch: new Date()
      });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: e.message }));
    }
  };

  useEffect(() => {
    fetchData();
    timerRef.current = setInterval(fetchData, config.refreshMs || 15000);
    return () => clearInterval(timerRef.current);
  }, [config.refreshMs, config.positionSize]);

  return state;
}
