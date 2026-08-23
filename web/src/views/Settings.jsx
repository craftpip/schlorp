import { useEffect, useState } from "react";

export default function Settings() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState("");
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState("");
  const [msg, setMsg] = useState("");

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

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(""), 1500); } catch {}
  };
  const save = async (key) => {
    const value = drafts[key] ?? "";
    setSaving(key); setMsg("");
    try {
      const r = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "save failed");
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

      {err && <div className="card" style={{ padding: 12, color: "var(--danger)", marginBottom: 12 }}>{err}</div>}
      {loading ? <div style={{ padding: 20, color: "var(--muted)" }}>Loading…</div> : filteredGroups.length === 0 ? <div className="empty">No matches.</div> : (
        <div style={{ display: "grid", gap: 16 }}>
          {filteredGroups.map((g) => (
            <div key={g.name} className="card" style={{ overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", fontWeight: 700, fontSize: 13, borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>{g.name} <span className="badge text-bg-secondary" style={{ marginLeft: 6 }}>{g.vars.length}</span></div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ color: "var(--muted)", textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                      <th style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>Variable</th>
                      <th style={{ padding: "8px 10px" }}>Value</th>
                      <th style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>Default</th>
                      <th style={{ padding: "8px 10px" }}>Description</th>
                      <th style={{ padding: "8px 10px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.vars.map((v) => (
                      <tr key={v.key} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "8px 10px", fontFamily: "var(--mono)", fontWeight: 600, whiteSpace: "nowrap" }}>{v.key}</td>
                        <td style={{ padding: "6px 8px" }}>
                          <input
                            className="form-control form-control-sm"
                            style={{ fontFamily: "var(--mono)", fontSize: 12, height: 28, minWidth: 160, borderColor: String(drafts[v.key] ?? v.value) !== String(v.def) ? "var(--accent)" : undefined }}
                            value={drafts[v.key] ?? ""}
                            onChange={(e) => setDrafts((d) => ({ ...d, [v.key]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") save(v.key); }}
                            placeholder={v.def}
                            disabled={saving === v.key}
                          />
                        </td>
                        <td style={{ padding: "8px 10px", fontFamily: "var(--mono)", color: "var(--muted)", whiteSpace: "nowrap" }}>{v.def}</td>
                        <td style={{ padding: "8px 10px", color: "var(--muted)" }}>{v.desc}</td>
                        <td style={{ padding: "8px 10px", whiteSpace: "nowrap", display: "flex", gap: 4 }}>
                          <button className="btn btn-sm btn-primary" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => save(v.key)} disabled={saving === v.key}>{saving === v.key ? "…" : "Save"}</button>
                          <button className="btn btn-sm btn-outline-secondary" style={{ padding: "2px 6px", fontSize: 11 }} onClick={() => copy(`${v.key}=${drafts[v.key] ?? v.value}`)}>{copied === `${v.key}=${drafts[v.key] ?? v.value}` ? "Copied" : "Copy"}</button>
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
