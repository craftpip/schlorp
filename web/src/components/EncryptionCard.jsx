import { useCallback, useEffect, useState } from "react";
import { vaultCall } from "./MediaTasksPanel.jsx";
import PatternPad from "./PatternPad.jsx";

// Settings → Encryption (plan 039 v3). One secret: a random key is created
// once and stored with your folders, sealed by your panel password (and your
// 5x5 pattern once you draw it). Logging in unlocks it automatically.

export default function EncryptionCard() {
  const [vault, setVault] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState("");
  const [ack, setAck] = useState(false);
  const [usePad, setUsePad] = useState(false);
  const [oldPass, setOldPass] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/vault/status", { cache: "no-store" });
      const j = await r.json();
      if (j && j.ok) setVault(j);
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, okMsg) => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const j = await fn();
      if (j) setVault(j);
      setPw(""); setAck(false);
      setMsg(okMsg);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const min = (vault && vault.minPassword) || 12;
  const inputStyle = { maxWidth: 280, height: 30, fontSize: 12 };
  let body;
  if (!vault) {
    body = <div style={{ color: "var(--muted)" }}>Loading…</div>;
  } else if (!vault.available) {
    body = <div style={{ color: "var(--muted)" }}><i className="bi bi-info-circle" /> Set a panel password first (Password &amp; pattern, below). Encryption is sealed with it.</div>;
  } else if (vault.legacy) {
    body = (
      <form onSubmit={(e) => { e.preventDefault(); if (!oldPass || !pw) return; run(async () => { const j = await vaultCall("/api/vault/upgrade", { passphrase: oldPass, password: pw }); setOldPass(""); return j; }, "Upgraded ✓ — your password now unlocks your files (the old passphrase no longer works)"); }} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ color: "#f59e0b", fontWeight: 600 }}><i className="bi bi-arrow-up-circle" /> Upgrade needed</div>
        <div style={{ color: "var(--muted)" }}>
          Encryption was set up with the earlier <b>separate encryption passphrase</b>. Enter it once: the same key (so your already-locked files stay readable) gets re-locked with your panel password, and the passphrase goes away.
        </div>
        <input data-testid="enc-old-pass" type="password" className="form-control form-control-sm" style={inputStyle} placeholder="Old encryption passphrase" value={oldPass} onChange={(e) => setOldPass(e.target.value)} autoComplete="off" />
        <input data-testid="enc-upgrade-pass" type="password" className="form-control form-control-sm" style={inputStyle} placeholder="Your panel password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
        <div style={{ color: "var(--muted)", fontSize: 11 }}>The panel password must be at least {min} characters — change it below first if yours is shorter.</div>
        <div><button data-testid="enc-upgrade" type="submit" className="btn btn-sm btn-primary" disabled={busy || !oldPass || !pw}>{busy ? "Upgrading…" : "Upgrade"}</button></div>
      </form>
    );
  } else if (!vault.exists) {
    body = (
      <form onSubmit={(e) => { e.preventDefault(); if (!pw || !ack) return; run(() => vaultCall("/api/vault/setup", { password: pw }), "Encryption is set up and unlocked ✓"); }} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ color: "var(--muted)" }}>
          A random key is created and stored with your folders (a copy on every drive). It is locked with your <b>panel password</b> — and with your pattern once you draw it — and neither is ever saved. Logging in unlocks your files; new downloads are encrypted even while locked.
        </div>
        <input data-testid="enc-setup-pass" type="password" className="form-control form-control-sm" style={inputStyle} placeholder="Your panel password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
        <div style={{ color: "var(--muted)", fontSize: 11 }}>Needs a password of at least {min} characters — change it below first if yours is shorter.</div>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input data-testid="enc-ack" type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 2 }} />
          <span>I understand there is <b>no recovery</b>: if I forget my password and pattern, my locked files are gone for good.</span>
        </label>
        <div><button data-testid="enc-setup" type="submit" className="btn btn-sm btn-primary" disabled={busy || !pw || !ack}>{busy ? "Setting up…" : "Set up encryption"}</button></div>
      </form>
    );
  } else if (!vault.unlocked) {
    const patternOk = vault.hasPattern && vault.patternSlot;
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <form onSubmit={(e) => { e.preventDefault(); if (!pw) return; run(() => vaultCall("/api/vault/unlock", { password: pw }), "Unlocked ✓"); }} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: "#f59e0b", fontWeight: 600 }}><i className="bi bi-lock-fill" /> Locked</span>
          <input data-testid="enc-unlock-pass" type="password" className="form-control form-control-sm" style={inputStyle} placeholder="Panel password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
          <button data-testid="enc-unlock" type="submit" className="btn btn-sm btn-warning" disabled={busy || !pw}>{busy ? "…" : "Unlock"}</button>
          {patternOk && <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setUsePad((x) => !x)}><i className="bi bi-grid-3x3-gap" /> {usePad ? "Hide pattern" : "Use pattern"}</button>}
        </form>
        {patternOk && usePad && <PatternPad size={5} minDots={8} px={220} hint="Draw your pattern" onComplete={async (p) => { const j = await vaultCall("/api/vault/unlock", { pattern: p }); setVault(j); setUsePad(false); setMsg("Unlocked ✓"); }} />}
      </div>
    );
  } else {
    body = (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: "#10b981", fontWeight: 600 }}><i className="bi bi-unlock-fill" /> Unlocked</span>
        <span style={{ color: "var(--muted)" }}>until restart, idle auto-lock, or Lock now</span>
        <button data-testid="enc-lock-now" type="button" className="btn btn-sm btn-outline-secondary" style={{ height: 28, fontSize: 12 }} disabled={busy} onClick={() => run(() => vaultCall("/api/vault/lock"), "Locked ✓ — your password or pattern opens it again")}><i className="bi bi-lock" /> Lock now</button>
      </div>
    );
  }

  return (
    <div data-testid="encryption-card" className="card" style={{ overflow: "hidden", marginBottom: 16 }}>
      <div style={{ padding: "10px 14px", fontWeight: 700, fontSize: 13, borderBottom: "1px solid var(--border)", background: "var(--surface-2)", display: "flex", alignItems: "center", gap: 8 }}>
        <i className="bi bi-shield-lock" /> Encryption
        {vault && vault.exists && <span className="badge text-bg-secondary" style={{ fontWeight: 500 }}>key {vault.keyId}</span>}
        {vault && vault.exists && vault.copies && <span className="badge text-bg-secondary" style={{ fontWeight: 500 }} title={`Key file copies: ${vault.copies.join(", ")}`}>{vault.copies.length} drive cop{vault.copies.length === 1 ? "y" : "ies"}</span>}
      </div>
      <div style={{ padding: "12px 14px", fontSize: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {body}
        {vault && vault.exists && vault.hasPattern && !vault.patternSlot && (
          <div style={{ color: "#f59e0b" }}><i className="bi bi-info-circle" /> Your pattern doesn't open encrypted files yet — re-draw it once in Password &amp; pattern below.</div>
        )}
        {vault && vault.error && !vault.legacy && <div style={{ color: "#f59e0b" }}><i className="bi bi-exclamation-triangle" /> {vault.error}</div>}
        {err && <div style={{ color: "#f87171" }}>{err}</div>}
        {msg && <div style={{ color: "#10b981" }}>{msg}</div>}
      </div>
    </div>
  );
}
