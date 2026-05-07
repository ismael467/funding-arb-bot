import { useState, useCallback } from "react";

const STORAGE_KEY = "funding_history_v2";
const MAX_ENTRIES = 2016; // ~7 days at 5min intervals

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch (e) {
    // localStorage full — trim and retry
    const trimmed = history.slice(-500);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  }
}

export default function useHistory() {
  const [history, setHistory] = useState(loadHistory);

  const addEntry = useCallback((data) => {
    if (!data) return;
    const entry = {
      ts: data.timestamp || Date.now(),
      hlFunding: data.hlFunding,
      extFunding: data.extFunding,
      spreadApr: data.spreadApr,
      hlVol: data.hlVol,
      extVol: data.extVol,
      priceDiff: data.priceDiff,
      score: data.score,
    };
    setHistory(prev => {
      // Deduplicate: don't add if same minute
      const lastTs = prev[prev.length - 1]?.ts || 0;
      if (entry.ts - lastTs < 60000) return prev;
      const next = [...prev, entry].slice(-MAX_ENTRIES);
      saveHistory(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setHistory([]);
  }, []);

  const exportCsv = useCallback(() => {
    const rows = [
      "date,hl_funding_apr,ext_funding_apr,spread_apr,hl_vol,ext_vol,price_diff,score",
      ...history.map(h => [
        new Date(h.ts).toISOString(),
        h.hlFunding?.toFixed(4),
        h.extFunding?.toFixed(4),
        h.spreadApr?.toFixed(4),
        h.hlVol?.toFixed(0),
        h.extVol?.toFixed(0),
        h.priceDiff?.toFixed(4),
        h.score
      ].join(","))
    ].join("\n");
    const blob = new Blob([rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kaito_funding_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [history]);

  // Stats
  const stats = history.length > 0 ? {
    avgSpreadApr: history.reduce((s, h) => s + (h.spreadApr || 0), 0) / history.length,
    maxSpreadApr: Math.max(...history.map(h => h.spreadApr || 0)),
    minSpreadApr: Math.min(...history.map(h => h.spreadApr || 0)),
    positiveDays: history.filter(h => h.spreadApr > 0).length / history.length * 100,
    count: history.length,
  } : null;

  return { history, addEntry, clearHistory, exportCsv, stats };
}
