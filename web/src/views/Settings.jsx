import { useEffect, useState } from "react";
import ConfirmModal from "../components/ConfirmModal";
import EncryptionCard from "../components/EncryptionCard.jsx";
import LoginUnlockCard from "../components/LoginUnlockCard.jsx";
import SettingsGroups from "../components/SettingsGroups.jsx";

export default function Settings() {
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


  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}><i className="bi bi-gear" style={{ marginRight: 8 }} />Settings</div>
      </div>

      <EncryptionCard />
      <LoginUnlockCard />

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

      <SettingsGroups />
    </div>
  );
}
