import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";

export default function App() {
  const [health, setHealth] = useState({ busy: false, browserReady: false });
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "health") setHealth(m);
      } catch {}
    };
    return () => ws.close();
  }, []);
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", justifyContent: "center", padding: "24px 16px" }}>
      <div style={{ width: "100%", maxWidth: 860 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <span className="brand-mark" style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#ec4899 100%)", display: "grid", placeItems: "center", color: "#fff" }}><i className="bi bi-play-fill" /></span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: "var(--text)" }}>xdl</div>
            <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: ".06em", textTransform: "uppercase", fontWeight: 600 }}>Video downloader</div>
          </div>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)" }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: health.busy ? "#f59e0b" : health.browserReady ? "#10b981" : "#64748b", display: "inline-block" }} />
            {health.busy ? "Working" : health.browserReady ? "Ready" : "Idle"}
          </span>
        </div>
        <nav style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          <NavLink to="/dashboard" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-download" /> Dashboard</NavLink>
          <NavLink to="/media" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-collection-play" /> Media</NavLink>
          <NavLink to="/collections" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-bookmark-star" /> Collections</NavLink>
          <NavLink to="/profiles" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-people" /> Profiles</NavLink>
          <NavLink to="/settings" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-gear" /> Settings</NavLink>
        </nav>
        <Outlet />
      </div>
    </div>
  );
}
