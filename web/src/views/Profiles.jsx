import { useEffect, useState } from "react";

export default function Profiles() {
  const [accounts, setAccounts] = useState([]);
  const [name, setName] = useState("");
  const [profileDir, setProfileDir] = useState("");
  const [msg, setMsg] = useState("");
  const [info, setInfo] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [vnc, setVnc] = useState({ enabled: false, running: false });
  const [vncBusy, setVncBusy] = useState(false);

  const loadVnc = async () => {
    try { const r = await fetch("/vnc/status"); const j = await r.json(); if (j.ok) setVnc({ enabled: j.enabled, running: j.running }); } catch {}
  };

  const toggleVnc = async () => {
    setVncBusy(true);
    try {
      const r = await fetch(vnc.enabled ? "/vnc/disable" : "/vnc/enable", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "failed");
      setVnc({ enabled: j.enabled ?? !vnc.enabled, running: j.running ?? !vnc.enabled });
    } catch (e) { setInfo(e.message); setTimeout(() => setInfo(""), 3000); }
    finally { setVncBusy(false); loadVnc(); }
  };

  const load = async () => {
    try {
      const r = await fetch("/accounts");
      const j = await r.json();
      if (j.ok) setAccounts(j.accounts || []);
    } catch {}
  };
  useEffect(() => { load(); loadVnc(); const t = setInterval(load, 4000); const tv = setInterval(loadVnc, 5000); return () => { clearInterval(t); clearInterval(tv); }; }, []);

  const onCreate = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, profileDir: profileDir || "Default" }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "failed");
      setName(""); setProfileDir(""); setMsg("Created ✓"); load();
    } catch (ex) { setMsg(ex.message); }
    finally { setBusy(false); }
  };
  const onDelete = async (n) => {
    if (!confirm(`Delete account "${n}"?`)) return;
    await fetch(`/accounts/${encodeURIComponent(n)}`, { method: "DELETE" });
    load();
  };
  const onOpen = async (n) => {
    setInfo("Opening browser…");
    const r = await fetch("/open-browser", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: n }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setInfo("");
    else setInfo(`Browser for "${n}" opened ✓ — VNC at 10.69.1.164:6778`);
    setTimeout(() => setInfo(""), 4000);
    load();
  };
  const onClose = async (n) => {
    await fetch("/close-browser", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: n }) });
    load();
  };
  const onResetDefault = async () => {
    if (!confirm("Reset default profile? This clears its browser data (cookies/logins) and restarts the browser.")) return;
    setMsg("Resetting…");
    const r = await fetch("/accounts/default/reset", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setMsg(j.error || "reset failed");
    else setMsg("Default reset ✓");
    load();
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}><i className="bi bi-people" style={{ marginRight: 8 }} />Profiles</div>
        <span className="badge text-bg-secondary">{accounts.length}</span>
        <span className={`badge ${vnc.enabled ? "text-bg-success" : "text-bg-secondary"}`} title={vnc.enabled ? "VNC enabled — anyone with the link can view the desktop" : "VNC disabled — desktop not exposed"}>{vnc.enabled ? "VNC enabled" : "VNC disabled"}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className={`btn btn-sm ${vnc.enabled ? "btn-outline-danger" : "btn-outline-secondary"}`} onClick={toggleVnc} disabled={vncBusy}><i className={vnc.enabled ? "bi bi-shield-lock" : "bi bi-broadcast"} /> {vncBusy ? "…" : vnc.enabled ? "Disable VNC" : "Enable VNC"}</button>
        {vnc.enabled && <a href="http://10.69.1.164:6778" target="_blank" rel="noopener" className="btn btn-sm btn-primary"><i className="bi bi-box-arrow-up-right" /> Open VNC</a>}
      </div>
      {!vnc.enabled && <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>VNC is disabled — the desktop is not exposed. Enable it when you need to log in, then disable again.</div>}
      {info && <div style={{ background: "rgba(16,185,129,.15)", border: "1px solid #065f46", color: "#d1fae5", padding: "8px 12px", borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{info}</div>}
      <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 16, background: "var(--surface)", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: showCreate ? 12 : 0 }}>
          <div style={{ fontWeight: 600 }}>Create account</div>
          <button type="button" className={`btn btn-sm ${showCreate ? "btn-outline-secondary" : "btn-primary"}`} onClick={() => setShowCreate((v) => !v)} style={{ marginLeft: "auto" }}>
            <i className={`bi ${showCreate ? "bi-chevron-up" : "bi-plus-lg"}`} /> {showCreate ? "Hide" : "Create"}
          </button>
        </div>
        {showCreate && (
          <>
            <form onSubmit={onCreate} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
              <div>
                <label className="form-label">Account name</label>
                <input className="form-control" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. work" required maxLength={40} />
              </div>
              <div>
                <label className="form-label">Profile folder</label>
                <input className="form-control" value={profileDir} onChange={(e) => setProfileDir(e.target.value)} placeholder="Default" />
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}><i className="bi bi-plus-lg" /> Create</button>
            </form>
            {msg && <div style={{ marginTop: 8, color: msg.includes("✓") ? "var(--success)" : "var(--danger)", fontSize: 13 }}>{msg}</div>}
          </>
        )}
      </div>
      {accounts.length === 0 ? <div className="empty"><i className="bi bi-person-plus" /> No accounts yet — create one above.</div> : (
        <div style={{ display: "grid", gap: 16 }}>
          {accounts.map((a) => (
            <div key={a.name} style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 12, background: "var(--surface)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ fontWeight: 700 }}>{a.name} {a.name === "default" && <span className="badge text-bg-secondary">default</span>}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>{a.userDataDir}/{a.profileDir}</div>
                    <div style={{ fontSize: 11, color: a.manualOpen ? "#10b981" : "var(--muted)" }}>{a.manualOpen ? "● Browser open (VNC)" : "○ Closed"}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {a.manualOpen ? <button className="btn btn-sm btn-outline-secondary" onClick={() => onClose(a.name)}><i className="bi bi-x-lg" /> Close</button> : <button className="btn btn-sm btn-primary" onClick={() => onOpen(a.name)}><i className="bi bi-box-arrow-up-right" /> Open</button>}
                    {a.name === "default" ? <button className="btn btn-sm btn-outline-secondary" onClick={onResetDefault} style={{ color: "var(--muted)", borderColor: "var(--border)" }}><i className="bi bi-arrow-counterclockwise" /> Reset</button> : <button className="btn btn-sm btn-outline-secondary" onClick={() => onDelete(a.name)}><i className="bi bi-trash" /> Delete</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
    </div>
  );
}
