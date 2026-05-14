import { useState, useCallback } from "react";

const STORAGE_KEY = "ranking_history_v1";
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
      ts:        data.timestamp || Date.now(),
      symbol:    data.symbol,
      spreadApr: data.spreadApr,
      shortDex:  data.shortDex,
      longDex:   data.longDex,
      score:     data.score,
      vol:       data.vol,
      count:     data.count,
    };
    setHistory(prev => {
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
      "date,symbol,spread_apr,short_dex,long_dex,score,vol,count",
      ...history.map(h => [
        new Date(h.ts).toISOString(),
        h.symbol         || "",
        h.spreadApr?.toFixed(4) || "",
        h.shortDex       || "",
        h.longDex        || "",
        h.score          ?? "",
        h.vol?.toFixed(0) || "",
        h.count          ?? "",
      ].join(","))
    ].join("\n");
    const blob = new Blob([rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ranking_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [history]);

  const stats = history.length > 0 ? {
    avgSpreadApr: history.reduce((s, h) => s + (h.spreadApr || 0), 0) / history.length,
    maxSpreadApr: Math.max(...history.map(h => h.spreadApr || 0)),
    minSpreadApr: Math.min(...history.map(h => h.spreadApr || 0)),
    positiveDays: history.filter(h => h.spreadApr > 0).length / history.length * 100,
    count: history.length,
  } : null;

  return { history, addEntry, clearHistory, exportCsv, stats };
}
