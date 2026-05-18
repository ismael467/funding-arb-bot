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
const DM_KEY           = "fundingArb_darkMode";

// ─── Themes ──────────────────────────────────────────────────────────────────

const LIGHT = {
  bg: "#f0f2f5", card: "#ffffff", border: "#e8edf2",
  text: "#0f172a", muted: "#64748b", subtle: "#94a3b8",
  green: "#10b981", red: "#ef4444", yellow: "#f59e0b",
  blue: "#3b82f6", accent: "#6366f1",
  strip: "#f8fafc", tableHead: "#f8fafc",
  countdown: "#f8fafc", cdText: "#0f172a", cdSub: "#94a3b8",
  metricVal: "#0f172a", progress: "#1e293b",
};
const DARK = {
  bg: "#080808", card: "#111111", border: "#1e1e1e",
  text: "#f1f5f9", muted: "#94a3b8", subtle: "#475569",
  green: "#10b981", red: "#ef4444", yellow: "#f59e0b",
  blue: "#60a5fa", accent: "#818cf8",
  strip: "#0d0d0d", tableHead: "#0d0d0d",
  countdown: "#0d0d0d", cdText: "#f1f5f9", cdSub: "#475569",
  metricVal: "#e2e8f0", progress: "#0f172a",
};

// ─── CSS keyframes ────────────────────────────────────────────────────────────

const CSS = `
@keyframes pulse-fire {
  0%   { transform:scale(1) rotate(0deg);   filter:brightness(1)   drop-shadow(0 0 4px #ff6b35); }
  30%  { transform:scale(1.6) rotate(-8deg);filter:brightness(1.7) drop-shadow(0 0 14px #ff4500); }
  55%  { transform:scale(1.3) rotate(6deg); filter:brightness(1.4) drop-shadow(0 0 10px #fbbf24); }
  80%  { transform:scale(1.5) rotate(-4deg);filter:brightness(1.6) drop-shadow(0 0 12px #ff6b35); }
  100% { transform:scale(1) rotate(0deg);   filter:brightness(1)   drop-shadow(0 0 4px #ff6b35); }
}
@keyframes fire-bg {
  0%,100%{ background:linear-gradient(135deg,#dc2626,#ea580c,#f59e0b); box-shadow:0 0 14px rgba(234,88,12,.7); }
  50%    { background:linear-gradient(135deg,#ea580c,#f59e0b,#fbbf24); box-shadow:0 0 24px rgba(251,191,36,.9); }
}
@keyframes glow-green {
  0%,100%{ box-shadow:0 0 5px rgba(16,185,129,.4); }
  50%    { box-shadow:0 0 18px rgba(16,185,129,.8),0 0 32px rgba(16,185,129,.3); }
}
@keyframes glow-yellow {
  0%,100%{ box-shadow:0 0 5px rgba(245,158,11,.4); }
  50%    { box-shadow:0 0 14px rgba(245,158,11,.8),0 0 26px rgba(245,158,11,.3); }
}
`;

// ─── Network ──────────────────────────────────────────────────────────────────

