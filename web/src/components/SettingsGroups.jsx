import { useEffect, useMemo, useState } from "react";

// User-friendly settings (server schema from GET /api/config): plain labels,
// real controls (switches, dropdowns, durations in s/min), per-row save,
// "advanced" items hidden by default, and a restart bar for settings that
// only apply after a restart.

const UNIT_MS = { ms: 1, s: 1000, min: 60000 };

function toDisplay(v, value) {
  if (v.type !== "duration" || value === "" || value == null) return value ?? "";
  const n = Number(value) / (UNIT_MS[v.unit] || 1);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : value;
}
function fromDisplay(v, text) {
  const t = String(text ?? "").trim();
  if (v.type !== "duration" || t === "") return t;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(Math.round(n * (UNIT_MS[v.unit] || 1)));
}
const UNIT_LABEL = { ms: "ms", s: "seconds", min: "minutes" };

function Switch({ checked, onChange, disabled, testId }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{ width: 42, height: 24, borderRadius: 999, border: "1px solid var(--border)", background: checked ? "var(--accent, #6366f1)" : "var(--surface-2)", position: "relative", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, transition: "background .15s", flex: "0 0 auto", padding: 0 }}
    >
      <span style={{ position: "absolute", top: 2, left: checked ? 20 : 2, width: 18, height: 18, borderRadius: 999, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "left .15s" }} />
    </button>
  );
}

function SettingRow({ v: v0, onSaved }) {
  // Values fixed by the container environment can't be changed here.
  const v = v0.lockedByContainer ? { ...v0, disabled: true } : v0;
  const effective = v.type === "password" ? "" : v.value !== "" ? v.value : v.def;
  const [draft, setDraft] = useState(toDisplay(v, v.value));
  const [show, setShow] = useState(false);
  const [state, setState] = useState(""); // "" | saving | saved | error
  const [err, setErr] = useState("");
  useEffect(() => { setDraft(toDisplay(v, v.value)); }, [v.value]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (raw) => {
    if (raw === null) { setState("error"); setErr("Enter a number"); return; }
    setState("saving"); setErr("");
    try {
      const r = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: v.key, value: raw }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "save failed");
      setState("saved");
      setTimeout(() => setState((s) => (s === "saved" ? "" : s)), 2000);
      onSaved(v, raw);
    } catch (e) { setState("error"); setErr(e.message); }
  };

  const dirty = v.type !== "bool" && v.type !== "select" && String(draft ?? "") !== String(toDisplay(v, v.value) ?? "");
  const isDefault = v.type === "password" ? !v.hasValue : v.value === "" || v.value === v.def;

  let control;
  if (v.type === "bool") {
    control = <Switch testId={`set-${v.key}`} checked={String(effective) === "1"} disabled={v.disabled || state === "saving"} onChange={(on) => save(on ? "1" : "0")} />;
  } else if (v.type === "select") {
    control = (
      <select data-testid={`set-${v.key}`} className="form-select form-select-sm" style={{ width: 180, height: 30, fontSize: 12 }} value={v.value} disabled={v.disabled || state === "saving"} onChange={(e) => save(e.target.value)}>
        {v.options.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
      </select>
    );
  } else {
    const isNum = v.type === "number" || v.type === "duration";
    control = (
      <form onSubmit={(e) => { e.preventDefault(); save(fromDisplay(v, draft)); }} style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          data-testid={`set-${v.key}`}
          type={v.type === "password" && !show ? "password" : isNum ? "number" : "text"}
          min={isNum ? (v.min ?? 0) : undefined}
          max={v.type === "number" ? v.max : undefined}
          step={v.type === "duration" ? "any" : undefined}
          className="form-control form-control-sm"
          style={{ width: isNum ? 110 : v.type === "path" || v.type === "text" ? 260 : 200, height: 30, fontSize: 12, fontFamily: v.type === "path" ? "var(--mono)" : undefined }}
          value={draft ?? ""}
          placeholder={v.type === "password" ? (v.hasValue ? "•••••• (set — type to change)" : "not set") : v.placeholder || toDisplay(v, v.def) || ""}
          onChange={(e) => setDraft(e.target.value)}
          disabled={v.disabled || state === "saving"}
          autoComplete={v.type === "password" ? "new-password" : "off"}
        />
        {v.type === "duration" && <span style={{ color: "var(--muted)", fontSize: 11 }}>{UNIT_LABEL[v.unit] || v.unit}</span>}
        {v.type === "password" && <button type="button" className="btn btn-sm btn-link" style={{ fontSize: 11, padding: 0 }} onClick={() => setShow((s) => !s)}>{show ? "Hide" : "Show"}</button>}
        {dirty && <button type="submit" className="btn btn-sm btn-primary" style={{ fontSize: 11, padding: "3px 10px" }} disabled={state === "saving"}>Save</button>}
      </form>
    );
  }

  return (
    <div data-testid={`setting-${v.key}`} className="setting-row" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 260px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 13 }} title={v.key}>{v.label}</span>
          {v.lockedByContainer && <span className="badge" title="Set by the container (docker-compose.yml environment: or its startup script), which overrides this page on every start. Change it there and recreate the container." style={{ fontSize: 9.5, fontWeight: 600, background: "rgba(148,163,184,.15)", color: "var(--muted)", border: "1px solid var(--border)" }}><i className="bi bi-box-seam" /> set by Docker</span>}
          {v.restart && !v.lockedByContainer && <span className="badge" title="Takes effect after a restart" style={{ fontSize: 9.5, fontWeight: 600, background: "rgba(245,158,11,.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,.35)" }}>restart</span>}
          {state === "saved" && <span style={{ color: "#10b981", fontSize: 11 }}><i className="bi bi-check2" /> Saved</span>}
          {state === "saving" && <span style={{ color: "var(--muted)", fontSize: 11 }}>Saving…</span>}
        </div>
        {v.desc && <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 2 }}>{v.desc}</div>}
        {err && <div style={{ color: "#f87171", fontSize: 11.5, marginTop: 2 }}>{err}</div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
        {control}
        {/* No Reset on on/off switches: flipping the switch is the reset. */}
        {!isDefault && v.type !== "password" && v.type !== "bool" && !v.lockedByContainer && (
          <button type="button" data-testid={`reset-${v.key}`} className="btn btn-sm btn-link" style={{ fontSize: 11, padding: 0, color: "var(--muted)" }} title={`Back to default (${v.type === "bool" ? (v.def === "1" ? "on" : "off") : toDisplay(v, v.def) || "empty"})`} onClick={() => save("")}>Reset</button>
        )}
      </div>
    </div>
  );
}

