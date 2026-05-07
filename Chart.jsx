import { useState, useEffect } from "react";
import useMarket, { getClassification } from "./useMarket";
import useHistory from "./useHistory";
import RankingTab from "./RankingTab";

const TABS = ["Monitor", "Ranking", "Histórico", "Alertas", "Config"];

const T = {
  bg: "#f0f2f5", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", subtle: "#94a3b8",
  green: "#10b981", greenBg: "#d1fae5",
  red: "#ef4444", redBg: "#fee2e2",
  yellow: "#f59e0b", yellowBg: "#fef3c7",
  blue: "#3b82f6", blueBg: "#dbeafe",
  accent: "#6366f1",
};

function cls(score) {
  if (score >= 80) return { label: "TOP",   color: T.green,  bg: T.greenBg,  emoji: "🔥" };
  if (score >= 65) return { label: "GOOD",  color: T.green,  bg: T.greenBg,  emoji: "🟢" };
  if (score >= 50) return { label: "OK",    color: T.yellow, bg: T.yellowBg, emoji: "🟡" };
  return              { label: "AVOID", color: T.red,    bg: T.redBg,    emoji: "🔴" };
}

function Card({ children, style = {} }) {
  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: 16, padding: "20px 24px",
      boxShadow: "0 1px 4px rgba(0,0,0,0.06)", ...style
    }}>{children}</div>
  );
}

