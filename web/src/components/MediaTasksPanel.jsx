import { askSameName, endSameNameBatch } from "./SameNamePrompt.jsx";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import PatternPad from "./PatternPad.jsx";

// Media panel background tasks (plan 039): file uploads and lock/unlock jobs.
// `useMediaTasks` owns the state; `MediaTasksPanel` renders the bottom-right
// progress card; `filesFromDataTransfer` expands OS drops (incl. folders).

let uploadSeq = 0;

// Upload queue lives at module level, not in the Media component: leaving the
// page keeps uploads running *and visible* when you come back (no orphaned
// XHRs, no accidental double uploads).
const uploadStore = { list: [], listeners: new Set(), xhrs: new Map(), running: false, onDone: null };
function subscribeUploads(fn) { uploadStore.listeners.add(fn); return () => uploadStore.listeners.delete(fn); }
function getUploads() { return uploadStore.list; }
function setUploadList(next) {
  uploadStore.list = next;
  for (const fn of uploadStore.listeners) { try { fn(); } catch {} }
}
function patchUpload(id, p) { setUploadList(uploadStore.list.map((u) => (u.id === id ? { ...u, ...p } : u))); }
// Warn before closing the tab while files are still uploading.
function beforeUnloadGuard(e) {
  if (uploadStore.list.some((u) => u.status === "queued" || u.status === "uploading" || u.status === "waiting")) { e.preventDefault(); e.returnValue = ""; }
}
if (typeof window !== "undefined") window.addEventListener("beforeunload", beforeUnloadGuard);

// Same-name check before uploading: queued files whose name is already taken
// in their folder wait for the popup ("waiting") while the rest keep going.
async function checkSameNames() {
  const todo = uploadStore.list.filter((u) => u.status === "queued" && !u.checked);
  if (!todo.length) return;
  setUploadList(uploadStore.list.map((u) => (todo.includes(u) ? { ...u, checked: true } : u)));
  const byFolder = new Map();
  for (const u of todo) { if (!byFolder.has(u.folder)) byFolder.set(u.folder, []); byFolder.get(u.folder).push(u); }
  for (const [folder, list] of byFolder) {
    let existing = {};
    try {
      const r = await fetch("/api/media/upload/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder, paths: list.map((u) => u.relPath) }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok && j.existing) existing = j.existing;
    } catch { /* can't check: the server keeps both (never overwrites) */ }
    for (const u of list) {
      const hit = existing[u.relPath];
      if (!hit) continue;
      const cur = uploadStore.list.find((x) => x.id === u.id);
      if (!cur || cur.status !== "queued") continue;
      patchUpload(u.id, { status: "waiting" });
      const relDir = u.relPath.includes("/") ? u.relPath.slice(0, u.relPath.lastIndexOf("/")) : "";
      askSameName({
        kind: "upload",
        name: hit.name,
        folder: [folder, relDir].filter(Boolean).join("/"),
        existing: { size: hit.size, mtime: hit.mtime },
        incoming: { size: u.size, mtime: u.file && u.file.lastModified },
      }).then((choice) => {
        const now = uploadStore.list.find((x) => x.id === u.id);
        if (!now || now.status !== "waiting") return;
        if (choice === "skip") patchUpload(u.id, { status: "skipped" });
        else patchUpload(u.id, { status: "queued", conflict: choice });
        pumpUploads();
      });
    }
  }
}

async function pumpUploads() {
  if (uploadStore.running) return;
  uploadStore.running = true;
  try {
    for (;;) {
      await checkSameNames();
      const next = uploadStore.list.find((u) => u.status === "queued");
      if (!next) break;
      patchUpload(next.id, { status: "uploading", loaded: 0 });
      const res = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        uploadStore.xhrs.set(next.id, xhr);
        const qs = new URLSearchParams();
        if (next.folder) qs.set("folder", next.folder);
        qs.set("path", next.relPath);
        if (next.conflict === "replace") qs.set("conflict", "replace");
        xhr.open("POST", `/api/media/upload?${qs.toString()}`);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        // Actions need the session header (cookie alone is refused: CSRF).
        try { const st = localStorage.getItem("xdl_session_token"); if (st) xhr.setRequestHeader("x-xdl-session", st); } catch {}
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) patchUpload(next.id, { loaded: e.loaded }); };
        xhr.onload = () => {
          let j = null;
          try { j = JSON.parse(xhr.responseText); } catch {}
          if (xhr.status >= 200 && xhr.status < 300 && j && j.ok) resolve({ ok: true, j });
          else resolve({ ok: false, error: (j && j.error) || `upload failed (${xhr.status})` });
        };
        xhr.onerror = () => resolve({ ok: false, error: "network error" });
        xhr.onabort = () => resolve({ ok: false, cancelled: true });
        xhr.send(next.file);
      });
      uploadStore.xhrs.delete(next.id);
      if (res.ok) {
        patchUpload(next.id, { status: "done", loaded: next.size, savedAs: res.j.rel, locked: !!res.j.locked });
        try { if (uploadStore.onDone) uploadStore.onDone(); } catch {}
      } else if (res.cancelled) {
        patchUpload(next.id, { status: "cancelled" });
      } else {
        patchUpload(next.id, { status: "error", error: res.error });
      }
    }
  } finally {
    uploadStore.running = false;
    // Queue drained and nothing waiting: "do the same for the rest" resets.
    if (!uploadStore.list.some((u) => u.status === "queued" || u.status === "uploading" || u.status === "waiting")) endSameNameBatch("upload");
  }
}
function enqueueUploadEntries(entries, folder) {
  const add = (entries || []).filter((e) => e && e.file).map((e) => ({
    id: ++uploadSeq,
    file: e.file,
    relPath: e.relPath || e.file.name,
    folder: folder || "",
    size: e.file.size,
    loaded: 0,
    status: "queued",
    error: null,
  }));
  if (!add.length) return;
  setUploadList([...uploadStore.list, ...add]);
  setTimeout(() => pumpUploads(), 0);
}
function cancelUploadById(id) {
  const x = uploadStore.xhrs.get(id);
  if (x) { try { x.abort(); } catch {} return; }
  setUploadList(uploadStore.list.map((u) => (u.id === id && (u.status === "queued" || u.status === "waiting") ? { ...u, status: "cancelled" } : u)));
}
function cancelAllUploadEntries() {
  setUploadList(uploadStore.list.map((u) => (u.status === "queued" || u.status === "waiting" ? { ...u, status: "cancelled" } : u)));
  for (const x of uploadStore.xhrs.values()) { try { x.abort(); } catch {} }
}
function clearFinishedUploads() {
  setUploadList(uploadStore.list.filter((u) => u.status === "queued" || u.status === "uploading" || u.status === "waiting"));
}

