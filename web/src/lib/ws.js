import { useEffect, useRef, useState } from "react";

export function useWebSocket(path = "/ws") {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState(null);
  const wsRef = useRef(null);
  const retryRef = useRef(1000);

  useEffect(() => {
    let closed = false;
    let timer = null;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}${path}`;
    function connect() {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        retryRef.current = 1000;
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        const d = Math.min(retryRef.current, 10000);
        retryRef.current = Math.min(retryRef.current * 1.5, 10000);
        timer = setTimeout(connect, d);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          setLastMessage(msg);
        } catch {}
      };
    }
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      try { wsRef.current?.close(); } catch {}
    };
  }, [path]);

  const send = (obj) => {
    try { wsRef.current?.send(JSON.stringify(obj)); } catch {}
  };
  return { connected, lastMessage, send };
}
