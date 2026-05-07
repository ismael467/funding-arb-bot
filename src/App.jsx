import { useState, useEffect } from "react";
import useMarket, { getClassification } from "./useMarket";
import useHistory from "./useHistory";
import Chart from "./Chart";

const TABS = ["Monitor", "DEX Compare", "Histórico", "Alertas", "Config"];

// ─── COMPONENTES BASE ─────────────────────────────────────────

function ClassBadge({ score }) {
  const cls = getClassification(score);
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 10,
      background: cls.color + "18", border: `1px solid ${cls.color}55`,
      borderRadius: 10, padding: "10px 20px"
    }}>
      <div style={{ width: 12, height: 12, borderRadius: "50%", background: cls.color, boxShadow: `0 0 12px ${cls.color}` }} />
      <span style={{ color: cls.color, fontWeight: 700, fontSize: 22 }}>{score}/100</span>
      <span style={{ background: cls.color + "33", color: cls.color, borderRadius: 6, padding: "2px 10px", fontSize: 13, fontWeight: 700 }}>
        {cls.emoji} {cls.label}
      </span>
    </div>
  );
}

function StatCard({ label, value, sub, ok, highlight }) {
  const color = ok === undefined ? (highlight ? "#00ff88" : "#fff") : ok ? "#00ff88" : "#ff4444";
  return (
    <div style={{
      background: highlight ? "#00ff8808" : "#111",
      border: `1px solid ${highlight ? "#00ff8833" : "#1e1e1e"}`,
      borderRadius: 10, padding: "14px 18px", flex: 1, minWidth: 130
    }}>
      <div style={{ color: "#555", fontSize: 11, marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
      <div style={{ color, fontSize: 18, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ color: "#444", fontSize: 11, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function FundingClock() {
  const [remaining, setRemaining] = useState("");
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const next = new Date(now);
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      const diff = next - now;
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setRemaining(`${m}m ${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ color: "#555", fontSize: 11 }}>Próximo funding</div>
      <div style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>{remaining}</div>
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState(0);
  const [config, setConfig] = useState({
    telegramToken:  localStorage.getItem("tg_token")      || import.meta.env.VITE_TELEGRAM_TOKEN  || "",
    telegramChatId: localStorage.getItem("tg_chat")       || import.meta.env.VITE_TELEGRAM_CHAT_ID || "",
    minSpread:      parseFloat(localStorage.getItem("min_spread")     || "0.05"),
    refreshMs:      parseInt(  localStorage.getItem("refresh_ms")     || "15000"),
    minHlVol:       parseInt(  localStorage.getItem("min_hl_vol")     || "100000"),
    minExtVol:      parseInt(  localStorage.getItem("min_ext_vol")    || "30000"),
    maxPriceDiff:   parseFloat(localStorage.getItem("max_price_diff") || "0.15"),
    positionSize:   parseInt(  localStorage.getItem("position_size")  || "150"),
  });

  const { data, loading, error, lastFetch } = useMarket(config);
  const { history, addEntry, exportCsv } = useHistory();
  const [alerts, setAlerts] = useState(() => JSON.parse(localStorage.getItem("alerts_log") || "[]"));
  const [lastAlertTs, setLastAlertTs] = useState(0);

  useEffect(() => {
    if (!data) return;
    addEntry(data);
    const now = Date.now();
    if (data.score >= 75 && now - lastAlertTs > 300000) {
      sendTelegram(data, config, setAlerts);
      setLastAlertTs(now);
    }
  }, [data]);

  const dexStatus = data?.allDex?.length
    ? `${data.allDex.map(d => d.name).join(" · ")} ✓`
    : "Conectando...";

  return (
    <div style={{ background: "#0a0a0a", minHeight: "100vh", color: "#fff", fontFamily: "'JetBrains Mono', monospace" }}>
      {/* Header */}
      <div style={{ borderBottom: "1px solid #1a1a1a", padding: "16px 24px", display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00ff88", boxShadow: "0 0 10px #00ff88", animation: "pulse 2s infinite" }} />
        <span style={{ fontWeight: 700, fontSize: 16, color: "#00ff88" }}>FUNDING ARB BOT</span>
        <span style={{ color: "#333", fontSize: 11 }}>v4 · {dexStatus}</span>
        <div style={{ marginLeft: "auto", color: "#333", fontSize: 11 }}>
          {lastFetch ? `↻ ${lastFetch.toLocaleTimeString()}` : "Cargando..."}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid #1a1a1a", padding: "0 24px", overflowX: "auto" }}>
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} style={{
            background: "none", border: "none",
            color: tab === i ? "#00ff88" : "#444",
            borderBottom: tab === i ? "2px solid #00ff88" : "2px solid transparent",
            padding: "12px 16px", cursor: "pointer", fontSize: 12,
            fontFamily: "inherit", whiteSpace: "nowrap"
          }}>{t}</button>
        ))}
      </div>

      <div style={{ padding: 24 }}>
        {tab === 0 && <MonitorTab data={data} loading={loading} error={error} config={config} />}
        {tab === 1 && <DexCompareTab data={data} loading={loading} />}
        {tab === 2 && <HistoricoTab history={history} data={data} exportCsv={exportCsv} />}
        {tab === 3 && <AlertasTab alerts={alerts} />}
        {tab === 4 && <ConfigTab config={config} setConfig={setConfig} />}
      </div>

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
    </div>
  );
}

// ─── MONITOR TAB ──────────────────────────────────────────────

function MonitorTab({ data, loading, error, config }) {
  if (loading) return <div style={{ color: "#333", padding: 60, textAlign: "center" }}>Conectando a APIs...</div>;
  if (error)   return <div style={{ color: "#ff4444", padding: 60, textAlign: "center" }}>Error: {error}</div>;
  if (!data)   return null;

  const { shortDex, longDex, shortFunding, longFunding, shortPrice, longPrice,
          shortVol, longVol, spreadApr, priceDiff, spreadPct, slippage,
          impact, liquidity, maxSize, netBenefit, extOI,
          score, passes, filterReasons } = data;

  const cls = getClassification(score);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Score + Clock */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ color: "#333", fontSize: 11, marginBottom: 8, letterSpacing: 1 }}>
            KAITO — SHORT {shortDex} · LONG {longDex}
          </div>
          <ClassBadge score={score} />
        </div>
        <FundingClock />
      </div>

      {/* Par óptimo detectado automáticamente */}
      <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 10, padding: 14 }}>
        <div style={{ color: "#555", fontSize: 11, marginBottom: 10, letterSpacing: 1 }}>PAR ÓPTIMO DETECTADO</div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ color: "#ff4444", fontSize: 11 }}>SHORT (funding alto)</div>
            <div style={{ color: "#fff", fontSize: 16, fontWeight: 700 }}>{shortDex}</div>
            <div style={{ color: "#ff6666", fontSize: 13 }}>{shortFunding?.toFixed(2)}% APR</div>
          </div>
          <div style={{ color: "#333", fontSize: 24 }}>→</div>
          <div>
            <div style={{ color: "#00ff88", fontSize: 11 }}>LONG (funding bajo)</div>
            <div style={{ color: "#fff", fontSize: 16, fontWeight: 700 }}>{longDex}</div>
            <div style={{ color: "#00ff88", fontSize: 13 }}>{longFunding?.toFixed(2)}% APR</div>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div style={{ color: "#555", fontSize: 11 }}>Spread APR</div>
            <div style={{ color: "#ffcc00", fontSize: 20, fontWeight: 700 }}>{spreadApr?.toFixed(1)}%</div>
          </div>
        </div>
      </div>

      {/* Filtros duros */}
      {!passes && filterReasons.length > 0 && (
        <div style={{ background: "#ff444410", border: "1px solid #ff444433", borderRadius: 10, padding: 14 }}>
          <div style={{ color: "#ff4444", fontSize: 11, marginBottom: 8, fontWeight: 700 }}>⚠ FILTROS DUROS NO SUPERADOS</div>
          {filterReasons.map((r, i) => (
            <div key={i} style={{ color: "#ff6666", fontSize: 12, marginTop: 4 }}>· {r}</div>
          ))}
        </div>
      )}

      {/* Ejecución real */}
      <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 10, padding: 16 }}>
        <div style={{ color: "#555", fontSize: 11, marginBottom: 14, letterSpacing: 1 }}>EJECUCIÓN REAL</div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <StatCard label="Spread mercado" value={`${(spreadPct * 100).toFixed(3)}%`} ok={spreadPct < 0.001} />
          <StatCard label="Slippage est."  value={`${(slippage * 100).toFixed(3)}%`}  ok={slippage < 0.001} />
          <StatCard label="Impact"          value={`${(impact * 100).toFixed(2)}%`}   ok={impact < 0.05} sub={`pos $${config.positionSize}`} />
          <StatCard label="Max size"         value={`$${maxSize?.toFixed(0)}`}          highlight />
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Liquidez ±0.5%" value={`$${(liquidity/1000).toFixed(0)}K`} ok={liquidity > 10000} />
        <StatCard label="Beneficio/8h"   value={`${netBenefit > 0 ? "+" : ""}${(netBenefit*100).toFixed(4)}%`} ok={netBenefit > 0} sub="tras costes" />
        <StatCard label="Price parity"   value={`${priceDiff?.toFixed(3)}%`} ok={priceDiff < config.maxPriceDiff} />
        <StatCard label="OI ref"          value={`$${(extOI/1000).toFixed(0)}K`} ok={extOI > 500000} />
      </div>

      {/* Score breakdown */}
      <ScoreBreakdown data={data} config={config} />

      {/* Trade box */}
      {score >= 65 && passes && (
        <div style={{ background: cls.color + "0d", border: `1px solid ${cls.color}33`, borderRadius: 10, padding: 16 }}>
          <div style={{ color: cls.color, fontWeight: 700, marginBottom: 8 }}>{cls.emoji} TRADE {cls.label}</div>
          <div style={{ color: "#aaa", fontSize: 13 }}>
            SHORT KAITO en <b style={{ color: "#fff" }}>{shortDex}</b> ·
            LONG KAITO en <b style={{ color: "#fff" }}>{longDex}</b>
          </div>
          <div style={{ color: "#444", fontSize: 11, marginTop: 6 }}>
            Max recomendado: <b style={{ color: cls.color }}>${maxSize?.toFixed(0)}</b> · Usar LIMIT orders
          </div>
        </div>
      )}
    </div>
  );
}

function ScoreBreakdown({ data, config }) {
  const { spreadApr, spreadPct, slippage, impact, vol, oi } = data;
  const items = [
    { label: "Funding diff",   weight: "25%", ok: spreadApr > 10,     detail: `${spreadApr?.toFixed(1)}% APR` },
    { label: "Spread mercado", weight: "20%", ok: spreadPct < 0.001,   detail: `${(spreadPct*100).toFixed(3)}%` },
    { label: "Slippage",       weight: "20%", ok: slippage < 0.001,    detail: `${(slippage*100).toFixed(3)}%` },
    { label: "Impact",         weight: "20%", ok: impact < 0.05,       detail: `${(impact*100).toFixed(2)}%` },
    { label: "Volumen mín",    weight: "10%", ok: vol >= 100000,        detail: `$${(vol/1000).toFixed(0)}K` },
    { label: "Open Interest",  weight: "5%",  ok: oi > 500000,          detail: `$${(oi/1000).toFixed(0)}K` },
  ];
  return (
    <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 10, padding: 16 }}>
      <div style={{ color: "#555", fontSize: 11, marginBottom: 14, letterSpacing: 1 }}>SCORE BREAKDOWN</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map(({ label, weight, ok, detail }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: ok ? "#00ff88" : "#ff4444", fontSize: 13, width: 16 }}>{ok ? "✓" : "✗"}</span>
            <span style={{ color: "#666", fontSize: 12, flex: 1 }}>{label}</span>
            <span style={{ color: ok ? "#aaa" : "#444", fontSize: 12 }}>{detail}</span>
            <span style={{ color: "#333", fontSize: 11, width: 32, textAlign: "right" }}>{weight}</span>
            <div style={{ width: 50, height: 3, background: "#1a1a1a", borderRadius: 2 }}>
              <div style={{ width: ok ? "100%" : "0%", height: "100%", background: ok ? "#00ff88" : "#222", borderRadius: 2, transition: "width 0.5s" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── DEX COMPARE TAB ──────────────────────────────────────────

function DexCompareTab({ data, loading }) {
  if (loading) return <div style={{ color: "#333", padding: 60, textAlign: "center" }}>Cargando...</div>;
  if (!data?.allDex?.length) return <div style={{ color: "#333", padding: 40 }}>Sin datos de DEX.</div>;

  const sorted = [...data.allDex].sort((a, b) => b.fundingApr - a.fundingApr);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ color: "#555", fontSize: 11, letterSpacing: 1 }}>COMPARATIVA FUNDING — KAITO</div>

      {/* Tabla DEX */}
      <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", padding: "10px 16px", borderBottom: "1px solid #1a1a1a" }}>
          {["DEX", "Funding APR", "Price", "Vol 24h", "Acción"].map(h => (
            <div key={h} style={{ color: "#444", fontSize: 11, letterSpacing: 1 }}>{h}</div>
          ))}
        </div>
        {sorted.map((dex, i) => {
          const isShort = dex.name === data.shortDex;
          const isLong  = dex.name === data.longDex;
          const rowColor = isShort ? "#ff444408" : isLong ? "#00ff8808" : "transparent";
          return (
            <div key={dex.name} style={{
              display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
              padding: "14px 16px", borderBottom: "1px solid #0f0f0f",
              background: rowColor
            }}>
              <div style={{ color: "#fff", fontWeight: 700, fontSize: 13 }}>{dex.name}</div>
              <div style={{ color: dex.fundingApr > 0 ? "#ff6666" : "#66ff66", fontSize: 13, fontWeight: 700 }}>
                {dex.fundingApr?.toFixed(2)}%
              </div>
              <div style={{ color: "#aaa", fontSize: 12 }}>${dex.price?.toFixed(4)}</div>
              <div style={{ color: "#aaa", fontSize: 12 }}>${(dex.vol24h/1000).toFixed(0)}K</div>
              <div style={{ fontSize: 12 }}>
                {isShort && <span style={{ color: "#ff4444", fontWeight: 700 }}>SHORT</span>}
                {isLong  && <span style={{ color: "#00ff88", fontWeight: 700 }}>LONG</span>}
                {!isShort && !isLong && <span style={{ color: "#333" }}>—</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Spread visual */}
      <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 10, padding: 20 }}>
        <div style={{ color: "#555", fontSize: 11, marginBottom: 16, letterSpacing: 1 }}>SPREAD ENTRE DEX</div>
        {sorted.map((dexA, i) =>
          sorted.slice(i + 1).map(dexB => {
            const spread = Math.abs(dexA.fundingApr - dexB.fundingApr);
            const isOptimal = (dexA.name === data.shortDex && dexB.name === data.longDex) ||
                              (dexB.name === data.shortDex && dexA.name === data.longDex);
            return (
              <div key={`${dexA.name}-${dexB.name}`} style={{
                display: "flex", alignItems: "center", gap: 12, marginBottom: 10,
                padding: 10, borderRadius: 8,
                background: isOptimal ? "#ffcc0010" : "transparent",
                border: isOptimal ? "1px solid #ffcc0033" : "1px solid transparent"
              }}>
                <span style={{ color: "#aaa", fontSize: 12, flex: 1 }}>{dexA.name} × {dexB.name}</span>
                <span style={{ color: isOptimal ? "#ffcc00" : "#666", fontSize: 14, fontWeight: 700 }}>
                  {spread.toFixed(1)}% APR
                </span>
                {isOptimal && <span style={{ color: "#ffcc00", fontSize: 11 }}>← ÓPTIMO</span>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── HISTÓRICO TAB ────────────────────────────────────────────

function HistoricoTab({ history, data, exportCsv }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={exportCsv} style={{
          background: "#111", border: "1px solid #222", color: "#aaa",
          borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontFamily: "inherit", fontSize: 12
        }}>↓ Export CSV</button>
      </div>
      <Chart history={history} />
      <Simulator data={data} />
    </div>
  );
}

function Simulator({ data }) {
  const [capital, setCapital] = useState(100);
  const [days, setDays] = useState(30);
  if (!data) return null;
  const apr    = data.spreadApr || 0;
  const profit = (capital * 3 * apr / 100) * (days / 365) - 0.20 * Math.ceil(days / 7);
  return (
    <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 10, padding: 20 }}>
      <div style={{ color: "#555", fontSize: 11, marginBottom: 16, letterSpacing: 1 }}>SIMULADOR</div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <label style={{ color: "#777", fontSize: 13 }}>Capital ($):
          <input type="number" value={capital} onChange={e => setCapital(+e.target.value)}
            style={{ background: "#0a0a0a", border: "1px solid #222", color: "#fff", borderRadius: 6, padding: "4px 8px", width: 80, marginLeft: 8, fontFamily: "inherit" }} />
        </label>
        <label style={{ color: "#777", fontSize: 13 }}>Días:
          <input type="number" value={days} onChange={e => setDays(+e.target.value)}
            style={{ background: "#0a0a0a", border: "1px solid #222", color: "#fff", borderRadius: 6, padding: "4px 8px", width: 60, marginLeft: 8, fontFamily: "inherit" }} />
        </label>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="APR actual"     value={`${apr.toFixed(1)}%`} />
        <StatCard label="Notional (×3)"  value={`$${(capital * 3).toFixed(0)}`} />
        <StatCard label={`Ganancia ~${days}d`} value={`$${profit.toFixed(2)}`} ok={profit > 0} />
        <StatCard label="ROI"            value={`${((profit/capital)*100).toFixed(1)}%`} ok={profit > 0} />
      </div>
    </div>
  );
}

// ─── ALERTAS TAB ──────────────────────────────────────────────

function AlertasTab({ alerts }) {
  return (
    <div>
      <div style={{ color: "#555", fontSize: 11, marginBottom: 16, letterSpacing: 1 }}>LOG DE ALERTAS ({alerts.length})</div>
      {alerts.length === 0 && <div style={{ color: "#222", fontSize: 13 }}>Sin alertas. Score debe ser ≥ 75.</div>}
      {[...alerts].reverse().map((a, i) => (
        <div key={i} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <div style={{ color: "#333", fontSize: 11 }}>{new Date(a.ts).toLocaleString()}</div>
          <div style={{ color: "#888", fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap" }}>{a.msg}</div>
        </div>
      ))}
    </div>
  );
}

// ─── CONFIG TAB ───────────────────────────────────────────────

function ConfigTab({ config, setConfig }) {
  const fields = [
    { label: "Telegram Token",        key: "tg_token",       stateKey: "telegramToken",  type: "text" },
    { label: "Telegram Chat ID",      key: "tg_chat",        stateKey: "telegramChatId", type: "text" },
    { label: "Position size ($)",     key: "position_size",  stateKey: "positionSize",   type: "number" },
    { label: "Refresh (ms)",          key: "refresh_ms",     stateKey: "refreshMs",      type: "number" },
    { label: "Vol mínimo Long ($)",   key: "min_hl_vol",     stateKey: "minHlVol",       type: "number" },
    { label: "Vol mínimo Short ($)",  key: "min_ext_vol",    stateKey: "minExtVol",      type: "number" },
    { label: "Price parity máx (%)", key: "max_price_diff", stateKey: "maxPriceDiff",   type: "number" },
  ];
  const toKey = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const save  = (key, val) => {
    localStorage.setItem(key, val);
    setConfig(c => ({ ...c, [toKey(key)]: isNaN(+val) ? val : +val }));
  };
  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ color: "#555", fontSize: 11, marginBottom: 20, letterSpacing: 1 }}>CONFIGURACIÓN</div>
      {fields.map(({ label, key, stateKey, type }) => (
        <div key={key} style={{ marginBottom: 14 }}>
          <div style={{ color: "#555", fontSize: 12, marginBottom: 4 }}>{label}</div>
          <input type={type} defaultValue={config[stateKey]} onBlur={e => save(key, e.target.value)}
            style={{ background: "#111", border: "1px solid #1e1e1e", color: "#fff", borderRadius: 6, padding: "8px 12px", width: "100%", fontFamily: "inherit", fontSize: 13 }} />
        </div>
      ))}
    </div>
  );
}

// ─── TELEGRAM ─────────────────────────────────────────────────

async function sendTelegram(data, config, setAlerts) {
  const token  = config.telegramToken;
  const chatId = config.telegramChatId;
  if (!token || !chatId) return;
  const level = data.score >= 85 ? "🔥 STRONG ENTRY" : data.score >= 75 ? "🟢 ENTER" : "🟡 WATCH";
  const msg = `${level}

Par: KAITO
SHORT: ${data.shortDex} (${data.shortFunding?.toFixed(2)}% APR)
LONG:  ${data.longDex} (${data.longFunding?.toFixed(2)}% APR)
Spread: ${data.spreadApr?.toFixed(1)}% APR
Score: ${data.score}/100
Impact: ${(data.impact*100).toFixed(2)}%
Max size: $${data.maxSize?.toFixed(0)}
Net/8h: ${data.netBenefit > 0 ? "+" : ""}${(data.netBenefit*100).toFixed(4)}%
Ejecución: LIMIT orders`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg })
    });
    const entry = { ts: Date.now(), msg };
    setAlerts(prev => {
      const next = [...prev, entry];
      localStorage.setItem("alerts_log", JSON.stringify(next.slice(-100)));
      return next;
    });
  } catch (e) { console.error("Telegram:", e); }
}