function Label({ children }) {
  return <div style={{ color: T.subtle, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>{children}</div>;
}

function BigStat({ label, value, sub, ok, highlight }) {
  const color = ok === undefined ? (highlight ? T.green : T.text) : ok ? T.green : T.red;
  return (
    <div style={{
      background: highlight ? T.greenBg : T.card,
      border: `1px solid ${highlight ? "#a7f3d0" : T.border}`,
      borderRadius: 12, padding: "16px 20px", flex: 1, minWidth: 130
    }}>
      <Label>{label}</Label>
      <div style={{ color, fontSize: 24, fontWeight: 800, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ color: T.subtle, fontSize: 12, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function FundingClock() {
  const [rem, setRem] = useState("");
  useEffect(() => {
    const tick = () => {
      const now = new Date(), next = new Date(now);
      next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
      const d = next - now;
      setRem(`${Math.floor(d/60000)}m ${Math.floor((d%60000)/1000)}s`);
    };
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id);
  }, []);
  return (
    <div style={{ textAlign: "right" }}>
      <Label>Próximo funding</Label>
      <div style={{ color: T.text, fontSize: 20, fontWeight: 700 }}>{rem}</div>
    </div>
  );
}

function ChartLight({ history }) {
  if (!history || history.length < 2) return <div style={{ color: T.subtle, fontSize: 13, padding: 20, textAlign: "center" }}>Acumulando datos...</div>;
  const W = 640, H = 200;
  const PAD = { top: 16, right: 16, bottom: 28, left: 48 };
  const IW = W - PAD.left - PAD.right, IH = H - PAD.top - PAD.bottom;
  const sample = history.length > 48 ? history.filter((_, i) => i % Math.floor(history.length / 48) === 0).slice(-48) : history;
  const vals = sample.map(h => h.spreadApr || 0);
  const avg  = vals.reduce((a, b) => a + b, 0) / vals.length;
  const max  = Math.max(...vals, 0), min = Math.min(...vals, 0);
  const yMax = max + Math.abs(max - min) * 0.15 + 5, yMin = Math.min(min - 2, 0);
  const toX  = i => PAD.left + (i / Math.max(sample.length - 1, 1)) * IW;
  const toY  = v => PAD.top + IH - ((v - yMin) / (yMax - yMin)) * IH;
  const barW = Math.max(3, IW / sample.length - 1);
  const avgY = toY(avg);
  return (
    <div>
      <div style={{ display: "flex", gap: 24, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          { l: "Media APR", v: `${avg.toFixed(1)}%`, c: T.blue },
          { l: "Máximo",    v: `${max.toFixed(1)}%`, c: T.green },
          { l: "Mínimo",    v: `${min.toFixed(1)}%`, c: T.red },
          { l: "% positivos", v: `${(vals.filter(v => v > 0).length / vals.length * 100).toFixed(0)}%`, c: T.text },
        ].map(({ l, v, c }) => (
          <div key={l}>
            <div style={{ color: T.subtle, fontSize: 11 }}>{l}</div>
            <div style={{ color: c, fontSize: 20, fontWeight: 800 }}>{v}</div>
          </div>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 20, borderTop: `2px dashed ${T.blue}` }} />
            <span style={{ color: T.blue, fontSize: 12, fontWeight: 600 }}>Media {avg.toFixed(1)}%</span>
          </div>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <svg width={W} height={H} style={{ display: "block" }}>
          {[0, 25, 50, 75, 100].map(p => {
            const v = yMin + (yMax - yMin) * p / 100, y = toY(v);
            return <g key={p}><line x1={PAD.left} y1={y} x2={W-PAD.right} y2={y} stroke={T.border} strokeWidth={1}/><text x={PAD.left-6} y={y+4} fill={T.subtle} fontSize={9} textAnchor="end">{v.toFixed(0)}%</text></g>;
          })}
          {sample.map((h, i) => {
            const v = h.spreadApr || 0;
            const x = PAD.left + (i / sample.length) * IW;
            const barTop = toY(Math.max(v, 0)), barBot = toY(Math.min(v, 0));
            const barH = Math.max(Math.abs(barBot - barTop), 2);
            const color = v >= 70 ? T.green : v >= 40 ? "#34d399" : v > 0 ? "#6ee7b7" : T.red;
            return <rect key={i} x={x} y={barTop} width={barW} height={barH} fill={color} rx={1} opacity={0.85}/>;
          })}
          <line x1={PAD.left} y1={avgY} x2={W-PAD.right} y2={avgY} stroke={T.blue} strokeWidth={2} strokeDasharray="8,5"/>
          <rect x={W-PAD.right-50} y={avgY-11} width={46} height={16} rx={4} fill={T.blueBg}/>
          <text x={W-PAD.right-27} y={avgY+1} fill={T.blue} fontSize={9} textAnchor="middle" fontWeight="700">{avg.toFixed(1)}%</text>
          {[0, Math.floor(sample.length/2), sample.length-1].map(i => i < sample.length && (
            <text key={i} x={PAD.left+(i/sample.length)*IW+barW/2} y={H-PAD.bottom+14} fill={T.subtle} fontSize={9} textAnchor="middle">
              {new Date(sample[i].ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState(0);
  const [config, setConfig] = useState({
    telegramToken:  localStorage.getItem("tg_token")      || import.meta.env.VITE_TELEGRAM_TOKEN   || "",
    telegramChatId: localStorage.getItem("tg_chat")       || import.meta.env.VITE_TELEGRAM_CHAT_ID || "",
    minSpread:      parseFloat(localStorage.getItem("min_spread")     || "0.05"),
    refreshMs:      parseInt(  localStorage.getItem("refresh_ms")     || "15000"),
    minHlVol:       parseInt(  localStorage.getItem("min_hl_vol")     || "100000"),
    minExtVol:      parseInt(  localStorage.getItem("min_ext_vol")    || "30000"),
    maxPriceDiff:   parseFloat(localStorage.getItem("max_price_diff") || "0.15"),
    positionSize:   parseInt(  localStorage.getItem("position_size")  || "150"),
  });

  const { data, loading, error, lastFetch } = useMarket(config);
  const { history, addEntry, exportCsv }    = useHistory();
  const [alerts, setAlerts]     = useState(() => JSON.parse(localStorage.getItem("alerts_log") || "[]"));
  const [lastAlertTs, setLastAlertTs] = useState(0);

  useEffect(() => {
    if (!data) return;
    addEntry(data);
    const now = Date.now();
    if (data.score >= 75 && now - lastAlertTs > 300000) {
      sendTelegram(data, config, setAlerts); setLastAlertTs(now);
    }
  }, [data]);

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.text, fontFamily: "'DM Sans','Segoe UI',sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      {/* Header */}
      <div style={{ background: T.card, borderBottom: `1px solid ${T.border}`, padding: "0 32px", display: "flex", alignItems: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 0", marginRight: 32 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: T.green, boxShadow: `0 0 8px ${T.green}` }} />
          <span style={{ fontWeight: 800, fontSize: 18, color: T.text, letterSpacing: -0.5 }}>FundingArb</span>
          <span style={{ background: T.accent+"20", color: T.accent, fontSize: 11, fontWeight: 700, borderRadius: 6, padding: "2px 8px" }}>v5</span>
        </div>
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} style={{
            background: "none", border: "none",
            color: tab === i ? T.accent : T.muted,
            borderBottom: tab === i ? `2px solid ${T.accent}` : "2px solid transparent",
            padding: "18px 16px", cursor: "pointer", fontSize: 14,
            fontFamily: "inherit", fontWeight: tab === i ? 700 : 500
          }}>{t}</button>
        ))}
        <div style={{ marginLeft: "auto", color: T.subtle, fontSize: 12 }}>
          {lastFetch ? `↻ ${lastFetch.toLocaleTimeString()}` : "Conectando..."}
        </div>
      </div>

      <div style={{ padding: "24px 32px", maxWidth: 1100, margin: "0 auto" }}>
        {tab === 0 && <MonitorTab data={data} loading={loading} error={error} config={config} history={history} />}
        {tab === 1 && <RankingTab config={config} />}
        {tab === 2 && <HistoricoTab history={history} data={data} exportCsv={exportCsv} />}
        {tab === 3 && <AlertasTab alerts={alerts} />}
        {tab === 4 && <ConfigTab config={config} setConfig={setConfig} />}
      </div>
    </div>
  );
}

function MonitorTab({ data, loading, error, config, history }) {
  if (loading) return <div style={{ color: T.muted, padding: 60, textAlign: "center", fontSize: 16 }}>Conectando a APIs...</div>;
  if (error)   return <div style={{ color: T.red,   padding: 60, textAlign: "center", fontSize: 16 }}>Error: {error}</div>;
  if (!data)   return null;
  const { shortDex, longDex, shortFunding, longFunding, spreadApr, priceDiff, spreadPct, slippage, impact, liquidity, maxSize, netBenefit, extOI, score, passes, filterReasons } = data;
  const c = cls(score);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
          <div>
            <Label>KAITO — SHORT {shortDex} · LONG {longDex}</Label>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 12, background: c.bg, border: `1.5px solid ${c.color}44`, borderRadius: 12, padding: "12px 24px", marginTop: 8 }}>
              <div style={{ width: 14, height: 14, borderRadius: "50%", background: c.color }} />
              <span style={{ color: c.color, fontWeight: 800, fontSize: 36 }}>{score}</span>
              <span style={{ color: T.muted, fontSize: 22 }}>/100</span>
              <span style={{ background: c.color, color: "#fff", borderRadius: 8, padding: "4px 14px", fontSize: 15, fontWeight: 700 }}>{c.emoji} {c.label}</span>
            </div>
          </div>
          <FundingClock />
        </div>
      </Card>

      <Card>
        <Label>PAR ÓPTIMO</Label>
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 12, flexWrap: "wrap" }}>
          <div style={{ background: T.redBg, borderRadius: 12, padding: "14px 20px" }}>
            <div style={{ color: T.red, fontSize: 12, fontWeight: 600 }}>SHORT · funding alto</div>
            <div style={{ color: T.text, fontSize: 24, fontWeight: 800, marginTop: 4 }}>{shortDex}</div>
            <div style={{ color: T.red, fontSize: 20, fontWeight: 700 }}>{shortFunding?.toFixed(2)}%</div>
          </div>
          <div style={{ color: T.subtle, fontSize: 32 }}>→</div>
          <div style={{ background: T.greenBg, borderRadius: 12, padding: "14px 20px" }}>
            <div style={{ color: T.green, fontSize: 12, fontWeight: 600 }}>LONG · funding bajo</div>
            <div style={{ color: T.text, fontSize: 24, fontWeight: 800, marginTop: 4 }}>{longDex}</div>
            <div style={{ color: T.green, fontSize: 20, fontWeight: 700 }}>{longFunding?.toFixed(2)}%</div>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <Label>SPREAD APR</Label>
            <div style={{ color: T.yellow, fontSize: 48, fontWeight: 800, lineHeight: 1 }}>{spreadApr?.toFixed(1)}%</div>
          </div>
        </div>
      </Card>

      {!passes && filterReasons?.length > 0 && (
        <div style={{ background: T.redBg, border: `1px solid ${T.red}44`, borderRadius: 12, padding: 16 }}>
          <div style={{ color: T.red, fontWeight: 700, fontSize: 15, marginBottom: 8 }}>⚠ Filtros duros no superados</div>
          {filterReasons.map((r, i) => <div key={i} style={{ color: T.red, fontSize: 13, marginTop: 4 }}>· {r}</div>)}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <BigStat label="Spread mercado" value={`${(spreadPct*100).toFixed(3)}%`} ok={spreadPct < 0.001} />
        <BigStat label="Slippage"       value={`${(slippage*100).toFixed(3)}%`}  ok={slippage < 0.001} />
        <BigStat label="Impact"         value={`${(impact*100).toFixed(2)}%`}    ok={impact < 0.05} sub={`pos $${config.positionSize}`} />
        <BigStat label="Max size"       value={`$${maxSize?.toFixed(0)}`}         highlight />
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <BigStat label="Liquidez ±0.5%" value={`$${(liquidity/1000).toFixed(0)}K`} ok={liquidity > 10000} />
        <BigStat label="Beneficio/8h"   value={`${netBenefit > 0?"+":""}${(netBenefit*100).toFixed(4)}%`} ok={netBenefit > 0} sub="tras costes" />
        <BigStat label="Price parity"   value={`${priceDiff?.toFixed(3)}%`} ok={priceDiff < config.maxPriceDiff} />
        <BigStat label="OI referencia"  value={`$${(extOI/1000).toFixed(0)}K`} ok={extOI > 500000} />
      </div>

      {/* Score breakdown */}
      <Card>
        <Label>SCORE BREAKDOWN</Label>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
          {[
            { l: "Funding diff",   pct: 25, ok: spreadApr > 10,         val: `${spreadApr?.toFixed(1)}% APR` },
            { l: "Spread mercado", pct: 20, ok: spreadPct < 0.001,       val: `${(spreadPct*100).toFixed(3)}%` },
            { l: "Slippage",       pct: 20, ok: slippage < 0.001,        val: `${(slippage*100).toFixed(3)}%` },
            { l: "Impact",         pct: 20, ok: impact < 0.05,           val: `${(impact*100).toFixed(2)}%` },
            { l: "Volumen mín",    pct: 10, ok: data.vol >= 100000,      val: `$${(data.vol/1000).toFixed(0)}K` },
            { l: "Open Interest",  pct: 5,  ok: data.oi > 500000,        val: `$${(data.oi/1000).toFixed(0)}K` },
          ].map(({ l, pct, ok, val }) => (
            <div key={l} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 16 }}>{ok ? "✅" : "❌"}</span>
              <span style={{ color: T.text, fontSize: 14, flex: 1, fontWeight: 500 }}>{l}</span>
              <span style={{ color: T.muted, fontSize: 13 }}>{val}</span>
              <span style={{ color: T.subtle, fontSize: 12, width: 30, textAlign: "right" }}>{pct}%</span>
              <div style={{ width: 80, height: 6, background: T.border, borderRadius: 3 }}>
                <div style={{ width: ok ? "100%" : "0%", height: "100%", background: ok ? T.green : T.border, borderRadius: 3, transition: "width 0.5s" }} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Gráfico integrado */}
      {history?.length > 1 && (
        <Card>
          <Label>HISTÓRICO SPREAD APR</Label>
          <ChartLight history={history} />
        </Card>
      )}

      {score >= 65 && passes && (
        <div style={{ background: c.bg, border: `1.5px solid ${c.color}55`, borderRadius: 12, padding: 20 }}>
          <div style={{ color: c.color, fontWeight: 800, fontSize: 18, marginBottom: 8 }}>{c.emoji} TRADE {c.label}</div>
          <div style={{ color: T.text, fontSize: 15 }}>SHORT KAITO en <b>{shortDex}</b> · LONG KAITO en <b>{longDex}</b></div>
          <div style={{ color: T.muted, fontSize: 13, marginTop: 6 }}>Max: <b style={{ color: c.color }}>${maxSize?.toFixed(0)}</b> · LIMIT orders · Delta-neutral</div>
        </div>
      )}
    </div>
  );
}

function HistoricoTab({ history, data, exportCsv }) {
  const [capital, setCapital] = useState(100);
  const [days, setDays]       = useState(30);
  const apr    = data?.spreadApr || 0;
  const profit = (capital * 3 * apr / 100) * (days / 365) - 0.20 * Math.ceil(days / 7);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ color: T.text, fontSize: 22, fontWeight: 800 }}>Histórico KAITO</div>
        <button onClick={exportCsv} style={{ background: T.card, border: `1px solid ${T.border}`, color: T.muted, borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>↓ Export CSV</button>
      </div>
      <Card>
        <ChartLight history={history} />
      </Card>
      <Card>
        <Label>SIMULADOR</Label>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "14px 0" }}>
          {[{ label: "Capital ($)", val: capital, set: setCapital, w: 90 }, { label: "Días", val: days, set: setDays, w: 70 }].map(({ label, val, set, w }) => (
            <label key={label} style={{ color: T.muted, fontSize: 14 }}>{label}:
              <input type="number" value={val} onChange={e => set(+e.target.value)} style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.text, borderRadius: 8, padding: "6px 12px", width: w, marginLeft: 8, fontFamily: "inherit", fontSize: 14 }} />
            </label>
          ))}
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <BigStat label="APR actual"        value={`${apr.toFixed(1)}%`} />
          <BigStat label="Notional (×3)"     value={`$${(capital*3).toFixed(0)}`} />
          <BigStat label={`Ganancia ~${days}d`} value={`$${profit.toFixed(2)}`} ok={profit > 0} />
          <BigStat label="ROI"               value={`${((profit/capital)*100).toFixed(1)}%`} ok={profit > 0} />
        </div>
      </Card>
    </div>
  );
}

function AlertasTab({ alerts }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ color: T.text, fontSize: 22, fontWeight: 800 }}>Alertas Telegram ({alerts.length})</div>
      {alerts.length === 0 && <Card><div style={{ color: T.muted }}>Sin alertas. Score ≥ 75 para activar.</div></Card>}
      {[...alerts].reverse().map((a, i) => (
        <Card key={i} style={{ padding: "14px 20px" }}>
          <div style={{ color: T.subtle, fontSize: 12 }}>{new Date(a.ts).toLocaleString()}</div>
          <div style={{ color: T.text, fontSize: 14, marginTop: 6, whiteSpace: "pre-wrap" }}>{a.msg}</div>
        </Card>
      ))}
    </div>
  );
}

