import { useEffect, useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import FileViewer from "../components/FileViewer";

function fmtSize(bytes) {
  if (bytes == null) return "";
  const n = Number(bytes);
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function toMediaUrl(folder, name) {
  const base = folder ? `${folder.replace(/\/$/, "")}/${name}` : name;
  return `/media/${encodeURIComponent(base).replace(/%2F/g, "/")}`;
}
function timeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  if (!d) return "";
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}
function fileCategory(name) {
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  if (/^(mp4|webm|mkv|mov|m4v|avi|mpg|mpeg|3gp|flv|ts|m3u8)$/i.test(ext)) return "video";
  if (/^(jpg|jpeg|png|gif|webp|bmp|avif)$/i.test(ext)) return "image";
  if (/^(mp3|m4a|aac|ogg|wav|flac|opus)$/i.test(ext)) return "audio";
  return "other";
}

export default function Media() {
  const [searchParams, setSearchParams] = useSearchParams();
  const folder = searchParams.get("folder") || "";
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const filter = searchParams.get("q") || "";
  const setFilter = (v) => {
    const ns = new URLSearchParams(searchParams);
    if (v) ns.set("q", v);
    else ns.delete("q");
    setSearchParams(ns, { replace: true });
  };
  const [viewerIdx, setViewerIdx] = useState(null);
  const lastViewedNameRef = useRef(null);
  const lastHighlightedMediaRef = useRef(null);
  const persistHighlightMedia = (name) => {
    const n = name ? name.replace(/[^a-zA-Z0-9]/g, "-") : "";
    if (lastHighlightedMediaRef.current && lastHighlightedMediaRef.current !== n) {
      const prev = document.getElementById(`media-file-${lastHighlightedMediaRef.current}`);
      if (prev) { prev.style.background = ""; prev.removeAttribute("data-highlighted"); }
    }
    const el = n ? document.getElementById(`media-file-${n}`) : null;
    if (el) { el.style.background = "rgba(99,102,241,0.14)"; el.setAttribute("data-highlighted", "true"); }
    lastHighlightedMediaRef.current = n;
  };

  const load = async (f) => {
    setLoading(true); setErr("");
    try {
      const r = await fetch(`/api/media?folder=${encodeURIComponent(f)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "failed");
      setItems(j.items || []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(folder); }, [folder]);

  const crumbs = folder ? folder.split("/").filter(Boolean) : [];
  const filtered = (() => {
    let base = items;
    const raw = filter.trim();
    if (raw) {
      const isNeg = raw.startsWith("!");
      const term = (isNeg ? raw.slice(1).trim() : raw).toLowerCase();
      if (term) {
        base = items.filter((it) => {
          const hit = it.name.toLowerCase().includes(term);
          return isNeg ? !hit : hit;
        });
      }
    }
    return base.filter((it) => it.dir || fileCategory(it.name) === "video");
  })();

  const goFolder = (name) => {
    const ns = new URLSearchParams(searchParams);
    ns.set("folder", folder ? `${folder}/${name}` : name);
    setSearchParams(ns);
  };
  const goUp = () => {
    if (!folder) return;
    const parts = folder.split("/").filter(Boolean);
    parts.pop();
    const nf = parts.join("/");
    const ns = new URLSearchParams(searchParams);
    if (nf) ns.set("folder", nf); else ns.delete("folder");
    setSearchParams(ns);
  };
  const goCrumb = (idx) => {
    const nf = crumbs.slice(0, idx + 1).join("/");
    const ns = new URLSearchParams(searchParams);
    ns.set("folder", nf);
    setSearchParams(ns);
  };
  const delFile = async (name) => {
    if (!confirm(`Delete "${name}"? This removes the file from /media.`)) return;
    const r = await fetch(`/api/media?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) alert(j.error || "delete failed");
    else load(folder);
  };

  const viewable = filtered.filter((it) => !it.dir);
  const openViewer = (name) => {
    const idx = viewable.findIndex((it) => it.name === name);
    if (idx !== -1) { persistHighlightMedia(name); setViewerIdx(idx); }
  };
  // reset viewer if folder/filter changes and file disappears - keep on next file after delete
  useEffect(() => {
    if (viewerIdx != null && (viewerIdx < 0 || viewerIdx >= viewable.length)) {
      if (viewable.length) setViewerIdx(Math.min(viewerIdx, viewable.length - 1));
      else setViewerIdx(null);
    }
  }, [viewable.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}><i className="bi bi-collection-play" style={{ marginRight: 8 }} /> Media library</div>
        <span className="badge text-bg-secondary">{items.length} items</span>
        <span style={{ flex: 1 }} />
        <input className="form-control form-control-sm" style={{ maxWidth: 200, height: 31 }} placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn btn-sm btn-outline-secondary" style={{ height: 31, display: "inline-flex", alignItems: "center" }} onClick={() => load(folder)} disabled={loading}><i className="bi bi-arrow-clockwise" /> Refresh</button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        <button className="btn btn-sm btn-outline-secondary" onClick={() => { const ns = new URLSearchParams(searchParams); ns.delete("folder"); setSearchParams(ns); }} disabled={!folder}><i className="bi bi-house" /> Media</button>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--muted)" }}>/</span>
            <button className="btn btn-sm btn-outline-secondary" onClick={() => goCrumb(i)}>{c}</button>
          </span>
        ))}
        {folder && <button className="btn btn-sm btn-outline-secondary" onClick={goUp} style={{ marginLeft: 8 }}><i className="bi bi-arrow-90deg-up" /> Up</button>}
      </div>

      {err && <div className="card" style={{ padding: 12, color: "var(--danger)", marginBottom: 12 }}>{err}</div>}

      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 0, fontSize: 12, fontWeight: 700, color: "var(--muted)", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
            <span>Name</span><span>Size</span><span>Time</span><span style={{ marginLeft: 12 }}>Actions</span>
          </div>
          {loading ? <div style={{ padding: 20, color: "var(--muted)" }}>Loading…</div> : filtered.length === 0 ? <div className="empty" style={{ padding: 20 }}><i className="bi bi-inbox" /> No files — download something!</div> : (
            <div>
              {filtered.map((it) => (
                <div key={it.name} id={`media-file-${it.name.replace(/[^a-zA-Z0-9]/g, "-")}`} data-filename={it.name} style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 10, alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border)", background: it.dir ? "var(--surface-2)" : "var(--surface)", cursor: it.dir ? "pointer" : "pointer" }} onClick={() => { if (it.dir) goFolder(it.name); else openViewer(it.name); }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                    <i className={`bi ${it.dir ? "bi-folder-fill" : "bi-file-earmark-play"}`} style={{ color: it.dir ? "#f59e0b" : "var(--accent)" }} />
                    {it.dir ? (
                      <button onClick={(e) => { e.stopPropagation(); goFolder(it.name); }} title={it.name} style={{ background: "none", border: 0, color: "var(--text)", fontWeight: 600, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</button>
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); openViewer(it.name); }} title={`Open ${it.name}`} style={{ background: "none", border: 0, color: "var(--text)", fontWeight: 500, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: 0 }}>{it.name}</button>
                    )}
                  </div>
                  <span className="small" style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtSize(it.size)}</span>
                  <span className="small" style={{ color: "var(--muted)", whiteSpace: "nowrap" }} title={it.mtime ? new Date(it.mtime).toLocaleString() : ""}>{timeAgo(it.mtime)}</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    {it.dir ? (
                      <button className="btn btn-sm btn-outline-secondary" onClick={(e) => { e.stopPropagation(); goFolder(it.name); }}><i className="bi bi-folder2-open" /> Open</button>
                    ) : (
                      <button className="btn btn-sm btn-outline-secondary" onClick={(e) => { e.stopPropagation(); delFile(it.name); }} style={{ color: "var(--muted)", borderColor: "var(--border)" }}><i className="bi bi-trash" style={{ color: "#f87171" }} /> Delete</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {(() => {
        if (viewerIdx == null || !viewable[viewerIdx]) return null;
        const curCat = fileCategory(viewable[viewerIdx].name);
        const sameViewable = viewable.filter((it) => fileCategory(it.name) === curCat);
        const curName = viewable[viewerIdx].name;
        const filteredIdx = sameViewable.findIndex((it) => it.name === curName);
        const handlePrev = () => {
          if (filteredIdx > 0) {
            const prev = sameViewable[filteredIdx - 1];
            const origIdx = viewable.findIndex((v) => v.name === prev.name);
            if (origIdx !== -1) { persistHighlightMedia(prev.name); setViewerIdx(origIdx); }
          }
        };
        const handleNext = () => {
          if (filteredIdx < sameViewable.length - 1) {
            const nxt = sameViewable[filteredIdx + 1];
            const origIdx = viewable.findIndex((v) => v.name === nxt.name);
            if (origIdx !== -1) { persistHighlightMedia(nxt.name); setViewerIdx(origIdx); }
          }
        };
        const scrollAndHighlight = (el) => {
          if (!el) return;
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          const n = el.id?.startsWith("media-file-") ? el.id.replace("media-file-", "") : el.getAttribute("data-filename")?.replace(/[^a-zA-Z0-9]/g, "-") || "";
          if (lastHighlightedMediaRef.current && lastHighlightedMediaRef.current !== n) {
            const prev = document.getElementById(`media-file-${lastHighlightedMediaRef.current}`);
            if (prev) { prev.style.background = ""; prev.removeAttribute("data-highlighted"); }
          }
          el.style.background = "rgba(99,102,241,0.14)";
          el.setAttribute("data-highlighted", "true");
          lastHighlightedMediaRef.current = n;
        };
        const handleClose = () => {
          const name = viewable[viewerIdx]?.name;
          if (name) lastViewedNameRef.current = name;
          setViewerIdx(null);
          setTimeout(() => {
            const n = name ? name.replace(/[^a-zA-Z0-9]/g, "-") : "";
            const el = n ? document.getElementById(`media-file-${n}`) : null;
            if (el) scrollAndHighlight(el);
            else if (name) {
              const esc = window.CSS?.escape ? window.CSS.escape(name) : name.replace(/"/g, '\\"');
              const q = document.querySelector(`[data-filename="${esc}"]`);
              scrollAndHighlight(q);
            }
          }, 80);
        };
        return (
          <FileViewer
            src={toMediaUrl(folder, viewable[viewerIdx].name)}
            title={viewable[viewerIdx].name}
            filePath={folder ? `${folder}/${viewable[viewerIdx].name}` : viewable[viewerIdx].name}
            url=""
            viewable={sameViewable}
            idx={filteredIdx}
            onClose={handleClose}
            onPrev={handlePrev}
            onNext={handleNext}
            onDeleted={() => load(folder)}
          />
        );
      })()}
    </div>
  );
}