async function proxyGet(url) {
  const r = await fetch(`${PROXY}?url=${encodeURIComponent(url)}`);
  return r.json();
}
async function proxyPost(url, body) {
  const r = await fetch(`${PROXY}?url=${encodeURIComponent(url)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ─── DEX fetchers ─────────────────────────────────────────────────────────────

async function fetchHL() {
  const [meta, mids] = await Promise.all([
    proxyPost(HL_API, { type: "metaAndAssetCtxs" }),
    proxyPost(HL_API, { type: "allMids" }),
  ]);
  const map = {};
  (meta[0]?.universe || []).forEach((a, i) => {
    const ctx = (meta[1] || [])[i];
    const px  = parseFloat(mids[a.name] || ctx?.markPx || 0);
    if (!px) return;
    map[a.name] = {
      fundingApr: parseFloat(ctx?.funding || 0) * 3 * 365 * 100,
      price: px, vol24h: parseFloat(ctx?.dayNtlVlm || 0),
      oi: parseFloat(ctx?.openInterest || 0) * px,
    };
  });
  return map;
}

async function fetchAster() {
  const [prem, tickers] = await Promise.all([
    proxyGet(`${ASTER_API}/fapi/v1/premiumIndex`),
    proxyGet(`${ASTER_API}/fapi/v1/ticker/24hr`),
  ]);
  const pm = {};
  (Array.isArray(prem) ? prem : []).forEach(p => { if (p.symbol) pm[p.symbol] = p; });
  const map = {};
  (Array.isArray(tickers) ? tickers : []).forEach(t => {
    if (!t.symbol) return;
    const sym = t.symbol.replace(/USDT$/, "").replace(/BUSD$/, "");
    const p   = pm[t.symbol] || {};
    const px  = parseFloat(p.markPrice || p.p || t.lastPrice || t.weightedAvgPrice || 0);
    if (!px) return;
    const lr  = parseFloat(p.lastFundingRate || 0);
    const idx = parseFloat(p.indexPrice || p.indexPx || 0);
    const fr  = lr !== 0 ? lr : Math.max(-0.0075, Math.min(0.0075, idx > 0 ? (px - idx) / idx : 0));
    map[sym]  = { fundingApr: fr * 6 * 365 * 100, price: px, vol24h: parseFloat(t.quoteVolume || 0), oi: parseFloat(p.openInterest || 0) * px };
  });
  return map;
}

async function fetchDydx() {
  try {
    const r = await fetch(`${DYDX_API}/v4/perpetualMarkets`);
    if (!r.ok) return {};
    const data = await r.json();
    const mkts = data.markets || data;
    if (typeof mkts !== "object" || Array.isArray(mkts)) return {};
    const map = {};
    for (const [k, m] of Object.entries(mkts)) {
      if (!k.includes("-")) continue;
      const sym = k.replace(/-USD[C]?$/, "");
      const px  = parseFloat(m.oraclePrice || m.indexPrice || m.markPrice || 0);
      if (!px) continue;
      map[sym] = {
        fundingApr: parseFloat(m.nextFundingRate || m.fundingRate || 0) * 24 * 365 * 100,
        price: px, vol24h: parseFloat(m.volume24H || m.volume24h || m.volume || 0),
        oi: parseFloat(m.openInterest || 0) * px,
      };
    }
    return map;
  } catch { return {}; }
}

async function fetchAsterComp() {
  const WANT = new Set(["1D", "1M", "1Y"]);
  const extract = j => {
    if (Array.isArray(j?.data?.details)) return j.data.details;
    if (Array.isArray(j))               return j;
    if (Array.isArray(j?.data))         return j.data;
    if (Array.isArray(j?.data?.rows))   return j.data.rows;
    if (Array.isArray(j?.data?.list))   return j.data.list;
    if (Array.isArray(j?.rows))         return j.rows;
    if (Array.isArray(j?.list))         return j.list;
    if (Array.isArray(j?.result))       return j.result;
    return [];
  };
  const total = j => j?.data?.total ?? j?.data?.count ?? j?.total ?? j?.count ?? 0;
  const doFetch = async url => {
    try { const r = await fetch(url); if (!r.ok) throw 0; return r.json(); }
    catch { return proxyGet(url); }
  };
  let first;
  try { first = await doFetch(ASTER_COMP_URL); }
  catch (e) { console.error("[AsterComp]", e.message); return {}; }

  const batch = extract(first), tot = total(first);
  const all   = [...batch];
  if (tot > batch.length && batch.length > 0) {
    const ps = batch.length, pages = Math.ceil(tot / ps);
    for (let pg = 2; pg <= pages; pg++) {
      try { all.push(...extract(await doFetch(`${ASTER_COMP_URL}?pageNum=${pg}&pageSize=${ps}`))); }
      catch { break; }
    }
  }
  const by = {};
  for (const it of all) {
    if (!it?.pair || !it.period || !WANT.has(it.period)) continue;
    const sym = it.pair.replace(/USDT$/, "").replace(/BUSD$/, "");
    if (!by[sym]) by[sym] = {};
    by[sym][it.period] = it;
  }
  console.log(`[AsterComp] ${Object.keys(by).length} tokens`);
  return by;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
  try { const p = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); return p && Date.now() - p.ts < CACHE_TTL ? p : null; } catch { return null; }
}
function saveCache(d) { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), ...d })); } catch {} }

// ─── Pure helpers ─────────────────────────────────────────────────────────────

const fmtApr   = (v, d=1) => v==null||isNaN(v) ? "N/D" : `${v>=0?"+":""}${v.toFixed(d)}%`;
const fmtMoney = v => { if(!v||isNaN(v)) return "N/D"; if(v>=1e9) return `$${(v/1e9).toFixed(1)}B`; if(v>=1e6) return `$${(v/1e6).toFixed(1)}M`; return `$${(v/1000).toFixed(0)}K`; };
const volDot   = v => v>=1e6?"#10b981":v>=3e5?"#f59e0b":"#ef4444";
const spdDot   = v => { const a=Math.abs(v??0); return a>=30?"#10b981":a>=10?"#f59e0b":"#ef4444"; };
const spdCell  = v => { const a=Math.abs(v??0); return a>=30?"#10b981":a>=10?"#34d399":a>0?"#f59e0b":"#ef4444"; };
const trend    = (live, d1) => { if(live==null||d1==null||Math.abs(d1)<.01) return "➡️"; const r=Math.abs(live)/Math.abs(d1); return r>=1.2?"⬆️":r<=.8?"⬇️":"➡️"; };
const badgeLv  = (s,v) => { const a=Math.abs(s??0); if(a>=30&&v>=1e6) return "fire"; if(a>=10&&v>=3e5) return "green"; if(a>=5||v>=3e5) return "yellow"; return "red"; };

// ─── GlobalBadge ─────────────────────────────────────────────────────────────

function GlobalBadge({ spread, vol }) {
  const lv = badgeLv(spread, vol);
  if (lv === "fire") return (
    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
      <span style={{ fontSize:34, display:"inline-block", animation:"pulse-fire .85s ease-in-out infinite" }}>🔥</span>
      <span style={{ padding:"5px 14px", borderRadius:24, fontWeight:900, fontSize:11, color:"#fff", letterSpacing:".07em", animation:"fire-bg 1.1s ease-in-out infinite" }}>ENTRADA FUERTE</span>
    </div>
  );
  if (lv === "green") return (
    <div style={{ display:"inline-flex", alignItems:"center", gap:7, background:"#d1fae5", border:"2px solid #10b981", borderRadius:24, padding:"5px 14px", animation:"glow-green 2s ease-in-out infinite" }}>
      <span style={{ fontSize:13 }}>🟢</span>
      <span style={{ fontWeight:800, fontSize:11, color:"#059669" }}>BUENA ENTRADA</span>
    </div>
  );
  if (lv === "yellow") return (
    <div style={{ display:"inline-flex", alignItems:"center", gap:7, background:"#fef3c7", border:"2px solid #f59e0b", borderRadius:24, padding:"5px 14px", animation:"glow-yellow 2.5s ease-in-out infinite" }}>
      <span style={{ fontSize:13 }}>🟡</span>
      <span style={{ fontWeight:800, fontSize:11, color:"#d97706" }}>MODERADA</span>
    </div>
  );
  return (
    <div style={{ display:"inline-flex", alignItems:"center", gap:7, background:"#fee2e2", border:"2px solid #ef4444", borderRadius:24, padding:"5px 14px" }}>
      <span style={{ fontSize:13 }}>🔴</span>
      <span style={{ fontWeight:800, fontSize:11, color:"#dc2626" }}>DÉBIL</span>
    </div>
  );
}

// ─── SpreadBarChart — always dark ─────────────────────────────────────────────

function SpreadBarChart({ live, d1, m1, y1 }) {
  const bars = [{ label:"Live",v:live },{ label:"1D",v:d1 },{ label:"1M",v:m1 },{ label:"1Y",v:y1 }].filter(b=>b.v!=null&&!isNaN(b.v));
  if (!bars.length) return (
    <div style={{ background:"#0a0a0a", borderRadius:12, padding:18, textAlign:"center", color:"#222", fontSize:11 }}>Sin datos Aster × ByBit</div>
  );
  const W=300,H=148,P={t:18,r:14,b:30,l:36};
  const IW=W-P.l-P.r, IH=H-P.t-P.b;
  const vals=bars.map(b=>b.v), avg=y1??vals.reduce((a,b)=>a+b,0)/vals.length;
  const mAbs=Math.max(...vals.map(Math.abs),Math.abs(avg),1);
  const yMax=mAbs*1.3, yMin=-mAbs*.25;
  const toY=v=>P.t+IH*(1-(v-yMin)/(yMax-yMin)), zY=toY(0), bW=(IW/bars.length)*.55;
  return (
    <div style={{ background:"#080808", borderRadius:12, border:"1px solid #161616", overflow:"hidden" }}>
      <div style={{ color:"#333", fontSize:9, letterSpacing:".12em", padding:"8px 0 2px", paddingLeft:P.l+2 }}>APR SPREAD · ASTER × BYBIT</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display:"block" }}>
        {[0, mAbs*.6].map((v,i)=>(
          <g key={i}>
            <line x1={P.l} y1={toY(v)} x2={W-P.r} y2={toY(v)} stroke={v===0?"#222":"#111"} strokeWidth={v===0?1.5:.8}/>
            {v===0 && <text x={P.l-4} y={toY(v)+3} fill="#2a2a2a" fontSize={7} textAnchor="end">0%</text>}
          </g>
        ))}
        {bars.map((b,i)=>{
          const cx=P.l+(i+.5)*(IW/bars.length), x=cx-bW/2, pos=b.v>=0;
          const bTop=pos?toY(b.v):zY, bH=Math.max(Math.abs(toY(b.v)-zY),4);
          const col=pos?"#10b981":"#ef4444";
          return (
            <g key={i}>
              <rect x={x} y={bTop} width={bW} height={bH} rx={3} fill={col} opacity={.92} style={{ filter:`drop-shadow(0 0 6px ${pos?"#10b98155":"#ef444455"})` }}/>
              <text x={cx} y={H-P.b+11} fill="#444" fontSize={9} textAnchor="middle">{b.label}</text>
              <text x={cx} y={pos?bTop-4:bTop+bH+9} fill={col} fontSize={8} textAnchor="middle" fontWeight="bold">
                {b.v>=0?"+":""}{b.v.toFixed(1)}%
              </text>
            </g>
          );
        })}
        {avg!=null&&(
          <g>
            <line x1={P.l} y1={toY(avg)} x2={W-P.r} y2={toY(avg)} stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="6,3" opacity={.85}/>
            <rect x={W-P.r-38} y={toY(avg)-8} width={37} height={13} rx={3} fill="#0f172a" opacity={.9}/>
            <text x={W-P.r-20} y={toY(avg)+2} fill="#60a5fa" fontSize={8} textAnchor="middle" fontWeight="bold">
              {avg>=0?"+":""}{avg.toFixed(1)}%
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

// ─── SpreadProgress ───────────────────────────────────────────────────────────

function SpreadProgress({ current, points, t }) {
  const valid = points.filter(v=>v!=null&&!isNaN(v));
  if (!valid.length || current==null) return null;
  const mx=Math.max(...valid.map(v=>Math.abs(v)),.01), pct=Math.min(Math.abs(current)/mx*100,100);
  const col=pct>=70?"#10b981":pct>=40?"#f59e0b":"#ef4444";
  return (
    <div style={{ marginTop:10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
        <span style={{ fontSize:9, color:t.subtle, letterSpacing:".06em" }}>⏫ SPREAD ACTUAL VS MÁX</span>
        <span style={{ fontSize:10, fontWeight:800, color:col }}>{pct.toFixed(0)}%</span>
      </div>
      <div style={{ background:t.progress, borderRadius:6, height:7, overflow:"hidden" }}>
        <div style={{ background:`linear-gradient(90deg,${col},${col}99)`, width:`${pct}%`, height:"100%", borderRadius:6, boxShadow:`0 0 10px ${col}88`, transition:"width .6s ease" }}/>
      </div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginTop:3 }}>
        <span style={{ fontSize:8, color:t.subtle }}>máx {mx>=0?"+":""}{mx.toFixed(1)}%</span>
      </div>
    </div>
  );
}

// ─── TokenCard ────────────────────────────────────────────────────────────────

function TokenCard({ sym, asterComp, hlMap, asterMap, dydxMap, isAuto, countdown, t }) {
  const hl=hlMap[sym]||{}, aster=asterMap[sym]||{}, dydx=dydxMap[sym]||{}, comp=asterComp[sym]||{};
  const cmpS = period => {
    const it=comp[period];
    if(!it||it.asterBybitComparison==null||it.bybitFundingRate==null) return null;
    return parseFloat(it.asterBybitComparison)*PERIOD_TO_ANNUAL[period]*100;
  };
  const bybit1D = (()=>{ const it=comp["1D"]; return it?.bybitFundingRate!=null?parseFloat(it.bybitFundingRate)*PERIOD_TO_ANNUAL["1D"]*100:null; })();
  const ab1D=cmpS("1D"), ab1M=cmpS("1M"), ab1Y=cmpS("1Y");
  const abLive = aster.fundingApr!=null&&bybit1D!=null ? aster.fundingApr-bybit1D : ab1D;
  const aHlL   = aster.fundingApr!=null&&hl.fundingApr!=null ? aster.fundingApr-hl.fundingApr : null;
  const hlDL   = hl.fundingApr!=null&&dydx.fundingApr!=null ? hl.fundingApr-dydx.fundingApr : null;
  const best   = Math.max(Math.abs(ab1Y??ab1M??ab1D??0), Math.abs(aHlL??0), Math.abs(hlDL??0));
  const trArrow = trend(abLive, ab1D);

  const pairs = [
    { label:"Aster × ByBit", live:abLive, d1:ab1D, m1:ab1M, y1:ab1Y },
    { label:"Aster × HL",    live:aHlL,   d1:null, m1:null, y1:null  },
    { label:"HL × dYdX",     live:hlDL,   d1:null, m1:null, y1:null  },
  ];

  return (
    <div style={{ background:t.card, borderRadius:22, boxShadow:`0 6px 30px rgba(0,0,0,${t===DARK?.18:.08})`, marginBottom:24, overflow:"hidden", border:`1px solid ${t.border}` }}>

      {/* Header */}
      <div style={{ padding:"18px 18px 12px", borderBottom:`1px solid ${t.border}` }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14, flexWrap:"wrap", gap:10 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:24, fontWeight:900, color:t.text, letterSpacing:"-.02em" }}>{sym}</span>
            {isAuto&&<span style={{ background:t===DARK?"#1e3a5f":"#eff6ff", color:t===DARK?"#60a5fa":"#2563eb", fontSize:10, fontWeight:700, padding:"3px 9px", borderRadius:12, border:`1px solid ${t===DARK?"#1e40af":"#bfdbfe"}` }}>AUTO</span>}
          </div>
          <GlobalBadge spread={best} vol={hl.vol24h||0}/>
        </div>
        {/* Metric dots */}
        <div style={{ display:"flex", gap:4, justifyContent:"space-around", flexWrap:"wrap" }}>
          {[
            { label:"Vol HL",    val:fmtMoney(hl.vol24h),    dot:volDot(hl.vol24h||0) },
            { label:"Vol Aster", val:fmtMoney(aster.vol24h), dot:volDot(aster.vol24h||0) },
            { label:"OI HL",     val:fmtMoney(hl.oi),        dot:volDot((hl.oi||0)*2) },
            { label:"Spread",    val:fmtApr(best),            dot:spdDot(best) },
          ].map(m=>(
            <div key={m.label} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:1, minWidth:54 }}>
              <span style={{ fontSize:10, color:m.dot }}>●</span>
              <span style={{ fontSize:9,  color:t.subtle, whiteSpace:"nowrap" }}>{m.label}</span>
              <span style={{ fontSize:10, fontWeight:700, color:t.metricVal??t.text }}>{m.val}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Countdown + Trend */}
      <div style={{ padding:"10px 18px", background:t.strip, borderBottom:`1px solid ${t.border}`, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <span style={{ fontSize:15 }}>⏰</span>
          <div>
            <div style={{ fontSize:9, color:t.subtle, lineHeight:1 }}>PRÓXIMO FUNDING ASTER</div>
            <div style={{ fontSize:16, fontWeight:900, color:t.text, fontFamily:"monospace", letterSpacing:".04em" }}>{countdown}</div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:9, color:t.subtle, lineHeight:1 }}>TENDENCIA</div>
            <div style={{ fontSize:9, color:t.subtle }}>live vs 1D avg</div>
          </div>
          <span style={{ fontSize:26 }}>{trArrow}</span>
        </div>
      </div>

      {/* Live APRs */}
      <div style={{ padding:"8px 18px", background:t.strip, borderBottom:`1px solid ${t.border}`, display:"flex", gap:18, flexWrap:"wrap" }}>
        {[{ dex:"HL",apr:hl.fundingApr },{ dex:"Aster",apr:aster.fundingApr },{ dex:"dYdX",apr:dydx.fundingApr }]
          .filter(d=>d.apr!=null).map(d=>(
            <span key={d.dex} style={{ fontSize:11, color:t.muted }}>
              {d.dex} <b style={{ color:(d.apr||0)>=0?"#ef4444":"#10b981" }}>{fmtApr(d.apr,2)}</b>
            </span>
          ))}
      </div>

      {/* Spread table */}
      <div style={{ overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
          <thead>
            <tr style={{ background:t.tableHead??t.strip }}>
              {["PAR","LIVE","1D","1M","1Y"].map((h,i)=>(
                <th key={h} style={{ padding:"7px 10px", textAlign:i===0?"left":"right", color:t.subtle, fontSize:9, fontWeight:700, letterSpacing:".08em", borderBottom:`1px solid ${t.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pairs.map((p,i)=>(
              <tr key={p.label} style={{ borderBottom:i<pairs.length-1?`1px solid ${t.border}`:"none", background:t.card }}>
                <td style={{ padding:"11px 10px", fontWeight:600, color:t.muted, whiteSpace:"nowrap", fontSize:11 }}>{p.label}</td>
                {[p.live,p.d1,p.m1,p.y1].map((v,vi)=>(
                  <td key={vi} style={{ padding:"11px 10px", textAlign:"right", fontWeight:v!=null?800:400, fontSize:v!=null?14:11, color:v!=null?spdCell(v):t.subtle }}>
                    {fmtApr(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Dark chart + progress (always dark section) */}
      <div style={{ padding:"14px 16px 18px", background:"#080808" }}>
        <SpreadBarChart live={abLive} d1={ab1D} m1={ab1M} y1={ab1Y}/>
        <SpreadProgress current={abLive??ab1D} points={[abLive,ab1D,ab1M,ab1Y,aHlL,hlDL].filter(Boolean)} t={DARK}/>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RankingTab({ config }) {
  const [state, setState]           = useState({ asterComp:{}, hlMap:{}, asterMap:{}, dydxMap:{} });
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [fromCache, setFromCache]   = useState(false);
  const [countdown, setCountdown]   = useState("--:--:--");
  const [darkMode, setDarkMode]     = useState(() => localStorage.getItem(DM_KEY) === "true");

  const t = darkMode ? DARK : LIGHT;

  // Persist dark mode
  useEffect(() => { localStorage.setItem(DM_KEY, darkMode); }, [darkMode]);

  // Shared countdown — one interval for all cards
  useEffect(() => {
    const tick = () => {
      const now=Date.now(), d=new Date();
      const day=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());
      let next=day+24*3600000;
      for (const h of [0,4,8,12,16,20]) { const tt=day+h*3600000; if(tt>now){next=tt;break;} }
      const diff=next-now, hh=Math.floor(diff/3600000), mm=Math.floor((diff%3600000)/60000), ss=Math.floor((diff%60000)/1000);
      setCountdown(`${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:${String(ss).padStart(2,"0")}`);
    };
    tick(); const id=setInterval(tick,1000); return ()=>clearInterval(id);
  }, []);

  const load = useCallback(async (forceRefresh=false) => {
    setLoading(true); setError(null);
    try {
      if (!forceRefresh) {
        const c=loadCache();
        if (c) { setState({ asterComp:c.asterComp||{}, hlMap:c.hlMap||{}, asterMap:c.asterMap||{}, dydxMap:c.dydxMap||{} }); setLastUpdate(new Date(c.ts)); setFromCache(true); return; }
      }
      const [asterComp,hlMap,asterMap,dydxMap] = await Promise.all([
        fetchAsterComp(), fetchHL().catch(()=>({})), fetchAster().catch(()=>({})), fetchDydx().catch(()=>({})),
      ]);
      const data={asterComp,hlMap,asterMap,dydxMap};
      saveCache(data); setState(data); setLastUpdate(new Date()); setFromCache(false);
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const autoToken = useMemo(() => {
    const { asterComp, hlMap }=state;
    return Object.entries(asterComp)
      .filter(([s])=>!FIXED_TOKENS.includes(s))
      .filter(([s,p])=>p["1Y"]?.asterBybitComparison!=null&&(hlMap[s]?.vol24h||0)>=100_000)
      .map(([s,p])=>({ s, v:Math.abs(parseFloat(p["1Y"].asterBybitComparison)*100) }))
      .sort((a,b)=>b.v-a.v)[0]?.s||null;
  }, [state]);

  const tokens = useMemo(()=>[...FIXED_TOKENS,...(autoToken?[autoToken]:[])],[autoToken]);

  return (
    <div style={{ maxWidth:480, margin:"0 auto", padding:"0 4px", background:t.bg, minHeight:"100vh" }}>
      <style>{CSS}</style>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 0 18px", flexWrap:"wrap", gap:10 }}>
        <div>
          <div style={{ fontSize:11, fontWeight:700, color:t.subtle, letterSpacing:".10em", textTransform:"uppercase" }}>Funding Arb · Aster · HL · dYdX</div>
          {lastUpdate&&(
            <div style={{ fontSize:11, color:t.subtle, marginTop:2 }}>
              {fromCache?"Caché":"Live"}: {lastUpdate.toLocaleTimeString()}
              {fromCache&&<button onClick={()=>load(true)} style={{ background:"none",border:"none",color:t.accent,cursor:"pointer",fontSize:11,fontWeight:700,padding:"0 0 0 8px" }}>↺ Refrescar</button>}
            </div>
          )}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {/* Dark mode toggle */}
          <button onClick={()=>setDarkMode(d=>!d)} title={darkMode?"Modo claro":"Modo oscuro"} style={{
            width:44, height:26, borderRadius:13, border:"none", cursor:"pointer",
            background:darkMode?"#6366f1":"#e2e8f0", position:"relative", transition:"background .3s",
            flexShrink:0,
          }}>
            <div style={{
              width:20, height:20, borderRadius:"50%", background:"#fff",
              position:"absolute", top:3, left:darkMode?21:3, transition:"left .3s",
              boxShadow:"0 1px 4px rgba(0,0,0,.3)",
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:11,
            }}>{darkMode?"🌙":"☀️"}</div>
          </button>
          <button onClick={()=>load(true)} disabled={loading} style={{
            background:loading?"transparent":`linear-gradient(135deg,${t.accent},#8b5cf6)`,
            border:loading?`1px solid ${t.border}`:"none",
            color:loading?t.subtle:"#fff", borderRadius:12, padding:"10px 20px",
            cursor:loading?"not-allowed":"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700,
            boxShadow:loading?"none":`0 4px 12px rgba(99,102,241,.4)`,
          }}>
            {loading?"Cargando...":"↻ Refrescar"}
          </button>
        </div>
      </div>

      {error&&<div style={{ background:"#fee2e2",border:"1px solid #fca5a5",borderRadius:14,padding:16,color:"#dc2626",fontSize:13,marginBottom:16 }}>Error: {error}</div>}

      {loading&&(
        <div style={{ background:t.card,border:`1px solid ${t.border}`,borderRadius:22,padding:40,textAlign:"center",marginBottom:16 }}>
          <div style={{ fontSize:32,marginBottom:12 }}>⏳</div>
          <div style={{ color:t.accent,fontSize:15,fontWeight:700 }}>Cargando datos...</div>
          <div style={{ color:t.subtle,fontSize:12,marginTop:6 }}>Aster · Hyperliquid · dYdX</div>
        </div>
      )}

      {!loading&&tokens.map(sym=>(
        <TokenCard key={sym} sym={sym} asterComp={state.asterComp} hlMap={state.hlMap} asterMap={state.asterMap} dydxMap={state.dydxMap} isAuto={sym===autoToken} countdown={countdown} t={t}/>
      ))}

      {!loading&&tokens.length===0&&!error&&(
        <div style={{ background:t.card,border:`1px solid ${t.border}`,borderRadius:22,padding:40,textAlign:"center",color:t.subtle }}>Sin datos. Pulsa Refrescar.</div>
      )}
    </div>
  );
}
