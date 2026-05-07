import { useMemo } from "react";

const W = 700;
const H = 260;
const PAD = { top: 20, right: 20, bottom: 40, left: 60 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export default function Chart({ history }) {
  const data = useMemo(() => {
    if (!history || history.length === 0) return null;
    // Sample last 48 entries for readability
    const sample = history.length > 48
      ? history.filter((_, i) => i % Math.floor(history.length / 48) === 0).slice(-48)
      : history;

    const values = sample.map(h => h.spreadApr || 0);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const range = Math.max(max - min, 10);
    const yMax = max + range * 0.1;
    const yMin = min - range * 0.1;

    const toX = (i) => PAD.left + (i / (sample.length - 1)) * INNER_W;
    const toY = (v) => PAD.top + INNER_H - ((v - yMin) / (yMax - yMin)) * INNER_H;

    const barW = Math.max(2, INNER_W / sample.length - 1);

    return { sample, values, avg, max, min, yMax, yMin, toX, toY, barW };
  }, [history]);

  if (!data) {
    return (
      <div style={{ background: "#111", border: "1px solid #1a1a1a", borderRadius: 10, padding: 20, textAlign: "center", color: "#333", fontSize: 13 }}>
        Sin histórico aún. Los datos se acumulan automáticamente.
      </div>
    );
  }

  const { sample, values, avg, yMax, yMin, toX, toY, barW } = data;
  const avgY = toY(avg);
  const zeroY = toY(0);

  // Y axis labels
  const yTicks = 5;
  const yTickValues = Array.from({ length: yTicks }, (_, i) => yMin + ((yMax - yMin) * i) / (yTicks - 1));

  // X axis labels (show ~6)
  const xLabelIndices = [0, Math.floor(sample.length / 4), Math.floor(sample.length / 2), Math.floor(sample.length * 3 / 4), sample.length - 1];

  return (
    <div style={{ background: "#111", border: "1px solid #1a1a1a", borderRadius: 10, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ color: "#555", fontSize: 11 }}>HISTÓRICO SPREAD APR — KAITO</div>
          <div style={{ color: "#aaa", fontSize: 12, marginTop: 4 }}>{sample.length} registros · último: {new Date(sample[sample.length - 1]?.ts).toLocaleString()}</div>
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 20, height: 2, background: "#3b82f6", borderTop: "2px dashed #3b82f6" }} />
            <span style={{ color: "#3b82f6", fontSize: 11 }}>Media {avg.toFixed(1)}%</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 12, height: 12, background: "#00ff88", borderRadius: 2 }} />
            <span style={{ color: "#aaa", fontSize: 11 }}>Spread APR</span>
          </div>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <svg width={W} height={H} style={{ display: "block" }}>
          {/* Grid lines */}
          {yTickValues.map((v, i) => {
            const y = toY(v);
            return (
              <g key={i}>
                <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="#1a1a1a" strokeWidth={1} />
                <text x={PAD.left - 8} y={y + 4} fill="#444" fontSize={10} textAnchor="end">{v.toFixed(0)}%</text>
              </g>
            );
          })}

          {/* Zero line */}
          {zeroY > PAD.top && zeroY < H - PAD.bottom && (
            <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY} stroke="#333" strokeWidth={1} />
          )}

          {/* Bars */}
          {sample.map((h, i) => {
            const v = h.spreadApr || 0;
            const x = PAD.left + (i / sample.length) * INNER_W;
            const barColor = v >= 70 ? "#00ff88" : v >= 40 ? "#ffcc00" : v > 0 ? "#00cc66" : "#ff4444";
            const barTop = toY(Math.max(v, 0));
            const barBottom = toY(Math.min(v, 0));
            const barHeight = Math.abs(barBottom - barTop);
            return (
              <rect
                key={i}
                x={x}
                y={barTop}
                width={barW}
                height={Math.max(barHeight, 1)}
                fill={barColor}
                opacity={0.8}
              />
            );
          })}

          {/* Average line (blue dashed) */}
          <line
            x1={PAD.left} y1={avgY}
            x2={W - PAD.right} y2={avgY}
            stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="6,4"
          />

          {/* X axis labels */}
          {xLabelIndices.map(i => {
            if (i >= sample.length) return null;
            const x = PAD.left + (i / sample.length) * INNER_W + barW / 2;
            return (
              <text key={i} x={x} y={H - PAD.bottom + 16} fill="#444" fontSize={9} textAnchor="middle">
                {formatDate(sample[i].ts)}
              </text>
            );
          })}

          {/* Axes */}
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} stroke="#222" strokeWidth={1} />
          <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} stroke="#222" strokeWidth={1} />
        </svg>
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 20, marginTop: 12, flexWrap: "wrap" }}>
        <div><span style={{ color: "#555", fontSize: 11 }}>Media: </span><span style={{ color: "#3b82f6", fontSize: 13, fontWeight: 700 }}>{avg.toFixed(1)}%</span></div>
        <div><span style={{ color: "#555", fontSize: 11 }}>Máx: </span><span style={{ color: "#00ff88", fontSize: 13 }}>{Math.max(...values).toFixed(1)}%</span></div>
        <div><span style={{ color: "#555", fontSize: 11 }}>Mín: </span><span style={{ color: "#ff4444", fontSize: 13 }}>{Math.min(...values).toFixed(1)}%</span></div>
        <div><span style={{ color: "#555", fontSize: 11 }}>Positivos: </span><span style={{ color: "#aaa", fontSize: 13 }}>{(values.filter(v => v > 0).length / values.length * 100).toFixed(0)}%</span></div>
      </div>
    </div>
  );
}