export default function SettingsGroups() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");
  const [advanced, setAdvanced] = useState(() => { try { return localStorage.getItem("xdl_settings_advanced") === "1"; } catch { return false; } });
  const [pendingRestart, setPendingRestart] = useState([]);
  const [restarting, setRestarting] = useState("");

  const load = async () => {
    setErr("");
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "failed");
      setGroups(j.groups || []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { try { localStorage.setItem("xdl_settings_advanced", advanced ? "1" : "0"); } catch {} }, [advanced]);

  const onSaved = (v, raw) => {
    setGroups((gs) => gs.map((g) => ({ ...g, vars: g.vars.map((x) => (x.key === v.key ? { ...x, value: x.type === "password" ? "" : raw, hasValue: x.type === "password" ? !!raw.trim() : raw !== "" } : x)) })));
    if (v.restart) setPendingRestart((p) => (p.includes(v.label) ? p : [...p, v.label]));
  };

  const restart = async (force = false) => {
    setRestarting("Restarting…");
    try {
      const r = await fetch("/api/restart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setRestarting(""); if (r.status === 409 && window.confirm(`${j.error}\n\nRestart anyway?`)) restart(true); else if (r.status !== 409) setErr(j.error || "restart failed"); return; }
      await new Promise((res) => setTimeout(res, 1500));
      for (let i = 0; i < 40; i++) {
        try { const h = await fetch("/health", { cache: "no-store" }); if (h.ok) { window.location.reload(); return; } } catch {}
        await new Promise((res) => setTimeout(res, 1000));
      }
      setRestarting("The server hasn't come back yet — reload the page in a moment.");
    } catch (e) { setRestarting(""); setErr(e.message); }
  };

  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => groups.map((g) => ({
    ...g,
    vars: g.vars.filter((v) => (advanced || !v.advanced || q) && (!q || [v.label, v.desc, v.key].some((t) => String(t || "").toLowerCase().includes(q)))),
  })).filter((g) => g.vars.length), [groups, advanced, q]);
  const hiddenCount = groups.reduce((n, g) => n + g.vars.filter((v) => v.advanced).length, 0);

  return (
    <div data-testid="settings-groups">
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 12px", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>App settings</div>
        <span style={{ flex: 1 }} />
        <input data-testid="settings-search" className="form-control form-control-sm" style={{ maxWidth: 220, height: 31 }} placeholder="Search settings…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)", cursor: "pointer" }}>
          <Switch testId="settings-advanced" checked={advanced} onChange={setAdvanced} /> Show advanced{!advanced && hiddenCount ? ` (${hiddenCount})` : ""}
        </label>
      </div>

      {pendingRestart.length > 0 && (
        <div data-testid="settings-restart-bar" style={{ position: "sticky", top: 8, zIndex: 20, display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", marginBottom: 12, borderRadius: 10, border: "1px solid rgba(245,158,11,.45)", background: "color-mix(in srgb, var(--surface) 85%, #f59e0b)", fontSize: 12, flexWrap: "wrap" }}>
          <i className="bi bi-arrow-repeat" style={{ color: "#f59e0b", fontSize: 16 }} />
          <span style={{ flex: 1 }}><b>Restart to apply:</b> {pendingRestart.join(", ")}</span>
          {restarting ? <span>{restarting}</span> : (
            <>
              <button data-testid="settings-restart" type="button" className="btn btn-sm btn-warning" onClick={() => restart(false)}>Restart now</button>
              <button type="button" className="btn btn-sm btn-link" style={{ fontSize: 11 }} onClick={() => setPendingRestart([])}>Later</button>
            </>
          )}
        </div>
      )}

      {err && <div className="card" style={{ padding: 12, color: "var(--danger)", marginBottom: 12 }}>{err}</div>}
      {loading ? <div style={{ padding: 20, color: "var(--muted)" }}>Loading…</div> : visible.length === 0 ? <div className="empty">No settings match “{filter}”.</div> : (
        <div style={{ display: "grid", gap: 16 }}>
          {visible.map((g) => (
            <div key={g.name} data-testid={`settings-group-${g.name}`} className="card" style={{ overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", fontWeight: 700, fontSize: 13, borderBottom: "1px solid var(--border)", background: "var(--surface-2)", display: "flex", alignItems: "center", gap: 8 }}>
                <i className={`bi ${g.icon || "bi-sliders"}`} /> {g.name}
              </div>
              <div>
                {g.vars.map((v) => <SettingRow key={v.key} v={v} onSaved={onSaved} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
