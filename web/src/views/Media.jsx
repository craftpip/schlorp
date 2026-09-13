import { useEffect, useState, useRef, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import FileViewer from "../components/FileViewer";
import ShortcutsHelp from "../components/ShortcutsHelp";
import PlaylistHoverMenu from "../components/PlaylistHoverMenu.jsx";
import { usePlaylists, playlistKeyForMedia } from "../store/PlaylistsContext.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import PromptModal from "../components/PromptModal.jsx";
import AlertModal from "../components/AlertModal.jsx";

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
  // filtered/viewable and playlistItemsForView are assigned after playlist state (which defines activePlId etc.) to avoid TDZ

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
  const rowKey = (it) => {
    if (it && it._isPlaylistItem) return it.rel || it.name;
    return isFlat ? it.rel || it.name : it.name;
  };
  const displayName = (it) => {
    if (it && it._isPlaylistItem) return String(it.rel || it.name).replace(/\//g, " > ");
    return isFlat ? String(it.rel || it.name).replace(/\//g, " > ") : it.name;
  };
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
  // Playlists (015)
  const { playlists, createPlaylist, renamePlaylist, deletePlaylist, removeItem: removePlaylistItem, refresh: refreshPlaylists, toggleItem: togglePlaylistItem } = usePlaylists();
  const activePlId = searchParams.get("pl") || searchParams.get("p") || "";
  const activePlaylist = activePlId ? playlists.find((p) => p.id === activePlId) : null;
  const [playlistDetail, setPlaylistDetail] = useState(null);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [playlistErr, setPlaylistErr] = useState("");
  const [editingPlId, setEditingPlId] = useState(null);
  const [editingPlName, setEditingPlName] = useState("");
  const [openMenuKey, setOpenMenuKey] = useState(null);
  const [fMenuKey, setFMenuKey] = useState(null);
  const fHeldRef = useRef(false);
  const [hoveredPlId, setHoveredPlId] = useState(null);
  const [promptState, setPromptState] = useState({ open: false, id: null, value: "" });
  const [confirmState, setConfirmState] = useState({ open: false, id: null, name: "" });
  const [alertState, setAlertState] = useState({ open: false, title: "", message: "" });
  const [deleteTarget, setDeleteTarget] = useState(null);
  const playlistMenuCloseTimer = useRef(null);
  const playlistKey = (it) => {
    if (it && it._isPlaylistItem) return rowKey(it);
    return playlistKeyForMedia(folder, rowKey(it));
  };
  const bookmarkedKeys = useMemo(() => {
    const s = new Set();
    for (const pl of playlists) for (const k of pl.items || []) s.add(k);
    return s;
  }, [playlists]);
  const playlistItemsForView = (() => {
    if (!activePlId || !playlistDetail || !Array.isArray(playlistDetail.items)) return null;
    return playlistDetail.items.filter((it) => !it.missing).map((it) => {
      const key = it.key;
      const name = it.name || key.split("/").pop() || key;
      const rel = key;
      return {
        name,
        rel,
        dir: false,
        size: it.size || 0,
        mtime: it.mtime || it.addedAt,
        created: it.created || it.mtime || it.addedAt,
        thumb: it.thumb || null,
        playlistKey: key,
        _isPlaylistItem: true,
      };
    });
  })();
  const inPlaylistView = !!activePlId;
  const filtered = (() => {
    let base = inPlaylistView && playlistItemsForView ? playlistItemsForView : items;
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
  const isEmptyForList = filtered.length === 0 && (!folder ? playlists.length === 0 : true);
  // Playlists as selectable items for keyboard nav (root only, not in playlist view) — shown first like folders
  const playlistsAsItems = !folder && !inPlaylistView ? playlists.map((pl) => ({ _isPlaylist: true, _pl: pl, name: pl.name, dir: false, plKey: `playlist:${pl.id}` })) : [];
  const allSelectable = [...playlistsAsItems, ...filtered];
  const selectableKey = (it) => (it && it._isPlaylist ? it.plKey : rowKey(it));
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
      // else select the first item (playlists first when in root, per user request).
      const keyOf = (it) => (isFlat ? it.rel || it.name : it.name);
      const allKeys = new Set(fresh.map(keyOf));
      const isRootForSelect = !f && !activePlId;
      if (isRootForSelect) {
        for (const pl of playlists) allKeys.add(`playlist:${pl.id}`);
      }
      const curSel = selKey;
      if (pending && allKeys.has(pending)) {
        if (pending !== curSel) setParam("sel", pending);
      } else if (curSel && allKeys.has(curSel)) {
        // keep — selection survives reload/refresh
      } else if (allKeys.size) {
        if (isRootForSelect && playlists.length) setParam("sel", `playlist:${playlists[0].id}`);
        else if (fresh.length) setParam("sel", keyOf(fresh[0]));
        else if (curSel) setParam("sel", "");
      } else if (curSel) {
        setParam("sel", "");
      }
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  // Fresh content (mount / folder / flat change / explicit refresh) scrolls once
  // to the selection. Delete-triggered reloads must NOT scroll (plan 014).
  const refresh = () => { freshLoadRef.current = true; load(folder); };
  // Playlist detail fetch when ?pl is set
  useEffect(() => {
    if (!activePlId) { setPlaylistDetail(null); setPlaylistLoading(false); return; }
    setPlaylistLoading(true);
    fetch(`/api/playlists/${encodeURIComponent(activePlId)}`).then((r) => r.json()).then((j) => {
      if (!j.ok) throw new Error(j.error || "failed");
      setPlaylistDetail(j.playlist);
    }).catch(() => setPlaylistDetail(null)).finally(() => setPlaylistLoading(false));
  }, [activePlId]);
  // Keep detail in sync when playlists list updates (e.g. toggle via hover menu)
  useEffect(() => {
    if (!activePlId || !playlistDetail) return;
    const active = playlists.find((p) => p.id === activePlId);
    if (!active) return;
    const curCount = playlistDetail.items ? playlistDetail.items.length : 0;
    const newCount = active.count ?? (active.items ? active.items.length : 0);
    if (active.updatedAt !== playlistDetail.updatedAt || newCount !== curCount) {
      fetch(`/api/playlists/${encodeURIComponent(activePlId)}`).then((r) => r.json()).then((j) => { if (j.ok) setPlaylistDetail(j.playlist); }).catch(() => {});
    }
  }, [playlists]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (playlistMenuCloseTimer.current) clearTimeout(playlistMenuCloseTimer.current); }, []);
  const handleCreatePlaylist = async () => {
    const name = String(newPlaylistName || "").trim();
    if (!name) return;
    setCreatingPlaylist(true); setPlaylistErr("");
    try { await createPlaylist(name); setNewPlaylistName(""); } catch (e) { setPlaylistErr(e.message || String(e)); } finally { setCreatingPlaylist(false); }
  };
  const openPlaylist = (id) => {
    const ns = new URLSearchParams(searchParams);
    ns.set("pl", id);
    ns.delete("p");
    // clear folder crumbs when opening playlist? keep folder for context but playlist view ignores it
    setSearchParams(ns, { replace: true });
  };
  const closePlaylist = () => {
    const ns = new URLSearchParams(searchParams);
    ns.delete("pl"); ns.delete("p");
    setSearchParams(ns, { replace: true });
  };
  useEffect(() => { freshLoadRef.current = true; load(folder, { clear: true }); }, [folder, isFlat]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (searchParams.get("open")) setParam("open", "");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Derived selection: index follows the ?s key (single select, now includes playlists when in root)
  const selectedIdx = selKey ? allSelectable.findIndex((it) => selectableKey(it) === selKey) : -1;
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
    if (viewerOpen || confirmState.open || promptState.open || alertState.open || !!deleteTarget) return;
    const moveSelection = (delta) => {
      if (!allSelectable.length) return;
      const base = selectedIdx !== -1 ? selectedIdx : (delta > 0 ? -1 : 0);
      const next = Math.min(allSelectable.length - 1, Math.max(0, base + delta));
      keyboardScrollRef.current = true;
      setSelectedKey(selectableKey(allSelectable[next]));
    };
    const onKey = (e) => {
      if (confirmState.open || promptState.open || alertState.open || !!deleteTarget) return;
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
        if (!allSelectable.length || selectedIdx === -1) return;
        e.preventDefault();
        const it = allSelectable[selectedIdx];
        if (it) {
          if (it._isPlaylist) openPlaylist(it._pl.id);
          else if (it.dir) goFolder(it.name);
          else openViewer(it);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerOpen, allSelectable, selectedIdx, searchParams, showHelp, confirmState.open, promptState.open, alertState.open, deleteTarget]);

  // Hold-F: while F is held, keep the save popup open for the selected file;
  // 1-9 toggles playlists 1-9. Release F closes. Grid + list, viewer closed.
  useEffect(() => {
    const isEditable = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const selectedFile = () => {
      if (selectedIdx == null || selectedIdx < 0 || selectedIdx >= allSelectable.length) return null;
      const it = allSelectable[selectedIdx];
      if (!it || it._isPlaylist || it.dir) return null;
      return it;
    };
    const onKeyDown = (e) => {
      if (viewerOpen || confirmState.open || promptState.open || alertState.open || !!deleteTarget) return;
      if (isEditable(e.target)) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      if (k === "f" || k === "F") {
        if (e.repeat) { e.preventDefault(); return; }
        const it = selectedFile();
        if (!it) return;
        e.preventDefault();
        fHeldRef.current = true;
        setFMenuKey(selectableKey(it));
        return;
      }
      if (fHeldRef.current && /^[1-9]$/.test(k)) {
        const idx = parseInt(k, 10) - 1;
        if (idx < playlists.length) {
          const it = selectedFile();
          if (!it) return;
          e.preventDefault();
          e.stopPropagation();
          const mediaKey = playlistKey(it);
          togglePlaylistItem(playlists[idx].id, mediaKey).catch(() => {});
        }
      }
    };
    const onKeyUp = (e) => {
      const k = e.key;
      if (k === "f" || k === "F") {
        if (fHeldRef.current) {
          fHeldRef.current = false;
          setFMenuKey(null);
        }
      }
    };
    const onBlur = () => {
      if (fHeldRef.current) {
        fHeldRef.current = false;
        setFMenuKey(null);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerOpen, allSelectable, selectedIdx, playlists, confirmState.open, promptState.open, alertState.open, deleteTarget]);

  // Follow selection while F is held (arrow keys move the popup with it).
  useEffect(() => {
    if (!fHeldRef.current) return;
    if (viewerOpen || confirmState.open || promptState.open || alertState.open || !!deleteTarget) {
      fHeldRef.current = false;
      setFMenuKey(null);
      return;
    }
    if (selectedIdx == null || selectedIdx < 0 || selectedIdx >= allSelectable.length) {
      setFMenuKey(null);
      return;
    }
    const it = allSelectable[selectedIdx];
    if (!it || it._isPlaylist || it.dir) {
      setFMenuKey(null);
      return;
    }
    setFMenuKey(selectableKey(it));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx, selKey]);

  const goFolder = (name) => {
    const ns = new URLSearchParams(searchParams);
    ns.set("f", encB64(folder ? `${folder}/${name}` : name));
    ns.delete("folder");
    setSearchParams(ns);
  };
  const goUp = () => {
    if (inPlaylistView) { closePlaylist(); return; }
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
  const delFile = (it) => {
    setDeleteTarget(it);
  };
  const confirmDeleteFile = async () => {
    const it = deleteTarget;
    if (!it) return;
    setDeleteTarget(null);
    const key = rowKey(it);
    const isPlItem = !!it._isPlaylistItem;
    const slash = key.lastIndexOf("/");
    let parent, base;
    if (isPlItem) {
      if (slash === -1) { parent = ""; base = key; }
      else { parent = key.slice(0, slash); base = key.slice(slash + 1); }
    } else {
      if (slash === -1) { parent = folder; base = key; }
      else { parent = folder ? `${folder}/${key.slice(0, slash)}` : key.slice(0, slash); base = key.slice(slash + 1); }
    }
    const r = await fetch(`/api/media?folder=${encodeURIComponent(parent)}&name=${encodeURIComponent(base)}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setAlertState({ open: true, title: "Delete failed", message: j.error || "delete failed" }); return; }
    // Keep selection on the neighbour (next ?? prev) instead of jumping to the top.
    const fi = filtered.findIndex((x) => rowKey(x) === key);
    if (fi !== -1) {
      const next = filtered[fi + 1] || filtered[fi - 1];
      pendingSelectRef.current = next ? rowKey(next) : null;
    }
    if (inPlaylistView && activePlId) {
      try {
        const rr = await fetch(`/api/playlists/${encodeURIComponent(activePlId)}`);
        const jj = await rr.json();
        if (jj.ok) setPlaylistDetail(jj.playlist);
      } catch {}
      refreshPlaylists();
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
    const isPlItem = !!it._isPlaylistItem;
    if (it.thumb && !isPlItem) return toMediaUrl(folder, it.thumb);
    if (isPlItem && it.thumb) return "/media/" + String(it.thumb).split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const cat = fileCategory(it.name);
    if (cat === "photo" || cat === "gif") {
      if (isPlItem) return "/media/" + String(it.rel || it.name).split("/").filter(Boolean).map(encodeURIComponent).join("/");
      return toMediaUrl(folder, it.rel || it.name);
    }
    // Video without a `-poster.*` sibling: serve the cover art embedded in the
    // file itself (if any). The endpoint only copies an attached-pic stream
    // (no decode/transcode); 404s fall back to the icon via onError.
    if (cat === "video") {
      const qs = new URLSearchParams();
      if (isPlItem) {
        qs.set("key", String(it.rel || it.name));
      } else {
        if (folder) qs.set("folder", folder);
        qs.set("key", rowKey(it));
      }
      return `/api/mediathumb?${qs.toString()}`;
    }
    return null;
  };
  // Google-Drive-style folder chip (grid view only): compact fixed-size row
  // item, not a tall preview box — folders have no thumbnails.
  const FOLDER_CHIP_W = 220;
  const FOLDER_CHIP_H = 56;
  const renderFolderChip = (it) => {
    const selected = selKey === rowKey(it);
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
  const renderPlaylistChip = (pl) => {
    const plKey = `playlist:${pl.id}`;
    const selected = selKey === plKey;
    const count = pl.count ?? (pl.items ? pl.items.length : 0);
    return (
      <div
        key={pl.id}
        id={`media-playlist-${pl.id}`}
        data-testid="media-tile-playlist"
        data-filename={plKey}
        data-selected={selected}
        className="media-tile-playlist"
        onClick={() => setSelectedKey(plKey)}
        onDoubleClick={() => openPlaylist(pl.id)}
        onMouseEnter={() => setHoveredPlId(pl.id)}
        onMouseLeave={() => setHoveredPlId((cur) => (cur === pl.id ? null : cur))}
        title={`${pl.name} · ${count} items — click to select, double-click to open`}
        style={{ width: FOLDER_CHIP_W, height: FOLDER_CHIP_H, flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, padding: "0 8px 0 12px", overflow: "hidden", borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--border)", outline: selected ? "2px solid #6366f1" : "none", cursor: "pointer", position: "relative" }}
      >
        <i className="bi bi-collection-play-fill" style={{ fontSize: 22, color: "#6366f1", flex: "0 0 auto" }} />
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pl.name}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4, flex: "0 0 auto", position: "relative", minWidth: 48, justifyContent: "flex-end" }}>
              <span style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap", marginRight: 6, transform: hoveredPlId === pl.id || selected ? "translateX(-52px)" : "translateX(0)", transition: "transform .15s" }}>{count}</span>
          <span className="playlist-chip-actions" style={{ display: "flex", gap: 2, position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)", opacity: hoveredPlId === pl.id || selected ? 1 : 0, transition: "opacity .15s", background: "var(--surface-2)", paddingLeft: 6 }}>
            <button data-testid={`playlist-chip-edit-${pl.id}`} title="Rename" onClick={(e) => { e.stopPropagation(); setPromptState({ open: true, id: pl.id, value: pl.name }); }} style={{ background: "none", border: 0, padding: 4, cursor: "pointer", color: "var(--muted)" }}><i className="bi bi-pencil" /></button>
            <button data-testid={`playlist-chip-delete-${pl.id}`} title="Delete playlist" onClick={(e) => { e.stopPropagation(); setConfirmState({ open: true, id: pl.id, name: pl.name }); }} style={{ background: "none", border: 0, padding: 4, cursor: "pointer", color: "#f87171" }}><i className="bi bi-trash" /></button>
          </span>
        </span>
      </div>
    );
  };
  const renderTile = (it, fi, w, h) => {
    const rk = rowKey(it);
    // A thumbnail URL that 404s (no poster sibling, no embedded cover art)
    // falls back to the icon placeholder instead of a blank black tile.
    const src = imgErr[rk] ? null : thrumb(it);
    const selected = selKey === rk;
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
    const pk = !isDir ? playlistKey(it) : null;
    const menuOpen = openMenuKey === rk || fMenuKey === rk;
    const viaF = fMenuKey === rk;
    const isBookmarked = pk ? bookmarkedKeys.has(pk) : false;
    const handleMenuEnter = () => { if (playlistMenuCloseTimer.current) { clearTimeout(playlistMenuCloseTimer.current); playlistMenuCloseTimer.current = null; } setOpenMenuKey(rk); };
    const handleMenuLeave = () => { if (playlistMenuCloseTimer.current) clearTimeout(playlistMenuCloseTimer.current); playlistMenuCloseTimer.current = setTimeout(() => setOpenMenuKey((cur) => (cur === rk ? null : cur)), 120); };
    const isCoarse = isCoarsePointer();
    return (
      <div
        key={isFlat ? it.rel || it.name : it.name}
        id={`media-file-${sanitizeKey(rowKey(it))}`}
        data-testid={isDir ? "media-tile-folder" : "media-tile-file"}
        className={isDir ? "media-tile-folder" : "media-tile-file"}
        data-filename={rowKey(it)}
        data-selected={selected}
        onClick={() => tapItem(it)}
        onDoubleClick={() => openItem(it)}
        title={`${displayName(it)} — click to select, double-click to open`}
        style={{ position: "relative", flex: isDir ? "0 0 auto" : "0 0 auto", width: w, height: h, overflow: menuOpen ? "visible" : "hidden", zIndex: menuOpen ? 60 : "auto", borderRadius: 0, background: isDir ? "var(--surface-2)" : "var(--surface-2)", outline: selected ? "2px solid var(--accent)" : "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}
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
        {!isDir && (
          <div
            className="media-tile-playlist-btn-wrap"
            style={{ position: "absolute", top: 6, left: 6, zIndex: 4, opacity: isCoarse || menuOpen || isBookmarked ? 1 : 0, transition: "opacity .12s" }}
            onMouseEnter={handleMenuEnter}
            onMouseLeave={handleMenuLeave}
          >
            <button
              data-testid="media-tile-playlist-btn"
              type="button"
              onClick={(e) => { e.stopPropagation(); if (isCoarse) setOpenMenuKey((cur) => (cur === rk ? null : rk)); else setOpenMenuKey(rk); }}
              style={{ width: 28, height: 28, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: menuOpen ? "rgba(99,102,241,.9)" : isBookmarked ? "rgba(99,102,241,.85)" : "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", cursor: "pointer" }}
            >
              <i className={`bi ${isBookmarked ? "bi-bookmark-fill" : "bi-bookmark"}`} style={{ fontSize: 12 }} />
            </button>
            {menuOpen && pk && (
              <div style={{ position: "absolute", top: 34, left: 0, zIndex: 90 }} onClick={(e) => e.stopPropagation()}>
                <PlaylistHoverMenu mediaKey={pk} placement="left" showIndex={viaF} />
              </div>
            )}
          </div>
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
      // For playlist items filePath is already absolute key, so prefix check may not match — keep as is if _isPlaylistItem
      const cur = viewable.find((v) => String(deletedRef).endsWith(rowKey(v)));
      if (cur && cur._isPlaylistItem) deletedKey = rowKey(cur);
      else deletedKey = prefix && s.startsWith(prefix) ? s.slice(prefix.length) : s;
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
    if (inPlaylistView && activePlId) {
      fetch(`/api/playlists/${encodeURIComponent(activePlId)}`).then((r) => r.json()).then((j) => { if (j.ok) setPlaylistDetail(j.playlist); }).catch(() => {});
      refreshPlaylists();
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
        <button data-testid="media-breadcrumb-root" className="btn btn-sm btn-outline-secondary" onClick={() => { const ns = new URLSearchParams(searchParams); ns.delete("f"); ns.delete("folder"); ns.delete("pl"); ns.delete("p"); setSearchParams(ns); }} disabled={!folder && !inPlaylistView}><i className="bi bi-house" /> Media</button>
        {!inPlaylistView && crumbs.map((c, i) => (
          <span key={i} data-testid={`media-breadcrumb-${c}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--muted)" }}>/</span>
            <button className="btn btn-sm btn-outline-secondary" onClick={() => goCrumb(i)}>{c}</button>
          </span>
        ))}
        {inPlaylistView && activePlaylist && (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--muted)" }}>/</span>
            <span className="btn btn-sm btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><i className="bi bi-collection-play-fill" /> {activePlaylist.name} · {activePlaylist.count ?? (activePlaylist.items ? activePlaylist.items.length : 0)}</span>
          </span>
        )}
        {inPlaylistView && playlistDetail && !activePlaylist && (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--muted)" }}>/</span>
            <span className="btn btn-sm btn-primary">{playlistDetail.name}</span>
          </span>
        )}
        {(folder || inPlaylistView) && <button data-testid="media-up" className="btn btn-sm btn-outline-secondary" onClick={goUp} style={{ marginLeft: 8 }}><i className="bi bi-arrow-90deg-up" /> Up</button>}
      </div>
      </div>

      <div data-testid="media-content" className="media-full">
      {err && <div data-testid="media-error" className="card" style={{ padding: 12, color: "var(--danger)", marginBottom: 12 }}>{err}</div>}

      <style>{`.media-tile-file:hover .media-tile-playlist-btn-wrap{opacity:1 !important} .media-row:hover .media-row-playlist-btn{opacity:1 !important} .media-tile-playlist:hover .playlist-chip-actions{opacity:1 !important} .media-row-playlist:hover .playlist-row-actions{opacity:1 !important}`}</style>
      {isGrid ? (
        <div data-testid="media-grid-card" className="card media-lib-card">
          <div data-testid="media-grid" ref={gridRef} className="card-body" style={{ padding: GRID_GAP }}>
            {inPlaylistView ? (
              playlistLoading ? <div data-testid="media-loading" style={{ padding: 20, gridColumn: "1 / -1", color: "var(--muted)" }}>Loading playlist…</div> : !playlistDetail ? <div data-testid="media-error" style={{ padding: 20, gridColumn: "1 / -1", color: "var(--danger)" }}>Playlist not found</div> : filtered.length === 0 ? <div data-testid="media-empty" className="empty" style={{ padding: 20, gridColumn: "1 / -1" }}><i className="bi bi-collection-play" /> Empty playlist — add files from Media</div> : !gridW ? <div data-testid="media-grid-measuring" style={{ padding: 20, color: "var(--muted)" }}>Measuring…</div> : (
                <div data-testid="media-grid-tiles" className="media-grid-tiles" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span className="small" style={{ color: "var(--muted)", fontWeight: 700 }}><i className="bi bi-collection-play-fill" style={{ color: "#6366f1", marginRight: 6 }} />{playlistDetail.name} · {playlistDetail.items.length} items</span>
                    <span style={{ flex: 1 }} />
                    <button className="btn btn-sm btn-outline-secondary" onClick={closePlaylist} title="Back to Media"><i className="bi bi-arrow-90deg-up" /> Back</button>
                  </div>
                  <div data-testid="media-grid-files" style={{ display: "flex", flexWrap: "wrap", gap: GRID_GAP }}>
                    {fileRows.map((row) => renderTile(row.it, row.i, row.w, row.h))}
                  </div>
                </div>
              )
            ) : loading && items.length === 0 ? <div data-testid="media-loading" style={{ padding: 20, gridColumn: "1 / -1", color: "var(--muted)" }}>Loading…</div> : !gridW ? <div data-testid="media-grid-measuring" style={{ padding: 20, color: "var(--muted)" }}>Measuring…</div> : (
              <div data-testid="media-grid-tiles" className="media-grid-tiles" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {(dirRows.length > 0 || (!folder && playlists.length > 0)) && (
                  <div data-testid="media-grid-folders">
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                      <span className="small" style={{ color: "var(--muted)", fontWeight: 700 }}><i className="bi bi-folder-fill" style={{ color: "#f59e0b", marginRight: 4 }} />Folders</span>
                      <span className="badge text-bg-secondary">{!folder ? dirRows.length + playlists.length : dirRows.length}</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: GRID_GAP }}>
                      {!folder && playlists.map((pl) => renderPlaylistChip(pl))}
                      {dirRows.map((row) => renderFolderChip(row.it))}
                    </div>
                  </div>
                )}
                {(fileRows.length > 0 || (!playlists.length && dirRows.length === 0 && filtered.length === 0)) && (
                  <div data-testid="media-grid-files" style={{ display: "flex", flexWrap: "wrap", gap: GRID_GAP }}>
                    {filtered.length === 0 ? (!loading ? <div data-testid="media-empty" className="empty" style={{ padding: 20, gridColumn: "1 / -1", width: "100%", textAlign: "center" }}><i className="bi bi-inbox" /> No files — download something!</div> : null) : fileRows.map((row) => renderTile(row.it, row.i, row.w, row.h))}
                  </div>
                )}
                {filtered.length > 0 && fileRows.length === 0 && !inPlaylistView && <div data-testid="media-empty" className="empty" style={{ padding: 12 }}><i className="bi bi-inbox" /> No files in this folder</div>}
              </div>
            )}
          </div>
        </div>
      ) : (
      <div data-testid="media-list-card" className="card media-lib-card">
        <div className="card-body" style={{ padding: 0, display: "grid", gridTemplateColumns: "28px minmax(0, 1fr) auto auto auto", gap: "0 10px", alignItems: "center" }}>
          <div data-testid="media-list-header" className="mrow" style={{ display: "grid", gridTemplateColumns: "subgrid", gridColumn: "1 / -1", gap: "0 10px", fontSize: 12, fontWeight: 700, color: "var(--muted)", padding: "10px 14px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
            <span />{sortBtn("name", "Name")}<span className="mcol-size" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>{sortBtn("size", "Size")}</span><span className="mcol-time" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>{sortBtn("time", "Time")}</span><span data-testid="media-header-actions" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>Actions</span>
          </div>
          {inPlaylistView ? (
            playlistLoading ? <div data-testid="media-loading" style={{ padding: 20, gridColumn: "1 / -1", color: "var(--muted)" }}>Loading playlist…</div> : !playlistDetail ? <div data-testid="media-error" style={{ padding: 20, gridColumn: "1 / -1", color: "var(--danger)" }}>Playlist not found</div> : (
              <>
                {filtered.length === 0 ? <div data-testid="media-empty" className="empty" style={{ padding: 20, gridColumn: "1 / -1" }}><i className="bi bi-collection-play" /> Empty playlist — add files from Media</div> : (
                  <div data-testid="media-list-rows" style={{ display: "contents" }}>
                    {filtered.map((it) => {
                      const ky = rowKey(it);
                      const pk = playlistKey(it);
                      const menuOpen = openMenuKey === ky || fMenuKey === ky;
                      const viaF = fMenuKey === ky;
                      const isSel = selKey === ky;
                      const isBookmarked = bookmarkedKeys.has(pk);
                      return (
                        <div key={ky} id={`media-file-${sanitizeKey(ky)}`} data-testid="media-row" data-filename={ky} data-selected={isSel} className="mrow" style={{ display: "grid", gridTemplateColumns: "subgrid", gridColumn: "1 / -1", gap: "0 10px", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border)", background: isSel ? "rgba(99,102,241,0.14)" : "var(--surface)", cursor: "pointer", userSelect: "none" }} onClick={() => tapItem(it)} onDoubleClick={() => openItem(it)} title={displayName(it)}>
                          <div style={{ position: "relative", display: "grid", placeItems: "center" }} onMouseEnter={() => { if (playlistMenuCloseTimer.current) clearTimeout(playlistMenuCloseTimer.current); setOpenMenuKey(ky); }} onMouseLeave={() => { if (playlistMenuCloseTimer.current) clearTimeout(playlistMenuCloseTimer.current); playlistMenuCloseTimer.current = setTimeout(() => setOpenMenuKey((cur) => cur === ky ? null : cur), 120); }}>
                            <button data-testid="media-row-playlist-btn" className="media-row-playlist-btn" type="button" onClick={(e) => { e.stopPropagation(); const coarse = isCoarsePointer(); if (coarse) setOpenMenuKey((cur) => cur === ky ? null : ky); else setOpenMenuKey(ky); }} style={{ width: 28, height: 28, padding: 0, borderRadius: 999, border: isBookmarked ? "1px solid rgba(99,102,241,.35)" : "1px solid var(--border)", background: menuOpen ? "rgba(99,102,241,.15)" : isBookmarked ? "rgba(99,102,241,.12)" : "var(--surface-2)", color: isBookmarked ? "#6366f1" : "var(--muted)", display: "grid", placeItems: "center", cursor: "pointer", opacity: 1 }}><i className={`bi ${isBookmarked ? "bi-bookmark-fill" : "bi-bookmark"}`} /></button>
                            {menuOpen && <div style={{ position: "absolute", top: 34, left: 0, zIndex: 90 }}><PlaylistHoverMenu mediaKey={pk} showIndex={viaF} /></div>}
                          </div>
                          <div data-testid="media-row-name" style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, marginLeft: "5px" }}>
                            <i className={`bi ${catIcon[fileCategory(it.name)]}`} style={{ color: "var(--accent)", display: "grid", placeItems: "center", width: 18, height: 18, fontSize: 14, lineHeight: 1, flex: "0 0 auto", transform: "translateY(1px)" }} />
                            <button data-testid="media-row-open-file" onClick={(e) => { e.stopPropagation(); tapItem(it); }} onDoubleClick={(e) => { e.stopPropagation(); openItem(it); }} style={{ background: "none", border: 0, color: "var(--text)", fontWeight: 500, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: 0, minWidth: 0, maxWidth: "100%" }}>{displayName(it)}</button>
                          </div>
                          <span data-testid="media-row-size" className="small mcol-size" style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtSize(it.size)}</span>
                          <span data-testid="media-row-time" className="small mcol-time" style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", color: "var(--muted)", whiteSpace: "nowrap" }} title={it.created ? new Date(it.created).toLocaleString() : ""}>{timeAgo(it.created || it.mtime)}</span>
                          <div data-testid="media-row-actions" style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
                            <button data-testid="media-row-playlist-remove" className="btn btn-sm btn-outline-secondary" onClick={async (e) => { e.stopPropagation(); try { await removePlaylistItem(activePlId, pk); const r = await fetch(`/api/playlists/${encodeURIComponent(activePlId)}`); const j = await r.json(); if (j.ok) setPlaylistDetail(j.playlist); } catch {} }} title="Remove from playlist" style={{ color: "#f87171" }}><i className="bi bi-x-lg" /></button>
                            <button data-testid="media-row-action-delete" className="btn btn-sm btn-outline-secondary" onClick={(e) => { e.stopPropagation(); delFile(it); }}><i className="bi bi-trash" style={{ color: "#f87171" }} /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )
          ) : (
            <>
              {loading && items.length === 0 ? <div data-testid="media-loading" style={{ padding: 20, gridColumn: "1 / -1", color: "var(--muted)" }}>Loading…</div> : (isEmptyForList ? (!loading ? <div data-testid="media-empty" className="empty" style={{ padding: 20, gridColumn: "1 / -1" }}><i className="bi bi-inbox" /> No files — download something!</div> : null) : (
                <div data-testid="media-list-rows" style={{ display: "contents" }}>
                  {!folder && playlists.map((pl) => {
                    const plKey = `playlist:${pl.id}`;
                    const sel = selKey === plKey;
                    return (
                      <div key={pl.id} id={`media-playlist-row-${pl.id}`} data-testid="media-row-playlist" data-filename={plKey} data-selected={sel} className="mrow mrow-dir media-row-playlist" style={{ display: "grid", gridTemplateColumns: "subgrid", gridColumn: "1 / -1", gap: "0 10px", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border)", background: sel ? "rgba(99,102,241,0.14)" : "var(--surface-2)", cursor: "pointer", userSelect: "none" }} onClick={() => setSelectedKey(plKey)} onDoubleClick={() => openPlaylist(pl.id)} title={`${pl.name} — click to select, double-click to open`}>
                        <div data-testid="media-row-name" style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, marginLeft: "5px", gridColumn: "1 / span 2" }}>
                          <i className="bi bi-collection-play-fill" style={{ color: "#6366f1", display: "grid", placeItems: "center", width: 18, height: 18, fontSize: 14, lineHeight: 1, flex: "0 0 auto", transform: "translateY(1px)" }} />
                          <button data-testid="media-row-open-playlist" onClick={(e) => { e.stopPropagation(); setSelectedKey(plKey); }} onDoubleClick={(e) => { e.stopPropagation(); openPlaylist(pl.id); }} title={`${pl.name} — click to select, double-click to open`} style={{ background: "none", border: 0, color: "var(--text)", fontWeight: 600, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, maxWidth: "100%", flex: 1, padding: 0, marginLeft: "5px" }}>{pl.name}</button>
                          <span className="playlist-row-actions" style={{ display: "inline-flex", gap: 4, opacity: sel ? 1 : 0, transition: "opacity .12s", marginLeft: 6, flex: "0 0 auto" }}>
                            <button data-testid={`playlist-row-edit-${pl.id}`} title="Rename" onClick={(e) => { e.stopPropagation(); setPromptState({ open: true, id: pl.id, value: pl.name }); }} className="btn btn-sm btn-outline-secondary" style={{ padding: "2px 6px" }}><i className="bi bi-pencil" /></button>
                            <button data-testid={`playlist-row-delete-${pl.id}`} title="Delete" onClick={(e) => { e.stopPropagation(); setConfirmState({ open: true, id: pl.id, name: pl.name }); }} className="btn btn-sm btn-outline-secondary" style={{ padding: "2px 6px", color: "#f87171" }}><i className="bi bi-trash" /></button>
                          </span>
                        </div>
                        <span className="small mcol-size" style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", color: "var(--muted)" }}>{pl.count ?? (pl.items ? pl.items.length : 0)} items</span>
                        <span className="small mcol-time" style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", color: "var(--muted)" }}>{timeAgo(pl.updatedAt || pl.createdAt)}</span>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
                          <button data-testid={`playlist-row-open-${pl.id}`} className="btn btn-sm btn-outline-secondary" onClick={(e) => { e.stopPropagation(); openPlaylist(pl.id); }}><i className="bi bi-folder2-open" /></button>
                        </div>
                      </div>
                    );
                  })}
                  {filtered.map((it) => {
                    const ky = rowKey(it);
                    const pk = !it.dir ? playlistKey(it) : null;
                    const menuOpen = openMenuKey === ky || fMenuKey === ky;
                    const viaF = fMenuKey === ky;
                    const isSel = selKey === ky;
                    const isBookmarked = pk ? bookmarkedKeys.has(pk) : false;
                    return (
                      <div key={isFlat ? it.rel || it.name : it.name} id={`media-file-${sanitizeKey(ky)}`} data-testid="media-row" data-filename={ky} data-selected={isSel} className={it.dir ? "mrow mrow-dir" : "mrow mrow-file"} style={{ display: "grid", gridTemplateColumns: "subgrid", gridColumn: "1 / -1", gap: "0 10px", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border)", background: isSel ? "rgba(99,102,241,0.14)" : it.dir ? "var(--surface-2)" : "var(--surface)", cursor: "pointer", userSelect: "none" }} onClick={() => tapItem(it)} onDoubleClick={() => openItem(it)} title="Click to select, double-click to open">
                        {!it.dir && (
                          <div style={{ position: "relative", display: "grid", placeItems: "center" }} onMouseEnter={() => { if (playlistMenuCloseTimer.current) clearTimeout(playlistMenuCloseTimer.current); setOpenMenuKey(ky); }} onMouseLeave={() => { if (playlistMenuCloseTimer.current) clearTimeout(playlistMenuCloseTimer.current); playlistMenuCloseTimer.current = setTimeout(() => setOpenMenuKey((cur) => cur === ky ? null : cur), 120); }}>
                            <button data-testid="media-row-playlist-btn" className="media-row-playlist-btn" type="button" onClick={(e) => { e.stopPropagation(); const coarse = isCoarsePointer(); if (coarse) setOpenMenuKey((cur) => cur === ky ? null : ky); else setOpenMenuKey(ky); }} style={{ width: 28, height: 28, padding: 0, borderRadius: 999, border: isBookmarked ? "1px solid rgba(99,102,241,.35)" : "1px solid var(--border)", background: menuOpen ? "rgba(99,102,241,.15)" : isBookmarked ? "rgba(99,102,241,.12)" : "var(--surface-2)", color: isBookmarked ? "#6366f1" : "var(--muted)", display: "grid", placeItems: "center", cursor: "pointer", opacity: 1 }}><i className={`bi ${isBookmarked ? "bi-bookmark-fill" : "bi-bookmark"}`} /></button>
                            {menuOpen && pk && <div style={{ position: "absolute", top: 34, left: 0, zIndex: 90 }}><PlaylistHoverMenu mediaKey={pk} showIndex={viaF} /></div>}
                          </div>
                        )}
                        <div data-testid="media-row-name" style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, marginLeft: "5px", ...(it.dir ? { gridColumn: "1 / span 2" } : {}) }}>
                          <i className={`bi ${it.dir ? "bi-folder-fill" : catIcon[fileCategory(it.name)]}`} style={{ color: it.dir ? "#f59e0b" : "var(--accent)", display: "grid", placeItems: "center", width: 18, height: 18, fontSize: 14, lineHeight: 1, flex: "0 0 auto", transform: "translateY(1px)" }} />
                          {it.dir ? (
                            <button data-testid="media-row-open-folder" onClick={(e) => { e.stopPropagation(); tapItem(it); }} onDoubleClick={(e) => { e.stopPropagation(); openItem(it); }} title={`${it.name} — click to select, double-click to open`} style={{ background: "none", border: 0, color: "var(--text)", fontWeight: 600, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, maxWidth: "100%" }}>{it.name}</button>
                          ) : (
                            <button data-testid="media-row-open-file" onClick={(e) => { e.stopPropagation(); tapItem(it); }} onDoubleClick={(e) => { e.stopPropagation(); openItem(it); }} title={`${displayName(it)} — click to select, double-click to open`} style={{ background: "none", border: 0, color: "var(--text)", fontWeight: 500, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: 0, minWidth: 0, maxWidth: "100%" }}>{displayName(it)}</button>
                          )}
                        </div>
                        <span data-testid="media-row-size" className="small mcol-size" style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtSize(it.size)}</span>
                        <span data-testid="media-row-time" className="small mcol-time" style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", color: "var(--muted)", whiteSpace: "nowrap" }} title={it.created ? new Date(it.created).toLocaleString() : ""}>{timeAgo(it.created || it.mtime)}</span>
                        <div data-testid="media-row-actions" style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
                          {it.dir ? (
                            <button data-testid="media-row-action-open" className="btn btn-sm btn-outline-secondary" onClick={(e) => { e.stopPropagation(); goFolder(it.name); }}><i className="bi bi-folder2-open" /></button>
                          ) : (
                            <button data-testid="media-row-action-delete" className="btn btn-sm btn-outline-secondary" onClick={(e) => { e.stopPropagation(); delFile(it); }} style={{ color: "var(--muted)", borderColor: "var(--border)" }}><i className="bi bi-trash" style={{ color: "#f87171" }} /></button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      )}
      {(() => {
        if (!viewerOpen || shownViewerIdx == null || !viewable[shownViewerIdx]) return null;
        const it = viewable[shownViewerIdx];
        const label = displayName(it);
        const keyName = rowKey(it);
        const isPlItem = !!it._isPlaylistItem;
        const viewerSrc = isPlItem ? "/media/" + String(keyName).split("/").filter(Boolean).map(encodeURIComponent).join("/") : toMediaUrl(folder, keyName);
        const viewerFilePath = isPlItem ? String(keyName) : (folder ? `${folder}/${keyName}` : keyName);
        // Quit keeps the selection (already synced while browsing) and never scrolls.
        const handleClose = () => setViewerKey(null);
        return (
          <div data-testid="media-viewer">
            <FileViewer
              src={viewerSrc}
              title={label}
              filePath={viewerFilePath}
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
      <PromptModal
        open={promptState.open}
        title="Rename playlist"
        message={`Enter new name for "${playlists.find((p) => p.id === promptState.id)?.name || ""}"`}
        defaultValue={promptState.value}
        placeholder="Playlist name"
        onCancel={() => setPromptState({ open: false, id: null, value: "" })}
        onConfirm={async (v) => {
          try {
            await renamePlaylist(promptState.id, v);
            setPromptState({ open: false, id: null, value: "" });
          } catch (e) {
            setAlertState({ open: true, title: "Rename failed", message: e.message || String(e) });
          }
        }}
      />
      <ConfirmModal
        open={confirmState.open}
        title="Delete playlist"
        message={`Delete playlist "${confirmState.name}"? Files stay in Media.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmState({ open: false, id: null, name: "" })}
        onConfirm={async () => {
          try {
            await deletePlaylist(confirmState.id);
            setConfirmState({ open: false, id: null, name: "" });
          } catch (e) {
            setAlertState({ open: true, title: "Delete failed", message: e.message || String(e) });
          }
        }}
      />
      <AlertModal open={alertState.open} title={alertState.title} message={alertState.message} onClose={() => setAlertState({ open: false, title: "", message: "" })} />
      <ConfirmModal
        open={!!deleteTarget}
        title="Delete file"
        message={deleteTarget ? `Delete "${displayName(deleteTarget)}"? This removes the file from /media.` : ""}
        confirmLabel="Delete"
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDeleteFile}
      />
      </div>
    </div>
  );
}