// POST to a vault route; throws the server's message on failure.
export async function vaultCall(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw Object.assign(new Error(j.error || `request failed (${r.status})`), { code: j.code || null, status: r.status });
  return j;
}

export function useMediaTasks({ onFilesChanged } = {}) {
  const changedRef = useRef(onFilesChanged);
  changedRef.current = onFilesChanged;
  const refreshTimer = useRef(null);
  // Debounced listing refresh so a burst of uploads reloads the grid once.
  const notifyChanged = useCallback((delay = 600) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      try { if (changedRef.current) changedRef.current(); } catch {}
    }, delay);
  }, []);
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  // ---- vault status ----
  const [vault, setVault] = useState(null);
  const refreshVault = useCallback(async () => {
    try {
      const r = await fetch("/api/vault/status", { cache: "no-store" });
      const j = await r.json();
      if (j && j.ok) setVault(j);
    } catch {}
  }, []);
  useEffect(() => { refreshVault(); }, [refreshVault]);

  // ---- uploads (module-level store: survives leaving the Media page) ----
  const uploads = useSyncExternalStore(subscribeUploads, getUploads);
  useEffect(() => {
    const onDone = () => notifyChanged();
    uploadStore.onDone = onDone;
    return () => { if (uploadStore.onDone === onDone) uploadStore.onDone = null; };
  }, [notifyChanged]);
  const enqueueUploads = enqueueUploadEntries;
  const cancelUpload = cancelUploadById;
  const cancelAllUploads = cancelAllUploadEntries;
  const clearUploads = clearFinishedUploads;

  // ---- lock jobs ----
  const [lockJob, setLockJob] = useState(null);
  const pollRef = useRef(null);
  const lastDoneRef = useRef(0);
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/media/lock/job", { cache: "no-store" });
      const j = await r.json();
      const job = j && j.job;
      setLockJob(job || null);
      if (!job || job.status !== "running") {
        stopPoll();
        notifyChanged(100);
        refreshVault();
      } else if (job.done - lastDoneRef.current >= 40) {
        lastDoneRef.current = job.done;
        notifyChanged(0);
      }
    } catch {}
  }, [notifyChanged, refreshVault]);
  const startPoll = useCallback(() => {
    stopPoll();
    lastDoneRef.current = 0;
    pollRef.current = setInterval(poll, 700);
  }, [poll]);
  useEffect(() => {
    // Pick up a job that is still running from before a reload.
    fetch("/api/media/lock/job", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (j && j.job && j.job.status === "running") { setLockJob(j.job); startPoll(); }
    }).catch(() => {});
    return stopPoll;
  }, [startPoll]);

  const startLock = useCallback(async ({ action, keys = [], dirs = [] }) => {
    const r = await fetch("/api/media/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, folder: "", keys, dirs }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `${action} failed`);
    setLockJob(j.job);
    startPoll();
    return j.job;
  }, [startPoll]);
  const cancelLock = useCallback(async () => {
    try { await fetch("/api/media/lock/cancel", { method: "POST" }); } catch {}
  }, []);
  const dismissLock = useCallback(() => setLockJob((j) => (j && j.status === "running" ? j : null)), []);

  // body: { password } or { pattern }
  const unlockVault = useCallback(async (body) => {
    const j = await vaultCall("/api/vault/unlock", body);
    setVault(j);
    notifyChanged(0);
    return j;
  }, [notifyChanged]);

  return { vault, refreshVault, unlockVault, uploads, enqueueUploads, cancelUpload, cancelAllUploads, clearUploads, lockJob, startLock, cancelLock, dismissLock };
}

