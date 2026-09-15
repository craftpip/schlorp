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
  const [showLogin, setShowLogin] = useState(false);
  const [hasFlagged, setHasFlagged] = useState(false);
  const [footerClicks, setFooterClicks] = useState(0);

  // --- Memo decoy: simple workable todo (localStorage only, looks real) ---
  const [todos, setTodos] = useState(() => {
    try {
      const raw = localStorage.getItem("haven_todos_v1");
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p) && p.length) return p; }
    } catch {}
    return [
      { id: "t1", text: "Buy groceries — milk, eggs, sourdough", done: false, group: "Personal" },
      { id: "t2", text: "Review Atlas kickoff notes with Priya", done: false, group: "Work" },
      { id: "t3", text: "Japan trip: book ryokan for Apr 14", done: false, group: "Personal" },
      { id: "t4", text: "Weekly review — fill habit tracker", done: true, group: "Personal" },
      { id: "t5", text: "Read Deep Work Ch. 3 — take notes", done: false, group: "Reading" },
      { id: "t6", text: "Draft side-project RFC", done: true, group: "Ideas" },
    ];
  });
  const [todoGroups, setTodoGroups] = useState(() => {
    try {
      const raw = localStorage.getItem("haven_todo_groups_v1");
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p) && p.length) return p; }
    } catch {}
    return ["Inbox", "Work", "Personal", "Reading", "Ideas"];
  });
  const [newTodoText, setNewTodoText] = useState("");
  const [newTodoGroup, setNewTodoGroup] = useState("Inbox");
  const [todoFilter, setTodoFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("All");
  const [newGroupName, setNewGroupName] = useState("");
  useEffect(() => { try { localStorage.setItem("haven_todos_v1", JSON.stringify(todos)); } catch {} }, [todos]);
  useEffect(() => { try { localStorage.setItem("haven_todo_groups_v1", JSON.stringify(todoGroups)); } catch {} }, [todoGroups]);
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
    document.title = "Memo";
  }, [auth.protected, auth.authed]);
  const doLogin = async (e) => {
    e.preventDefault(); setPwErr("");
    const r = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { localStorage.setItem("xdl_admin_pw", pw); localStorage.setItem("xdl_panel_pw", pw); localStorage.setItem("xdl_last_activity", String(Date.now())); setShowLogin(false); setPwErr(""); setAuth({ checking: false, protected: true, authed: true }); setPw(""); }
    else setPwErr(j.error || "Invalid password");
  };
  const doLogout = () => { fetch("/api/auth/logout", { method: "POST" }); localStorage.removeItem("xdl_admin_pw"); localStorage.removeItem("xdl_panel_pw"); localStorage.removeItem("xdl_last_activity"); setShowLogin(false); setPw(""); setPwErr(""); setAuth({ checking: false, protected: true, authed: false }); };

  useEffect(() => {
    if (!auth.protected || !auth.authed) return;
    const touch = () => { try { localStorage.setItem("xdl_last_activity", String(Date.now())); } catch {} };
    const events = ["keydown", "click", "mousedown", "touchstart", "scroll"];
    events.forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
    const check = () => {
      try {
        const last = Number(localStorage.getItem("xdl_last_activity") || 0);
        if (last && Date.now() - last > 600000) doLogout();
      } catch {}
    };
    const t = setInterval(check, 30000);
    check();
    return () => { events.forEach((ev) => document.removeEventListener(ev, touch)); clearInterval(t); };
  }, [auth.protected, auth.authed]);

  // Hidden login hotkey when logged out: Ctrl+Shift+L -> open login modal, Esc -> close
  useEffect(() => {
    if (!auth.protected || auth.authed) return;
    const onKey = (e) => {
      if (e.key === "Escape" && showLogin) { setShowLogin(false); setPwErr(""); }
      if (e.ctrlKey && e.shiftKey && String(e.key).toLowerCase() === "l") { e.preventDefault(); setShowLogin(true); setPwErr(""); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [auth.protected, auth.authed, showLogin]);

  useEffect(() => {
    if (!auth.protected || !auth.authed) return;
    const down = new Set();
    const isEsc = (e) => e.code === "Escape" || e.key === "Escape";
    const isTilde = (e) => e.code === "Backquote" || e.key === "~" || e.key === "`";
    const onKeyDown = (e) => {
      if (isEsc(e)) down.add("Escape");
      if (isTilde(e)) down.add("Backquote");
      if (down.has("Escape") && down.has("Backquote")) { e.preventDefault(); down.clear(); doLogout(); }
    };
    const onKeyUp = (e) => {
      if (isEsc(e)) down.delete("Escape");
      if (isTilde(e)) down.delete("Backquote");
    };
    const onBlur = () => down.clear();
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => { document.removeEventListener("keydown", onKeyDown); document.removeEventListener("keyup", onKeyUp); window.removeEventListener("blur", onBlur); };
  }, [auth.protected, auth.authed]);

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
        // Only configured lists count: stale state for removed lists must not flag the tab.
        const configuredUrls = new Set(
          (j.config?.savedLists || []).map((l) => String(l?.url || "").trim()).filter(Boolean)
        );
        const flagged = Object.entries(lists).some(
          ([url, v]) => v && v.paused && configuredUrls.has(String(url).trim())
        );
        setHasFlagged(!!flagged);
      } catch { setHasFlagged(false); }
    };
    check();
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
  }, [auth.protected, auth.authed]);
  if (auth.checking) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)" }} />
    );
  }
  if (auth.protected && !auth.authed) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", justifyContent: "center", padding: "24px 16px" }}>
        <div style={{ width: "100%", maxWidth: 860, padding: "0 var(--pane-pad, 18px)", boxSizing: "border-box" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24, paddingTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "default", userSelect: "none" }} title="Memo">
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-.02em", color: "var(--text)" }}>Memo</div>
                <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: 600, marginTop: 1 }}>Private workspace</div>
              </div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>
              <span style={{ cursor: "pointer" }}>Notes</span>
              <span style={{ cursor: "pointer" }}>Archive</span>
              <span style={{ cursor: "pointer" }}>About</span>
            </div>
          </div>

          <div className="card" style={{ padding: 18, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "grid", placeItems: "center", color: "#fff", fontSize: 13 }}><i className="bi bi-check2-square" /></span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", lineHeight: 1 }}>Todo</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{todos.filter((t) => !t.done).length} to do · {todos.filter((t) => t.done).length} done</div>
              </div>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)", background: "var(--surface-2)", border: "1px solid var(--border)", padding: "4px 8px", borderRadius: 99 }}>{todos.length} total</span>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const txt = String(newTodoText || "").trim();
                if (!txt) return;
                const g = String(newTodoGroup || "Inbox").trim() || "Inbox";
                if (!todoGroups.includes(g)) { setTodoGroups((prev) => [...prev, g]); }
                setTodos((prev) => [{ id: `t${Date.now()}${Math.random().toString(36).slice(2, 4)}`, text: txt, done: false, group: g }, ...prev]);
                setNewTodoText("");
              }}
              style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}
            >
              <input
                className="form-control"
                value={newTodoText}
                onChange={(e) => setNewTodoText(e.target.value)}
                placeholder="Add a task…"
                style={{ flex: "1 1 200px", minWidth: 160, padding: "9px 12px", fontSize: 13.5 }}
              />
              <select value={newTodoGroup} onChange={(e) => setNewTodoGroup(e.target.value)} className="form-control" style={{ flex: "0 0 140px", padding: "9px 10px", fontSize: 13 }}>
                {todoGroups.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
              <button type="submit" className="btn btn-primary" style={{ padding: "9px 16px", whiteSpace: "nowrap" }}><i className="bi bi-plus-lg" /> Add</button>
            </form>

            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[
                  { k: "all", l: "All" },
                  { k: "active", l: "To do" },
                  { k: "done", l: "Done" },
                ].map((f) => (
                  <button
                    key={f.k}
                    type="button"
                    onClick={() => setTodoFilter(f.k)}
                    className={`btn btn-sm ${todoFilter === f.k ? "btn-primary" : "btn-outline-secondary"}`}
                    style={{ fontSize: 12, padding: "5px 10px", borderRadius: 99 }}
                  >
                    {f.l}
                    <span style={{ marginLeft: 6, fontSize: 10, opacity: .85, background: todoFilter === f.k ? "rgba(255,255,255,.22)" : "var(--surface-2)", padding: "1px 6px", borderRadius: 99 }}>
                      {f.k === "all" ? todos.length : f.k === "active" ? todos.filter((t) => !t.done).length : todos.filter((t) => t.done).length}
                    </span>
                  </button>
                ))}
              </div>
              <span style={{ flex: 1 }} />
              {todos.some((t) => t.done) && (
                <button type="button" className="btn btn-sm btn-outline-secondary" style={{ fontSize: 12, padding: "5px 10px" }} onClick={() => setTodos((prev) => prev.filter((t) => !t.done))}><i className="bi bi-trash" /> Clear done</button>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {["All", ...todoGroups].map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGroupFilter(g)}
                  style={{ padding: "5px 11px", borderRadius: 99, fontSize: 12, fontWeight: groupFilter === g ? 600 : 500, whiteSpace: "nowrap", background: groupFilter === g ? "linear-gradient(135deg,var(--accent),var(--accent-2))" : "var(--surface)", color: groupFilter === g ? "#fff" : "var(--muted)", border: `1px solid ${groupFilter === g ? "transparent" : "var(--border)"}`, cursor: "pointer", boxShadow: groupFilter === g ? "0 2px 8px rgba(99,102,241,.35)" : "none" }}
                >
                  {g}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto" }}>
              <input
                className="form-control"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="New group"
                style={{ width: 120, padding: "6px 10px", fontSize: 12 }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const n = String(newGroupName || "").trim();
                    if (!n || todoGroups.includes(n)) return;
                    setTodoGroups((prev) => [...prev, n]);
                    setNewTodoGroup(n);
                    setGroupFilter(n);
                    setNewGroupName("");
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                style={{ fontSize: 12, padding: "6px 10px" }}
                onClick={() => {
                  const n = String(newGroupName || "").trim();
                  if (!n || todoGroups.includes(n)) return;
                  setTodoGroups((prev) => [...prev, n]);
                  setNewTodoGroup(n);
                  setGroupFilter(n);
                  setNewGroupName("");
                }}
              >
                <i className="bi bi-folder-plus" /> Add group
              </button>
            </div>
          </div>

          {(() => {
            const filtered = todos.filter((t) => {
              if (groupFilter !== "All" && t.group !== groupFilter) return false;
              if (todoFilter === "active" && t.done) return false;
              if (todoFilter === "done" && !t.done) return false;
              return true;
            });
            if (!filtered.length) {
              return (
                <div className="card" style={{ padding: 28, textAlign: "center", color: "var(--muted)", marginBottom: 16 }}>
                  <div style={{ fontSize: 20, marginBottom: 6 }}><i className="bi bi-inbox" /></div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{todoFilter === "done" ? "No completed tasks" : todoFilter === "active" ? "All caught up" : groupFilter !== "All" ? `No tasks in ${groupFilter}` : "No tasks yet"}</div>
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>{todoFilter === "all" ? "Add a task above to get started." : "Try switching filters."}</div>
                </div>
              );
            }
            const groupsToShow = groupFilter === "All" ? [...new Set(filtered.map((t) => t.group))] : [groupFilter];
            return (
              <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
                {groupsToShow.map((gname) => {
                  const items = filtered.filter((t) => t.group === gname);
                  if (!items.length) return null;
                  return (
                    <div key={gname} className="card" style={{ overflow: "hidden" }}>
                      <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                        <span style={{ width: 7, height: 7, borderRadius: 99, background: gname === "Work" ? "#6366f1" : gname === "Personal" ? "#0ea5e9" : gname === "Reading" ? "#f59e0b" : gname === "Ideas" ? "#8b5cf6" : "#94a3b8", display: "inline-block" }} />
                        <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--text)" }}>{gname}</span>
                        <span style={{ fontSize: 11, color: "var(--muted)", background: "var(--surface)", border: "1px solid var(--border)", padding: "2px 7px", borderRadius: 99 }}>{items.filter((t) => !t.done).length} to do · {items.filter((t) => t.done).length} done</span>
                        {todoGroups.length > 1 && groupFilter === "All" && (
                          <button type="button" className="btn btn-sm btn-outline-secondary" style={{ marginLeft: "auto", fontSize: 11, padding: "3px 8px" }} onClick={() => { if (confirm(`Remove group "${gname}"? Tasks will move to Inbox.`)) { setTodos((prev) => prev.map((t) => (t.group === gname ? { ...t, group: "Inbox" } : t))); setTodoGroups((prev) => prev.filter((x) => x !== gname)); if (newTodoGroup === gname) setNewTodoGroup("Inbox"); if (groupFilter === gname) setGroupFilter("All"); } }} title="Remove group"><i className="bi bi-trash" /></button>
                        )}
                      </div>
                      <div style={{ display: "grid" }}>
                        {items.map((t) => (
                          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--border)", background: t.done ? "var(--surface-2)" : "var(--surface)", opacity: t.done ? .82 : 1 }}>
                            <button
                              type="button"
                              aria-label={t.done ? "Mark as to do" : "Mark as done"}
                              onClick={() => setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))}
                              style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${t.done ? "#10b981" : "var(--border-strong)"}`, background: t.done ? "#10b981" : "var(--surface)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}
                            >
                              {t.done && <i className="bi bi-check-lg" style={{ display: "block", lineHeight: 1, fontSize: 12, transform: "translateY(0.5px)" }} />}
                            </button>
                            <span style={{ flex: 1, fontSize: 13.5, color: t.done ? "var(--muted)" : "var(--text)", textDecoration: t.done ? "line-through" : "none", wordBreak: "break-word", lineHeight: 1.4 }}>{t.text}</span>
                            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--faint)", background: "var(--surface-2)", border: "1px solid var(--border)", padding: "2px 6px", borderRadius: 99, whiteSpace: "nowrap" }}>{t.group}</span>
                            <button type="button" className="btn btn-sm btn-outline-secondary" style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => setTodos((prev) => prev.filter((x) => x.id !== t.id))} title="Remove"><i className="bi bi-x-lg" /></button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          <div className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 10, background: "var(--surface-2)", marginBottom: 16 }}>
            <span style={{ width: 28, height: 28, borderRadius: 8, background: "#10b98118", color: "#10b981", display: "grid", placeItems: "center", fontSize: 13 }}><i className="bi bi-shield-check" /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, color: "var(--text)" }}>All changes saved locally</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{todos.length} tasks · {todos.filter((t) => !t.done).length} to do · stored on this device</div>
            </div>
            <div style={{ height: 6, width: 90, background: "var(--border)", borderRadius: 99, overflow: "hidden", flexShrink: 0 }}><div style={{ width: `${todos.length ? Math.round((todos.filter((t) => t.done).length / todos.length) * 100) : 0}%`, height: "100%", background: "linear-gradient(90deg,#6366f1,#8b5cf6)" }} /></div>
          </div>

          <div style={{ textAlign: "center", marginTop: 18, fontSize: 11, color: "var(--faint)", letterSpacing: ".02em", cursor: "pointer", userSelect: "none" }} onClick={() => {
            const n = footerClicks + 1;
            if (n >= 5) { setShowLogin(true); setFooterClicks(0); }
            else setFooterClicks(n);
          }}>
            <span style={{ cursor: "default" }}>© 2026 Memo — Private workspace</span>
            <span style={{ margin: "0 8px", opacity: .4 }}>·</span>
            <span style={{ cursor: "default" }}>Privacy</span>
          </div>

          {showLogin && (
            <div onClick={() => { setShowLogin(false); setPwErr(""); }} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
              <div onClick={(e) => e.stopPropagation()} className="card" style={{ padding: 20, width: "100%", maxWidth: 320, boxShadow: "0 12px 32px rgba(0,0,0,.18)" }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: "var(--text)" }}>Enter password</div>
                <form onSubmit={doLogin} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="password" className="form-control" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" autoFocus style={{ flex: 1, padding: "9px 10px", fontSize: 13 }} />
                  <button type="submit" className="btn btn-primary btn-sm" style={{ padding: "9px 14px" }}>Continue</button>
                </form>
                {pwErr && <div style={{ color: "var(--danger)", fontSize: 11.5, marginTop: 8 }}>{pwErr}</div>}
                <div style={{ marginTop: 10, textAlign: "right" }}>
                  <button type="button" className="btn btn-sm btn-outline-secondary" style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => { setShowLogin(false); setPwErr(""); }}>Close</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="app-shell" style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", justifyContent: "center", padding: "24px 16px" }}>
      <div className="app-pane" style={{ width: "100%", maxWidth: 860, padding: "0 var(--pane-pad, 18px)", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src="/logo.png" alt="schlorp logo" style={{ height: 36, width: "auto", display: "block", borderRadius: 10, transform: "translateY(-3px)" }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-.02em", color: "var(--text)", lineHeight: 1 }}>schlorp</div>
              <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: ".2em", textTransform: "uppercase", fontWeight: 600, marginTop: 2 }}>Private workspace</div>
            </div>
          </div>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)" }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: health.busy ? "#f59e0b" : health.browserReady ? "#10b981" : "#64748b", display: "inline-block" }} />
            {health.busy ? "Working" : health.browserReady ? "Ready" : "Idle"}
          </span>
          {auth.protected && auth.authed && <button className="btn btn-sm btn-outline-secondary" style={{ marginLeft: 8 }} onClick={doLogout}><i className="bi bi-box-arrow-right" /> Logout</button>}
        </div>
        <nav className="app-nav" style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          <NavLink to="/dashboard" title="Dashboard" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-download" /> <span className="app-nav-label">Dashboard</span></NavLink>
          <NavLink to="/media" title="Media" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-collection-play" /> <span className="app-nav-label">Media</span></NavLink>
          <NavLink to="/collections" title="Collections" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-bookmark-star" /> <span className="app-nav-label">Collections</span>{hasFlagged && <i className="bi bi-exclamation-triangle-fill" style={{ color: "#f59e0b", marginLeft: 2, fontSize: 11 }} title="Login expired — some collections paused" />}</NavLink>
          <NavLink to="/profiles" title="Profiles" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-people" /> <span className="app-nav-label">Profiles</span></NavLink>
          <NavLink to="/settings" title="Settings" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : "btn-outline-secondary"}`}><i className="bi bi-gear" /> <span className="app-nav-label">Settings</span></NavLink>
        </nav>
        <Outlet />
      </div>
    </div>
  );
}
