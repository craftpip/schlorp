import { useCallback, useEffect, useState } from "react";
import { PatternSetup } from "./PatternPad.jsx";
import { vaultCall } from "./MediaTasksPanel.jsx";
import { WORDS, passwordBits, patternBits, crackEstimate } from "../lib/crackTime.js";

// Settings → Password & pattern (plan 040 v2). One password for everything;
// the 5x5 pattern is an alternative for login and unlocking encrypted files.

const LOCK_LABELS = { 0: "Never", 5: "5 minutes", 15: "15 minutes", 30: "30 minutes", 60: "1 hour", 120: "2 hours" };
// 6 words from a ~230-word list ≈ 47 bits — centuries against a GPU rig.
function suggest(n = 6) {
  const b = new Uint32Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => WORDS[x % WORDS.length]).join("-");
}
export function strengthOf(p) {
  const s = String(p || "");
  if (!s) return null;
  return crackEstimate(passwordBits(s), "password");
}

// "Time to crack" line shown under the password / pattern being set.
export function CrackLine({ est, what }) {
  if (!est) return null;
  return (
    <div data-testid="crack-estimate" style={{ color: est.tone, fontSize: 11.5 }}>
      <b>{est.label}</b> — with a stolen drive, {what} could be cracked <b>{est.text === "instantly" ? "instantly" : `in ${est.text}`}</b> (≈{est.bits} bits; offline, strong GPU rig)
    </div>
  );
}

