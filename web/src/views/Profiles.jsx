import { useEffect, useState } from "react";

export default function Profiles() {
  const [accounts, setAccounts] = useState([]);
  const [name, setName] = useState("");
  const [profileDir, setProfileDir] = useState("");
  const [cdpUrlDraft, setCdpUrlDraft] = useState("");
  const [createType, setCreateType] = useState("local"); // local | cdp
  const [msg, setMsg] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [vnc, setVnc] = useState({ enabled: false, running: false });
  const [vncBusy, setVncBusy] = useState(false);
  const [opening, setOpening] = useState(null);
  const [editingCdp, setEditingCdp] = useState({}); // name -> draft string or undefined
  const [checking, setChecking] = useState({}); // name -> boolean

  const loadVnc = async () => {
    try { const r = await fetch("/vnc/status"); const j = await r.json(); if (j.ok) setVnc({ enabled: j.enabled, running: j.running }); } catch {}
  };

  const load = async () => {
    try {
      const r = await fetch("/accounts");
      const j = await r.json();
      if (j.ok) setAccounts(j.accounts || []);
    } catch {}
  };
  useEffect(() => { load(); loadVnc(); const t = setInterval(load, 4000); const tv = setInterval(loadVnc, 5000); return () => { clearInterval(t); clearInterval(tv); }; }, []);
  useEffect(() => {
    if (!accounts.length || vncBusy || opening) return;
    const anyOpen = accounts.some((a) => a.manualOpen);
    if (!anyOpen && vnc.enabled) {
      const t = setTimeout(() => {
        fetch("/vnc/disable", { method: "POST" }).then(() => loadVnc()).catch(() => {});
      }, 3000);
      return () => clearTimeout(t);
    }
  }, [accounts, vnc.enabled, vncBusy, opening]);

  const onCreate = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg("");
    try {
      const payload = createType === "cdp"
        ? { name, cdpUrl: cdpUrlDraft }
        : { name, profileDir: profileDir || "Default" };
      const r = await fetch("/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "failed");
      setName(""); setProfileDir(""); setCdpUrlDraft(""); setMsg("Created ✓"); load();
      // auto probe cdp after create
      if (createType === "cdp" && payload.cdpUrl) {
        setTimeout(() => { void onCheckCdp(name); }, 800);
      }
    } catch (ex) { setMsg(ex.message); }
    finally { setBusy(false); }
  };
  const onDelete = async (n) => {
    if (!confirm(`Delete account "${n}"?`)) return;
    await fetch(`/accounts/${encodeURIComponent(n)}`, { method: "DELETE" });
    load();
  };
  const onClearCdpDefault = async (n) => {
    if (!confirm(`Remove CDP link for "${n}"? This will clear its CDP URL and revert to local.`)) return;
    const r = await fetch(`/accounts/${encodeURIComponent(n)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cdpUrl: "" }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setInfo(j.error || "failed"); setTimeout(() => setInfo(""), 3000); return; }
    setInfo("CDP cleared ✓"); setTimeout(() => setInfo(""), 2500); load();
  };
  const onCheckCdp = async (n) => {
    setChecking((s) => ({ ...s, [n]: true }));
    try {
      const r = await fetch(`/accounts/${encodeURIComponent(n)}/cdp/check`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "check failed");
      // refresh accounts to get updated status
      await load();
      setInfo(`CDP ${j.status === "up" ? "up" : "down"}${j.latencyMs ? ` · ${j.latencyMs}ms` : ""}${j.error ? ` — ${j.error.slice(0, 120)}` : ""}`);
      setTimeout(() => setInfo(""), 3000);
    } catch (e) { setInfo(e.message); setTimeout(() => setInfo(""), 3000); }
    finally { setChecking((s) => ({ ...s, [n]: false })); }
  };
  const onSaveCdp = async (n) => {
    const draft = editingCdp[n];
    if (draft == null) return;
    const raw = String(draft).trim();
    if (raw && !/^wss?:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
      setInfo("CDP URL must start with ws://, wss://, http:// or https://");
      setTimeout(() => setInfo(""), 3000);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/accounts/${encodeURIComponent(n)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cdpUrl: raw }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "failed");
      setEditingCdp((s) => { const n2 = { ...s }; delete n2[n]; return n2; });
      setInfo(raw ? "CDP saved ✓" : "CDP cleared ✓");
      setTimeout(() => setInfo(""), 2500);
      await load();
      if (raw) setTimeout(() => { void onCheckCdp(n); }, 600);
    } catch (e) { setInfo(e.message); setTimeout(() => setInfo(""), 3000); }
    finally { setBusy(false); }
  };
  const onOpen = async (n) => {
    const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
    const vncUrl = `http://${host}:6778/vnc.html?autoconnect=1&host=${host}&port=6778&resize=scale`;
    setOpening(n);
    try {
      let vs0 = null;
      try { vs0 = await fetch("/vnc/status").then((x) => x.json()); } catch {}
      if (!vs0 || !vs0.running) {
        const er = await fetch("/vnc/enable", { method: "POST" });
        const ej = await er.json().catch(() => ({}));
        if (!er.ok) throw new Error(ej.error || "failed to enable remote desktop");
        let ok = false;
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 300));
          try { const vs = await fetch("/vnc/status").then((x) => x.json()); if (vs.running) { ok = true; break; } } catch {}
        }
        if (!ok) throw new Error("Remote desktop did not start in time");
        await loadVnc();
      }
      setInfo(`Launching browser for "${n}"…`);
      let r = await fetch("/open-browser", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: n }) });
      let text = await r.text();
      let j = {};
      try { j = JSON.parse(text); } catch {}
      if (!r.ok && r.status === 409) {
        setInfo("Cleaning up previous session…");
        await fetch("/close-browser", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: n }) }).catch(() => {});
        await new Promise((x) => setTimeout(x, 800));
        r = await fetch("/open-browser", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: n }) });
        text = await r.text();
        j = {};
        try { j = JSON.parse(text); } catch {}
      }
      if (!r.ok) {
        const msg = j.error || text.slice(0, 300) || "failed to open browser";
        throw new Error(msg);
      }
      setInfo("Confirming remote desktop is active…");
      let running = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r2) => setTimeout(r2, 300));
        try { const vs = await fetch("/vnc/status").then((x) => x.json()); if (vs.running) { running = true; break; } } catch {}
      }
      if (!running) throw new Error("Remote desktop not active yet — try again");
      setInfo(`Browser for "${n}" opened ✓ — opening remote desktop…`);
      const win = window.open(vncUrl, "_blank");
      if (!win) {
        setInfo(`Browser for "${n}" opened — click Open remote desktop to view`);
      } else {
        setTimeout(() => setInfo(""), 4000);
      }
    } catch (e) {
      setInfo(e.message || "failed");
      setTimeout(() => setInfo(""), 5000);
    } finally {
      await load();
      loadVnc();
      setOpening(null);
    }
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
        <span className={`badge ${vnc.enabled ? "text-bg-success" : "text-bg-secondary"}`} title={vnc.enabled ? "Remote desktop active" : "Remote desktop idle — will start when you open a profile"}>{vnc.enabled ? "Remote desktop active" : "Remote desktop idle"}</span>
        <span style={{ flex: 1 }} />
      </div>

      {info && <div style={{ background: "rgba(16,185,129,.15)", border: "1px solid #065f46", color: "#d1fae5", padding: "8px 12px", borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{info}</div>}
      <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 16, background: "var(--surface)", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: showCreate ? 12 : 0 }}>
          <div style={{ fontWeight: 600 }}>Create account</div>
          <button type="button" className={`btn btn-sm ${showCreate ? "btn-outline-secondary" : "btn-primary"}`} onClick={() => { setShowCreate((v) => !v); if (!showCreate) setMsg(""); }} style={{ marginLeft: "auto" }}>
            <i className={`bi ${showCreate ? "bi-chevron-up" : "bi-plus-lg"}`} /> {showCreate ? "Hide" : "Create"}
          </button>
        </div>
        {showCreate && (
          <>
            <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <div
                onClick={() => setCreateType("local")}
                style={{
                  flex: "1 1 160px",
                  border: `2px solid ${createType === "local" ? "var(--accent, #6366f1)" : "var(--border)"}`,
                  borderRadius: 10,
                  padding: "12px 14px",
                  cursor: "pointer",
                  background: createType === "local" ? "rgba(99,102,241,0.08)" : "var(--surface-2)",
                  display: "flex", gap: 10, alignItems: "center",
                }}
              >
                <i className="bi bi-hdd" style={{ fontSize: 22, color: createType === "local" ? "#6366f1" : "var(--muted)" }} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>Local browser</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>Stored profile on this server</div>
                </div>
                {createType === "local" && <i className="bi bi-check-circle-fill" style={{ marginLeft: "auto", color: "#6366f1" }} />}
              </div>
              <div
                onClick={() => setCreateType("cdp")}
                style={{
                  flex: "1 1 160px",
                  border: `2px solid ${createType === "cdp" ? "var(--accent, #6366f1)" : "var(--border)"}`,
                  borderRadius: 10,
                  padding: "12px 14px",
                  cursor: "pointer",
                  background: createType === "cdp" ? "rgba(99,102,241,0.08)" : "var(--surface-2)",
                  display: "flex", gap: 10, alignItems: "center",
                }}
              >
                <i className="bi bi-broadcast" style={{ fontSize: 22, color: createType === "cdp" ? "#6366f1" : "var(--muted)" }} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>External CDP</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>ws:// or http://host:9222</div>
                </div>
                {createType === "cdp" && <i className="bi bi-check-circle-fill" style={{ marginLeft: "auto", color: "#6366f1" }} />}
              </div>
            </div>
            <form onSubmit={onCreate} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
              <div>
                <label className="form-label">Account name</label>
                <input className="form-control" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. work" required maxLength={40} />
              </div>
              {createType === "local" ? (
                <div>
                  <label className="form-label">Profile folder</label>
                  <input className="form-control" value={profileDir} onChange={(e) => setProfileDir(e.target.value)} placeholder="Default" />
                </div>
              ) : (
                <div style={{ flex: "1 1 240px", minWidth: 220 }}>
                  <label className="form-label">CDP URL <span style={{ color: "var(--danger)" }}>*</span></label>
                  <input className="form-control" value={cdpUrlDraft} onChange={(e) => setCdpUrlDraft(e.target.value)} placeholder="ws://10.69.1.42:9222 or http://10.69.1.42:9222" required={createType === "cdp"} />
                </div>
              )}
              <button type="submit" className="btn btn-primary" disabled={busy}><i className="bi bi-plus-lg" /> Create</button>
            </form>
            {createType === "cdp" && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>External Chromium CDP — paste the endpoint. Status will show up/down in the profile card. No VNC for CDP profiles.</div>}
            {msg && <div style={{ marginTop: 8, color: msg.includes("✓") ? "var(--success)" : "var(--danger)", fontSize: 13 }}>{msg}</div>}
          </>
        )}
      </div>
      {accounts.length === 0 ? <div className="empty"><i className="bi bi-person-plus" /> No accounts yet — create one above.</div> : (
        <div style={{ display: "grid", gap: 16 }}>
          {accounts.map((a) => {
            const isCdp = Boolean(a.cdpUrl);
            const cdpStatus = a.cdpStatus || (isCdp ? "checking" : "not_configured");
            const isChecking = Boolean(checking[a.name]);
            return (
              <div key={a.name} style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 12, background: "var(--surface)", display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {a.name} {a.name === "default" && <span className="badge text-bg-secondary">default</span>}
                    {isCdp ? <span className="badge" style={{ background: "#6366f1", color: "#fff", fontSize: 10, fontWeight: 700 }}><i className="bi bi-broadcast" style={{ marginRight: 4 }} />CDP</span> : <span className="badge text-bg-secondary" style={{ fontSize: 10 }}>local</span>}
                    {!isCdp && <span className={`badge ${a.manualOpen ? "text-bg-success" : "text-bg-secondary"}`} style={{ fontSize: 10, fontWeight: 600 }}>{a.manualOpen ? "open" : "closed"}</span>}
                    {isCdp && (
                      <span
                        className={`badge ${cdpStatus === "up" ? "text-bg-success" : cdpStatus === "down" ? "text-bg-danger" : cdpStatus === "checking" ? "text-bg-warning" : "text-bg-secondary"}`}
                        style={{ fontSize: 10, fontWeight: 600 }}
                        title={a.cdpError ? a.cdpError : a.cdpWsEndpoint || a.cdpUrl || ""}
                      >
                        {isChecking || cdpStatus === "checking" ? "checking…" : cdpStatus === "up" ? `● CDP up${a.cdpLatencyMs ? ` · ${a.cdpLatencyMs}ms` : ""}` : cdpStatus === "down" ? "● CDP down" : "—"}
                      </span>
                    )}
                  </div>
                  {isCdp ? (
                    <>
                      <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)", marginTop: 4, wordBreak: "break-all" }}>{a.cdpUrl}</div>
                      {a.cdpWsEndpoint && a.cdpStatus === "up" && <div style={{ fontSize: 10, color: "var(--faint)", fontFamily: "var(--mono)", marginTop: 2, wordBreak: "break-all" }}>→ {a.cdpWsEndpoint}</div>}
                      {a.cdpError && <div style={{ fontSize: 11, color: "#ef4444", marginTop: 4, wordBreak: "break-word" }}>{a.cdpError.slice(0, 160)}</div>}
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{a.cdpCheckedAt ? `checked ${new Date(a.cdpCheckedAt).toLocaleTimeString()}` : "not checked yet"}</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)", marginTop: 2 }}>{a.userDataDir}/{a.profileDir}</div>
                      <div style={{ fontSize: 11, color: a.manualOpen ? "#10b981" : "var(--muted)", marginTop: 2 }}>{a.manualOpen ? "● Browser open — remote desktop" : "○ Closed"}</div>
                    </>
                  )}
                  {editingCdp[a.name] != null && (
                    <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <input className="form-control form-control-sm" style={{ minWidth: 220, flex: "1 1 220px" }} value={editingCdp[a.name]} onChange={(e) => setEditingCdp((s) => ({ ...s, [a.name]: e.target.value }))} placeholder="ws://host:9222 or http://host:9222" />
                      <button className="btn btn-sm btn-primary" onClick={() => onSaveCdp(a.name)} disabled={busy}><i className="bi bi-check-lg" /> Save</button>
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => setEditingCdp((s) => { const n2 = { ...s }; delete n2[a.name]; return n2; })}>Cancel</button>
                    </div>
                  )}
                </div>
                <div className="profile-actions" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {isCdp ? (
                    <>
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => onCheckCdp(a.name)} disabled={isChecking} style={{ minWidth: 90, justifyContent: "center", display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {isChecking ? <><span className="spinner-border spinner-border-sm" style={{ width: 12, height: 12, borderWidth: 2 }} /> Checking…</> : <><i className="bi bi-arrow-clockwise" /> Test</>}
                      </button>
                      <button
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => setEditingCdp((s) => ({ ...s, [a.name]: s[a.name] != null ? s[a.name] : (a.cdpUrl || "") }))}
                        style={{ minWidth: 90, justifyContent: "center", display: "inline-flex", alignItems: "center", gap: 6 }}
                      >
                        <i className="bi bi-pencil" /> Edit
                      </button>
                      {a.name === "default" ? (
                        <button className="btn btn-sm btn-outline-secondary" onClick={() => onClearCdpDefault(a.name)} style={{ minWidth: 90, justifyContent: "center", display: "inline-flex", alignItems: "center", gap: 6 }}><i className="bi bi-trash" /> Remove</button>
                      ) : (
                        <button className="btn btn-sm btn-outline-secondary" onClick={() => onDelete(a.name)} style={{ minWidth: 90, justifyContent: "center", display: "inline-flex", alignItems: "center", gap: 6 }}><i className="bi bi-trash" /> Remove</button>
                      )}
                    </>
                  ) : (
                    <>
                      {a.manualOpen ? (
                        <>
                          <a href={`http://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:6778/vnc.html?autoconnect=1&host=${typeof window !== "undefined" ? window.location.hostname : "localhost"}&port=6778&resize=scale`} target="_blank" rel="noopener" className="btn btn-sm btn-primary" style={{ minWidth: 118, justifyContent: "center", display: "inline-flex", alignItems: "center", gap: 6 }}><i className="bi bi-box-arrow-up-right" /> Open</a>
                          <button className="btn btn-sm btn-outline-secondary" onClick={() => onClose(a.name)} style={{ minWidth: 118, justifyContent: "center", display: "inline-flex", alignItems: "center", gap: 6 }}><i className="bi bi-x-lg" /> Close window</button>
                        </>
                      ) : (
                        <button className="btn btn-sm btn-primary" onClick={() => onOpen(a.name)} disabled={opening === a.name} style={{ minWidth: 118, justifyContent: "center", display: "inline-flex", alignItems: "center", gap: 6 }}>{opening === a.name ? <><span className="spinner-border spinner-border-sm" style={{ width: 12, height: 12, borderWidth: 2 }} /> Starting…</> : <><i className="bi bi-box-arrow-up-right" /> Open</>}</button>
                      )}
                      <button
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => setEditingCdp((s) => ({ ...s, [a.name]: s[a.name] != null ? s[a.name] : "" }))}
                        title="Add CDP URL to this profile"
                        style={{ minWidth: 90, justifyContent: "center", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}
                      >
                        <i className="bi bi-link-45deg" /> CDP
                      </button>
                      {a.name === "default" ? <button className="btn btn-sm btn-outline-secondary" onClick={onResetDefault} style={{ minWidth: 118, justifyContent: "center", display: "inline-flex", alignItems: "center", color: "var(--muted)", borderColor: "var(--border)" }}><i className="bi bi-arrow-counterclockwise" /> Reset</button> : <button className="btn btn-sm btn-outline-secondary" onClick={() => onDelete(a.name)} style={{ minWidth: 118, justifyContent: "center", display: "inline-flex", alignItems: "center" }}><i className="bi bi-trash" /> Remove</button>}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
