import { useEffect, useState, useRef, useMemo } from "react";
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
function toMediaUrl(folder, rel) {
  const base = folder ? `${folder.replace(/\/$/, "")}/${rel}` : rel;
  return "/media/" + base.split("/").filter(Boolean).map(encodeURIComponent).join("/");
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
  if (ext === "gif") return "gif";
  if (/^(mp4|webm|mkv|mov|m4v|avi|mpg|mpeg|3gp|flv|ts|m3u8)$/i.test(ext)) return "video";
  if (/^(jpg|jpeg|png|webp|bmp|avif)$/i.test(ext)) return "photo";
  if (/^(mp3|m4a|aac|ogg|wav|flac|opus)$/i.test(ext)) return "audio";
  return "other";
}
function isPosterFile(name) {
  return /-poster\.(jpe?g|png|webp|avif|gif)$/i.test(String(name || ""));
}
const catIcon = {
  video: "bi-file-earmark-play",
  photo: "bi-file-earmark-image",
  gif: "bi-filetype-gif",
  audio: "bi-file-earmark-music",
  other: "bi-file-earmark",
};
const TYPE_CHIPS = [["all", "All"], ["photo", "Img"], ["video", "Vid"], ["gif", "GIF"]];

export default function Media() {
  const [searchParams, setSearchParams] = useSearchParams();
  const folder = searchParams.get("folder") || "";
  const isFlat = searchParams.get("flat") === "1";
  const isGrid = searchParams.get("view") === "grid";
  const type = searchParams.get("type") || "all";
  const sort = searchParams.get("sort") || null;
  const sortDir = searchParams.get("dir") || "asc";
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const filter = searchParams.get("q") || "";

  const crumbs = folder ? folder.split("/").filter(Boolean) : [];
  const filtered = (() => {
    let base = items;
    const raw = filter.trim();
    if (raw) {
      const isNeg = raw.startsWith("!");
      const term = (isNeg ? raw.slice(1).trim() : raw).toLowerCase();
      if (term) {
        base = base.filter((it) => {
          const hay = (isFlat ? it.rel || it.name : it.name).toLowerCase();
          const hit = hay.includes(term);
          return isNeg ? !hit : hit;
        });
      }
    }
    if (type !== "all") base = base.filter((it) => !it.dir && fileCategory(it.name) === type);
    if (sort) {
      const dirs = [];
      const files = [];
      for (const it of base) (it.dir ? dirs : files).push(it);
      const col = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      const by = (a, b) => {
        if (sort === "name") return col.compare(a.name, b.name);
        if (sort === "size") return (a.size || 0) - (b.size || 0);
        if (sort === "time") return new Date(a.created || a.mtime || 0) - new Date(b.created || b.mtime || 0);
        return 0;
      };
      files.sort((a, b) => (sortDir === "desc" ? -by(a, b) : by(a, b)));
      dirs.sort((a, b) => col.compare(a.name, b.name));
      return [...dirs, ...files];
    }
    return base;
  })();
  const viewable = filtered.filter((it) => !it.dir);

  const setParam = (k, v) => {
    const ns = new URLSearchParams(searchParams);
    if (v == null || v === "") ns.delete(k);
    else ns.set(k, v);
    setSearchParams(ns, { replace: true });
  };
  const setFilter = (v) => setParam("q", v);
  const setType = (v) => setParam("type", v === "all" ? "" : v);
  const [viewerIdx, setViewerIdx] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [ratios, setRatios] = useState({});
  const [gridW, setGridW] = useState(0);
  const gridRef = useRef(null);
  const clampRatio = (r) => Math.min(2.2, Math.max(0.55, Number(r) || NaN));
  const GRID_GAP = 8;
  const GRID_TARGET_H = 240;
  useEffect(() => {
    if (!isGrid) return;
    const el = gridRef.current;
    if (!el) return;
    const measure = () => setGridW(Math.max(el.offsetWidth || window.innerWidth || 1200, 40));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isGrid]);
  const onImgLoad = (e, rk) => {
    const nw = e.currentTarget.naturalWidth;
    const nh = e.currentTarget.naturalHeight;
    if (!nw || !nh) return;
    const r = clampRatio(nw / nh);
    setRatios((prev) => (prev[rk] === r ? prev : { ...prev, [rk]: r }));
  };
  const selectAfterLoadRef = useRef(null);
  const lastViewedNameRef = useRef(null);
  const lastHighlightedMediaRef = useRef(null);
  const sanitizeKey = (s) => String(s || "").replace(/[^a-zA-Z0-9]/g, "-");
  const rowKey = (it) => (isFlat ? it.rel || it.name : it.name);
  const displayName = (it) => (isFlat ? String(it.rel || it.name).replace(/\//g, " > ") : it.name);
  const persistHighlightMedia = (keyName) => {
    const n = keyName ? sanitizeKey(keyName) : "";
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
      const target = selectAfterLoadRef.current;
      selectAfterLoadRef.current = null;
      const qs = new URLSearchParams();
      if (f) qs.set("folder", f);
      if (isFlat) qs.set("flat", "1");
      const r = await fetch(`/api/media?${qs.toString()}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "failed");
      setItems((j.items || []).filter((it) => it.dir || !isPosterFile(it.name)));
      setRatios({});
      if (target) {
        const idx = (j.items || []).findIndex((it) => (it.rel || it.name) === target || it.name === target);
        if (idx !== -1) setSelectedIdx(idx);
      } else { setSelectedIdx(0); }
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(folder); }, [folder, isFlat]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (searchParams.get("open")) setParam("open", "");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selKey = searchParams.get("sel");
  const suppressScrollRef = useRef(false);
  const prevSelKeyRef = useRef(null);
  useEffect(() => {
    if (loading || !items.length) return;
    if (selKey) {
      const fi = filtered.findIndex((it) => rowKey(it) === selKey);
      if (fi !== -1) {
        if (prevSelKeyRef.current === selKey && fi !== selectedIdx) {
          suppressScrollRef.current = true;
        }
        setSelectedIdx(fi);
      } else {
        setParam("sel", "");
      }
    }
    prevSelKeyRef.current = selKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, folder, isFlat, searchParams]);

  const syncedSelRef = useRef(null);
  useEffect(() => {
    if (viewerIdx == null) return;
    const it = viewable[viewerIdx];
    if (!it) return;
    const k = rowKey(it);
    if (k !== syncedSelRef.current || searchParams.get("sel") !== k) {
      syncedSelRef.current = k;
      setParam("sel", k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerIdx, viewable.length]);

  const filteredRef = useRef(null);
  filteredRef.current = filtered;
  useEffect(() => {
    if (viewerIdx != null) return;
    const f = filteredRef.current;
    const it = f[selectedIdx];
    if (!it) return;
    const key = rowKey(it);
    const cur = searchParams.get("sel");
    if (it.dir) {
      if (cur && !f.some((x) => !x.dir && rowKey(x) === cur)) setParam("sel", "");
    } else if (key !== cur) {
      setParam("sel", key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx, viewerIdx]);

  useEffect(() => {
    if (viewerIdx != null) return;
    if (suppressScrollRef.current) { suppressScrollRef.current = false; return; }
    const el = document.querySelector(`[data-selected="true"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedIdx, viewerIdx]);

  useEffect(() => {
    if (viewerIdx != null) return;
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      const k = e.key;
      const isUp = k === "ArrowUp" || k === "w" || k === "W";
      const isDown = k === "ArrowDown" || k === "s" || k === "S";
      const isLeft = k === "ArrowLeft" || k === "a" || k === "A";
      const isRight = k === "ArrowRight" || k === "d" || k === "D";
      const isEnter = k === " " || k === "Enter";
      const lowK = k.toLowerCase();
      if (lowK === "g" && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); setParam("view", isGrid ? "" : "grid"); }
      else if (lowK === "f" && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); setParam("flat", isFlat ? "" : "1"); }
      else if (lowK === "t" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        const order = TYPE_CHIPS.map((c) => c[0]);
        const i = order.indexOf(type);
        const next = order[(i + 1) % order.length];
        setType(next);
      }
      else if (isLeft) { e.preventDefault(); goUp(); }
      else if (isUp) { e.preventDefault(); setSelectedIdx((i) => Math.max(0, i - 1)); }
      else if (isDown) { e.preventDefault(); setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1)); }
      else if (isRight || isEnter) {
        if (!filtered.length) return;
        e.preventDefault();
        const it = filtered[selectedIdx];
        if (it) { if (it.dir) goFolder(it.name); else openViewer(it); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerIdx, filtered, selectedIdx, searchParams]);

  const goFolder = (name) => {
    const ns = new URLSearchParams(searchParams);
    ns.set("folder", folder ? `${folder}/${name}` : name);
    setSearchParams(ns);
  };
  const goUp = () => {
    if (!folder) return;
    const parts = folder.split("/").filter(Boolean);
    const cameFrom = parts.pop();
    const nf = parts.join("/");
    const ns = new URLSearchParams(searchParams);
    if (nf) ns.set("folder", nf); else ns.delete("folder");
    selectAfterLoadRef.current = cameFrom;
    setSearchParams(ns);
  };
  const goCrumb = (idx) => {
    const nf = crumbs.slice(0, idx + 1).join("/");
    const ns = new URLSearchParams(searchParams);
    ns.set("folder", nf);
    setSearchParams(ns);
  };
  const delFile = async (it) => {
    const key = rowKey(it);
    if (!confirm(`Delete "${displayName(it)}"? This removes the file from /media.`)) return;
    const slash = key.lastIndexOf("/");
    let parent, base;
    if (slash === -1) { parent = folder; base = key; }
    else { parent = folder ? `${folder}/${key.slice(0, slash)}` : key.slice(0, slash); base = key.slice(slash + 1); }
    const r = await fetch(`/api/media?folder=${encodeURIComponent(parent)}&name=${encodeURIComponent(base)}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) alert(j.error || "delete failed");
    else load(folder);
  };

  const rows = useMemo(() => {
    if (!isGrid || !gridW) return [];
    return filtered.map((it, i) => {
      const isDir = !!it.dir;
      if (isDir) return { it, i, h: GRID_TARGET_H, w: Math.min(GRID_TARGET_H * 1.25, 260), isDir: true };
      const r = clampRatio(parseFloat(ratios[rowKey(it)]) || 1);
      let w = Math.round(GRID_TARGET_H * r);
      const max = Math.max(gridW - GRID_GAP * 2, 80);
      if (w > max) w = max;
      return { it, i, h: GRID_TARGET_H, w, isDir: false };
    });
  }, [isGrid, gridW, filtered, ratios]);
  const openViewer = (it) => {
    if (!it || it.dir) return;
    const idx = viewable.findIndex((v) => rowKey(v) === rowKey(it));
    if (idx !== -1) { persistHighlightMedia(rowKey(it)); setViewerIdx(idx); setParam("sel", rowKey(it)); }
  };
  const thrumb = (it) => {
    if (!it || it.dir) return null;
    if (it.thumb) return toMediaUrl(folder, it.thumb);
    const cat = fileCategory(it.name);
    if (cat === "photo" || cat === "gif") return toMediaUrl(folder, it.rel || it.name);
    return null;
  };
  const renderTile = (it, fi, w, h) => {
    const src = thrumb(it);
    const selected = fi === selectedIdx;
    const isDir = !!it.dir;
    return (
      <div
        key={isFlat ? it.rel || it.name : it.name}
        id={`media-file-${sanitizeKey(rowKey(it))}`}
        data-testid={isDir ? "media-tile-folder" : "media-tile-file"}
        data-filename={rowKey(it)}
        data-selected={selected}
        onClick={() => { setSelectedIdx(fi); if (it.dir) goFolder(it.name); else openViewer(it); }}
        title={displayName(it)}
        style={{ position: "relative", flex: isDir ? "0 0 auto" : "0 0 auto", width: w, height: h, overflow: "hidden", borderRadius: 0, background: isDir ? "var(--surface-2)" : "var(--surface-2)", outline: selected ? "2px solid var(--accent)" : "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}
      >
        {src ? (
          <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onLoad={(e) => onImgLoad(e, rowKey(it))} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000", flex: 1 }} />
        ) : isDir ? (
          <i className="bi bi-folder-fill" style={{ fontSize: 44, color: "#f59e0b" }} />
        ) : (
          <i className={`bi ${catIcon[fileCategory(it.name)]}`} style={{ fontSize: 34, color: "var(--muted)" }} />
        )}
        {isDir && (
          <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "4px 6px", fontSize: 11, color: "#fff", background: "linear-gradient(transparent, rgba(0,0,0,.7))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", pointerEvents: "none" }}>{displayName(it)}</span>
        )}
        {!isDir && src && (
          <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "4px 6px", fontSize: 10, color: "#fff", background: "linear-gradient(transparent, rgba(0,0,0,.65))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", pointerEvents: "none" }}>{displayName(it)}</span>
        )}
      </div>
    );
  };
  const toggleSort = (key) => {
    const ns = new URLSearchParams(searchParams);
    const cur = ns.get("sort");
    const curDir = ns.get("dir");
    const initialDir = key === "name" ? "asc" : "desc";
    if (cur !== key) { ns.set("sort", key); ns.set("dir", initialDir); }
    else if (curDir === initialDir) { ns.set("dir", initialDir === "asc" ? "desc" : "asc"); }
    else { ns.delete("sort"); ns.delete("dir"); }
    setSearchParams(ns, { replace: true });
  };
  const sortBtn = (key, label) => (
    <button data-testid={`media-sort-${key}`} type="button" onClick={() => toggleSort(key)} title={`Sort by ${label}`} style={{ background: "none", border: 0, padding: 0, color: sort === key ? "var(--text)" : "inherit", fontWeight: 700, fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, textAlign: "left" }}>
      {label}<span style={{ color: "var(--accent)", minWidth: 10, display: "inline-block" }}>{sort === key ? (sortDir === "desc" ? "▼" : "▲") : ""}</span>
    </button>
  );
  // reset viewer if folder/filter changes and file disappears - keep on next file after delete
  useEffect(() => {
    if (viewerIdx != null && (viewerIdx < 0 || viewerIdx >= viewable.length)) {
      if (viewable.length) setViewerIdx(Math.min(viewerIdx, viewable.length - 1));
      else setViewerIdx(null);
    }
  }, [viewable.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const goViewer = (i) => {
    if (i >= 0 && i < viewable.length) {
      const k = rowKey(viewable[i]);
      persistHighlightMedia(k);
      setViewerIdx(i);
      setParam("sel", k);
    }
  };

  return (
    <div data-testid="media-page">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div data-testid="media-title" style={{ fontWeight: 700, fontSize: 14 }}><i className="bi bi-collection-play" style={{ marginRight: 8 }} /> Media library</div>
        <span data-testid="media-item-count" className="badge text-bg-secondary">{items.length} items</span>
      </div>
      <div data-testid="media-sticky" style={{ position: "sticky", top: 0, zIndex: 50, background: "var(--bg)", paddingBottom: 10, borderBottom: err ? "none" : "1px solid var(--border)", marginBottom: 12, boxShadow: "0 6px 12px -8px rgba(0,0,0,.4)" }}>
      <div data-testid="media-toolbar" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input data-testid="media-filter" className="form-control form-control-sm" style={{ maxWidth: 200, height: 31 }} placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button data-testid="media-refresh" className="btn btn-sm btn-outline-secondary" style={{ height: 31, display: "inline-flex", alignItems: "center" }} onClick={() => load(folder)} disabled={loading}><i className="bi bi-arrow-clockwise" /> Refresh</button>
          <div data-testid="media-type-filter" style={{ display: "inline-flex", alignItems: "center", gap: 2, border: "1px solid var(--border)", borderRadius: 8, padding: 2, background: "var(--surface-2)" }} title="Type filter — press t to cycle">
            {TYPE_CHIPS.map(([v, label]) => (
              <button key={v} data-testid={`media-type-${v}`} type="button" className={`btn btn-sm ${type === v ? "btn-primary" : "btn-outline-secondary"}`} style={{ height: 25, padding: "0 10px", fontSize: 11, display: "inline-flex", alignItems: "center", borderRadius: 6 }} onClick={() => setType(v)}>{label}</button>
            ))}
          </div>
        <div data-testid="media-view-toggle" style={{ display: "inline-flex", alignItems: "center", gap: 2, border: "1px solid var(--border)", borderRadius: 8, padding: 2, background: "var(--surface-2)" }}>
          <button data-testid="media-view-list" type="button" className={`btn btn-sm ${isGrid ? "btn-outline-secondary" : "btn-primary"}`} style={{ height: 25, width: 25, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 6 }} onClick={() => setParam("view", "")} title="List view (g)"><i className="bi bi-list-ul" /></button>
          <button data-testid="media-view-grid" type="button" className={`btn btn-sm ${isGrid ? "btn-primary" : "btn-outline-secondary"}`} style={{ height: 25, width: 25, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 6 }} onClick={() => setParam("view", "grid")} title="Grid view (g)"><i className="bi bi-grid-3x3-gap-fill" /></button>
        </div>
        <button data-testid="media-flatten" type="button" className={`btn btn-sm ${isFlat ? "btn-primary" : "btn-outline-secondary"}`} onClick={() => setParam("flat", isFlat ? "" : "1")} title="Flatten: list all files recursively under this folder (f)" style={{ height: 31, display: "inline-flex", alignItems: "center", gap: 5 }}><i className="bi bi-layers" /> Flatten</button>
      </div>

      <div data-testid="media-breadcrumbs" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <button data-testid="media-breadcrumb-root" className="btn btn-sm btn-outline-secondary" onClick={() => { const ns = new URLSearchParams(searchParams); ns.delete("folder"); setSearchParams(ns); }} disabled={!folder}><i className="bi bi-house" /> Media</button>
        {crumbs.map((c, i) => (
          <span key={i} data-testid={`media-breadcrumb-${c}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--muted)" }}>/</span>
            <button className="btn btn-sm btn-outline-secondary" onClick={() => goCrumb(i)}>{c}</button>
          </span>
        ))}
        {folder && <button data-testid="media-up" className="btn btn-sm btn-outline-secondary" onClick={goUp} style={{ marginLeft: 8 }}><i className="bi bi-arrow-90deg-up" /> Up</button>}
      </div>
      </div>

      <div data-testid="media-content" className="media-full">
      {err && <div data-testid="media-error" className="card" style={{ padding: 12, color: "var(--danger)", marginBottom: 12 }}>{err}</div>}

      {isGrid ? (
        <div data-testid="media-grid-card" className="card">
          <div data-testid="media-grid" ref={gridRef} className="card-body" style={{ padding: GRID_GAP }}>
            {loading ? <div data-testid="media-loading" style={{ padding: 20, color: "var(--muted)" }}>Loading…</div> : filtered.length === 0 ? <div data-testid="media-empty" className="empty" style={{ padding: 20 }}><i className="bi bi-inbox" /> No files — download something!</div> : !gridW ? <div data-testid="media-grid-measuring" style={{ padding: 20, color: "var(--muted)" }}>Measuring…</div> : (
              <div data-testid="media-grid-tiles" style={{ display: "flex", flexWrap: "wrap", gap: GRID_GAP }}>
                {rows.map((row) => renderTile(row.it, row.i, row.w, row.h))}
              </div>
            )}
          </div>
        </div>
      ) : (
      <div data-testid="media-list-card" className="card">
        <div className="card-body" style={{ padding: 0 }}>
          <div data-testid="media-list-header" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto auto", gap: 10, fontSize: 12, fontWeight: 700, color: "var(--muted)", padding: "10px 14px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
            {sortBtn("name", "Name")}{sortBtn("size", "Size")}{sortBtn("time", "Time")}<span data-testid="media-header-actions">Actions</span>
          </div>
          {loading ? <div data-testid="media-loading" style={{ padding: 20, color: "var(--muted)" }}>Loading…</div> : filtered.length === 0 ? <div data-testid="media-empty" className="empty" style={{ padding: 20 }}><i className="bi bi-inbox" /> No files — download something!</div> : (
            <div data-testid="media-list-rows">
              {filtered.map((it, fi) => {
                const ky = rowKey(it);
                return (
                  <div key={isFlat ? it.rel || it.name : it.name} id={`media-file-${sanitizeKey(ky)}`} data-testid="media-row" data-filename={ky} data-selected={fi === selectedIdx} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto auto", gap: 10, alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border)", background: fi === selectedIdx ? "rgba(99,102,241,0.14)" : it.dir ? "var(--surface-2)" : "var(--surface)", cursor: "pointer" }} onClick={() => { setSelectedIdx(fi); if (it.dir) goFolder(it.name); else openViewer(it); }}>
                    <div data-testid="media-row-name" style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                      <i className={`bi ${it.dir ? "bi-folder-fill" : catIcon[fileCategory(it.name)]}`} style={{ color: it.dir ? "#f59e0b" : "var(--accent)" }} />
                      {it.dir ? (
                        <button data-testid="media-row-open-folder" onClick={(e) => { e.stopPropagation(); goFolder(it.name); }} title={it.name} style={{ background: "none", border: 0, color: "var(--text)", fontWeight: 600, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, maxWidth: "100%" }}>{it.name}</button>
                      ) : (
                        <button data-testid="media-row-open-file" onClick={(e) => { e.stopPropagation(); openViewer(it); }} title={`Open ${displayName(it)}`} style={{ background: "none", border: 0, color: "var(--text)", fontWeight: 500, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: 0, minWidth: 0, maxWidth: "100%" }}>{displayName(it)}</button>
                      )}
                    </div>
                    <span data-testid="media-row-size" className="small" style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtSize(it.size)}</span>
                    <span data-testid="media-row-time" className="small" style={{ color: "var(--muted)", whiteSpace: "nowrap" }} title={it.created ? new Date(it.created).toLocaleString() : ""}>{timeAgo(it.created || it.mtime)}</span>
                    <div data-testid="media-row-actions" style={{ display: "flex", gap: 6 }}>
                      {it.dir ? (
                        <button data-testid="media-row-action-open" className="btn btn-sm btn-outline-secondary" onClick={(e) => { e.stopPropagation(); goFolder(it.name); }}><i className="bi bi-folder2-open" /> Open</button>
                      ) : (
                        <button data-testid="media-row-action-delete" className="btn btn-sm btn-outline-secondary" onClick={(e) => { e.stopPropagation(); delFile(it); }} style={{ color: "var(--muted)", borderColor: "var(--border)" }}><i className="bi bi-trash" style={{ color: "#f87171" }} /> Delete</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      )}
      {(() => {
        if (viewerIdx == null || !viewable[viewerIdx]) return null;
        const it = viewable[viewerIdx];
        const label = displayName(it);
        const keyName = rowKey(it);
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
          if (keyName) lastViewedNameRef.current = keyName;
          setParam("sel", keyName);
          setViewerIdx(null);
          setTimeout(() => {
            const curSel = document.querySelector('[data-selected="true"]');
            if (curSel && curSel.getAttribute("data-filename") !== keyName) return;
            const n = keyName ? sanitizeKey(keyName) : "";
            const el = n ? document.getElementById(`media-file-${n}`) : null;
            if (el) scrollAndHighlight(el);
            else if (keyName) {
              const esc = window.CSS?.escape ? window.CSS.escape(keyName) : keyName.replace(/"/g, '\\"');
              const q = document.querySelector(`[data-filename="${esc}"]`);
              scrollAndHighlight(q);
            }
          }, 80);
        };
        return (
          <div data-testid="media-viewer">
            <FileViewer
              src={toMediaUrl(folder, keyName)}
              title={label}
              filePath={folder ? `${folder}/${keyName}` : keyName}
              url=""
              viewable={viewable}
              idx={viewerIdx}
              onClose={handleClose}
              onPrev={() => goViewer(viewerIdx - 1)}
              onNext={() => goViewer(viewerIdx + 1)}
              onGoto={goViewer}
              onDeleted={() => load(folder)}
            />
          </div>
        );
      })()}
      </div>
    </div>
  );
}