function Choice({ label, options, value, onChange, disabled }) {
  return (
    <div className="sec-row">
      <span style={{ minWidth: 130, color: "var(--muted)" }}>{label}</span>
      <div style={{ display: "inline-flex", gap: 2, padding: 2, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-2)", opacity: disabled ? 0.5 : 1 }}>
        {options.map(([k, text, dis]) => (
          <button key={k} type="button" disabled={disabled || dis} className={`btn btn-sm ${value === k ? "btn-primary" : "btn-link"}`} style={{ fontSize: 11, padding: "2px 10px", textDecoration: "none" }} onClick={() => onChange(k)}>{text}</button>
        ))}
      </div>
    </div>
  );
}

export default function LoginUnlockCard() {
  const [sec, setSec] = useState(null);
  const [vault, setVault] = useState(null);
  const [mode, setMode] = useState(null); // "password" | "pattern" | "remove-pattern" | null
  const [cur, setCur] = useState("");
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [show, setShow] = useState(false);
  const [pattern, setPattern] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([fetch("/api/security", { cache: "no-store" }).then((r) => r.json()), fetch("/api/vault/status", { cache: "no-store" }).then((r) => r.json())]);
      if (a && a.ok) setSec(a);
      if (b && b.ok) setVault(b);
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const reset = () => { setMode(null); setCur(""); setP1(""); setP2(""); setPattern(null); setShow(false); };
  const say = (m) => { setMsg(m); setErr(""); setTimeout(() => setMsg(""), 5000); };
  const act = async (fn, okMsg) => {
    setBusy(true); setErr("");
    try { await fn(); reset(); await load(); say(okMsg); } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };

  if (!sec) return null;
  const vaultExists = vault && vault.exists;
  const strength = strengthOf(p1);
  const mismatch = p2 && p1 !== p2;
  const pwBad = !p1 || p1 !== p2;
  const inputStyle = { maxWidth: 280, height: 30, fontSize: 12 };

  return (
    <div data-testid="login-unlock-card" className="card" style={{ overflow: "hidden", marginBottom: 16 }}>
      <div style={{ padding: "10px 14px", fontWeight: 700, fontSize: 13, borderBottom: "1px solid var(--border)", background: "var(--surface-2)", display: "flex", alignItems: "center", gap: 8 }}>
        <i className="bi bi-key" /> Password &amp; pattern
      </div>
      <div style={{ padding: "12px 14px", fontSize: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ color: "var(--muted)" }}>
          One password for everything: it logs you in and unlocks encrypted files. A 5×5 pattern can do the same. Neither is stored anywhere readable. 5 wrong tries lock attempts for a while.
        </div>

        {/* Password */}
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="sec-row">
            <span style={{ minWidth: 130, color: "var(--muted)" }}>Password</span>
            <span data-testid="pw-status" style={{ fontWeight: 600 }}>{sec.hasPassword ? "Set" : "Not set — the panel is open to anyone on your network"}</span>
            {mode !== "password" && <button type="button" data-testid="pw-change" className="btn btn-sm btn-outline-primary" style={{ fontSize: 11, padding: "2px 10px" }} onClick={() => { reset(); setMode("password"); }}>{sec.hasPassword ? "Change" : "Set password"}</button>}
          </div>
          {mode === "password" && (
            <form onSubmit={(e) => { e.preventDefault(); if (pwBad) return; act(async () => { const j = await vaultCall("/api/security/password", { currentPassword: cur, newPassword: p1 }); if (j.token) localStorage.setItem("xdl_session_token", j.token); }, sec.hasPassword ? "Password changed ✓ — other devices were logged out" : "Password set ✓"); }} style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 138 }}>
              {sec.hasPassword && <input data-testid="pw-current" type="password" className="form-control form-control-sm" style={inputStyle} placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />}
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input data-testid="pw-new" type={show ? "text" : "password"} className="form-control form-control-sm" style={inputStyle} placeholder="New password" value={p1} onChange={(e) => setP1(e.target.value)} autoComplete="new-password" />
                <button type="button" className="btn btn-sm btn-outline-secondary" style={{ height: 30, fontSize: 11 }} onClick={() => { setP1(suggest()); setP2(""); setShow(true); }}><i className="bi bi-shuffle" /> Suggest</button>
                <button type="button" className="btn btn-sm btn-link" style={{ fontSize: 11 }} onClick={() => setShow((x) => !x)}>{show ? "Hide" : "Show"}</button>
              </div>
              <CrackLine est={strength} what="this password" />
              <input data-testid="pw-new2" type={show ? "text" : "password"} className="form-control form-control-sm" style={inputStyle} placeholder="New password again" value={p2} onChange={(e) => setP2(e.target.value)} autoComplete="new-password" />
              {mismatch && <div style={{ color: "#f87171" }}>The two entries don't match.</div>}
              {vaultExists && <div style={{ color: "var(--muted)" }}>Encrypted files are re-sealed with the new password — nothing is re-encrypted.</div>}
              <div style={{ display: "flex", gap: 6 }}>
                <button data-testid="pw-save" type="submit" className="btn btn-sm btn-primary" disabled={busy || pwBad || (sec.hasPassword && !cur)}>{busy ? "Saving…" : "Save password"}</button>
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={reset}>Cancel</button>
              </div>
            </form>
          )}
        </section>

        {/* Pattern */}
        <section style={{ display: "flex", flexDirection: "column", gap: 8, opacity: sec.hasPassword ? 1 : 0.6 }}>
          <div className="sec-row">
            <span style={{ minWidth: 130, color: "var(--muted)" }}>Pattern (5×5)</span>
            <span data-testid="pattern-status" style={{ fontWeight: 600 }}>{sec.pattern ? "Set" : "Not set"}</span>
            {sec.hasPassword && mode !== "pattern" && <button type="button" data-testid="pattern-set" className="btn btn-sm btn-outline-primary" style={{ fontSize: 11, padding: "2px 10px" }} onClick={() => { reset(); setMode("pattern"); }}>{sec.pattern ? "Change" : "Set pattern"}</button>}
            {sec.pattern && mode !== "remove-pattern" && <button type="button" className="btn btn-sm btn-outline-danger" style={{ fontSize: 11, padding: "2px 10px" }} onClick={() => { reset(); setMode("remove-pattern"); }}>Remove</button>}
          </div>
          {mode === "pattern" && (
            <div style={{ paddingLeft: 138, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ color: "var(--muted)" }}>At least {sec.minDots} dots. It also unlocks encrypted files from the drive, so avoid simple shapes (letters, borders, straight lines).</div>
              {!pattern ? (
                <PatternSetup size={5} minDots={sec.minDots} px={240} onDone={setPattern} />
              ) : (
                <form onSubmit={(e) => { e.preventDefault(); act(async () => { const j = await vaultCall("/api/security/pattern", { pattern, password: cur }); if (j.token) localStorage.setItem("xdl_session_token", j.token); }, "Pattern saved ✓ — other devices were logged out"); }} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ color: "#10b981" }}><i className="bi bi-check2-circle" /> Pattern recorded ({pattern.dots.length} dots).</div>
                  <CrackLine est={crackEstimate(patternBits(pattern.dots, 5), "pattern")} what="this pattern" />
                  <div>Confirm with your password:</div>
                  <input data-testid="pattern-confirm-pass" type="password" className="form-control form-control-sm" style={inputStyle} placeholder="Password" value={cur} onChange={(e) => setCur(e.target.value)} autoFocus autoComplete="current-password" />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button data-testid="pattern-save" type="submit" className="btn btn-sm btn-primary" disabled={busy || !cur}>{busy ? "Saving…" : "Save pattern"}</button>
                    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setPattern(null)}>Redraw</button>
                    <button type="button" className="btn btn-sm btn-link" onClick={reset}>Cancel</button>
                  </div>
                </form>
              )}
            </div>
          )}
          {mode === "remove-pattern" && (
            <form onSubmit={(e) => { e.preventDefault(); act(async () => { const j = await vaultCall("/api/security/pattern", { pattern: null, password: cur }); if (j.token) localStorage.setItem("xdl_session_token", j.token); }, "Pattern removed ✓"); }} style={{ paddingLeft: 138, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="password" className="form-control form-control-sm" style={{ ...inputStyle, maxWidth: 220 }} placeholder="Password" value={cur} onChange={(e) => setCur(e.target.value)} autoFocus />
              <button type="submit" className="btn btn-sm btn-danger" disabled={busy || !cur}>Remove pattern</button>
              <button type="button" className="btn btn-sm btn-link" onClick={reset}>Cancel</button>
            </form>
          )}
          {vaultExists && sec.pattern && !vault.patternSlot && <div style={{ color: "#f59e0b", paddingLeft: 138 }}><i className="bi bi-info-circle" /> Re-draw your pattern once so it can unlock encrypted files too.</div>}
        </section>

        <Choice label="Login shows first" value={sec.preferLogin} onChange={(v) => act(() => vaultCall("/api/security/prefs", { preferLogin: v }), "Saved ✓")} options={[["password", "Password"], ["pattern", "Pattern", !sec.pattern]]} />
        <div className="sec-row">
          <span style={{ minWidth: 130, color: "var(--muted)" }} title="After this long without using the panel you're logged out everywhere, and encrypted files need your password or pattern again">Log out after idle</span>
          <select data-testid="autolock-select" className="form-select form-select-sm" style={{ width: 160, height: 28, fontSize: 12 }} disabled={!sec.hasPassword} value={sec.autoLockMinutes} onChange={(e) => act(async () => { const j = await vaultCall("/api/security/prefs", { autoLockMinutes: Number(e.target.value) }); window.dispatchEvent(new Event("xdl-security-changed")); return j; }, "Saved ✓")}>
            {(sec.autoLockChoices || [0, 15, 30, 60]).map((m) => <option key={m} value={m}>{LOCK_LABELS[m] || `${m} min`}</option>)}
          </select>
        </div>
        {err && <div style={{ color: "#f87171" }}>{err}</div>}
        {msg && <div style={{ color: "#10b981" }}>{msg}</div>}
      </div>
    </div>
  );
}
