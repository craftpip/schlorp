import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";

if (typeof window !== "undefined" && !window._xdlFetchPatched) {
  window._xdlFetchPatched = true;
  const _origFetch = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    try {
      const t = localStorage.getItem("xdl_admin_pw") || localStorage.getItem("xdl_panel_pw") || "";
      if (t) {
        opts = { ...opts, headers: { ...(opts.headers || {}), "x-panel-password": t, "x-admin-password": t } };
      }
    } catch {}
    return _origFetch(url, opts);
  };
}

export default function App() {
  const [health, setHealth] = useState({ busy: false, browserReady: false });
  const [auth, setAuth] = useState({ checking: true, protected: false, authed: false });
  const [pw, setPw] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [hasFlagged, setHasFlagged] = useState(false);
  useEffect(() => {
    fetch("/api/auth/status").then((r) => r.json()).then((j) => {
      if (!j.protected) setAuth({ checking: false, protected: false, authed: true });
      else {
        const t2 = localStorage.getItem("xdl_panel_pw") || localStorage.getItem("xdl_admin_pw") || "";
        if (!t2) setAuth({ checking: false, protected: true, authed: false });
        else fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: t2 }) }).then((r) => {
          if (r.ok) setAuth({ checking: false, protected: true, authed: true });
          else setAuth({ checking: false, protected: true, authed: false });
        }).catch(() => setAuth({ checking: false, protected: true, authed: false }));
      }
    }).catch(() => setAuth({ checking: false, protected: false, authed: true }));
  }, []);
  useEffect(() => {
    if (auth.protected && !auth.authed) document.title = "Password is required";
    else document.title = "xdl — Video downloader";
  }, [auth.protected, auth.authed]);
  const doLogin = async (e) => {
    e.preventDefault(); setPwErr("");
    const r = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { localStorage.setItem("xdl_admin_pw", pw); localStorage.setItem("xdl_panel_pw", pw); setAuth({ checking: false, protected: true, authed: true }); setPw(""); }
    else setPwErr(j.error || "Invalid password");
  };
  const doLogout = () => { localStorage.removeItem("xdl_admin_pw"); localStorage.removeItem("xdl_panel_pw"); setAuth({ checking: false, protected: true, authed: false }); };

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
  useEffect(() => {
    if (auth.protected && !auth.authed) return;
    const check = async () => {
      try {
        const r = await fetch("/sync-config");
        const j = await r.json();
        const lists = j.lists || {};
        const flagged = Object.values(lists).some((v) => v && v.paused);
        setHasFlagged(!!flagged);
      } catch { setHasFlagged(false); }
    };
    check();
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
  }, [auth.protected, auth.authed]);
  if (auth.checking) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", justifyContent: "center", padding: "24px 16px" }}>
        <div style={{ width: "100%", maxWidth: 860 }}>
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Checking access…</div>
        </div>
      </div>
    );
  }
  if (auth.protected && !auth.authed) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", justifyContent: "center", alignItems: "center", padding: "40px 16px" }}>
        <div className="card" style={{ padding: 28, maxWidth: 380, width: "100%", margin: 0, height: "fit-content", boxShadow: "0 8px 32px rgba(0,0,0,.12)" }}>
          <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 16 }}><i className="bi bi-shield-lock" style={{ marginRight: 6 }} /> Password is required</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 16, lineHeight: 1.5 }}>This panel is protected. Enter the password to continue. Leave blank in Settings to disable.</div>
          <form onSubmit={doLogin} style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input type="password" className="form-control" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" autoFocus style={{ flex: 1, padding: "10px 12px" }} />
            <button type="submit" className="btn btn-primary" style={{ padding: "10px 18px", whiteSpace: "nowrap" }}>Unlock</button>
          </form>
          {pwErr && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 10, padding: "8px 10px", background: "rgba(239,68,68,.08)", borderRadius: 8 }}>{pwErr}</div>}
        </div>
      </div>
    );
  }
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
          {auth.protected && auth.authed && <button className="btn btn-sm btn-outline-secondary" style={{ marginLeft: 8 }} onClick={doLogout}><i className="bi bi-box-arrow-right" /> Logout</button>}
        </div>
        <nav style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          <NavLink to="/dashboard" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-download" /> Dashboard</NavLink>
          <NavLink to="/media" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-collection-play" /> Media</NavLink>
          <NavLink to="/collections" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-bookmark-star" /> Collections {hasFlagged && <i className="bi bi-exclamation-triangle-fill" style={{ color: "#f59e0b", marginLeft: 2, fontSize: 11 }} title="Login expired — some collections paused" />}</NavLink>
          <NavLink to="/profiles" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-people" /> Profiles</NavLink>
          <NavLink to="/settings" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-gear" /> Settings</NavLink>
        </nav>
        <Outlet />
      </div>
    </div>
  );
}
