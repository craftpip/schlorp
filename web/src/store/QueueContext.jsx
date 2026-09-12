import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useWebSocket } from "../lib/ws";

const QueueContext = createContext(null);

export function QueueProvider({ children }) {
  const [active, setActive] = useState([]);
  const [completed, setCompleted] = useState([]);
  const [logsById, setLogsById] = useState({});
  const [gap, setGapState] = useState({ minMs: 0, maxMs: 0 });
  const [gapWait, setGapWait] = useState(null);
  const [paused, setPaused] = useState(false);
  const { connected, lastMessage, send } = useWebSocket("/ws");

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === "queue:snapshot") {
      setActive(lastMessage.active || []);
      setCompleted(lastMessage.completed || []);
      if (lastMessage.gap) setGapState(lastMessage.gap);
      if (lastMessage.gapWait !== undefined) setGapWait(lastMessage.gapWait);
      if (lastMessage.paused !== undefined) setPaused(!!lastMessage.paused);
    } else if (lastMessage.type === "queue:paused") {
      setPaused(!!lastMessage.paused);
    } else if (lastMessage.type === "queue:gap") {
      setGapWait(lastMessage.waiting ? { remainingSec: lastMessage.remainingSec ?? 0, paused: !!lastMessage.paused } : null);
    } else if (lastMessage.type === "job:progress") {
      setActive((prev) => prev.map((it) => it.id === lastMessage.id ? { ...it, stage: lastMessage.stage ?? it.stage, pct: lastMessage.pct ?? it.pct, detail: lastMessage.detail ?? it.detail, filePath: lastMessage.filePath || it.filePath } : it));
    } else if (lastMessage.type === "job:log") {
      setLogsById((m) => {
        const arr = m[lastMessage.id] ? [...m[lastMessage.id], lastMessage.chunk] : [lastMessage.chunk];
        if (arr.length > 500) arr.splice(0, arr.length - 500);
        return { ...m, [lastMessage.id]: arr };
      });
    } else if (lastMessage.type === "health") {
      // handled elsewhere via event? store for consumers
    }
  }, [lastMessage]);

  // initial fetch + poll (active/gap) — gapWait via WS + poll fallback (1s) to avoid flicker
  useEffect(() => {
    let t;
    const load = () => fetch("/queue").then((r) => r.json()).then((j) => {
      if (j.ok) {
        setActive(j.active || []);
        setCompleted(j.completed || []);
        if (j.gap) setGapState(j.gap);
        if (j.gapWait?.waiting) setGapWait(j.gapWait);
        if (j.paused !== undefined) setPaused(!!j.paused);
      }
    }).catch(() => {});
    load();
    t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, []);

  const pause = useCallback(async () => {
    setPaused(true);
    const res = await fetch("/queue/pause", { method: "POST" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setPaused(false);
      throw new Error(j.error || "pause failed");
    }
    return res.json();
  }, []);

  const resume = useCallback(async () => {
    setPaused(false);
    const res = await fetch("/queue/resume", { method: "POST" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "resume failed");
    }
    return res.json();
  }, []);

  const setGap = useCallback(async (minMs, maxMs) => {
    const res = await fetch("/queue/gap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minSeconds: Math.round(minMs / 1000), maxSeconds: Math.round(maxMs / 1000) }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "gap update failed");
    }
    return res.json();
  }, []);

  const add = useCallback(async (urls, folder, maxQuality, account) => {
    const res = await fetch("/queue/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, folder, maxQuality, account: account || undefined }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "queue add failed");
    }
    return res.json();
  }, []);

  const remove = useCallback(async (id) => {
    setActive((prev) => prev.filter((it) => it.id !== id));
    setCompleted((prev) => prev.filter((it) => it.id !== id));
    await fetch("/queue/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  }, []);

  const retry = useCallback(async (id) => {
    await fetch("/queue/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  }, []);

  const retryAll = useCallback(async (ids) => {
    for (const id of ids || []) {
      await fetch("/queue/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    }
  }, []);

  const clearCompleted = useCallback(async () => {
    setCompleted([]);
    await fetch("/queue/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ which: "completed" }) });
  }, []);

  const clearActive = useCallback(async () => {
    setActive([]);
    await fetch("/queue/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ which: "active" }) });
  }, []);

  return (
    <QueueContext.Provider value={{ active, completed, logsById, connected, gap, gapWait, paused, pause, resume, setGap, add, remove, retry, retryAll, clearCompleted, clearActive, send }}>
      {children}
    </QueueContext.Provider>
  );
}

export function useQueue() {
  const v = useContext(QueueContext);
  if (!v) throw new Error("useQueue outside provider");
  return v;
}