// Expand a drop's DataTransfer into [{ file, relPath }], walking dropped
// folders (relPath keeps the folder structure, e.g. "trip/day1/a.jpg").
export async function filesFromDataTransfer(dt) {
  if (!dt) return [];
  const items = Array.from(dt.items || []);
  // Entries must be taken synchronously, before the first await.
  const entries = items.map((it) => (it.kind === "file" && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
  if (!entries.some(Boolean)) return Array.from(dt.files || []).map((file) => ({ file, relPath: file.name }));
  const out = [];
  const fileOf = (entry) => new Promise((resolve) => entry.file(resolve, () => resolve(null)));
  const readAll = (dir) => new Promise((resolve) => {
    const reader = dir.createReader();
    const acc = [];
    const step = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(acc);
      acc.push(...batch);
      step();
    }, () => resolve(acc));
    step();
  });
  const walk = async (entry, prefix, depth) => {
    if (!entry || depth > 16 || out.length > 20000) return;
    if (entry.name.startsWith(".")) return;
    if (entry.isFile) {
      const f = await fileOf(entry);
      if (f) out.push({ file: f, relPath: prefix ? `${prefix}/${entry.name}` : entry.name });
    } else if (entry.isDirectory) {
      const kids = await readAll(entry);
      for (const k of kids) await walk(k, prefix ? `${prefix}/${entry.name}` : entry.name, depth + 1);
    }
  };
  for (const e of entries) await walk(e, "", 0);
  return out;
}

