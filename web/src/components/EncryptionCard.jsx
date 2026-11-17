import { useCallback, useEffect, useState } from "react";
import { vaultCall } from "./MediaTasksPanel.jsx";
import PatternPad from "./PatternPad.jsx";
import ConfirmModal from "./ConfirmModal.jsx";

// Settings → Encryption (plan 039 v3). One secret: a random key is created
// once and stored with your folders, sealed by your panel password (and your
// 5x5 pattern once you draw it). Logging in unlocks it automatically.

export default function EncryptionCard() {
  const [vault, setVault] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState("");
  const [usePad, setUsePad] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);
  // Only when the server has no key from this login (e.g. it restarted).
  const [needPw, setNeedPw] = useState(false);

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
      setPw("");
      setMsg(okMsg);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const inputStyle = { maxWidth: 280, height: 30, fontSize: 12 };
  // Turn on encryption: just a confirmation — the server uses the key it
  // derived from your password when you logged in (plan 042).
  const turnOn = async (password) => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const j = await vaultCall("/api/vault/setup", password ? { password } : {});
      setVault(j); setPw(""); setNeedPw(false);
      setMsg("Encryption is on ✓");
    } catch (e) {
      if (e.code === "NEEDS_PASSWORD") setNeedPw(true);
      setErr(e.message || String(e));
    } finally { setBusy(false); }
  };
  let body;
  if (!vault) {
    body = <div style={{ color: "var(--muted)" }}>Loading…</div>;
  } else if (vault.needsRestore && vault.unlocked) {
    body = <div data-testid="enc-restored" style={{ color: "#10b981" }}><i className="bi bi-unlock" /> Your files are open. Now set a panel password below (<b>Password &amp; pattern</b>) — it will lock them from now on.</div>;
  } else if (vault.needsRestore) {
    // Fresh install / lost settings on an encrypted drive: the first password
    // must be the one the drive was encrypted with.
    const restorePw = async (e) => {
      e.preventDefault();
      if (!pw) return;
      setBusy(true); setErr(""); setMsg("");
      try {
        const j = await vaultCall("/api/security/password", { newPassword: pw });
        if (j.token) localStorage.setItem("xdl_session_token", j.token);
        setMsg("Restored ✓ — this is your panel password now");
        setTimeout(() => window.location.reload(), 700);
      } catch (e2) { setErr(e2.message || String(e2)); }
      finally { setBusy(false); }
    };
    body = (
      <div data-testid="enc-restore" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ color: "#f59e0b", fontWeight: 600 }}><i className="bi bi-hdd" /> Encrypted files found on this drive</div>
        <div style={{ color: "var(--muted)" }}>Enter the password you used before to open them. It also becomes your panel password here.</div>
        <form onSubmit={restorePw} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input data-testid="enc-restore-pass" type="password" className="form-control form-control-sm" style={inputStyle} placeholder="Your previous password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" autoFocus />
          <button data-testid="enc-restore-go" type="submit" className="btn btn-sm btn-primary" disabled={busy || !pw}>{busy ? "Checking…" : "Restore"}</button>
          {vault.patternSlot && <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setUsePad((x) => !x)}><i className="bi bi-grid-3x3-gap" /> {usePad ? "Hide pattern" : "Use pattern"}</button>}
        </form>
        {vault.patternSlot && usePad && <PatternPad size={5} minDots={8} px={220} hint="Draw your previous pattern" onComplete={async (p) => { setErr(""); try { const j = await vaultCall("/api/vault/unlock", { pattern: p }); setVault(j); setUsePad(false); setMsg("Opened ✓"); } catch (e2) { setErr(e2.message || String(e2)); } }} />}
      </div>
    );
  } else if (!vault.available) {
    body = <div style={{ color: "var(--muted)" }}><i className="bi bi-info-circle" /> Set a panel password first (Password &amp; pattern, below). Encryption is sealed with it.</div>;
  } else if (!vault.exists) {
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ color: "var(--muted)" }}>
          Your files get locked with the password (and pattern) you log in with. Logging in opens them; new downloads are encrypted even while locked.
        </div>
        {needPw ? (
          <form onSubmit={(e) => { e.preventDefault(); if (pw) turnOn(pw); }} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input data-testid="enc-setup-pass" type="password" className="form-control form-control-sm" style={inputStyle} placeholder="The password you log in with" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" autoFocus />
            <button data-testid="enc-setup" type="submit" className="btn btn-sm btn-primary" disabled={busy || !pw}>{busy ? "Turning on…" : "Turn on"}</button>
          </form>
        ) : (
          <div><button data-testid="enc-setup" type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => setConfirmOn(true)}><i className="bi bi-shield-lock" /> {busy ? "Turning on…" : "Turn on encryption"}</button></div>
        )}
        <ConfirmModal
          open={confirmOn}
          title="Turn on encryption?"
          message="Locked files open only with your password or pattern. There is no recovery — if you forget both, locked files are gone for good."
          confirmLabel="Turn on"
          onCancel={() => setConfirmOn(false)}
          onConfirm={() => { setConfirmOn(false); turnOn(""); }}
        />
      </div>
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
    // Set up and unlocked: show the key's status in place of the button.
    body = <KeyStatus vault={vault} />;
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
        {vault && vault.error && <div style={{ color: "#f59e0b" }}><i className="bi bi-exclamation-triangle" /> {vault.error}</div>}
        {err && <div style={{ color: "#f87171" }}>{err}</div>}
        {msg && <div style={{ color: "#10b981" }}>{msg}</div>}
      </div>
    </div>
  );
}

// Key status once encryption is on: where the key file lives, what opens it,
// whether it's open right now and what happens to new files.
function KeyStatus({ vault }) {
  const row = (label, value, testid) => (
    <div style={{ display: "flex", gap: 8 }} data-testid={testid}>
      <span style={{ minWidth: 130, color: "var(--muted)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
  const created = vault.createdAt ? new Date(vault.createdAt) : null;
  const copies = vault.copies || [];
  const opens = ["password", vault.patternSlot ? "pattern" : null].filter(Boolean).join(" or ");
  const mins = Number(vault.autoLockMinutes) || 0;
  return (
    <div data-testid="enc-status" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ color: "#10b981", fontWeight: 600 }}><i className="bi bi-unlock" /> Encryption is on — key unlocked</div>
      {row("Key", <code>{vault.keyId}</code>, "enc-status-key")}
      {created && !Number.isNaN(created.getTime()) && row("Created", created.toLocaleString())}
      {row("Opens with", opens)}
      {row("Key file", copies.length ? copies.map((c) => (c === "." ? "media root" : c)).join(", ") : "—", "enc-status-copies")}
      {row("New files", vault.encryptNew ? "encrypted automatically" : "saved unencrypted (ENCRYPT_NEW_MEDIA=0)", "enc-status-new")}
      {row("Locks", mins ? `after ${mins} min idle (logs out everywhere)` : "only when the server restarts")}
      <div style={{ color: "var(--muted)" }}>Existing files stay as they are — encrypt them from the Media page (right-click → Encrypt).</div>
    </div>
  );
}
