import { useState } from "react";
import PatternPad from "./PatternPad.jsx";
import { CrackLine, strengthOf } from "./LoginUnlockCard.jsx";

// First-run wizard (plan 043), shown while no panel password is set.
//   kind "new"        — empty media folder: welcome, then choose a password.
//   kind "returning"  — media already there: acknowledge it, then a password.
//   kind "encrypted"  — the drive has encrypted files: the password (or
//                       pattern) used before unlocks them and becomes the
//                       panel password.
// onDone(token) — logged in; onSkip() — use the panel without a password.

const SKIP_KEY = "xdl_setup_skipped";
export function setupSkipped() {
  try { return localStorage.getItem(SKIP_KEY) === "1"; } catch { return false; }
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `request failed (${r.status})`);
  return j;
}

const fmt = (n) => Number(n || 0).toLocaleString();

export default function SetupWizard({ state, onDone, onSkip }) {
  const kind = state.kind;
  // "intro" → "password" (new/returning); "unlock" → ("newpass" after a pattern) for encrypted.
  const [step, setStep] = useState(kind === "encrypted" ? (state.unlocked ? "newpass" : "unlock") : "intro");
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [usePad, setUsePad] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const skip = () => {
    try { localStorage.setItem(SKIP_KEY, "1"); } catch {}
    onSkip();
  };
  const setPassword = async (password) => {
    setBusy(true); setErr("");
    try {
      const j = await post("/api/security/password", { newPassword: password });
      try { localStorage.removeItem(SKIP_KEY); } catch {}
      onDone(j.token || "");
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const unlockWithPattern = async (pattern) => {
    setErr("");
    try {
      await post("/api/vault/unlock", { pattern });
      setUsePad(false);
      setStep("newpass");
    } catch (e) { setErr(e.message || String(e)); }
  };

  const strength = strengthOf(p1);
  const mismatch = p2 && p1 !== p2;
  const files = `${fmt(state.files)}${state.capped ? "+" : ""} file${state.files === 1 ? "" : "s"}`;
  const folders = `${fmt(state.folders)} folder${state.folders === 1 ? "" : "s"}`;

  let icon, title, body;
  if (step === "intro" && kind === "new") {
    icon = "bi-stars";
    title = "Welcome to schlorp";
    body = (
      <>
        <p className="wiz-text">Let's set things up. First, choose a password for this panel — you'll use it to log in, and it can also encrypt your media later.</p>
        <button data-testid="wizard-start" type="button" className="btn btn-primary" onClick={() => setStep("password")}>Get started <i className="bi bi-arrow-right" /></button>
      </>
    );
  } else if (step === "intro") {
    icon = "bi-collection";
    title = "Welcome back";
    body = (
      <>
        <p className="wiz-text">We found your library: <b>{files}</b> in <b>{folders}</b>. Everything is where you left it — nothing was changed.</p>
        <p className="wiz-text">Choose a password to protect this panel.</p>
        <button data-testid="wizard-start" type="button" className="btn btn-primary" onClick={() => setStep("password")}>Continue <i className="bi bi-arrow-right" /></button>
      </>
    );
  } else if (step === "password" || step === "newpass") {
    const restored = step === "newpass";
    icon = restored ? "bi-unlock" : "bi-shield-lock";
    title = restored ? "Your files are unlocked" : "Choose a password";
    body = (
      <form onSubmit={(e) => { e.preventDefault(); if (p1 && p1 === p2) setPassword(p1); }} className="wiz-form">
        {restored && <p className="wiz-text">Now choose a password for this panel. Your files will be locked with it too (your pattern keeps working).</p>}
        <input data-testid="wizard-pass" type="password" className="form-control" placeholder="Password" value={p1} onChange={(e) => setP1(e.target.value)} autoComplete="new-password" autoFocus />
        <input data-testid="wizard-pass2" type="password" className="form-control" placeholder="Repeat password" value={p2} onChange={(e) => setP2(e.target.value)} autoComplete="new-password" />
        {mismatch ? <div className="wiz-err">The passwords don't match</div> : <CrackLine est={strength} what="this password" />}
        <button data-testid="wizard-save" type="submit" className="btn btn-primary" disabled={busy || !p1 || p1 !== p2}>{busy ? "Saving…" : "Set password"}</button>
      </form>
    );
  } else {
    icon = "bi-shield-check";
    title = "Welcome back — your files are safe";
    body = (
      <>
        <p className="wiz-text">This drive has <b>{fmt(state.encrypted)}</b> encrypted file{state.encrypted === 1 ? "" : "s"}{state.files > state.encrypted ? <> (and {fmt(state.files - state.encrypted)} unencrypted)</> : null}. They're intact and open with the password{state.patternSlot ? " or pattern" : ""} you used before.</p>
        <p className="wiz-text">Enter it below — it unlocks your files and becomes your panel password here, so there's nothing else to set up.</p>
        {state.keyProblem && <div className="wiz-err"><i className="bi bi-exclamation-triangle" /> {state.keyProblem}</div>}
        <form onSubmit={(e) => { e.preventDefault(); if (p1) setPassword(p1); }} className="wiz-form">
          <input data-testid="wizard-restore-pass" type="password" className="form-control" placeholder="Your previous password" value={p1} onChange={(e) => setP1(e.target.value)} autoComplete="current-password" autoFocus />
          <button data-testid="wizard-restore" type="submit" className="btn btn-primary" disabled={busy || !p1}>{busy ? "Checking…" : "Unlock my files"}</button>
        </form>
        {state.patternSlot && (
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setUsePad((x) => !x)}><i className="bi bi-grid-3x3-gap" /> {usePad ? "Use the password instead" : "Use my pattern instead"}</button>
            {usePad && <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}><PatternPad size={5} minDots={8} px={240} hint="Draw your previous pattern" onComplete={unlockWithPattern} /></div>}
          </div>
        )}
      </>
    );
  }

  return (
    <div data-testid="setup-wizard" className="wiz-shell">
      <div className="wiz-card card">
        <div className="wiz-brand">
          <img src="/logo.png" alt="" style={{ height: 30, borderRadius: 8 }} />
          <span>schlorp</span>
        </div>
        <div className="wiz-icon"><i className={`bi ${icon}`} /></div>
        <h1 className="wiz-title">{title}</h1>
        {body}
        {err && <div className="wiz-err" data-testid="wizard-error">{err}</div>}
        <button data-testid="wizard-skip" type="button" className="wiz-skip" onClick={skip}>
          {kind === "encrypted" && step !== "newpass" ? "Skip for now — encrypted files stay locked" : "Skip for now — use without a password"}
        </button>
      </div>
    </div>
  );
}
