import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueue } from "../store/QueueContext";
import FileViewer from "../components/FileViewer";

function toMediaUrl(fp) {
  if (!fp) return "";
  const s = String(fp);
  const idx = s.indexOf("/media/");
  if (idx !== -1) return s.slice(idx);
  return s;
}
function deriveTitle(url, filePath) {
  if (filePath) {
    const base = String(filePath).split("/").pop() || "";
    return base.replace(/-\d+\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim() || url;
  }
  try {
    const u = new URL(url);
    if (u.hostname.includes("pornhub") && u.pathname.includes("view_video")) {
      const key = u.searchParams.get("viewkey");
      return key ? `Pornhub • ${key.slice(0, 16)}` : "Pornhub video";
    }
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    if (seg.toLowerCase() === "view_video.php") return `${u.hostname.replace(/^www\./, "")} • ${seg}`;
    const decoded = decodeURIComponent(seg).replace(/[-_]+/g, " ").trim();
    if (decoded.length > 3) return decoded.length > 60 ? decoded.slice(0, 60) + "…" : decoded;
    return u.hostname.replace(/^www\./, "") + u.pathname.slice(0, 40);
  } catch { return url; }
}
function fileCategoryFromPath(fp) {
  const ext = String(fp || "").split(".").pop()?.toLowerCase() || "";
  if (/^(mp4|webm|mkv|mov|m4v|avi|mpg|mpeg|3gp|flv|ts|m3u8)$/i.test(ext)) return "video";
  if (/^(jpg|jpeg|png|gif|webp|bmp|avif)$/i.test(ext)) return "image";
  if (/^(mp3|m4a|aac|ogg|wav|flac|opus)$/i.test(ext)) return "audio";
  return "other";
}
function stageLabel(stage, pct) {
  const map = { queued: "Queued", browser: "Starting browser", navigating: "Opening page", capturing: "Capturing media", extracting: "Extracting", downloading: "Downloading", muxing: "Muxing", done: "Done", error: "Failed" };
  return `${map[stage] || stage} ${pct != null ? `· ${pct}%` : ""}`;
}
function barBackground(stage) {
  switch (stage) {
    case "browser":
    case "navigating":
    case "capturing":
    case "extracting":
      return "linear-gradient(90deg,#f59e0b,#f97316)"; // amber — internal navigation / prep (5→55%)
    case "downloading":
    case "muxing":
      return "linear-gradient(90deg,#6366f1,#8b5cf6)"; // violet — actual file download (70→100%)
    case "queued":
      return "#475569";
    case "done":
      return "#22c55e";
    case "error":
      return "#ef4444";
    default:
      return "linear-gradient(90deg,#6366f1,#8b5cf6)";
  }
}
const GAP_FULL = /^\d+(?:\.\d+)?[ms]$/i;
function parseGapText(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return 0;
  const m = t.match(/^(\d+(?:\.\d+)?)([ms])$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Math.round(m[2].toLowerCase() === "s" ? n * 1000 : n * 60000);
}
function fmtGapMs(ms) {
  if (!ms || ms <= 0) return "";
  return ms % 60000 === 0 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`;
}

export default function Dashboard() {
  const { active, completed, logsById, gap, gapWait, setGap, add, remove, retry, clearCompleted, clearActive } = useQueue();
  const [urls, setUrls] = useState("");
  const [folder, setFolder] = useState(() => { try { return localStorage.getItem("xdl_dash_folder") || ""; } catch { return ""; } });
  const [folderOptions, setFolderOptions] = useState([]);
  const [maxQuality, setMaxQuality] = useState(() => { try { return localStorage.getItem("xdl_dash_maxQuality") || ""; } catch { return ""; } });
  const [account, setAccount] = useState(() => { try { return localStorage.getItem("xdl_dash_account") || ""; } catch { return ""; } });
  const [accountOptions, setAccountOptions] = useState([]);
  useEffect(() => { try { localStorage.setItem("xdl_dash_folder", folder); } catch {} }, [folder]);
  useEffect(() => { try { localStorage.setItem("xdl_dash_maxQuality", maxQuality); } catch {} }, [maxQuality]);
  useEffect(() => { try { localStorage.setItem("xdl_dash_account", account); } catch {} }, [account]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [gapMin, setGapMin] = useState("");
  const [gapMax, setGapMax] = useState("");
  const [gapErr, setGapErr] = useState("");
  const [viewerFile, setViewerFile] = useState(null);
  const lastViewedRef = useRef(null);
  const lastHighlightedDashRef = useRef(null);
  const persistHighlightDash = (id) => {
    if (lastHighlightedDashRef.current && lastHighlightedDashRef.current !== id) {
      const prev = document.getElementById(`dash-file-${lastHighlightedDashRef.current}`);
      if (prev) { prev.style.background = ""; prev.removeAttribute("data-highlighted"); }
    }
    const el = document.getElementById(`dash-file-${id}`);
    if (el) { el.style.background = "rgba(99,102,241,0.14)"; el.setAttribute("data-highlighted", "true"); }
    lastHighlightedDashRef.current = id;
  };
  useEffect(() => {
    if (gap?.maxMs > 0) {
      setGapMin(fmtGapMs(gap.minMs));
      setGapMax(fmtGapMs(gap.maxMs));
    }
  }, [gap?.minMs, gap?.maxMs]);
  const saveGap = () => {
    const mn = parseGapText(gapMin), mx = parseGapText(gapMax);
    if (mn === null || mx === null) { setGapErr("Use format: 90s or 5m"); return; }
    setGapErr("");
    let a = Math.max(0, mn), b = Math.max(0, mx);
    if (a > 0 && b <= 0) b = a;
    if (b < a) { const t = a; a = b; b = t; }
    setGap(a, b).catch(() => {});
  };
  const clearGap = () => { setGapMin(""); setGapMax(""); setGapErr(""); setGap(0, 0).catch(() => {}); };
  const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
  const firstQueuedId = active.find((i) => i.status === "queued")?.id;
  const [displayGapWait, setDisplayGapWait] = useState(null);
  useEffect(() => {
    if (gapWait?.waiting) setDisplayGapWait(gapWait);
    else {
      const t = setTimeout(() => setDisplayGapWait(null), 800);
      return () => clearTimeout(t);
    }
  }, [gapWait]);

  useEffect(() => {
    fetch("/api/media").then((r) => r.json()).then((j) => {
      if (j.ok && Array.isArray(j.items)) {
        const dirs = j.items.filter((it) => it.dir).map((it) => it.name);
        setFolderOptions(dirs);
      }
    }).catch(() => {});
    fetch("/accounts").then((r) => r.json()).then((j) => {
      if (j.ok && Array.isArray(j.accounts)) setAccountOptions(j.accounts.map((a) => a.name));
    }).catch(() => {});
  }, []);

  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "completed" ? "completed" : "active";
  const setTab = (v) => setSearchParams(v === "active" ? {} : { tab: v }, { replace: true });
  const total = active.length + completed.length;
  const done = completed.filter((i) => i.status === "done").length;
  const pct = total ? Math.round((done / Math.max(1, total)) * 100) : 0;

  const onAdd = async (e) => {
    e.preventDefault();
    const list = urls.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) { setErr("Add at least one URL"); return; }
    setErr(""); setBusy(true);
    try {
      await add(list, folder, maxQuality || null, account || null);
      setUrls("");
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="hero-download" style={{ marginBottom: 18 }}>
        <div className="hero-inner">
          <form onSubmit={onAdd}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Add videos</div>
              <span className="badge text-bg-primary"><i className="bi bi-lightning-charge" /> Auto-queue</span>
            </div>
            <label className="form-label">Video URLs — one per line</label>
            <textarea className="form-control" rows={3} placeholder={"https://www.instagram.com/reel/XXXX\nhttps://www.xvideos.com/video1234/title"} value={urls} onChange={(e) => setUrls(e.target.value)} />
            <div className="row g-2" style={{ marginTop: 12, alignItems: "end" }}>
              <div className="col" style={{ flex: "1 1 0", minWidth: 110 }}>
                <label className="form-label"><i className="bi bi-folder2" /> Folder</label>
                <input className="form-control" type="text" list="folder-list" placeholder="e.g. instagram / favorites" value={folder} onChange={(e) => setFolder(e.target.value)} />
                <datalist id="folder-list">
                  {folderOptions.map((n) => <option key={n} value={n} />)}
                </datalist>
              </div>
              <div className="col" style={{ flex: "1 1 0", minWidth: 110 }}>
                <label className="form-label"><i className="bi bi-badge-hd" /> Max quality</label>
                <select className="form-control" value={maxQuality} onChange={(e) => setMaxQuality(e.target.value)}>
                  <option value="">Best (auto)</option>
                  <option value="1080">1080p (max)</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                  <option value="360">360p</option>
                  <option value="240">240p</option>
                </select>
              </div>
              <div className="col" style={{ flex: "1 1 0", minWidth: 110 }}>
                <label className="form-label"><i className="bi bi-person" /> Profile</label>
                <select className="form-control" value={account} onChange={(e) => setAccount(e.target.value)}>
                  <option value="">Default</option>
                  {accountOptions.filter((n) => n !== "default").map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div className="col" style={{ flex: "0 0 auto" }}>
                <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}><i className="bi bi-plus-lg" /> Add to queue</button>
              </div>
            </div>
            {err && <div className="status-text" style={{ color: "var(--danger)", marginTop: 8 }}>{err}</div>}
          </form>
        </div>
      </div>

      <style>{`@media (max-width: 640px){
  .dash-top{ flex-wrap: wrap !important; gap: 4px !important; padding-bottom: 6px !important; }
  .dash-top .btn{ padding: 3px 6px !important; font-size: 10px !important; }
  .dash-top .form-control-sm{ width: 44px !important; font-size: 10px !important; padding: 3px 4px !important; }
  .dash-top .badge{ font-size: 9px !important; padding: 1px 4px !important; }
  .content{ padding: 10px 8px !important; }
  .hero-inner{ padding: 12px !important; }
  .hero-download{ margin-bottom: 10px !important; }
  .card-body{ padding: 10px !important; }
  .queue-card{ padding: 8px 10px !important; }
  .view-title{ font-size: 18px !important; }
}`}</style>
      <div className="dash-top" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, borderBottom: "1px solid var(--border)", paddingBottom: 10, flexWrap: "wrap" }}>
        <button className={`btn btn-sm ${tab === "active" ? "btn-primary" : "btn-outline-secondary"}`} style={{ height: 30 }} onClick={() => setTab("active")}>
          <i className="bi bi-collection-play" /> Active{active.length ? <span style={{ fontSize: 11, opacity: 0.85 }}>({active.filter((i) => i.status === "running").length}/{active.filter((i) => i.status === "queued").length})</span> : null}
        </button>
        <button className={`btn btn-sm ${tab === "completed" ? "btn-primary" : "btn-outline-secondary"}`} style={{ height: 30 }} onClick={() => setTab("completed")}>
          <i className="bi bi-check2-all" /> Completed{(() => { const d = completed.filter((i) => i.status === "done").length, e = completed.filter((i) => i.status === "error").length; if (!d && !e) return null; return <span style={{ fontSize: 11, opacity: 0.85 }}>({d}/{e})</span>; })()}
        </button>
        <span style={{ flex: 1, minWidth: 12 }} />
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", flexWrap: "nowrap", flexShrink: 0 }}>
          <span className="small" style={{ color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }} title="Wait between downloads — same values = fixed, different = random range. Format: 90s or 5m"><i className="bi bi-hourglass-split" /> Gap</span>
        <div style={{ position: "relative", display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
          <input type="text" className={`form-control form-control-sm ${gapErr ? "is-invalid" : ""}`} style={{ width: 56, height: 30, borderTopRightRadius: 0, borderBottomRightRadius: 0, padding: "4px 8px", fontSize: 12 }} value={gapMin} placeholder="5m" onChange={(e) => { if (gapErr) setGapErr(""); setGapMin(e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter") saveGap(); }} />
          <span className="small" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", height: 30, padding: "0 6px", border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--muted)", marginLeft: -1, fontSize: 11 }}>–</span>
          <input type="text" className={`form-control form-control-sm ${gapErr ? "is-invalid" : ""}`} style={{ width: 56, height: 30, borderRadius: 0, marginLeft: -1, padding: "4px 8px", fontSize: 12 }} value={gapMax} placeholder="15m" onChange={(e) => { if (gapErr) setGapErr(""); setGapMax(e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter") saveGap(); }} />
          <button type="button" className="btn btn-sm btn-outline-secondary" style={{ height: 30, ...(gap?.maxMs > 0 || gapMin || gapMax) ? { borderRadius: 0, marginLeft: -1 } : { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, marginLeft: -1 }} } onClick={saveGap} title="Apply gap"><i className="bi bi-check-lg" /></button>
          {(gap?.maxMs > 0 || gapMin || gapMax) && (
            <button type="button" className="btn btn-sm btn-outline-secondary" style={{ height: 30, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, marginLeft: -1 }} onClick={clearGap} title="Disable gap"><i className="bi bi-x-lg" /></button>
          )}
          {gapErr && (
            <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 6, background: "#2a1215", border: "1px solid #7f1d1d", color: "#fca5a5", padding: "6px 10px", borderRadius: 8, fontSize: 12, zIndex: 20, whiteSpace: "nowrap", boxShadow: "0 4px 16px rgba(0,0,0,.35)" }}>
              <i className="bi bi-exclamation-triangle" /> {gapErr}
            </div>
          )}
        </div>
          {tab === "active" && (
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={clearActive} disabled={!active.filter((i) => i.status !== "running").length} title="Clear queued items — running downloads are kept" style={{ height: 30 }}><i className="bi bi-x-lg" /> Clear</button>
          )}
          {tab === "completed" && (
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={clearCompleted} disabled={!completed.length} title="Clear entries only — files stay in /media" style={{ height: 30 }}><i className="bi bi-x-lg" /> Clear</button>
          )}
        </div>
      </div>

          {tab === "active" ? (
            <>
              <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 10 }}><span className="small fw-semibold">{total ? `${done} of ${total} done` : "No items yet"}</span><span style={{ flex: 1 }} /><span className="small" style={{ fontWeight: 700, color: "var(--accent)" }}>{pct}%</span></div>
                <div className="progress" style={{ marginTop: 8, height: 8 }}><div className="progress-bar" style={{ width: `${pct}%`, background: "linear-gradient(90deg,#6366f1,#8b5cf6)", transition: "width .3s" }} /></div>
                <div className="small" style={{ color: "var(--muted)", marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{active.length ? <><span>{active.filter((i) => i.status === "running").length} running · {active.filter((i) => i.status === "queued").length} queued</span>{displayGapWait?.waiting && <span style={{ color: "var(--text)", fontWeight: 600 }}><i className="bi bi-hourglass-split" style={{ marginRight: 4 }} />next in {fmtSecs(displayGapWait.remainingSec || 0)}{displayGapWait.paused ? " · paused" : ""}</span>}</> : "idle — add URLs above"}</div>
              </div>
              {active.length === 0 ? <div className="empty"><i className="bi bi-inbox" /> Queue is empty — paste URLs above.</div> : (
                <div style={{ display: "grid", gap: 10 }}>
                  {active.map((it) => (
                    <div key={it.id} className={`queue-card ${it.status}`} style={{ border: "1px solid var(--border)", background: "var(--surface)", boxShadow: "0 1px 2px rgba(0,0,0,.04)", borderRadius: 12 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span className={`badge ${it.status === "running" ? "text-bg-primary" : "text-bg-secondary"} badge-dot`}>{it.status}</span>
                    <span className="small" style={{ color: "var(--muted)" }}>{stageLabel(it.stage, it.pct)}</span>
                    {it.detail && <span className="small" style={{ color: "var(--faint)", marginLeft: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280, fontFamily: "var(--mono)", fontSize: 11 }}>{it.detail}</span>}
                    <span style={{ flex: 1 }} />
                    {it.status === "running" ? (
                      <button className="btn btn-sm btn-outline-secondary" disabled title="Running — cannot remove until it finishes or fails"><i className="bi bi-x-lg" /> Remove</button>
                    ) : (
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => remove(it.id)} title="Remove from queue"><i className="bi bi-x-lg" /> Remove</button>
                    )}
                      </div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={deriveTitle(it.url, it.filePath)}>{deriveTitle(it.url, it.filePath)}</div>
                  <div className="queue-url" style={{ marginTop: 2, fontSize: 11, color: "var(--faint)" }}>{it.url}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}><i className="bi bi-folder2" /> {it.folder || "—"}</div>
                  <div className="progress" style={{ height: 6, marginTop: 8 }}><div className="progress-bar" style={{ width: `${it.pct || 0}%`, background: barBackground(it.stage), transition: "width .4s ease, background .3s ease" }} /></div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {completed.length === 0 ? <div className="empty"><i className="bi bi-check-circle" /> Nothing completed yet.</div> : (
                <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
                  {completed.map((it) => (
                    <div key={it.id} id={`dash-file-${it.id}`} data-filepath={it.filePath} className={`queue-card ${it.status}`} style={{ overflow: "hidden", minWidth: 0, cursor: it.status === "done" && it.filePath ? "pointer" : "default" }} onClick={() => { if (it.status === "done" && it.filePath) { persistHighlightDash(it.id); setViewerFile(it); } }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span className={`badge ${it.status === "done" ? "text-bg-success" : "text-bg-danger"} badge-dot`}>{it.status}</span>
                        <span className="small" style={{ color: "var(--muted)" }}>{it.stage}</span>
                        <span style={{ flex: 1 }} />
                        {it.status === "error" && <button className="btn btn-sm btn-outline-secondary" onClick={(e) => { e.stopPropagation(); retry(it.id); }}><i className="bi bi-arrow-counterclockwise" /> Retry</button>}
                        <button className="btn btn-sm btn-outline-secondary" onClick={(e) => { e.stopPropagation(); remove(it.id); }} title="Remove entry only — keeps file in /media"><i className="bi bi-x-lg" /> Remove</button>
                      </div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={deriveTitle(it.url, it.filePath)}>{deriveTitle(it.url, it.filePath)}</div>
                  <div className="queue-url" style={{ marginTop: 2, fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%", display: "block" }} title={it.url}>{it.url}</div>
                  {it.status === "done" && it.filePath && (
                    <div className="small" style={{ marginTop: 6, padding: "8px 10px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", minWidth: 0 }}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); persistHighlightDash(it.id); setViewerFile(it); }}
                        style={{ width: "100%", textAlign: "left", background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--accent)", fontWeight: 600, fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6, overflow: "hidden", minWidth: 0 }}
                        title="Open viewer"
                      >
                        <i className="bi bi-play-circle" style={{ flexShrink: 0 }} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{toMediaUrl(it.filePath)}</span>
                      </button>
                    </div>
                  )}
                  {it.status === "done" && it.filePath && (
                    <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 4, fontFamily: "var(--mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%", display: "block" }} title={it.filePath}>Saved to: {it.filePath}</div>
                  )}
                  {it.status === "error" && <div className="small" style={{ color: "var(--danger)", marginTop: 4 }}>{it.error || "Failed"}</div>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
      {(() => {
        if (!viewerFile) return null;
        const viewable = completed.filter((c) => c.status === "done" && c.filePath);
        const curCat = fileCategoryFromPath(viewerFile.filePath);
        const sameViewable = viewable.filter((v) => fileCategoryFromPath(v.filePath) === curCat);
        const idx = sameViewable.findIndex((v) => v.id === viewerFile.id);
        const scrollAndHighlight = (el) => {
          if (!el) return;
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          const id = el.id?.startsWith("dash-file-") ? el.id.replace("dash-file-", "") : null;
          if (id) persistHighlightDash(id);
          else { el.style.background = "rgba(99,102,241,0.14)"; el.setAttribute("data-highlighted", "true"); }
        };
        if (idx === -1) return <FileViewer file={viewerFile} viewable={sameViewable} idx={-1} onClose={() => { lastViewedRef.current = viewerFile; setViewerFile(null); setTimeout(() => { const el = document.getElementById(`dash-file-${viewerFile.id}`); scrollAndHighlight(el); }, 80); }} onPrev={() => {}} onNext={() => {}} onGoto={() => {}} />;
        const handleClose = () => {
          const cur = viewerFile;
          lastViewedRef.current = cur;
          setViewerFile(null);
          setTimeout(() => {
            const el = cur?.id ? document.getElementById(`dash-file-${cur.id}`) : null;
            if (el) scrollAndHighlight(el);
            else if (cur?.filePath) { const esc = window.CSS?.escape ? window.CSS.escape(cur.filePath) : cur.filePath.replace(/"/g, '\\"'); const q = document.querySelector(`[data-filepath="${esc}"]`); scrollAndHighlight(q); }
          }, 80);
        };
        const handleDeleted = () => {
        };
        return (
          <FileViewer
            file={viewerFile}
            viewable={sameViewable}
            idx={idx}
            onClose={handleClose}
            onPrev={() => { if (idx > 0) { const p = sameViewable[idx - 1]; persistHighlightDash(p.id); setViewerFile(p); } }}
            onNext={() => { if (idx < sameViewable.length - 1) { const n = sameViewable[idx + 1]; persistHighlightDash(n.id); setViewerFile(n); } }}
            onGoto={(targetIdx) => { if (targetIdx >= 0 && targetIdx < sameViewable.length) { const item = sameViewable[targetIdx]; persistHighlightDash(item.id); setViewerFile(item); } }}
            onDeleted={handleDeleted}
          />
        );
      })()}
    </div>
  );
}