function ConfigTab({ config, setConfig }) {
  const fields = [
    { label: "Telegram Token", key: "tg_token", stateKey: "telegramToken", type: "text" },
    { label: "Telegram Chat ID", key: "tg_chat", stateKey: "telegramChatId", type: "text" },
    { label: "Position size ($)", key: "position_size", stateKey: "positionSize", type: "number" },
    { label: "Refresh (ms)", key: "refresh_ms", stateKey: "refreshMs", type: "number" },
    { label: "Vol mínimo Long ($)", key: "min_hl_vol", stateKey: "minHlVol", type: "number" },
    { label: "Vol mínimo Short ($)", key: "min_ext_vol", stateKey: "minExtVol", type: "number" },
    { label: "Price parity máx (%)", key: "max_price_diff", stateKey: "maxPriceDiff", type: "number" },
  ];
  const toKey = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const save  = (key, val) => { localStorage.setItem(key, val); setConfig(c => ({ ...c, [toKey(key)]: isNaN(+val) ? val : +val })); };
  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ color: T.text, fontSize: 22, fontWeight: 800, marginBottom: 20 }}>Configuración</div>
      {fields.map(({ label, key, stateKey, type }) => (
        <div key={key} style={{ marginBottom: 16 }}>
          <div style={{ color: T.muted, fontSize: 13, fontWeight: 500, marginBottom: 6 }}>{label}</div>
          <input type={type} defaultValue={config[stateKey]} onBlur={e => save(key, e.target.value)}
            style={{ background: T.card, border: `1px solid ${T.border}`, color: T.text, borderRadius: 8, padding: "10px 14px", width: "100%", fontFamily: "inherit", fontSize: 14 }} />
        </div>
      ))}
    </div>
  );
}

async function sendTelegram(data, config, setAlerts) {
  const { telegramToken: token, telegramChatId: chatId } = config;
  if (!token || !chatId) return;
  const c   = cls(data.score);
  const lvl = data.score >= 85 ? "🔥 STRONG ENTRY" : data.score >= 75 ? "🟢 ENTER" : "🟡 WATCH";
  const msg = `${lvl}\n\nPar: KAITO\nSHORT: ${data.shortDex} (${data.shortFunding?.toFixed(2)}% APR)\nLONG: ${data.longDex} (${data.longFunding?.toFixed(2)}% APR)\nSpread: ${data.spreadApr?.toFixed(1)}% APR\nScore: ${data.score}/100 ${c.label}\nImpact: ${(data.impact*100).toFixed(2)}%\nMax size: $${data.maxSize?.toFixed(0)}\nNet/8h: ${data.netBenefit > 0?"+":""}${(data.netBenefit*100).toFixed(4)}%\nEjecución: LIMIT orders`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg })
    });
    const entry = { ts: Date.now(), msg };
    setAlerts(prev => { const next = [...prev, entry]; localStorage.setItem("alerts_log", JSON.stringify(next.slice(-100))); return next; });
  } catch (e) { console.error("Telegram:", e); }
}