export function isOsFileDrag(e) {
  const types = e && e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function Bar({ pct, tone }) {
  return (
    <div style={{ height: 4, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: "100%", background: tone || "var(--accent, #6366f1)", transition: "width .2s" }} />
    </div>
  );
}

// `thumbGen` (optional): { busy, progress, result, onOpen, onDismiss } — the
// Shift+G thumbnail run, shown here while its popup is closed.
export function MediaTasksPanel({ tasks, thumbGen }) {
  const [collapsed, setCollapsed] = useState(false);
  if (!tasks) return null;
  const { uploads, lockJob } = tasks;
  const tg = thumbGen && (thumbGen.busy || thumbGen.result) ? thumbGen : null;
  if (!uploads.length && !lockJob && !tg) return null;
  const tgRunning = !!(tg && tg.busy);
  const tgP = tg && tg.progress;
  const tgPct = tgRunning ? (tgP && tgP.total ? (tgP.index / tgP.total) * 100 : 0) : 100;
  const active = uploads.filter((u) => u.status === "queued" || u.status === "uploading" || u.status === "waiting");
  const done = uploads.filter((u) => u.status === "done").length;
  const failed = uploads.filter((u) => u.status === "error").length;
  const totalBytes = uploads.reduce((s, u) => s + (u.status === "cancelled" || u.status === "skipped" ? 0 : u.size), 0);
  const sentBytes = uploads.reduce((s, u) => s + (u.status === "done" ? u.size : u.status === "uploading" ? u.loaded : 0), 0);
  const lockRunning = lockJob && lockJob.status === "running";
  const lockPct = lockJob && lockJob.total ? ((lockJob.done + lockJob.skipped + lockJob.failed) / lockJob.total) * 100 : lockRunning ? 0 : 100;
  const verb = lockJob && lockJob.action === "unlock" ? "Decrypting" : "Encrypting";
  const verbDone = lockJob && lockJob.action === "unlock" ? "Decrypted" : "Encrypted";
  return (
    <div data-testid="media-tasks-panel" style={{ position: "fixed", right: 16, bottom: 16, zIndex: 130, width: "min(360px, calc(100vw - 32px))", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,.3)", fontSize: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: collapsed ? "none" : "1px solid var(--border)" }}>
        <i className={`bi ${lockRunning ? "bi-shield-lock" : active.length ? "bi-cloud-arrow-up" : tgRunning ? "bi-images" : "bi-check2-circle"}`} style={{ color: "var(--accent, #6366f1)" }} />
        <span style={{ fontWeight: 700, flex: 1 }}>
          {lockRunning ? `${verb} ${lockJob.label}…` : tgRunning && !active.length ? (tgP && tgP.total ? `Generating thumbnails ${tgP.index} of ${tgP.total}` : "Generating thumbnails…") : active.length ? `Uploading ${done + 1 > uploads.length ? uploads.length : done + 1} of ${uploads.filter((u) => u.status !== "cancelled").length}` : "Tasks finished"}
        </span>
        <button type="button" className="btn btn-sm btn-link" style={{ padding: "0 4px", color: "var(--muted)" }} onClick={() => setCollapsed((v) => !v)} title={collapsed ? "Expand" : "Collapse"}><i className={`bi ${collapsed ? "bi-chevron-up" : "bi-chevron-down"}`} /></button>
        {!lockRunning && !active.length && !tgRunning && (
          <button type="button" data-testid="media-tasks-close" className="btn btn-sm btn-link" style={{ padding: "0 4px", color: "var(--muted)" }} onClick={() => { tasks.clearUploads(); tasks.dismissLock(); if (tg && tg.onDismiss) tg.onDismiss(); }} title="Close"><i className="bi bi-x-lg" /></button>
        )}
      </div>
      {!collapsed && (
        <div style={{ maxHeight: 280, overflowY: "auto", padding: "6px 10px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
          {tg && (
            <div data-testid="media-tasks-thumbgen" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <i className="bi bi-images" />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: tg.onOpen ? "pointer" : undefined }} title={(tgP && tgP.file) || "Open thumbnail generator"} onClick={tg.onOpen}>
                  {tgRunning
                    ? ((tgP && tgP.file) || "Preparing…")
                    : tg.result.ok
                      ? `Thumbnails: ${tg.result.generated} generated${tg.result.skipped ? ` · ${tg.result.skipped} skipped` : ""}`
                      : `Thumbnails failed: ${tg.result.error || "unknown error"}`}
                </span>
                {tgP && tgP.total > 0 && <span style={{ color: "var(--muted)" }}>{tgRunning ? tgP.index : tgP.total}/{tgP.total}</span>}
              </div>
              <Bar pct={tgPct} tone={(tg.result && !tg.result.ok) || (tg.result ? tg.result.failed : tgP && tgP.failed) ? "#f59e0b" : undefined} />
              {((tg.result && tg.result.ok && tg.result.failed > 0) || (tgRunning && tgP && tgP.failed > 0)) && (
                <div style={{ color: "#f87171" }}>{tg.result ? tg.result.failed : tgP.failed} failed</div>
              )}
            </div>
          )}
          {lockJob && (
            <div data-testid="media-tasks-lock" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <i className={`bi ${lockJob.action === "unlock" ? "bi-unlock" : "bi-lock-fill"}`} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={lockJob.current || ""}>
                  {lockRunning ? (lockJob.current || "Preparing…") : `${verbDone} ${lockJob.done} file${lockJob.done === 1 ? "" : "s"}${lockJob.skipped ? ` · ${lockJob.skipped} already ${lockJob.action === "unlock" ? "decrypted" : "encrypted"}` : ""}${lockJob.status === "cancelled" ? " · cancelled" : ""}`}
                </span>
                <span style={{ color: "var(--muted)" }}>{lockJob.done + lockJob.skipped + lockJob.failed}/{lockJob.total}</span>
                {lockRunning && <button type="button" className="btn btn-sm btn-link" style={{ padding: "0 4px", color: "#f87171" }} onClick={tasks.cancelLock} title="Stop"><i className="bi bi-stop-circle" /></button>}
              </div>
              <Bar pct={lockPct} tone={lockJob.failed ? "#f59e0b" : undefined} />
              {lockJob.failed > 0 && (
                <div style={{ color: "#f87171" }}>{lockJob.failed} failed{lockJob.errors && lockJob.errors[0] ? ` — ${lockJob.errors[0].file || ""}: ${lockJob.errors[0].error}` : ""}</div>
              )}
            </div>
          )}
          {uploads.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {uploads.length > 1 && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--muted)" }}>
                  <span style={{ flex: 1 }}>{fmtBytes(sentBytes)} / {fmtBytes(totalBytes)}{failed ? ` · ${failed} failed` : ""}</span>
                  {active.length > 0 && <button type="button" className="btn btn-sm btn-link" style={{ padding: 0, color: "#f87171", fontSize: 11 }} onClick={tasks.cancelAllUploads}>Cancel all</button>}
                </div>
              )}
              {uploads.slice(-200).map((u) => (
                <div key={u.id} data-testid="media-upload-row" data-status={u.status} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <i className={`bi ${u.status === "done" ? (u.locked ? "bi-lock-fill" : "bi-check-circle") : u.status === "error" ? "bi-exclamation-circle" : u.status === "cancelled" || u.status === "skipped" ? "bi-slash-circle" : u.status === "waiting" ? "bi-question-circle" : "bi-arrow-up-circle"}`} style={{ color: u.status === "error" ? "#f87171" : u.status === "done" ? "#10b981" : "var(--muted)" }} />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u.error || u.savedAs || u.relPath}>{u.relPath}</span>
                    <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{u.status === "uploading" ? `${Math.round((u.loaded / Math.max(1, u.size)) * 100)}%` : u.status === "error" ? "failed" : u.status === "queued" ? fmtBytes(u.size) : u.status === "waiting" ? "name taken — waiting for you" : u.status}</span>
                    {(u.status === "queued" || u.status === "uploading" || u.status === "waiting") && <button type="button" className="btn btn-sm btn-link" style={{ padding: "0 2px", color: "var(--muted)" }} onClick={() => tasks.cancelUpload(u.id)} title="Cancel"><i className="bi bi-x" /></button>}
                  </div>
                  {u.status === "uploading" && <Bar pct={(u.loaded / Math.max(1, u.size)) * 100} />}
                  {u.status === "error" && <div style={{ color: "#f87171", paddingLeft: 20 }}>{u.error}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Light frame + label while files from the computer are dragged over the
// page (no blur, so the folders stay visible as drop targets). Over a folder
// the label names that folder; elsewhere uploads go to the open folder.
export function UploadDropOverlay({ visible, folder, onFolder, encrypt }) {
  if (!visible) return null;
  return (
    <div data-testid="media-drop-overlay" style={{ position: "fixed", inset: 0, zIndex: 140, pointerEvents: "none", border: "3px dashed rgba(99,102,241,.8)", borderRadius: 12, background: "rgba(99,102,241,.06)" }}>
      <div style={{ position: "absolute", left: "50%", bottom: 24, transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 10, padding: "10px 18px", borderRadius: 999, color: "#fff", background: "rgba(30,32,60,.92)", boxShadow: "0 8px 24px rgba(0,0,0,.3)", whiteSpace: "nowrap", maxWidth: "calc(100vw - 32px)", overflow: "hidden", textOverflow: "ellipsis" }}>
        <i className={`bi ${onFolder ? "bi-folder-symlink" : "bi-cloud-arrow-up"}`} style={{ fontSize: 20 }} />
        <span style={{ fontWeight: 700, fontSize: 14 }}>Drop to upload into {folder ? `“${folder}”` : "Media (root)"}</span>
        <span style={{ fontSize: 12, opacity: 0.8 }}>{encrypt ? "encrypted · " : ""}{onFolder ? "" : "or drop on a folder"}</span>
      </div>
    </div>
  );
}

// Shown while encrypted media is locked (after a restart without a login
// that opened it, idle auto-lock, or Lock now): unlock with the panel
// password or, once it seals a vault slot, the pattern.
export function VaultLockedBanner({ tasks }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showPad, setShowPad] = useState(null); // null = follow preferLogin
  const v = tasks && tasks.vault;
  if (!v || !v.exists || v.unlocked) return null;
  if (v.needsRestore) {
    // Fresh install on an encrypted drive, wizard skipped: nothing to type
    // here — the restore happens in the welcome wizard.
    const reopen = () => {
      try { localStorage.removeItem("xdl_setup_skipped"); } catch {}
      window.location.reload();
    };
    return (
      <div data-testid="media-vault-restore" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 12px", marginBottom: 8, borderRadius: 10, border: "1px solid rgba(245,158,11,.45)", background: "rgba(245,158,11,.12)", fontSize: 12 }}>
        <i className="bi bi-shield-lock-fill" style={{ color: "#f59e0b", fontSize: 16 }} />
        <span style={{ flex: "1 1 220px" }}><b>Some files on this drive are encrypted.</b> They open with the password you used before — it also becomes your panel password here.</span>
        <button type="button" data-testid="vault-restore" className="btn btn-sm btn-warning" style={{ height: 28 }} onClick={reopen}><i className="bi bi-unlock" /> Restore my files</button>
      </div>
    );
  }
  const patternOk = !!(v.hasPattern && v.patternSlot);
  const padOpen = patternOk && (showPad === null ? v.preferLogin === "pattern" : showPad);
  const done = () => setTimeout(() => window.location.reload(), 300); // re-fetch failed (423) thumbnails
  const submit = async (e) => {
    e.preventDefault();
    if (!pw) return;
    setBusy(true); setErr("");
    try { await tasks.unlockVault({ password: pw }); setPw(""); done(); } catch (x) { setErr(x.message || String(x)); } finally { setBusy(false); }
  };
  return (
    <form data-testid="media-vault-locked" onSubmit={submit} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 12px", marginBottom: 8, borderRadius: 10, border: "1px solid rgba(245,158,11,.45)", background: "rgba(245,158,11,.12)", fontSize: 12 }}>
      <i className="bi bi-shield-lock-fill" style={{ color: "#f59e0b", fontSize: 16 }} />
      <span style={{ flex: "1 1 220px" }}>
        <b>Encrypted media is locked.</b> {patternOk ? "Enter your password or draw your pattern." : "Enter your password to view locked files."} New downloads are still encrypted while locked.{v.error ? ` (${v.error})` : ""}
      </span>
      {patternOk && <button type="button" data-testid="vault-use-pattern" className="btn btn-sm btn-outline-warning" style={{ height: 28 }} onClick={() => setShowPad(!padOpen)}><i className="bi bi-grid-3x3-gap" /> {padOpen ? "Hide pattern" : "Use pattern"}</button>}
      <input type="password" className="form-control form-control-sm" style={{ width: 180, height: 28 }} placeholder="Panel password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
      <button type="submit" className="btn btn-sm btn-warning" disabled={busy || !pw} style={{ height: 28 }}>{busy ? "…" : "Unlock"}</button>
      {err && <span style={{ color: "#f87171", flexBasis: "100%" }}>{err}</span>}
      {padOpen && (
        <div style={{ flexBasis: "100%", display: "flex", justifyContent: "center", paddingTop: 6 }}>
          <PatternPad size={5} minDots={8} px={240} hint="Draw your pattern" testId="vault-unlock-pattern" onComplete={async (p) => { await tasks.unlockVault({ pattern: p }); done(); }} />
        </div>
      )}
    </form>
  );
}
