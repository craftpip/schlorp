import { useEffect, useState, useRef, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import FileViewer from "../components/FileViewer";
import ShortcutsHelp from "../components/ShortcutsHelp";

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

// Obfuscated URL params: `?f=` = base64url(folder), `?s=` = base64url(selKey).
// Legacy plaintext `?folder=` / `?sel=` still read (old bookmarks) but never written.
function encB64(s) {
  try {
    return btoa(unescape(encodeURIComponent(String(s ?? ""))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch { return ""; }
}
function decB64(s) {
  try {
    const b64 = String(s ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    return decodeURIComponent(escape(atob(b64 + pad)));
  } catch { return ""; }
}

export default function Media() {
  const [searchParams, setSearchParams] = useSearchParams();
  const folder = (() => {
    const v = searchParams.get("f");
    if (v != null) return decB64(v);
    return searchParams.get("folder") || "";
  })();
  const isFlat = searchParams.get("flat") === "1";
  const isGrid = searchParams.get("view") !== "list";
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
    const key = k === "folder" ? "f" : k === "sel" ? "s" : k;
    const val = k === "folder" || k === "sel" ? encB64(v) : v;
    if (v == null || v === "" || val === "") ns.delete(key);
    else ns.set(key, val);
    if (k === "folder") ns.delete("folder");
    if (k === "sel") ns.delete("sel");
    setSearchParams(ns, { replace: true });
  };
  const setFilter = (v) => setParam("q", v);
  const setType = (v) => setParam("type", v === "all" ? "" : v);
  const [viewerKey, setViewerKey] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [ratios, setRatios] = useState({});
  const [imgErr, setImgErr] = useState({});
  const [thumbLoaded, setThumbLoaded] = useState({});
  const [gifVideo, setGifVideo] = useState({});
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
  const sanitizeKey = (s) => String(s || "").replace(/[^a-zA-Z0-9]/g, "-");
  const rowKey = (it) => (isFlat ? it.rel || it.name : it.name);
  const displayName = (it) => (isFlat ? String(it.rel || it.name).replace(/\//g, " > ") : it.name);
  // Single-select model (plan 014): `?s=<base64url rowKey>` is the source of truth (single select only).
  // 1 click = select, double-click = open. Derived index follows the key across reloads.
  const selKey = (() => {
    const v = searchParams.get("s");
    if (v != null) return decB64(v);
    return searchParams.get("sel") || "";
  })();
  const setSelectedKey = (k) => {
    const next = k || "";
    if (next !== selKey) setParam("sel", next);
  };
  const isCoarsePointer = () => {
    try { return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); }
    catch { return false; }
  };
  const pendingSelectRef = useRef(null); // key to restore after the next load (go-up, delete)
  const freshLoadRef = useRef(false); // next committed items scroll once to the selection
  const keyboardScrollRef = useRef(false); // next selection commit scrolls (arrow-key nav)

  // Same-folder reloads (refresh / delete) keep the stale rows mounted while
  // fetching — unmounting the list collapses the page height and the browser
  // clamps scrollY to the top with no way back. Only fresh navigation clears.
  const load = async (f, { clear = false } = {}) => {
    if (clear) setItems([]);
    setLoading(true); setErr("");
    const pending = pendingSelectRef.current;
    pendingSelectRef.current = null;
    try {
      const qs = new URLSearchParams();
      if (f) qs.set("folder", f);
      if (isFlat) qs.set("flat", "1");
      const r = await fetch(`/api/media?${qs.toString()}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "failed");
      const fresh = (j.items || []).filter((it) => it.dir || !isPosterFile(it.name));
      setItems(fresh);
      setRatios({});
      setImgErr({});
      setThumbLoaded({});
      setGifVideo({});
      // Key-based restore: explicit pending key wins, then keep ?s if still present,
      // else select the first item (empty folder = no selection).
      const keyOf = (it) => (isFlat ? it.rel || it.name : it.name);
      const keys = new Set(fresh.map(keyOf));
      const curSel = selKey;
      if (pending && keys.has(pending)) {
        if (pending !== curSel) setParam("sel", pending);
      } else if (curSel && keys.has(curSel)) {
        // keep — selection survives reload/refresh
      } else if (fresh.length) {
        setParam("sel", keyOf(fresh[0]));
      } else if (curSel) {
        setParam("sel", "");
      }
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  // Fresh content (mount / folder / flat change / explicit refresh) scrolls once
  // to the selection. Delete-triggered reloads must NOT scroll (plan 014).
  const refresh = () => { freshLoadRef.current = true; load(folder); };
  useEffect(() => { freshLoadRef.current = true; load(folder, { clear: true }); }, [folder, isFlat]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (searchParams.get("open")) setParam("open", "");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Derived selection: index follows the ?s key (single select, no index state).
  const selectedIdx = selKey ? filtered.findIndex((it) => rowKey(it) === selKey) : -1;
  // Key-based viewer: index follows the viewed key across reloads/deletes.
  const viewerIdx = viewerKey ? viewable.findIndex((v) => rowKey(v) === viewerKey) : null;
  const viewerOpen = viewerKey != null;
  const lastViewerIdxRef = useRef(0);
  // Library help belongs to the no-player context: close it when the player opens
  // (the player renders its own copy of the guide while open).
  useEffect(() => { if (viewerOpen) setShowHelp(false); }, [viewerOpen]);
  useEffect(() => {
    if (viewerIdx != null && viewerIdx !== -1) lastViewerIdxRef.current = viewerIdx;
  }, [viewerIdx]);
  // Index actually rendered by the viewer (last position while reloading).
  const shownViewerIdx = viewerOpen
    ? (viewerIdx !== null && viewerIdx !== -1 ? viewerIdx : Math.min(lastViewerIdxRef.current, Math.max(0, viewable.length - 1)))
    : null;

  // Sticky-aware scroll: native scrollIntoView({block:"nearest"}) ignores the
  // sticky toolbar, leaving the row hidden under it or bottom-flush. Scroll
  // manually only when the selected row is actually out of view.
  const scrollSelectionIntoView = () => {
    const el = document.querySelector(`[data-selected="true"]`);
    if (!el) return;
    const sticky = document.querySelector(`[data-testid="media-sticky"]`);
    const offset = (sticky ? sticky.offsetHeight : 0) + 12;
    const rect = el.getBoundingClientRect();
    if (rect.top < offset || rect.bottom > window.innerHeight) {
      window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - offset), behavior: "auto" });
    }
  };

  // Scroll ONLY on fresh content load (mount / folder change / explicit refresh).
  // Delete reloads, viewer close, clicks and double-clicks never scroll.
  useEffect(() => {
    if (!freshLoadRef.current || loading || !filtered.length || viewerOpen) return;
    freshLoadRef.current = false;
    scrollSelectionIntoView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, loading]);
  // Arrow-key navigation arms a one-shot scroll so the highlight stays visible.
  useEffect(() => {
    if (!keyboardScrollRef.current || viewerOpen) { keyboardScrollRef.current = false; return; }
    keyboardScrollRef.current = false;
    scrollSelectionIntoView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx]);

  useEffect(() => {
    if (viewerOpen) return;
    const moveSelection = (delta) => {
      if (!filtered.length) return;
      const base = selectedIdx !== -1 ? selectedIdx : (delta > 0 ? -1 : 0);
      const next = Math.min(filtered.length - 1, Math.max(0, base + delta));
      keyboardScrollRef.current = true;
      setSelectedKey(rowKey(filtered[next]));
    };
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      const k = e.key;
      const isUp = k === "ArrowUp" || k === "w" || k === "W";
      const isDown = k === "ArrowDown" || k === "s" || k === "S";
      const isLeft = k === "ArrowLeft" || k === "a" || k === "A";
      const isRight = k === "ArrowRight" || k === "d" || k === "D";
      const isEnter = k === " " || k === "Enter";
      const lowK = k.toLowerCase();
      if ((k === "/" || k === "?") && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); setShowHelp((v) => !v); return; }
      if (k === "Escape" && showHelp) { e.preventDefault(); setShowHelp(false); return; }
      if (lowK === "g" && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); setParam("view", isGrid ? "list" : ""); }
      else if (lowK === "j" && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); setParam("flat", isFlat ? "" : "1"); }
      else if (lowK === "t" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        const order = TYPE_CHIPS.map((c) => c[0]);
        const i = order.indexOf(type);
        const next = order[(i + 1) % order.length];
        setType(next);
      }
      else if (isLeft) { e.preventDefault(); goUp(); }
      else if (isUp) { e.preventDefault(); moveSelection(-1); }
      else if (isDown) { e.preventDefault(); moveSelection(1); }
      else if (isRight || isEnter) {
        if (!filtered.length || selectedIdx === -1) return;
        e.preventDefault();
        const it = filtered[selectedIdx];
        if (it) { if (it.dir) goFolder(it.name); else openViewer(it); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerOpen, filtered, selectedIdx, searchParams, showHelp]);

  const goFolder = (name) => {
    const ns = new URLSearchParams(searchParams);
    ns.set("f", encB64(folder ? `${folder}/${name}` : name));
    ns.delete("folder");
    setSearchParams(ns);
  };
  const goUp = () => {
    if (!folder) return;
    const parts = folder.split("/").filter(Boolean);
    const cameFrom = parts.pop();
    const nf = parts.join("/");
    const ns = new URLSearchParams(searchParams);
    if (nf) ns.set("f", encB64(nf)); else ns.delete("f");
    ns.delete("folder");
    pendingSelectRef.current = cameFrom;
    setSearchParams(ns);
  };
  const goCrumb = (idx) => {
    const nf = crumbs.slice(0, idx + 1).join("/");
    const ns = new URLSearchParams(searchParams);
    ns.set("f", encB64(nf));
    ns.delete("folder");
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
    if (!r.ok) { alert(j.error || "delete failed"); return; }
    // Keep selection on the neighbour (next ?? prev) instead of jumping to the top.
    const fi = filtered.findIndex((x) => rowKey(x) === key);
    if (fi !== -1) {
      const next = filtered[fi + 1] || filtered[fi - 1];
      pendingSelectRef.current = next ? rowKey(next) : null;
    }
    load(folder);
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
  // 1 click = select only; double-click (or Enter) = open. Touch keeps tap-to-open.
  const selectOnly = (it) => setSelectedKey(rowKey(it));
  const openItem = (it) => {
    if (!it) return;
    setSelectedKey(rowKey(it));
    if (it.dir) goFolder(it.name);
    else openViewer(it);
  };
  const tapItem = (it) => {
    // Coarse pointers (mobile): single tap selects AND opens (previous behaviour).
    if (isCoarsePointer()) openItem(it);
    else selectOnly(it);
  };
  const openViewer = (it) => {
    if (!it || it.dir) return;
    const k = rowKey(it);
    if (!viewable.some((v) => rowKey(v) === k)) return;
    setSelectedKey(k);
    setViewerKey(k);
  };
  const thrumb = (it) => {
    if (!it || it.dir) return null;
    if (it.thumb) return toMediaUrl(folder, it.thumb);
    const cat = fileCategory(it.name);
    if (cat === "photo" || cat === "gif") return toMediaUrl(folder, it.rel || it.name);
    // Video without a `-poster.*` sibling: serve the cover art embedded in the
    // file itself (if any). The endpoint only copies an attached-pic stream
    // (no decode/transcode); 404s fall back to the icon via onError.
    if (cat === "video") {
      const qs = new URLSearchParams();
      if (folder) qs.set("folder", folder);
      qs.set("key", rowKey(it));
      return `/api/mediathumb?${qs.toString()}`;
    }
    return null;
  };
  // Google-Drive-style folder chip (grid view only): compact fixed-size row
  // item, not a tall preview box — folders have no thumbnails.
  const FOLDER_CHIP_W = 220;
  const FOLDER_CHIP_H = 56;
  const renderFolderChip = (it, fi) => {
    const selected = fi === selectedIdx;
    return (
      <div
        key={isFlat ? it.rel || it.name : it.name}
        id={`media-file-${sanitizeKey(rowKey(it))}`}
        data-testid="media-tile-folder"
        data-filename={rowKey(it)}
        data-selected={selected}
        onClick={() => tapItem(it)}
        onDoubleClick={() => openItem(it)}
        title={`${displayName(it)} — click to select, double-click to open`}
        style={{ width: FOLDER_CHIP_W, height: FOLDER_CHIP_H, flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, padding: "0 12px", overflow: "hidden", borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--border)", outline: selected ? "2px solid var(--accent)" : "none", cursor: "pointer" }}
      >
        <i className="bi bi-folder-fill" style={{ fontSize: 24, color: "#f59e0b", flex: "0 0 auto" }} />
        <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName(it)}</span>
      </div>
    );
  };
  const renderTile = (it, fi, w, h) => {
    const rk = rowKey(it);
    // A thumbnail URL that 404s (no poster sibling, no embedded cover art)
    // falls back to the icon placeholder instead of a blank black tile.
    const src = imgErr[rk] ? null : thrumb(it);
    const selected = fi === selectedIdx;
    const isDir = !!it.dir;
    // `.gif` files that are actually MP4 bytes (mislabeled at download time,
    // e.g. reddit saves) fail in <img> — the server sniffs them as video/mp4.
    // Flip to a muted looping <video> on image error so they still preview.
    const cat = fileCategory(it.name);
    const asVideo = cat === "gif" && !!gifVideo[rk];
    const loaded = !!thumbLoaded[rk];
    const markLoaded = (e) => {
      onImgLoad(e, rowKey(it));
      const k = rowKey(it);
      setThumbLoaded((prev) => (prev[k] ? prev : { ...prev, [k]: 1 }));
    };
    const markVideoLoaded = () => {
      const k = rowKey(it);
      setThumbLoaded((prev) => (prev[k] ? prev : { ...prev, [k]: 1 }));
    };
    const markErr = () => {
      const k = rowKey(it);
      // GIF <img> failure → retry as video before falling back to the icon.
      if (cat === "gif" && !gifVideo[k]) {
        setGifVideo((prev) => ({ ...prev, [k]: 1 }));
        return;
      }
      setImgErr((prev) => (prev[k] ? prev : { ...prev, [k]: 1 }));
    };
    return (
      <div
        key={isFlat ? it.rel || it.name : it.name}
        id={`media-file-${sanitizeKey(rowKey(it))}`}
        data-testid={isDir ? "media-tile-folder" : "media-tile-file"}
        data-filename={rowKey(it)}
        data-selected={selected}
        onClick={() => tapItem(it)}
        onDoubleClick={() => openItem(it)}
        title={`${displayName(it)} — click to select, double-click to open`}
        style={{ position: "relative", flex: isDir ? "0 0 auto" : "0 0 auto", width: w, height: h, overflow: "hidden", borderRadius: 0, background: isDir ? "var(--surface-2)" : "var(--surface-2)", outline: selected ? "2px solid var(--accent)" : "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}
      >
        {src ? (
          <span style={{ position: "relative", width: "100%", height: "100%", flex: 1, display: "block", background: "#000", minHeight: 0 }}>
            {!loaded && (
              <span data-testid="media-thumb-loading" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}>
                <span className="xdl-thumb-spinner" />
              </span>
            )}
            {asVideo ? (
              <video src={src} autoPlay muted loop playsInline preload="metadata" onLoadedData={markVideoLoaded} onError={markErr} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000", opacity: loaded ? 1 : 0 }} />
            ) : (
              <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onLoad={markLoaded} onError={markErr} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000", opacity: loaded ? 1 : 0 }} />
            )}
          </span>
        ) : isDir ? (
          <i className="bi bi-folder-fill" style={{ fontSize: 44, color: "#f59e0b" }} />
        ) : (
          <i className={`bi ${catIcon[fileCategory(it.name)]}`} style={{ fontSize: 34, color: "var(--muted)" }} />
        )}
        {isDir && (
          <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "4px 6px", fontSize: 11, color: "#fff", background: "linear-gradient(transparent, rgba(0,0,0,.7))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", pointerEvents: "none" }}>{displayName(it)}</span>
        )}
        {!isDir && (
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
  // Close the viewer if its file disappears entirely (e.g. externally deleted
  // with no neighbour to fall back to). Delete flows set viewerKey explicitly.
  useEffect(() => {
    if (viewerOpen && viewable.length === 0) setViewerKey(null);
  }, [viewable.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const goViewer = (i) => {
    if (i >= 0 && i < viewable.length) {
      const k = rowKey(viewable[i]);
      setSelectedKey(k);
      setViewerKey(k);
    }
  };
  // After a delete inside the viewer: stay open on the neighbour (next ?? prev),
  // keep it selected, reload without jumping to the top. Only item → close.
  const handleViewerDeleted = (deletedRef) => {
    // FileViewer passes its filePath (`${folder}/${key}`); recover the rowKey.
    let deletedKey = viewerKey;
    if (deletedRef) {
      const s = String(deletedRef);
      const prefix = folder ? `${folder}/` : "";
      deletedKey = prefix && s.startsWith(prefix) ? s.slice(prefix.length) : s;
    }
    const di = viewable.findIndex((v) => rowKey(v) === deletedKey);
    const next = di !== -1 ? (viewable[di + 1] || viewable[di - 1]) : null;
    if (!next) {
      pendingSelectRef.current = null;
      setViewerKey(null);
    } else {
      const nk = rowKey(next);
      pendingSelectRef.current = nk;
      setSelectedKey(nk);
      setViewerKey(nk);
    }
    load(folder);
  };

  // Grid view only: folders render as a Drive-style fixed-size row on top,
  // files render as preview tiles below. List view is untouched.
  const dirRows = rows.filter((r) => r.isDir);
  const fileRows = rows.filter((r) => !r.isDir);

  return (
    <div data-testid="media-page" className="media-page">
      <div className="media-page-title" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div data-testid="media-title" style={{ fontWeight: 700, fontSize: 14 }}><i className="bi bi-collection-play" style={{ marginRight: 8 }} /> Media library</div>
        <span data-testid="media-item-count" className="badge text-bg-secondary">{items.length} items</span>
        {loading && items.length > 0 && <span data-testid="media-updating" className="small text-muted"><i className="bi bi-arrow-clockwise" /> Updating…</span>}
        <span className="small text-muted media-hint" style={{ marginLeft: 2 }}>Click to select · double-click to open</span>
      </div>
      <div data-testid="media-sticky" className="media-sticky" style={{ position: "sticky", top: 0, zIndex: 50, margin: "0 -10px", paddingTop: 6, paddingLeft: 10, paddingRight: 10, paddingBottom: 10, borderRadius: "0 0 10px 10px", background: "color-mix(in srgb, var(--bg) 60%, transparent)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", borderBottom: err ? "none" : "1px solid var(--border)", marginBottom: 12, boxShadow: "0 6px 12px -8px rgba(0,0,0,.4)" }}>
      <div data-testid="media-toolbar" className="media-toolbar" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input data-testid="media-filter" className="form-control form-control-sm media-filter" style={{ maxWidth: 200, height: 31 }} placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button data-testid="media-refresh" className="btn btn-sm btn-outline-secondary" style={{ height: 31, display: "inline-flex", alignItems: "center" }} onClick={refresh} disabled={loading} title="Refresh"><i className="bi bi-arrow-clockwise" /> <span className="media-btn-label">Refresh</span></button>
          <div data-testid="media-type-filter" style={{ display: "inline-flex", alignItems: "center", gap: 2, border: "1px solid var(--border)", borderRadius: 8, padding: 2, background: "var(--surface-2)" }} title="Type filter — press t to cycle">
            {TYPE_CHIPS.map(([v, label]) => (
              <button key={v} data-testid={`media-type-${v}`} type="button" className={`btn btn-sm ${type === v ? "btn-primary" : "btn-outline-secondary"}`} style={{ height: 25, padding: "0 10px", fontSize: 11, display: "inline-flex", alignItems: "center", borderRadius: 6 }} onClick={() => setType(v)}>{label}</button>
            ))}
          </div>
        <div data-testid="media-view-toggle" style={{ display: "inline-flex", alignItems: "center", gap: 2, border: "1px solid var(--border)", borderRadius: 8, padding: 2, background: "var(--surface-2)" }}>
          <button data-testid="media-view-list" type="button" className={`btn btn-sm ${isGrid ? "btn-outline-secondary" : "btn-primary"}`} style={{ height: 25, width: 25, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 6 }} onClick={() => setParam("view", "list")} title="List view (g)"><i className="bi bi-list-ul" /></button>
          <button data-testid="media-view-grid" type="button" className={`btn btn-sm ${isGrid ? "btn-primary" : "btn-outline-secondary"}`} style={{ height: 25, width: 25, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 6 }} onClick={() => setParam("view", "")} title="Grid view (g)"><i className="bi bi-grid-3x3-gap-fill" /></button>
        </div>
        <button data-testid="media-flatten" type="button" className={`btn btn-sm ${isFlat ? "btn-primary" : "btn-outline-secondary"}`} onClick={() => setParam("flat", isFlat ? "" : "1")} title="Flatten: list all files recursively under this folder (j)" style={{ height: 31, display: "inline-flex", alignItems: "center", gap: 5 }}><i className="bi bi-layers" /> <span className="media-btn-label">Flatten</span></button>
      </div>

      <div data-testid="media-breadcrumbs" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <button data-testid="media-breadcrumb-root" className="btn btn-sm btn-outline-secondary" onClick={() => { const ns = new URLSearchParams(searchParams); ns.delete("f"); ns.delete("folder"); setSearchParams(ns); }} disabled={!folder}><i className="bi bi-house" /> Media</button>
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
        <div data-testid="media-grid-card" className="card media-lib-card">
          <div data-testid="media-grid" ref={gridRef} className="card-body" style={{ padding: GRID_GAP }}>
            {loading && items.length === 0 ? <div data-testid="media-loading" style={{ padding: 20, color: "var(--muted)" }}>Loading…</div> : filtered.length === 0 ? (!loading ? <div data-testid="media-empty" className="empty" style={{ padding: 20 }}><i className="bi bi-inbox" /> No files — download something!</div> : null) : !gridW ? <div data-testid="media-grid-measuring" style={{ padding: 20, color: "var(--muted)" }}>Measuring…</div> : (
              <div data-testid="media-grid-tiles" className="media-grid-tiles" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {dirRows.length > 0 && (
                  <div data-testid="media-grid-folders">
                    <div className="small" style={{ color: "var(--muted)", fontWeight: 700, marginBottom: 6 }}>Folders</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: GRID_GAP }}>
                      {dirRows.map((row) => renderFolderChip(row.it, row.i))}
                    </div>
                  </div>
                )}
                {fileRows.length > 0 && (
                  <div data-testid="media-grid-files" style={{ display: "flex", flexWrap: "wrap", gap: GRID_GAP }}>
                    {fileRows.map((row) => renderTile(row.it, row.i, row.w, row.h))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
      <div data-testid="media-list-card" className="card media-lib-card">
        <div className="card-body" style={{ padding: 0 }}>
          <div data-testid="media-list-header" className="mrow" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto auto", gap: 10, fontSize: 12, fontWeight: 700, color: "var(--muted)", padding: "10px 14px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
            {sortBtn("name", "Name")}<span className="mcol-size">{sortBtn("size", "Size")}</span><span className="mcol-time">{sortBtn("time", "Time")}</span><span data-testid="media-header-actions">Actions</span>
          </div>
          {loading && items.length === 0 ? <div data-testid="media-loading" style={{ padding: 20, color: "var(--muted)" }}>Loading…</div> : filtered.length === 0 ? (!loading ? <div data-testid="media-empty" className="empty" style={{ padding: 20 }}><i className="bi bi-inbox" /> No files — download something!</div> : null) : (
            <div data-testid="media-list-rows">
              {filtered.map((it, fi) => {
                const ky = rowKey(it);
                return (
                  <div key={isFlat ? it.rel || it.name : it.name} id={`media-file-${sanitizeKey(ky)}`} data-testid="media-row" data-filename={ky} data-selected={fi === selectedIdx} className="mrow" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto auto", gap: 10, alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border)", background: fi === selectedIdx ? "rgba(99,102,241,0.14)" : it.dir ? "var(--surface-2)" : "var(--surface)", cursor: "pointer", userSelect: "none" }} onClick={() => tapItem(it)} onDoubleClick={() => openItem(it)} title="Click to select, double-click to open">
                    <div data-testid="media-row-name" style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                      <i className={`bi ${it.dir ? "bi-folder-fill" : catIcon[fileCategory(it.name)]}`} style={{ color: it.dir ? "#f59e0b" : "var(--accent)" }} />
                      {it.dir ? (
                        <button data-testid="media-row-open-folder" onClick={(e) => { e.stopPropagation(); tapItem(it); }} onDoubleClick={(e) => { e.stopPropagation(); openItem(it); }} title={`${it.name} — click to select, double-click to open`} style={{ background: "none", border: 0, color: "var(--text)", fontWeight: 600, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, maxWidth: "100%" }}>{it.name}</button>
                      ) : (
                        <button data-testid="media-row-open-file" onClick={(e) => { e.stopPropagation(); tapItem(it); }} onDoubleClick={(e) => { e.stopPropagation(); openItem(it); }} title={`${displayName(it)} — click to select, double-click to open`} style={{ background: "none", border: 0, color: "var(--text)", fontWeight: 500, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: 0, minWidth: 0, maxWidth: "100%" }}>{displayName(it)}</button>
                      )}
                    </div>
                    <span data-testid="media-row-size" className="small mcol-size" style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtSize(it.size)}</span>
                    <span data-testid="media-row-time" className="small mcol-time" style={{ color: "var(--muted)", whiteSpace: "nowrap" }} title={it.created ? new Date(it.created).toLocaleString() : ""}>{timeAgo(it.created || it.mtime)}</span>
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
        if (!viewerOpen || shownViewerIdx == null || !viewable[shownViewerIdx]) return null;
        const it = viewable[shownViewerIdx];
        const label = displayName(it);
        const keyName = rowKey(it);
        // Quit keeps the selection (already synced while browsing) and never scrolls.
        const handleClose = () => setViewerKey(null);
        return (
          <div data-testid="media-viewer">
            <FileViewer
              src={toMediaUrl(folder, keyName)}
              title={label}
              filePath={folder ? `${folder}/${keyName}` : keyName}
              url=""
              viewable={viewable}
              idx={shownViewerIdx}
              onClose={handleClose}
              onPrev={() => goViewer(shownViewerIdx - 1)}
              onNext={() => goViewer(shownViewerIdx + 1)}
              onGoto={goViewer}
              onDeleted={handleViewerDeleted}
            />
          </div>
        );
      })()}
      {showHelp && !viewerOpen && <ShortcutsHelp active="library" onClose={() => setShowHelp(false)} />}
      </div>
    </div>
  );
}