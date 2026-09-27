import { useEffect, useState } from "react";
import ConfirmModal from "../components/ConfirmModal";

export default function Settings() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState("");
  const [msg, setMsg] = useState("");
  const [upd, setUpd] = useState(null);
  const [updErr, setUpdErr] = useState("");
  const [updBusy, setUpdBusy] = useState(false);
  const [updMsg, setUpdMsg] = useState("");
  const [confirmUpd, setConfirmUpd] = useState(false);

  // The server may answer with HTML (e.g. an older build without the update
  // routes returns the SPA page) — say so instead of throwing a parse error.
  const readJson = async (r) => {
    const text = await r.text();
    try { return JSON.parse(text); }
    catch { throw new Error(`server has no update endpoint (HTTP ${r.status}) — restart the app to load it`); }
  };

  const loadUpdate = async () => {
    setUpdErr("");
    try {
      const r = await fetch("/api/update/status");
      const j = await readJson(r);
      if (!j.ok) { setUpd(null); setUpdErr(j.error || "update status unavailable"); return; }
      setUpd(j);
    } catch (e) { setUpd(null); setUpdErr(e.message); }
  };
  useEffect(() => { loadUpdate(); }, []);

  // After a successful update the server restarts itself — wait for it to answer
  // again, then reload so the page comes from the new build.
  const waitForRestart = async () => {
    await new Promise((r) => setTimeout(r, 2500)); // let the server actually go down first
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const r = await fetch("/health");
        if (r.ok) { window.location.reload(); return; }
      } catch { /* still down */ }
    }
    setUpdBusy(false);
    setUpdMsg("Update applied, but the server has not come back yet. Reload manually.");
  };

  const runUpdate = async () => {
    setConfirmUpd(false);
    setUpdBusy(true); setUpdErr(""); setUpdMsg("Updating…");
    try {
      const r = await fetch("/api/update", { method: "POST" });
      const j = await readJson(r);
      if (!r.ok || !j.ok) {
        setUpdBusy(false);
        setUpdMsg(j.error || "update failed");
        loadUpdate();
        return;
      }
      setUpdMsg(`${j.method === "git" ? "Pulled" : "Downloaded"} ${j.commitShort || ""} — restarting…`);
      await waitForRestart();
    } catch (e) { setUpdBusy(false); setUpdMsg(e.message); }
  };

  const load = async () => {
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/config");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "failed");
      setGroups(j.groups || []);
      const d = {};
      for (const g of j.groups || []) for (const v of g.vars) d[v.key] = String(v.value ?? "");
      setDrafts(d);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async (key) => {
    const value = drafts[key] ?? "";
    setSaving(key); setMsg("");
    try {
      const r = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "save failed");
      if (key === "UI_PANEL_PASSWORD") {
        // keep local auth in sync — new password becomes the stored token
        if (value.trim()) { localStorage.setItem("xdl_admin_pw", value.trim()); localStorage.setItem("xdl_panel_pw", value.trim()); }
        else { localStorage.removeItem("xdl_admin_pw"); localStorage.removeItem("xdl_panel_pw"); }
      }
      setMsg(`${key} saved ✓ — restart container to apply`);
      setTimeout(() => setMsg(""), 3000);
      load();
    } catch (e) { setMsg(e.message); setTimeout(() => setMsg(""), 3000); }
    finally { setSaving(""); }
  };

  const q = filter.trim().toLowerCase();
  const filteredGroups = q ? groups.map((g) => ({
    ...g,
    vars: g.vars.filter((v) => v.key.toLowerCase().includes(q) || String(v.value).toLowerCase().includes(q) || v.desc.toLowerCase().includes(q)),
  })).filter((g) => g.vars.length) : groups;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}><i className="bi bi-gear" style={{ marginRight: 8 }} />Settings</div>
        <span className="badge text-bg-secondary">{groups.reduce((n, g) => n + g.vars.length, 0)} vars</span>
        <span style={{ flex: 1 }} />
        <input className="form-control form-control-sm" style={{ maxWidth: 220, height: 31 }} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn btn-sm btn-outline-secondary" style={{ height: 31 }} onClick={load}><i className="bi bi-arrow-clockwise" /> Refresh</button>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12 }}>Edit values inline — press <code>Enter</code> to save to <code>.env</code> (restart container to apply).</div>
      {msg && <div style={{ padding: "8px 12px", borderRadius: 8, fontSize: 13, marginBottom: 10, background: msg.includes("✓") ? "rgba(16,185,129,.15)" : "rgba(239,68,68,.12)", border: `1px solid ${msg.includes("✓") ? "#065f46" : "#7f1d1d"}`, color: msg.includes("✓") ? "#d1fae5" : "#fecaca" }}>{msg}</div>}

      <div className="card" style={{ overflow: "hidden", marginBottom: 16 }}>
        <div style={{ padding: "10px 14px", fontWeight: 700, fontSize: 13, borderBottom: "1px solid var(--border)", background: "var(--surface-2)", display: "flex", alignItems: "center", gap: 8 }}>
          <i className="bi bi-cloud-arrow-down" /> Updates
          {upd && <span className="badge text-bg-secondary" style={{ fontWeight: 500 }}>{upd.method === "git" ? "git pull" : "github zip"}</span>}
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm btn-outline-secondary" style={{ height: 26, fontSize: 11 }} onClick={loadUpdate} disabled={updBusy}><i className="bi bi-arrow-clockwise" /> Check</button>
        </div>
        <div style={{ padding: "12px 14px", fontSize: 12 }}>
          {updErr ? (
            <div style={{ color: "var(--danger)" }}><i className="bi bi-exclamation-triangle" /> {updErr}</div>
          ) : !upd ? (
            <div style={{ color: "var(--muted)" }}>Checking for updates…</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "var(--muted)" }}>
                <span><i className="bi bi-github" /> {upd.repo || "—"} · {upd.branch}</span>
                <span><i className="bi bi-circle-fill" style={{ fontSize: 7, color: "var(--accent)" }} /> local {upd.localShort || "?"}</span>
                <span><i className="bi bi-cloud" /> upstream {upd.updateAvailable ? upd.latestShort : (upd.localKnown ? (upd.localShort || "?") : "?")}</span>
              </div>
              {upd.updateAvailable && upd.latestMessage && (
                <div style={{ marginTop: 6, color: "var(--text)" }}><i className="bi bi-stars" /> {upd.latestMessage}</div>
              )}
              <div style={{ marginTop: 8, fontWeight: 600, color: upd.updateAvailable ? "var(--accent)" : upd.blockedReason ? "var(--danger)" : "var(--muted)" }}>
                {upd.updateAvailable
                  ? `Update available — ${upd.upstreamAhead} new commit(s) on ${upd.branch}`
                  : upd.blockedReason || "Up to date"}
              </div>
              {upd.dirtyCount > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", color: "var(--muted)" }}>{upd.dirtyCount} uncommitted change(s) block the update</summary>
                  <div style={{ marginTop: 6, fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", maxHeight: 160, overflow: "auto" }}>
                    {upd.changes.map((c) => <div key={c.path}>{c.status} {c.path}</div>)}
                    {upd.dirtyCount > upd.changes.length && <div>…and {upd.dirtyCount - upd.changes.length} more</div>}
                  </div>
                </details>
              )}
              <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  className="btn btn-sm btn-primary"
                  style={{ height: 30 }}
                  disabled={updBusy || !upd.canUpdate}
                  title={upd.canUpdate ? `Update to ${upd.latestShort} and restart` : (upd.blockedReason || "no update available")}
                  onClick={() => setConfirmUpd(true)}
                >
                  <i className="bi bi-cloud-arrow-down" /> {updBusy ? "Working…" : "Update & restart"}
                </button>
                {upd.latestError && <span style={{ color: "var(--muted)" }}><i className="bi bi-info-circle" /> {upd.latestError}</span>}
                {updMsg && <span style={{ color: updMsg.startsWith("Updating") || updMsg.includes("restarting") ? "var(--accent)" : "var(--muted)" }}>{updMsg}</span>}
              </div>
            </>
          )}
        </div>
      </div>
      <ConfirmModal
        open={confirmUpd}
        title="Update and restart?"
        message={`Fetch the latest ${upd?.branch || ""} from ${upd?.repo || "GitHub"} (${upd?.method === "git" ? "git pull" : "download the GitHub zip"}), replace the project files, then restart the server.\n\nThe server will be unreachable for a few seconds.`}
        confirmLabel="Update & restart"
        onConfirm={runUpdate}
        onCancel={() => setConfirmUpd(false)}
      />

      {err && <div className="card" style={{ padding: 12, color: "var(--danger)", marginBottom: 12 }}>{err}</div>}
      {loading ? <div style={{ padding: 20, color: "var(--muted)" }}>Loading…</div> : filteredGroups.length === 0 ? <div className="empty">No matches.</div> : (
        <div style={{ display: "grid", gap: 16 }}>
          {filteredGroups.map((g) => (
            <div key={g.name} className="card" style={{ overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", fontWeight: 700, fontSize: 13, borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>{g.name} <span className="badge text-bg-secondary" style={{ marginLeft: 6 }}>{g.vars.length}</span></div>
              <div style={{ overflowX: "auto" }}>
                <table className="settings-table" style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ color: "var(--muted)", textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                      <th style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>Variable</th>
                      <th style={{ padding: "8px 10px" }}>Value</th>
                      <th className="sc-def" style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>Default</th>
                      <th className="sc-desc" style={{ padding: "8px 10px" }}>Description</th>
                      <th style={{ padding: "8px 10px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.vars.map((v) => (
                      <tr key={v.key} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "8px 10px", fontFamily: "var(--mono)", fontWeight: 600, whiteSpace: "nowrap" }}>{v.key}</td>
                        <td style={{ padding: "6px 8px" }}>
                          <input
                            type={v.isPassword ? "password" : "text"}
                            className="form-control form-control-sm"
                            style={{ fontFamily: "var(--mono)", fontSize: 12, height: 28, minWidth: 160, borderColor: (v.hasValue ? true : String(drafts[v.key] ?? v.value) !== String(v.def)) ? "var(--accent)" : undefined }}
                            value={drafts[v.key] ?? ""}
                            onChange={(e) => setDrafts((d) => ({ ...d, [v.key]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") save(v.key); }}
                            placeholder={v.placeholder || v.def}
                            disabled={saving === v.key}
                          />
                        </td>
                        <td className="sc-def" style={{ padding: "8px 10px", fontFamily: "var(--mono)", color: "var(--muted)", whiteSpace: "nowrap" }}>{v.def}</td>
                        <td className="sc-desc" style={{ padding: "8px 10px", color: "var(--muted)" }}>{v.desc}</td>
                        <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                          <button className="btn btn-sm btn-primary" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => save(v.key)} disabled={saving === v.key}>{saving === v.key ? "…" : "Save"}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
