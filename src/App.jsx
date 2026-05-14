import { useState } from "react";
import RankingTab from "./RankingTab";
import useHistory from "./useHistory";

const TABS = ["Ranking", "Histórico", "Alertas", "Config"];

const T = {
  bg: "#f0f2f5", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", subtle: "#94a3b8",
  green: "#10b981", greenBg: "#d1fae5",
  red: "#ef4444", redBg: "#fee2e2",
  yellow: "#f59e0b", yellowBg: "#fef3c7",
  blue: "#3b82f6", blueBg: "#dbeafe",
  accent: "#6366f1",
};

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

  const { history, exportCsv } = useHistory();
  const [alerts] = useState(() => JSON.parse(localStorage.getItem("alerts_log") || "[]"));

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.text, fontFamily: "'DM Sans','Segoe UI',sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
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
      </div>

      <div style={{ padding: "24px 32px", maxWidth: 1100, margin: "0 auto" }}>
        {tab === 0 && <RankingTab config={config} />}
        {tab === 1 && <HistoricoTab history={history} exportCsv={exportCsv} />}
        {tab === 2 && <AlertasTab alerts={alerts} />}
        {tab === 3 && <ConfigTab config={config} setConfig={setConfig} />}
      </div>
    </div>
  );
}

function HistoricoTab({ history, exportCsv }) {
  const [capital, setCapital] = useState(100);
  const [days, setDays]       = useState(30);
  const [apr, setApr]         = useState(0);
  const profit = (capital * 3 * apr / 100) * (days / 365) - 0.20 * Math.ceil(days / 7);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ color: T.text, fontSize: 22, fontWeight: 800 }}>Histórico Ranking</div>
        <button onClick={exportCsv} style={{ background: T.card, border: `1px solid ${T.border}`, color: T.muted, borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>↓ Export CSV</button>
      </div>
      <Card>
        <ChartLight history={history} />
      </Card>
      <Card>
        <Label>SIMULADOR</Label>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "14px 0" }}>
          {[
            { label: "Capital ($)", val: capital, set: setCapital, w: 90 },
            { label: "APR (%)",     val: apr,     set: setApr,     w: 70 },
            { label: "Días",        val: days,    set: setDays,    w: 70 },
          ].map(({ label, val, set, w }) => (
            <label key={label} style={{ color: T.muted, fontSize: 14 }}>{label}:
              <input type="number" value={val} onChange={e => set(+e.target.value)} style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.text, borderRadius: 8, padding: "6px 12px", width: w, marginLeft: 8, fontFamily: "inherit", fontSize: 14 }} />
            </label>
          ))}
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <BigStat label="APR"                  value={`${apr.toFixed(1)}%`} />
          <BigStat label="Notional (×3)"        value={`$${(capital*3).toFixed(0)}`} />
          <BigStat label={`Ganancia ~${days}d`} value={`$${profit.toFixed(2)}`} ok={profit > 0} />
          <BigStat label="ROI"                  value={`${((profit/capital)*100).toFixed(1)}%`} ok={profit > 0} />
        </div>
      </Card>
    </div>
  );
}

function AlertasTab({ alerts }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ color: T.text, fontSize: 22, fontWeight: 800 }}>Alertas Telegram ({alerts.length})</div>
      {alerts.length === 0 && <Card><div style={{ color: T.muted }}>Sin alertas registradas.</div></Card>}
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
    { label: "Telegram Token",       key: "tg_token",       stateKey: "telegramToken",  type: "password" },
    { label: "Telegram Chat ID",     key: "tg_chat",        stateKey: "telegramChatId", type: "password" },
    { label: "Position size ($)",    key: "position_size",  stateKey: "positionSize",   type: "number" },
    { label: "Refresh (ms)",         key: "refresh_ms",     stateKey: "refreshMs",      type: "number" },
    { label: "Vol mínimo Long ($)",  key: "min_hl_vol",     stateKey: "minHlVol",       type: "number" },
    { label: "Vol mínimo Short ($)", key: "min_ext_vol",    stateKey: "minExtVol",      type: "number" },
    { label: "Price parity máx (%)", key: "max_price_diff", stateKey: "maxPriceDiff",   type: "number" },
  ];
  const toKey = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const save  = (key, val) => { localStorage.setItem(key, val); setConfig(c => ({ ...c, [toKey(key)]: isNaN(+val) ? val : +val })); };
  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ color: T.text, fontSize: 22, fontWeight: 800, marginBottom: 20 }}>Configuración</div>
      <div style={{ background: T.yellowBg, border: "1px solid #fcd34d", borderRadius: 10, padding: "10px 14px", marginBottom: 20, color: "#92400e", fontSize: 13, fontWeight: 500 }}>
        ⚠ Variables sensibles van en Railway, no aquí
      </div>
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
