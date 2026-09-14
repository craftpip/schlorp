import { useEffect, useState, useRef, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import FileViewer from "../components/FileViewer";
import ShortcutsHelp from "../components/ShortcutsHelp";
import PlaylistHoverMenu from "../components/PlaylistHoverMenu.jsx";
import { usePlaylists, playlistKeyForMedia } from "../store/PlaylistsContext.jsx";
import { useStacks } from "../store/StacksContext.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import PromptModal from "../components/PromptModal.jsx";
import AlertModal from "../components/AlertModal.jsx";
import MediaContextMenu from "../components/MediaContextMenu.jsx";

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
  // Custom manual order (sort=custom): server-persisted per folder+flat scope.
  // Loaded on demand when custom sort is active; files missing from the
  // stored order append after ordered ones in listing order.
  const [customOrder, setCustomOrder] = useState([]);
  const [dropInfo, setDropInfo] = useState(null);
  const dragKeyRef = useRef(null);
  const dragKeysRef = useRef(null); // pile drag: whole member block moves as one
  const customOrderMap = useMemo(() => {
    const m = new Map();
    for (let i = 0; i < customOrder.length; i++) {
      if (!m.has(customOrder[i])) m.set(customOrder[i], i);
    }
    return m;
  }, [customOrder]);

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
  const [yArmKey, setYArmKey] = useState(null);
  const lastYRef = useRef(0);
  const yArmRef = useRef(null);
  const yTimerRef = useRef(null);
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
  // Stacks (016): per-folder pile state + grid-only multi-select. Stacks only
  // apply to non-playlist grid views; list view stays flat single-select.
  const { stacksForFolder: stacksForFolderAll, refresh: refreshStacks, createStack, renameStack, deleteStack, addItems: addStackItems, removeItems: removeStackItems } = useStacks();
  const folderStacks = isGrid && !inPlaylistView ? stacksForFolderAll(folder) : [];
  const [selKeys, setSelKeys] = useState(() => new Set());
  const [anchorKey, setAnchorKey] = useState(null);
  const [spreadStackId, setSpreadStackId] = useState(null);
  useEffect(() => {
    if (isGrid && !inPlaylistView) refreshStacks(folder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGrid, folder, inPlaylistView]);
  // Reset grid multi-select + spread whenever the visible set changes meaningfully.
  useEffect(() => {
    setSelKeys(new Set());
    setAnchorKey(null);
    setSpreadStackId(null);
  }, [folder, isFlat, type, filter, sort, activePlId]);
  // Shared view ordering (filter text + type + sort, dirs first) so the
  // list render and the default-selection pick in load() agree.
  // Search/type filters apply to files only — folders are always visible.
  const applyViewOrder = (list) => {
    const raw = filter.trim();
    const isNeg = raw.startsWith("!");
    const term = (isNeg ? raw.slice(1).trim() : raw).toLowerCase();
    let base = list.filter((it) => {
      if (it.dir) return true;
      if (term) {
        const hay = (isFlat ? it.rel || it.name : it.name).toLowerCase();
        const hit = hay.includes(term);
        if (isNeg ? hit : !hit) return false;
      }
      if (type !== "all" && fileCategory(it.name) !== type) return false;
      return true;
    });
    if (sort === "custom") {
      // Manual order: dirs stay name-sorted on top; playlist views keep
      // their own order (custom drag-drop is a media-folder feature).
      if (inPlaylistView) return base;
      const dirs = [];
      const files = [];
      for (const it of base) (it.dir ? dirs : files).push(it);
      const col = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      dirs.sort((a, b) => col.compare(a.name, b.name));
      if (customOrderMap.size) {
        const keyOf = (it) => (isFlat ? it.rel || it.name : it.name);
        files.sort((a, b) => {
          const ai = customOrderMap.has(keyOf(a)) ? customOrderMap.get(keyOf(a)) : Infinity;
          const bi = customOrderMap.has(keyOf(b)) ? customOrderMap.get(keyOf(b)) : Infinity;
          return ai - bi;
        });
      }
      return [...dirs, ...files];
    }
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
  };
  const filtered = (() => {
    const base = inPlaylistView && playlistItemsForView ? playlistItemsForView : items;
    return applyViewOrder(base);
  })();
  const viewable = filtered.filter((it) => !it.dir);
  const isEmptyForList = filtered.length === 0 && (!folder ? playlists.length === 0 : true);
  const filtersActive = type !== "all" || filter.trim() !== "";
  // Missing folder on disk (API 400 ENOENT) with nothing loaded.
  const folderMissing = !!err && items.length === 0 && /ENOENT|no such file or directory|ENOTDIR/i.test(err);
  const clearFilters = () => {
    const ns = new URLSearchParams(searchParams);
    ns.delete("q");
    ns.delete("type");
    setSearchParams(ns, { replace: true });
  };
  // Shown instead of "no files" whenever search/type filters hide everything.
  const filterEmptyNotice = (
    <div data-testid="media-empty-filters" className="empty" style={{ padding: 20, gridColumn: "1 / -1", width: "100%", textAlign: "center" }}>
      <i className="bi bi-funnel" /> No files match the current filters — folders are always shown.
      <div style={{ marginTop: 8 }}>
        <button data-testid="media-clear-filters" type="button" className="btn btn-sm btn-outline-secondary" onClick={clearFilters}>Clear search & type filter</button>
      </div>
    </div>
  );
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
        else {
          // Default to the first VISIBLE item (view order), not raw API order.
          const ordered = applyViewOrder(fresh);
          if (ordered.length) setParam("sel", keyOf(ordered[0]));
          else if (curSel) setParam("sel", "");
        }
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
  // Custom order: fetch the stored sequence for this folder+flat scope when
  // custom sort becomes active (or the scope changes while active).
  useEffect(() => {
    if (sort !== "custom" || inPlaylistView) return;
    const qs = new URLSearchParams();
    if (folder) qs.set("folder", folder);
    if (isFlat) qs.set("flat", "1");
    fetch(`/api/mediaorder?${qs.toString()}`).then((r) => r.json()).then((j) => {
      if (j && j.ok && Array.isArray(j.order)) setCustomOrder(j.order);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, folder, isFlat, inPlaylistView]);
  // Persist a reordered visible sequence (optimistic: state first, PUT after).
  const saveCustomOrder = (order) => {
    setCustomOrder(order);
    fetch("/api/mediaorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder, flat: isFlat ? "1" : "", order }),
    }).catch(() => {});
  };
  // Reorder helpers operate on the visible file sequence (drag-drop is
  // disabled while search/type filters are active, so visible === all).
  const moveCustomKey = (dragKey, targetKey, after = false) => {
    moveCustomKeys(dragKey ? [dragKey] : [], targetKey, after);
  };
  // Move a block of file keys (a pile's members) as one unit to before/after
  // a target file key in the visible custom order.
  const moveCustomKeys = (dragKeys, targetKey, after = false) => {
    const set = new Set(dragKeys || []);
    if (!set.size || !targetKey || set.has(targetKey)) return;
    const vis = filtered.filter((it) => !it.dir).map((it) => rowKey(it));
    if (!vis.includes(targetKey) || ![...set].every((k) => vis.includes(k))) return;
    const orderedDrag = vis.filter((k) => set.has(k));
    const next = vis.filter((k) => !set.has(k));
    const idx = next.indexOf(targetKey) + (after ? 1 : 0);
    next.splice(idx, 0, ...orderedDrag);
    setSelectedKey(orderedDrag[0]);
    saveCustomOrder(next);
  };
  // Is this key a member of the currently spread pile? (Same basename
  // rule as grouping; keeps the pile open when selecting inside it.)
  const isSpreadMember = (k) => {
    if (!spreadStackId || !k) return false;
    const st = folderStacks.find((s) => s.id === spreadStackId);
    const items = st && Array.isArray(st.items) ? st.items : [];
    return items.includes(String(k).split("/").pop());
  };
  // Member file keys of a stack in visible order (works flat + non-flat by
  // matching bare basenames, same rule as pile grouping).
  const pileMemberKeys = (stackId) => {
    const st = folderStacks.find((s) => s.id === stackId);
    const items = st && Array.isArray(st.items) ? st.items : [];
    if (!items.length) return [];
    const set = new Set(items);
    return filtered.filter((it) => !it.dir && set.has(String(rowKey(it)).split("/").pop())).map((it) => rowKey(it));
  };
  // Staggered rise-in animation for freshly spread members (mount-only;
  // steady re-renders keep the same string so it never replays). Order
  // follows the VISUAL sequence (grid order), not stack file order.
  // NOTE: must stay BELOW gridVisible (memo runs during render).
  const spreadMemberAnim = (key) => {
    const idx = spreadVisualOrder.get(key);
    if (idx === undefined) return undefined;
    return `media-member-in .25s ease ${idx * 45}ms backwards`;
  };
  // For a given mouse point inside the tile container, find the nearest file
  // tile and where on it the drop should land: its closest edge/side, which
  // tells us both the insertion point (before/after the tile) and the visual
  // line position (left/right/top/bottom of the tile).
  // `skip` is a Set of dragged keys (single file or whole pile block incl.
  // the pile id). Pile containers resolve to an edge member file key so
  // drops onto piles insert before/after the whole pile.
  const nearestDropInfo = (container, px, py, skip) => {
    const skipSet = skip instanceof Set ? skip : new Set(skip ? [skip] : []);
    const vis = filtered.filter((it) => !it.dir).map((it) => rowKey(it));
    const els = container.querySelectorAll("[data-filename]");
    let best = null;
    let bestDist = Infinity;
    for (const el of els) {
      if (skipSet.has(el.dataset.filename)) continue;
      if (el.classList.contains("media-tile-folder")) continue;
      // Inner cascade tiles of a collapsed pile are hidden: the pile
      // container itself represents the whole block as drop target.
      if (el.getAttribute("data-testid") === "media-tile-file" && el.closest && el.closest('[data-testid="media-tile-pile"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const dx = px < r.left ? r.left - px : px > r.right ? px - r.right : 0;
      const dy = py < r.top ? r.top - py : py > r.bottom ? py - r.bottom : 0;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) { bestDist = d; best = el; }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    let side, align;
    if (px < r.left) { side = "before"; align = "left"; }
    else if (px > r.right) { side = "after"; align = "right"; }
    else if (py < r.top) { side = "before"; align = "top"; }
    else if (py > r.bottom) { side = "after"; align = "bottom"; }
    else {
      // Hovering ON the item: it is the destination, so the dragged file
      // takes its slot. If the target sits after the source, that slot is
      // one position ahead (after the target); otherwise it is before it.
      const firstDrag = [...skipSet].find((k) => vis.includes(k));
      const si = firstDrag !== undefined ? vis.indexOf(firstDrag) : -1;
      const ti = vis.indexOf(best.dataset.filename);
      if (si > -1 && ti > -1 && si < ti) { side = "after"; align = "right"; }
      else { side = "before"; align = "left"; }
    }
    let key = best.dataset.filename;
    if (best.getAttribute("data-testid") === "media-tile-pile") {
      // Dropping onto a pile inserts before/after the whole pile block:
      // resolve to the edge member in visible order.
      const mem = pileMemberKeys(key);
      if (!mem.length) return null;
      if (side === "after") key = mem[mem.length - 1];
      else key = mem[0];
      // If the dragged block sits before the pile, "before pile" really
      // means after it (same slot rule as files above).
      const firstDrag = [...skipSet].find((k) => vis.includes(k));
      const si = firstDrag !== undefined ? vis.indexOf(firstDrag) : -1;
      const ti = vis.indexOf(key);
      if (si > -1 && ti > -1 && si < ti && side !== "after") { side = "after"; align = "right"; key = mem[mem.length - 1]; }
    }
    return { key, side, align };
  };
  const sameDropInfo = (a, b) => !!a && !!b && a.key === b.key && a.side === b.side && a.align === b.align;
  useEffect(() => () => { if (playlistMenuCloseTimer.current) clearTimeout(playlistMenuCloseTimer.current); if (yTimerRef.current) clearTimeout(yTimerRef.current); }, []);
  // Merge server-side dimensions without resetting thumbnails
  // (setItems/load would flash spinners). Retries a few times so entries
  // still warming on the server land without a reload. Playlist view items
  // get `ratio` inline from the detail endpoint instead.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const dimsPollRef = useRef({ scope: "", rounds: 0, timer: null });
  useEffect(() => {
    if (inPlaylistView || !items.length) return undefined;
    const scopeKey = `${folder}\n${isFlat ? 1 : 0}\n${items.length}`;
    const st = dimsPollRef.current;
    if (st.scope !== scopeKey) {
      st.scope = scopeKey;
      st.rounds = 0;
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
    }
    const qs = new URLSearchParams();
    if (folder) qs.set("folder", folder);
    if (isFlat) qs.set("flat", "1");
    const query = qs.toString();
    const doFetch = () => {
      const cur = itemsRef.current;
      if (!cur.some((it) => !it.dir && !Number.isFinite(it.ratio))) { stopPoll(); return; }
      if (st.rounds >= 4) { stopPoll(); return; }
      st.rounds += 1;
      fetch(`/api/mediadims?${query}`).then((r) => r.json()).then((j) => {
        if (!j || !j.ok || !j.dims) return;
        setRatios((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const [k, v] of Object.entries(j.dims)) {
            if (!Number.isFinite(v) || k in next) continue;
            next[k] = v;
            changed = true;
          }
          return changed ? next : prev;
        });
      }).catch(() => {});
    };
    const stopPoll = () => { if (st.timer) { clearInterval(st.timer); st.timer = null; } };
    doFetch();
    st.timer = setInterval(doFetch, 4000);
    return () => { if (st.timer) { clearInterval(st.timer); st.timer = null; } };
  }, [items, folder, isFlat, inPlaylistView]);
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

  // Grid piles render member tiles inside the pile container: those inner
  // tiles are not nav cells. TILE_NAV_Q selects only top-level cells
  // (pile container counts as one cell for its members), and navSelectedEl
  // prefers the pile container over an inner tile when both are marked.
  const TILE_NAV_Q = '[data-testid="media-tile-file"]:not([data-testid="media-tile-pile"] [data-testid="media-tile-file"]), [data-testid="media-tile-folder"], [data-testid="media-tile-playlist"], [data-testid="media-tile-pile"]';
  const navSelectedEl = () => {
    const all = [...document.querySelectorAll('[data-selected="true"]')];
    if (!all.length) return null;
    return all.find((el) => el.getAttribute("data-testid") === "media-tile-pile" || !(el.closest && el.closest('[data-testid="media-tile-pile"]'))) || all[0];
  };
  // Sticky-aware scroll: native scrollIntoView({block:"nearest"}) ignores the
  // sticky toolbar, leaving the row hidden under it or bottom-flush. Scroll
  // manually only when the selected row is actually out of view.
  // Directional minimal scroll: rows leaving through the top pin just below
  // the sticky toolbar; rows leaving through the bottom only just come into
  // view at the bottom edge (never yanked up to the top).
  const scrollSelectionIntoView = (smooth = false) => {
    const el = navSelectedEl();
    if (!el) return;
    // Cancel any in-flight smooth scroll first: single presses glide, so when
    // reversing direction the previous animation is still running and the
    // measurement below reads a mid-flight position (row looks in-view, no
    // scroll fires, animation settles with the selection out of view — the
    // "two presses to turn around" bug). Measuring at rest fixes it.
    window.scrollTo({ top: window.scrollY, behavior: "auto" });
    const sticky = document.querySelector(`[data-testid="media-sticky"]`);
    const offset = (sticky ? sticky.offsetHeight : 0) + 12;
    const rect = el.getBoundingClientRect();
    const behavior = smooth ? "smooth" : "auto";
    if (rect.top < offset) {
      window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - offset), behavior });
    } else if (rect.bottom > window.innerHeight) {
      window.scrollTo({ top: window.scrollY + (rect.bottom - window.innerHeight) + 12, behavior });
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
  // Keyboard navigation arms a one-shot scroll so the highlight stays visible.
  // Single presses glide (smooth); held-key repeats snap (instant) so the
  // view advances one row at a time instead of chasing a smooth animation.
  useEffect(() => {
    if (!keyboardScrollRef.current || viewerOpen) { keyboardScrollRef.current = false; return; }
    const smooth = keyboardScrollRef.current === "smooth";
    keyboardScrollRef.current = false;
    scrollSelectionIntoView(smooth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx]);

  useEffect(() => {
    if (viewerOpen || confirmState.open || promptState.open || alertState.open || !!deleteTarget) return;
    const moveSelection = (delta, smooth = true) => {
      if (!allSelectable.length) return;
      const base = selectedIdx !== -1 ? selectedIdx : (delta > 0 ? -1 : 0);
      const next = Math.min(allSelectable.length - 1, Math.max(0, base + delta));
      keyboardScrollRef.current = smooth ? "smooth" : "instant";
      selectSingleKey(selectableKey(allSelectable[next]));
    };
    // Grid view: move to the nearest tile/chip in a direction (WASD).
    // Piles ("media-tile-pile") are single cells: keyboard entering a pile
    // expands it with a SINGLE primary (first member) — never mass-selects.
    // Moving onto a file outside the spread pile collapses it again.
    const collapseSpreadUnlessMember = (fid) => {
      const spread = spreadStackIdRef.current;
      if (!spread || !fid) return;
      const st = (folderStacksRef.current || []).find((s) => s.id === spread);
      const items = st && Array.isArray(st.items) ? st.items : [];
      if (!items.includes(String(fid).split("/").pop())) setSpreadStackId(null);
    };
    // Keyboard motion is always single-select: primary + selKeys + anchor
    // move together so no stale multi-selection (ghost outlines) survives.
    const selectSingleKey = (k) => {
      if (!k) return;
      collapseSpreadUnlessMember(k);
      setSelKeys(new Set([k]));
      setAnchorKey(k);
      setSelectedKey(k);
    };
    const landOn = (el) => {
      if (el.getAttribute("data-testid") === "media-tile-pile") {
        const entry = gridVisibleRef.current.find((ve) => ve.kind === "pile" && ve.stackId === el.getAttribute("data-filename"));
        if (entry && entry.members && entry.members.length) {
          setSpreadStackId(entry.stackId);
          const fk = rowKey(entry.members[0]);
          setSelKeys(new Set([fk]));
          setAnchorKey(fk);
          setSelectedKey(fk);
        }
        return;
      }
      const fid = el.getAttribute("data-filename");
      if (fid) selectSingleKey(fid);
    };
    const moveSelectionSpatial = (dir, smooth = true) => {
      const nodes = [...document.querySelectorAll(TILE_NAV_Q)];
      if (!nodes.length) return;
      const current = navSelectedEl();
      if (!current) {
        keyboardScrollRef.current = true;
        landOn(nodes[0]);
        return;
      }
      const cr = current.getBoundingClientRect();
      const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
      let best = null, bestScore = Infinity;
      for (const el of nodes) {
        if (el === current) continue;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const dx = x - cx, dy = y - cy;
        let primary, secondary;
        // Left/right stay on the same visual row: candidates on other rows
        // are ignored so row-end Right falls through to array order below
        // instead of jumping to the far-right tile elsewhere on the page.
        if (dir === "left") { if (dx >= -4) continue; if (Math.abs(r.top - cr.top) >= 4) continue; primary = -dx; secondary = Math.abs(dy); }
        else if (dir === "right") { if (dx <= 4) continue; if (Math.abs(r.top - cr.top) >= 4) continue; primary = dx; secondary = Math.abs(dy); }
        else if (dir === "up") { if (dy >= -4) continue; primary = -dy; secondary = Math.abs(dx); }
        else { if (dy <= 4) continue; primary = dy; secondary = Math.abs(dx); }
        const score = primary + secondary * 2.5;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (!best && (dir === "left" || dir === "right")) {
        // Row edge: move to the next/prev cell in VISUAL grid order (not
        // folder order — members of a spread pile would otherwise jump to
        // unrelated files and wrongly collapse the pile).
        const delta = dir === "right" ? 1 : -1;
        const order = gridVisibleRef.current;
        const curGKey = current.getAttribute("data-testid") === "media-tile-pile"
          ? `stack:${current.getAttribute("data-filename")}`
          : current.getAttribute("data-filename");
        const gi = order.findIndex((ve) => ve.key === curGKey);
        if (gi !== -1 && order.length) {
          const gj = gi + delta;
          if (gj >= 0 && gj < order.length) {
            keyboardScrollRef.current = smooth ? "smooth" : "instant";
            const target = order[gj];
            if (target.kind === "pile") {
              const pel = nodes.find((n) => n.getAttribute("data-testid") === "media-tile-pile" && n.getAttribute("data-filename") === target.stackId);
              if (pel) { landOn(pel); return; }
            } else {
              selectSingleKey(target.key);
              return;
            }
          }
          return;
        }
        // Non file/pile cells (folders at root): fall back to DOM order.
        const ci = nodes.indexOf(current);
        const ni = ci + delta;
        if (ci !== -1 && ni >= 0 && ni < nodes.length) {
          keyboardScrollRef.current = smooth ? "smooth" : "instant";
          landOn(nodes[ni]);
        }
        return;
      }
      if (best) {
        keyboardScrollRef.current = smooth ? "smooth" : "instant";
        landOn(best);
      }
    };
    // Grid view: Shift+W / Shift+S jumps a full page up / down, keeping the
    // column. Tiles are grouped into visual rows by offsetTop.
    const moveSelectionPage = (dir, smooth = true) => {
      const nodes = [...document.querySelectorAll(TILE_NAV_Q)];
      if (!nodes.length) return;
      const rows = [];
      for (const el of nodes) {
        const top = el.offsetTop;
        const row = rows.find((r) => Math.abs(r.top - top) < 4);
        if (row) row.els.push(el);
        else rows.push({ top, els: [el] });
      }
      rows.sort((a, b) => a.top - b.top);
      let curRow = dir > 0 ? 0 : rows.length - 1, curCol = 0;
      const current = navSelectedEl();
      if (current) {
        const ci = rows.findIndex((r) => r.els.includes(current));
        if (ci !== -1) { curRow = ci; curCol = rows[ci].els.indexOf(current); }
      }
      const sticky = document.querySelector('[data-testid="media-sticky"]');
      const offset = (sticky ? sticky.offsetHeight : 0) + 24;
      const heights = rows.map((r) => Math.max(...r.els.map((el) => el.offsetHeight || GRID_TARGET_H)));
      const rowH = [...heights].sort((a, b) => a - b)[Math.floor(heights.length / 2)] || GRID_TARGET_H;
      const rowsPerPage = Math.max(1, Math.floor((window.innerHeight - offset) / (rowH + GRID_GAP)));
      const nextRow = Math.min(rows.length - 1, Math.max(0, curRow + dir * rowsPerPage));
      const target = rows[nextRow].els[Math.min(curCol, rows[nextRow].els.length - 1)];
      if (target) {
        keyboardScrollRef.current = smooth ? "smooth" : "instant";
        landOn(target);
      }
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
      // Grid: Esc clears multi-select and collapses any spread stack.
      if (isGrid && !inPlaylistView && k === "Escape") {
        e.preventDefault();
        const hadSpread = !!spreadStackIdRef.current;
        setSpreadStackId(null);
        setSelKeys(new Set(selKey ? [selKey] : []));
        setAnchorKey(selKey || null);
        if (hadSpread) return;
      }
      if (lowK === "g" && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); setParam("view", isGrid ? "list" : ""); }
      else if (lowK === "j" && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); setParam("flat", isFlat ? "" : "1"); }
      else if (lowK === "t" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        const order = TYPE_CHIPS.map((c) => c[0]);
        const i = order.indexOf(type);
        const next = order[(i + 1) % order.length];
        setType(next);
      }
      else if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3")) {
        // Shift+1/2/3 toggles Name/Size/Time sort (grid + list, viewer closed).
        // Uses e.code: with Shift held the key reads "!" / "@" / "#" on US layouts.
        e.preventDefault();
        if (e.code === "Digit1") toggleSort("name");
        else if (e.code === "Digit2") toggleSort("size");
        else toggleSort("time");
      }
      else if (lowK === "y" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Same as viewer: y twice deletes the selected file (600ms window).
        if (e.repeat) return;
        e.preventDefault();
        if (selectedIdx === -1) return;
        const it = allSelectable[selectedIdx];
        if (!it || it._isPlaylist || it.dir) return;
        const now = Date.now();
        const k = selectableKey(it);
        if (now - lastYRef.current < 600 && yArmRef.current === k) {
          lastYRef.current = 0;
          yArmRef.current = null;
          setYArmKey(null);
          if (yTimerRef.current) { clearTimeout(yTimerRef.current); yTimerRef.current = null; }
          if (runDeleteItemRef.current) runDeleteItemRef.current(it);
        } else {
          lastYRef.current = now;
          yArmRef.current = k;
          setYArmKey(k);
          if (yTimerRef.current) clearTimeout(yTimerRef.current);
          yTimerRef.current = setTimeout(() => { setYArmKey(null); yArmRef.current = null; lastYRef.current = 0; yTimerRef.current = null; }, 600);
        }
      }
      else if (isGrid && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (lowK === "w" || lowK === "s")) {
        e.preventDefault();
        moveSelectionPage(lowK === "w" ? -1 : 1, !e.repeat);
      }
      else if (isGrid && !e.ctrlKey && !e.altKey && !e.metaKey && (lowK === "w" || lowK === "a" || lowK === "s" || lowK === "d" || lowK === "q")) {
        e.preventDefault();
        const glide = !e.repeat;
        if (lowK === "w") moveSelectionSpatial("up", glide);
        else if (lowK === "a") moveSelectionSpatial("left", glide);
        else if (lowK === "s") moveSelectionSpatial("down", glide);
        else if (lowK === "d") moveSelectionSpatial("right", glide);
        else goUp();
      }
      else if (isLeft) { e.preventDefault(); goUp(); }
      else if (isUp) { e.preventDefault(); moveSelection(-1, !e.repeat); }
      else if (isDown) { e.preventDefault(); moveSelection(1, !e.repeat); }
      else if (isRight || isEnter) {
        if (!allSelectable.length || selectedIdx === -1) return;
        e.preventDefault();
        const it = allSelectable[selectedIdx];
        if (it) {
          // Grid: Enter on a member of a collapsed pile spreads it (that pile
          // becomes the selection instead of opening the file).
          if (isGrid && !inPlaylistView && isEnter && !it._isPlaylist && !it.dir && !spreadStackIdRef.current) {
            const pileId = keyPileMapRef.current.get(selectableKey(it));
            if (pileId) {
              const entry = gridVisibleRef.current.find((ve) => ve.kind === "pile" && ve.stackId === pileId);
              if (entry) {
                setSpreadStackId(pileId);
                const fk = rowKey(entry.members[0]);
                setSelKeys(new Set([fk]));
                setAnchorKey(fk);
                setSelectedKey(fk);
                return;
              }
            }
          }
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
  // letter toggles the first matching list, 1-9 toggles extras by number.
  // Release F closes. Grid + list, viewer closed.
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
        // Digits toggle extras (lists without a letter hotkey: shared first
        // letter beyond the first, or non-letter names), numbered 1-9.
        const extras = playlists.filter((p, i) => {
          const ch = String(p.name || "").trim().charAt(0).toLowerCase();
          return !(/^[a-z]$/.test(ch) && playlists.findIndex((q) => String(q.name || "").trim().charAt(0).toLowerCase() === ch) === i);
        });
        const hit = extras[parseInt(k, 10) - 1];
        if (hit) {
          const it = selectedFile();
          if (!it) return;
          e.preventDefault();
          e.stopPropagation();
          togglePlaylistItem(hit.id, playlistKey(it)).catch(() => {});
        }
        return;
      }
      if (fHeldRef.current && /^[a-zA-Z]$/.test(k)) {
        // Letter hotkey: toggles the first list starting with that letter
        // (F+O → "orange"). Later lists sharing the letter use 1-9.
        const hit = playlists.find((p) => String(p.name || "").trim().charAt(0).toLowerCase() === k.toLowerCase());
        if (hit) {
          e.preventDefault();
          e.stopPropagation();
          const it = selectedFile();
          if (!it) return;
          togglePlaylistItem(hit.id, playlistKey(it)).catch(() => {});
          return;
        }
        // No list starts with this letter — fall through to normal navigation.
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
    await runDeleteItem(it);
  };
  const runDeleteItem = async (it) => {
    if (!it) return;
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
    // Optimistic UI: drop just the deleted row locally instead of a full
    // reload — keeps scroll position and loaded thumbnails intact.
    setItems((prev) => prev.filter((x) => {
      const rk = rowKey(x);
      return rk !== key && playlistKeyForMedia(folder, rk) !== key;
    }));
    const pending = pendingSelectRef.current;
    pendingSelectRef.current = null;
    if (pending) setSelectedKey(pending);
  };
  const runDeleteItemRef = useRef(null);
  runDeleteItemRef.current = runDeleteItem;

  const rows = useMemo(() => {
    if (!isGrid || !gridW) return [];
    return filtered.map((it, i) => {
      const isDir = !!it.dir;
      if (isDir) return { it, i, h: GRID_TARGET_H, w: Math.min(GRID_TARGET_H * 1.25, 260), isDir: true };
      // Server-provided ratio (from .mediadims.json) sizes tiles on first
      // paint; measured ratios refine afterwards. No reflow from scratch.
      const r = clampRatio(parseFloat(ratios[rowKey(it)]) || it.ratio || 1);
      let w = Math.round(GRID_TARGET_H * r);
      const max = Math.max(gridW - GRID_GAP * 2, 80);
      if (w > max) w = max;
      return { it, i, h: GRID_TARGET_H, w, isDir: false };
    });
  }, [isGrid, gridW, filtered, ratios]);
  // 1 click = select only; double-click (or Enter) = open. Touch keeps tap-to-open.
  const selectOnly = (it) => { const k = rowKey(it); setSelKeys(new Set([k])); setAnchorKey(k); setSelectedKey(k); };
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
        style={{ width: FOLDER_CHIP_W, height: FOLDER_CHIP_H, flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, padding: "0 12px", overflow: "hidden", borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--border)", outline: selected ? "4px solid var(--accent)" : "none", cursor: "pointer" }}
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
        style={{ width: FOLDER_CHIP_W, height: FOLDER_CHIP_H, flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, padding: "0 8px 0 12px", overflow: "hidden", borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--border)", outline: selected ? "4px solid #6366f1" : "none", cursor: "pointer", position: "relative" }}
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
  const renderTile = (it, fi, w, h, anim) => {
    const rk = rowKey(it);
    // A thumbnail URL that 404s (no poster sibling, no embedded cover art)
    // falls back to the icon placeholder instead of a blank black tile.
    const src = imgErr[rk] ? null : thrumb(it);
    const isPrimary = selKey === rk;
    // Grid multi-select: `selKeys` drives the highlight (primary inside it).
    // List view / single selection: highlight == primary. `data-selected` stays
    // primary-only so keyboard nav & scroll keep working with multi-select on.
    const gridMulti = isGrid && !inPlaylistView;
    const highlight = gridMulti && selKeys.size ? selKeys.has(rk) : isPrimary;
    const selected = isPrimary;
    const isDir = !!it.dir;
    // Stack membership (gray) is independent of selection (accent): members
    // of a stack always show the gray ring; selection overrides with accent.
    const inStack = !isDir && Array.isArray(it.stacks) && it.stacks.length > 0;
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
    // Custom manual order: file tiles are draggable in grid view only (list
    // view just displays the order). Disabled for folders, playlist views,
    // and while search/type filters hide files (visible !== all there).
    const dragEnabled = sort === "custom" && !inPlaylistView && !isDir && !filtersActive;
    const isDropTarget = dropInfo && dropInfo.key === rk;
    const dropAlign = isDropTarget ? dropInfo.align : null;
    return (
      <div
        key={isFlat ? it.rel || it.name : it.name}
        id={`media-file-${sanitizeKey(rowKey(it))}`}
        data-testid={isDir ? "media-tile-folder" : "media-tile-file"}
        className={isDir ? "media-tile-folder" : "media-tile-file"}
        data-filename={rowKey(it)}
        data-selected={selected}
        onClick={(e) => { if (!isDir && gridMulti) gridClickHandler({ kind: "file", it, key: rk }, e); else if (!isDir && isCoarsePointer()) openItem(it); else tapItem(it); }}
        onDoubleClick={() => openItem(it)}
        onContextMenu={(e) => { if (gridMulti && !isDir) { e.preventDefault(); openContextMenu(e, { kind: "file", it, key: rk }); } }}
        title={dragEnabled ? `${displayName(it)} — drag to reorder` : `${displayName(it)} — click to select, double-click to open`}
        draggable={dragEnabled || (gridMulti && !isDir)}
        onDragStart={(e) => {
          if (!(dragEnabled || (gridMulti && !isDir))) return;
          // Dragging an unselected file carries just that file — never a
          // stale multi-selection (dragstart suppresses the click that
          // would otherwise select it first).
          let carry = [...selectedKeysForStack];
          if (!carry.includes(rk)) {
            carry = [rk];
            setSelKeys(new Set([rk]));
            setAnchorKey(rk);
            setSelectedKey(rk);
          }
          if (dragEnabled) {
            // Single file for ordering (even spread members: dropping
            // outside the open pile detaches them, inside reorders).
            dragKeyRef.current = rk;
            dragKeysRef.current = null;
            e.dataTransfer.effectAllowed = "move";
            try { e.dataTransfer.setData("text/plain", rk); } catch {}
          }
          // Stack drag: carry the dragged file(s) so pile drop targets add them
          try { e.dataTransfer.setData("application/x-xdl-stack", JSON.stringify(carry)); } catch {}
        }}
        onDragEnd={() => { dragKeyRef.current = null; dragKeysRef.current = null; if (dropInfo) setDropInfo(null); }}
        style={{ position: "relative", flex: isDir ? "0 0 auto" : "0 0 auto", width: w, height: h, overflow: (menuOpen || isDropTarget) ? "visible" : "hidden", zIndex: menuOpen ? 60 : "auto", borderRadius: 0, background: isDir ? "var(--surface-2)" : "var(--surface-2)", outline: highlight ? "4px solid var(--accent)" : (inStack ? "4px solid var(--muted)" : "none"), cursor: dragEnabled ? "grab" : "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, contentVisibility: menuOpen ? "visible" : "auto", containIntrinsicSize: `${w}px ${h}px`, animation: anim || undefined }}
      >
        {src ? (
          <span style={{ position: "relative", width: "100%", height: "100%", flex: 1, display: "block", background: "#000", minHeight: 0 }}>
            {!loaded && (
              <span data-testid="media-thumb-loading" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}>
                <span className="xdl-thumb-spinner" />
              </span>
            )}
            {asVideo ? (
              <video src={src} autoPlay muted loop playsInline preload="metadata" onLoadedData={markVideoLoaded} onError={markErr} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000", opacity: loaded ? 1 : 0, transition: "opacity .45s ease" }} />
            ) : (
              <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onLoad={markLoaded} onError={markErr} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000", opacity: loaded ? 1 : 0, transition: "opacity .45s ease" }} />
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
        {isDropTarget && (
          <span data-testid="media-drop-line" style={{
            position: "absolute",
            borderRadius: 2,
            background: "#6366f1",
            boxShadow: "0 0 8px rgba(99,102,241,.9)",
            zIndex: 5,
            pointerEvents: "none",
            ...(dropAlign === "left" ? { left: -6, top: -2, bottom: -2, width: 4 }
              : dropAlign === "right" ? { right: -6, top: -2, bottom: -2, width: 4 }
              : dropAlign === "top" ? { top: -6, left: -2, right: -2, height: 4 }
              : { bottom: -6, left: -2, right: -2, height: 4 }),
          }} />
        )}
      </div>
    );
  };
  const toggleSort = (key) => {
    const ns = new URLSearchParams(searchParams);
    const cur = ns.get("sort");
    if (key === "custom") {
      // Custom has no direction: click activates, second click exits to unsorted.
      if (cur !== "custom") { ns.set("sort", "custom"); ns.delete("dir"); }
      else { ns.delete("sort"); ns.delete("dir"); }
      setSearchParams(ns, { replace: true });
      return;
    }
    const curDir = ns.get("dir");
    const initialDir = key === "name" ? "asc" : "desc";
    if (cur !== key) { ns.set("sort", key); ns.set("dir", initialDir); }
    else if (curDir === initialDir) { ns.set("dir", initialDir === "asc" ? "desc" : "asc"); }
    else { ns.delete("sort"); ns.delete("dir"); }
    setSearchParams(ns, { replace: true });
  };
  const sortBtn = (key, label, tid) => (
    <button data-testid={tid || `media-sort-${key}`} type="button" onClick={() => toggleSort(key)} title={`Sort by ${label}`} style={{ background: "none", border: 0, padding: 0, color: sort === key ? "var(--text)" : "inherit", fontWeight: 700, fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, textAlign: "left" }}>
      {label}<span style={{ color: "var(--accent)", minWidth: 10, display: "inline-block" }}>{sort === key ? (sortDir === "desc" ? "▼" : "▲") : ""}</span>
    </button>
  );
  const sortBarBtn = (key, label, tid) => {
    const active = sort === key;
    const isCustom = key === "custom";
    return (
      <button data-testid={tid} type="button" className={`btn btn-sm ${active ? "btn-primary" : "btn-outline-secondary"}`} onClick={() => toggleSort(key)} title={isCustom ? "Custom order — drag tiles to rearrange (grid)" : `Sort by ${label}`} style={{ height: 25, padding: "0 10px", fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4, borderRadius: 6, fontWeight: 600 }}>
        {label}
        {!isCustom && active && <span style={{ color: "#fff", display: "inline-block", fontSize: 10 }}>{sortDir === "desc" ? "▼" : "▲"}</span>}
      </button>
    );
  };
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
      pendingSelectRef.current = null;
      setSelectedKey(nk);
      setViewerKey(nk);
    }
    if (inPlaylistView && activePlId) {
      fetch(`/api/playlists/${encodeURIComponent(activePlId)}`).then((r) => r.json()).then((j) => { if (j.ok) setPlaylistDetail(j.playlist); }).catch(() => {});
      refreshPlaylists();
    }
    // Optimistic UI: drop just the deleted file locally instead of a full
    // reload — keeps loaded thumbnails intact when quitting the viewer.
    const dk = deletedKey;
    if (dk != null) {
      setItems((prev) => prev.filter((x) => {
        const rk = rowKey(x);
        return rk !== dk && playlistKeyForMedia(folder, rk) !== dk;
      }));
    }
  };

  // Grid view only: folders render as a Drive-style fixed-size row on top,
  // files render as preview tiles below. List view is untouched.
  const dirRows = rows.filter((r) => r.isDir);
  const fileRows = rows.filter((r) => !r.isDir);

  // --- Stacks (016): gridVisible pile grouping ---
  // Each item's `it.stacks` (from API) tells which stack(s) it belongs to.
  // A pile cell groups 2+ visible members of the same stack into one grid slot.
  const gridVisible = useMemo(() => {
    if (!isGrid || !gridW) return [];
    if (inPlaylistView) {
      return filtered.filter((it) => !it.dir).map((it) => ({ kind: "file", it, key: rowKey(it), w: 0, h: GRID_TARGET_H }));
    }
    const files = filtered.filter((it) => !it.dir);
    // Count visible members per stack id
    const stackCount = new Map();
    for (const it of files) {
      const st = (it.stacks || [])[0];
      if (st) stackCount.set(st.id, (stackCount.get(st.id) || 0) + 1);
    }
    const seq = [];
    const emitted = new Set();
    for (const it of files) {
      if (emitted.has(it)) continue;
      const st = (it.stacks || [])[0];
      if (st && stackCount.get(st.id) >= 2) {
        const members = files.filter((x) => (x.stacks || [])[0]?.id === st.id && !emitted.has(x));
        if (!members.length) continue;
        // Mark all members as emitted
        for (const m of members) emitted.add(m);
        if (spreadStackId === st.id) {
          // Spread: show members as normal tiles
          for (const m of members) seq.push({ kind: "file", it: m, key: rowKey(m), w: 0, h: GRID_TARGET_H });
        } else {
          // Pile: one cell containing up to 4 stacked cards
          const stack = folderStacks.find((s) => s.id === st.id);
          seq.push({ kind: "pile", stackId: st.id, stackName: (stack && stack.name) || st.name, stack: stack || { id: st.id, name: st.name, count: st.count }, members, count: members.length, key: `stack:${st.id}` });
        }
        continue;
      }
      seq.push({ kind: "file", it, key: rowKey(it), w: 0, h: GRID_TARGET_H });
    }
    return seq;
  }, [isGrid, gridW, filtered, inPlaylistView, spreadStackId, folderStacks]);
  // Compute widths for gridVisible entries
  const gridVisibleWithWidths = useMemo(() => {
    if (!isGrid || !gridW) return [];
    return gridVisible.map((entry) => {
      if (entry.kind === "pile") return { ...entry, w: GRID_TARGET_H * 1.25, h: GRID_TARGET_H };
      const it = entry.it;
      const r = clampRatio(parseFloat(ratios[entry.key]) || it.ratio || 1);
      let w = Math.round(GRID_TARGET_H * r);
      const max = Math.max(gridW - GRID_GAP * 2, 80);
      if (w > max) w = max;
      return { ...entry, w, h: GRID_TARGET_H };
    });
  }, [isGrid, gridW, gridVisible, ratios]);
  const gridKeys = useMemo(() => gridVisible.map((e) => e.key), [gridVisible]);
  // Map: member rowKey → pile stackId (for Enter-to-spread on a selected member)
  const keyPileMap = useMemo(() => {
    const m = new Map();
    for (const e of gridVisible) {
      if (e.kind !== "pile") continue;
      for (const mem of e.members) m.set(rowKey(mem), e.stackId);
    }
    return m;
  }, [gridVisible]);
  // Visual order index of spread members (for stagger delays). Declared
  // here because gridVisible is only available below (memo runs on render).
  const spreadVisualOrder = useMemo(() => {
    const m = new Map();
    if (!spreadStackId) return m;
    const st = folderStacks.find((s) => s.id === spreadStackId);
    const items = st && Array.isArray(st.items) ? st.items : [];
    if (!items.length) return m;
    const set = new Set(items);
    let i = 0;
    for (const e of gridVisible) {
      if (e.kind === "file" && set.has(String(e.key).split("/").pop())) m.set(e.key, i++);
    }
    return m;
  }, [spreadStackId, gridVisible, folderStacks]);
  // Live refs so the keyboard effect can always read fresh grid data
  const gridVisibleRef = useRef(gridVisible);
  gridVisibleRef.current = gridVisible;
  const keyPileMapRef = useRef(keyPileMap);
  keyPileMapRef.current = keyPileMap;
  const spreadStackIdRef = useRef(spreadStackId);
  spreadStackIdRef.current = spreadStackId;
  const folderStacksRef = useRef(folderStacks);
  folderStacksRef.current = folderStacks;
  // Grid click handler: Shift/Ctrl-aware multi-select (replaces tapItem for grid tiles).
  const gridClickHandler = (entry, e) => {
    if (!isGrid) { tapItem(entry.kind === "file" ? entry.it : entry.members[0]); return; }
    const k = entry.key;
    const isPile = entry.kind === "pile";
    const cellKeys = isPile ? entry.members.map((m) => rowKey(m)) : [k];
    const shift = e?.shiftKey;
    const ctrl = e?.ctrlKey || e?.metaKey;
    // Coarse pointer: treat as plain click (single tap = select+open)
    if (isCoarsePointer()) {
      if (isPile) { setSpreadStackId(entry.stackId); setSelKeys(new Set([cellKeys[0]])); setAnchorKey(cellKeys[0]); setSelectedKey(cellKeys[0]); }
      else { setSelKeys(new Set([k])); setAnchorKey(k); setSelectedKey(k); }
      return;
    }
    if (shift) {
      // Range select from anchor to clicked in gridVisible order
      const fromKey = anchorKey || selKey;
      const fromIdx = gridKeys.indexOf(fromKey);
      const toIdx = gridKeys.indexOf(k);
      const lo = Math.min(fromIdx !== -1 ? fromIdx : toIdx, toIdx);
      const hi = Math.max(fromIdx !== -1 ? fromIdx : toIdx, toIdx);
      const range = new Set();
      for (let i = lo; i <= hi; i++) {
        const ve = gridVisible[i];
        if (!ve) continue;
        if (ve.kind === "pile") { for (const mk of ve.members.map((m) => rowKey(m))) range.add(mk); }
        else range.add(ve.key);
      }
      setSelKeys(range);
      setSelectedKey(cellKeys[0]);
      return;
    }
    if (ctrl) {
      // Toggle clicked in/out of selection
      setSelKeys((prev) => {
        const next = new Set(prev);
        for (const ck of cellKeys) { if (next.has(ck)) next.delete(ck); else next.add(ck); }
        return next;
      });
      setAnchorKey(cellKeys[0]);
      setSelectedKey(cellKeys[0]);
      if (isPile && !spreadStackId) setSpreadStackId(entry.stackId);
      return;
    }
    // Plain click
    if (isPile && !spreadStackId) {
      // Click on a pile: spread it, select the first member only
      setSpreadStackId(entry.stackId);
      setSelKeys(new Set([cellKeys[0]]));
      setAnchorKey(cellKeys[0]);
      setSelectedKey(cellKeys[0]);
      return;
    }
    // Collapse any spread stack when clicking outside it (clicking a
    // member of the open pile keeps it open).
    if (spreadStackId && !isSpreadMember(k)) setSpreadStackId(null);
    setSelKeys(new Set([k]));
    setAnchorKey(k);
    setSelectedKey(k);
  };
  const gridClickRef = useRef(gridClickHandler);
  gridClickRef.current = gridClickHandler;
  // Selection toolbar visible when grid multi-select is active
  const selCount = selKeys.size || (selKey ? 1 : 0);
  const canStackSelection = isGrid && !inPlaylistView && selCount >= 2 && (() => {
    // All selected must be files (not dirs) and in the same folder (for non-flat)
    return true; // simplified: frontend stacks are per-folder anyway
  })();
  const selToolbar = isGrid && !inPlaylistView && selCount > 0 && (
    <span data-testid="media-selection-toolbar" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600 }}>
      <span>{selCount} selected</span>
      {canStackSelection && <button data-testid="media-stack-selection" type="button" className="btn btn-sm btn-primary" onClick={() => {
        stackSelectionNow();
      }} style={{ height: 24, padding: "0 10px", fontSize: 11 }}>Stack</button>}
      {selCount > 0 && <button data-testid="media-delete-selection" type="button" className="btn btn-sm btn-outline-secondary" onClick={() => {
        const keys = [...selKeys];
        if (!keys.length && selKey) keys.push(selKey);
        if (!keys.length) return;
        // Build fake items for delete confirmation
        const targets = keys.map((k) => filtered.find((it) => rowKey(it) === k)).filter(Boolean);
        if (targets.length === 1) setDeleteTarget(targets[0]);
        else if (targets.length > 1) { setMultiDeleteTarget(targets); }
      }} style={{ height: 24, padding: "0 10px", fontSize: 11, color: "#f87171" }}>Delete</button>}
      <button data-testid="media-clear-selection" type="button" className="btn btn-sm btn-outline-secondary" onClick={() => { setSelKeys(new Set()); setAnchorKey(null); setSpreadStackId(null); }} style={{ height: 24, padding: "0 10px", fontSize: 11 }}>Clear</button>
    </span>
  );
  // Multi-delete state (batch delete with confirm)
  const [multiDeleteTarget, setMultiDeleteTarget] = useState(null);
  const confirmMultiDelete = async () => {
    const targets = multiDeleteTarget;
    setMultiDeleteTarget(null);
    if (!targets || !targets.length) return;
    for (const it of targets) {
      try {
        const key = rowKey(it);
        const isPlItem = !!it._isPlaylistItem;
        const slash = key.lastIndexOf("/");
        let parent, base;
        if (isPlItem) { parent = slash === -1 ? "" : key.slice(0, slash); base = slash === -1 ? key : key.slice(slash + 1); }
        else { parent = slash === -1 ? folder : (folder ? `${folder}/${key.slice(0, slash)}` : key.slice(0, slash)); base = slash === -1 ? key : key.slice(slash + 1); }
        await fetch(`/api/media?folder=${encodeURIComponent(parent)}&name=${encodeURIComponent(base)}`, { method: "DELETE" });
      } catch {}
    }
    setSelKeys(new Set());
    setAnchorKey(null);
    refresh();
  };
  // Pile rendering: regular member tiles cascaded in a single grid cell —
  // first tile full, each next tile tucked behind showing only its right
  // PEEK strip. Clicks/drops are handled at the pile container level.
  const renderPile = (entry) => {
    const { stackId, stackName, members, count, key } = entry;
    const PEEK = 10;
    const firstKey = rowKey(members[0]);
    const r0 = clampRatio(parseFloat(ratios[firstKey]) || members[0].ratio || 1);
    let memberW = Math.round(GRID_TARGET_H * r0);
    const max = Math.max(gridW - GRID_GAP * 2, 80);
    if (memberW > max) memberW = max;
    const inSel = selKeys.size ? members.some((m) => selKeys.has(rowKey(m))) : false;
    const shift = Math.max(memberW - PEEK, 0);
    // Custom manual order: the whole pile drags as one block. Dropping onto
    // another pile inserts before/after it (by half); dropping files onto a
    // pile still adds them to the stack (existing behavior).
    const isCustomReorder = sort === "custom" && !inPlaylistView && !filtersActive;
    const pileDropSide = (() => {
      if (!dropInfo || !isCustomReorder) return null;
      const mem = pileMemberKeys(stackId);
      if (!mem.includes(dropInfo.key)) return null;
      return dropInfo.side === "after" ? "right" : "left";
    })();
    return (
      <div
        key={key}
        data-testid="media-tile-pile"
        data-filename={stackId}
        data-selected={members.some((m) => selKey === rowKey(m))}
        onClick={(e) => gridClickHandler(entry, e)}
        onDoubleClick={(e) => {
          // Double-click pile: spread it, select the first member only
          e.stopPropagation();
          setSpreadStackId(stackId);
          setSelKeys(new Set([rowKey(members[0])]));
        }}
        draggable={isCustomReorder}
        onDragStart={(e) => {
          if (!isCustomReorder) return;
          const mem = pileMemberKeys(stackId);
          if (!mem.length) return;
          dragKeysRef.current = mem;
          dragKeyRef.current = null;
          e.dataTransfer.effectAllowed = "move";
          try { e.dataTransfer.setData("text/plain", mem[0]); } catch {}
        }}
        onDragEnd={() => { dragKeysRef.current = null; dragKeyRef.current = null; if (dropInfo) setDropInfo(null); }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; e.currentTarget.style.outline = "3px solid var(--accent)"; }}
        onDragLeave={(e) => { e.currentTarget.style.outline = inSel ? "4px solid var(--accent)" : "none"; }}
        onDrop={(e) => {
          e.preventDefault(); e.stopPropagation();
          e.currentTarget.style.outline = inSel ? "4px solid var(--accent)" : "none";
          if (dragKeysRef.current && dragKeysRef.current.length) {
            // Reorder: drop the dragged pile block before/after this pile.
            const r = e.currentTarget.getBoundingClientRect();
            const after = (e.clientX - r.left) > r.width / 2;
            const mem = pileMemberKeys(stackId);
            const edge = after ? mem[mem.length - 1] : mem[0];
            const dks = dragKeysRef.current;
            dragKeysRef.current = null; dragKeyRef.current = null; setDropInfo(null);
            if (edge) moveCustomKeys(dks, edge, after);
            return;
          }
          try {
            const data = JSON.parse(e.dataTransfer.getData("application/x-xdl-stack") || "null");
            if (Array.isArray(data) && data.length && stackId) {
              // Dropped onto another pile: join it, leaving the open pile.
              detachIfOutsideSpread(data, null);
              addStackItems(stackId, data, folder).then(() => refreshStacksAndAnnotate()).catch(() => {});
            }
          } catch {}
        }}
        title={isCustomReorder ? `${stackName} — ${count} files — drag to reorder` : `${stackName} — ${count} files`}
        style={{ position: "relative", display: "flex", flexDirection: "row", alignItems: "stretch", width: memberW + PEEK * (members.length - 1), height: GRID_TARGET_H, flex: "0 0 auto", cursor: isCustomReorder ? "grab" : "pointer", outline: inSel ? "4px solid var(--accent)" : "none", animation: "media-pile-in .22s ease" }}
      >
        {pileDropSide && (
          <div style={{ position: "absolute", top: 0, bottom: 0, [pileDropSide]: -3, width: 4, borderRadius: 2, background: "var(--accent)", zIndex: 10, pointerEvents: "none" }} />
        )}
        {members.map((m, i) => (
          <div key={rowKey(m)} style={{ marginLeft: i === 0 ? 0 : -shift, zIndex: members.length - i, pointerEvents: "none", flex: "0 0 auto" }}>
            {renderTile(m, i, memberW, GRID_TARGET_H)}
          </div>
        ))}
      </div>
    );
  };

  // --- Context menu (grid only) ---
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, entry }
  const [ctxMenuStackId, setCtxMenuStackId] = useState(null);
  const ctxRef = useRef(null);
  const openContextMenu = (e, entry) => {
    e.preventDefault();
    e.stopPropagation();
    let sid = null;
    if (entry.kind === "pile") sid = entry.stackId;
    else if (entry.kind === "file") {
      const stacks = entry.it && entry.it.stacks;
      if (Array.isArray(stacks) && stacks.length) sid = stacks[0].id;
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
    setCtxMenuStackId(sid);
  };
  // Close context menu on outside click / escape
  useEffect(() => {
    if (!ctxMenu) return;
    const onDoc = (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-testid="media-context-menu"]')) return;
      setCtxMenu(null);
    };
    const onKey = (e) => { if (e.key === "Escape") setCtxMenu(null); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [ctxMenu]);
  // Selected keys in grid (files only)
  const selectedKeysForStack = useMemo(() => {
    const s = new Set();
    if (selKeys.size) for (const k of selKeys) s.add(k);
    else if (selKey) s.add(selKey);
    return s;
  }, [selKeys, selKey]);
  const promptStackPropsFor = (id) => {
    const st = folderStacks.find((s) => s.id === id);
    return { title: "Rename stack", message: "", defaultValue: st ? st.name : "", placeholder: "Stack name" };
  };
  // After stack mutations, refresh stacks + patch `it.stacks` annotations
  // in place. A full media reload would wipe thumbnail state (ratios,
  // loaded flags) and force ~1000 images to refetch with spinners.
  // Stacks left with a lone file are dissolved server-side; a spread pile
  // whose stack vanished collapses.
  const annotateItems = (stacks) => {
    const byBase = new Map();
    for (const s of stacks || []) {
      const scount = s.count ?? (Array.isArray(s.items) ? s.items.length : 0);
      for (const b of (s.items || [])) {
        if (!byBase.has(b)) byBase.set(b, []);
        byBase.get(b).push({ id: s.id, name: s.name, count: scount });
      }
    }
    setItems((prev) => prev.map((it) => {
      if (it.dir) return it;
      const base = String(isFlat ? (it.rel || it.name) : it.name).split("/").pop();
      const mine = byBase.get(base) || [];
      if (!mine.length && !it.stacks) return it;
      const next = { ...it };
      if (mine.length) next.stacks = mine;
      else delete next.stacks;
      return next;
    }));
  };
  const refreshStacksAndAnnotate = async () => {
    const stacks = await refreshStacks(folder);
    if (!Array.isArray(stacks)) { refresh(); return; }
    if (spreadStackIdRef.current && !stacks.some((s) => s.id === spreadStackIdRef.current)) setSpreadStackId(null);
    annotateItems(stacks);
  };
  // A member dragged out of the open (spread) pile leaves the stack.
  // Dropping inside the open pile (infoKey is a fellow member) keeps it.
  const detachIfOutsideSpread = (keys, infoKey) => {
    if (!spreadStackId) return;
    const mem = pileMemberKeys(spreadStackId);
    const dragged = (keys || []).filter((k) => mem.includes(k));
    if (!dragged.length) return;
    if (infoKey && mem.includes(infoKey)) return;
    removeStackItems(spreadStackId, dragged, folder).then(() => refreshStacksAndAnnotate()).catch(() => {});
  };
  const handleStackPromptConfirm = async (v) => {
    const id = promptState.id;
    setPromptState({ open: false, id: null, value: "" });
    try {
      await renameStack(id, v, folder);
      await refreshStacksAndAnnotate();
    } catch (e) {
      setAlertState({ open: true, title: "Stack error", message: e.message || String(e) });
    }
  };
  // Stacks need no name: create immediately with the first unused "Stack N".
  const stackSelectionNow = async () => {
    const items = [...selectedKeysForStack];
    if (items.length < 2) return;
    const used = new Set(folderStacks.map((s) => String(s.name || "").toLowerCase()));
    let n = 1;
    while (used.has(`stack ${n}`)) n++;
    try {
      await createStack({ name: `Stack ${n}`, folder, items });
      await refreshStacksAndAnnotate();
    } catch (e) {
      setAlertState({ open: true, title: "Stack error", message: e.message || String(e) });
    }
  };
  const confirmStackDelete = (id) => {
    setConfirmState({ open: true, id: `stack:${id}`, name: folderStacks.find((s) => s.id === id)?.name || "" });
  };
  const handleStackDeleteConfirm = async () => {
    const id = String(confirmState.id || "").replace(/^stack:/, "");
    setConfirmState({ open: false, id: null, name: "" });
    try {
      await deleteStack(id, folder);
      await refreshStacksAndAnnotate();
      if (spreadStackId === id) setSpreadStackId(null);
    } catch (e) {
      setAlertState({ open: true, title: "Delete failed", message: e.message || String(e) });
    }
  };
  const handleRemoveFromStack = async (stackId, keys) => {
    try {
      // Server dissolves stacks left with a lone file; sync clears dead spread.
      await removeStackItems(stackId, keys, folder);
      await refreshStacksAndAnnotate();
      setSelKeys(new Set());
    } catch (e) {
      setAlertState({ open: true, title: "Remove failed", message: e.message || String(e) });
    }
  };

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
        {selToolbar}
        <span data-testid="media-sort-bar" title="Sort (same as list header)" style={{ display: "inline-flex", alignItems: "center", gap: 2, marginLeft: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 2, background: "var(--surface-2)" }}>
          {sortBarBtn("name", "Name", "media-sortbar-name")}
          {sortBarBtn("size", "Size", "media-sortbar-size")}
          {sortBarBtn("time", "Time", "media-sortbar-time")}
          {sortBarBtn("custom", "Custom", "media-sortbar-custom")}
        </span>
      </div>
      </div>

      <div data-testid="media-content" className="media-full">
      {err && <div data-testid="media-error" className="card" style={{ padding: 12, color: "var(--danger)", marginBottom: 12 }}>{folderMissing ? `Folder not found: ${folder} — it may have been moved, renamed or deleted.` : err}</div>}

      <style>{`.media-tile-file:hover .media-tile-playlist-btn-wrap{opacity:1 !important} .media-row:hover .media-row-playlist-btn{opacity:1 !important} .media-tile-playlist:hover .playlist-chip-actions{opacity:1 !important} .media-row-playlist:hover .playlist-row-actions{opacity:1 !important}@keyframes media-pile-in{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}@keyframes media-member-in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}`}</style>
      {isGrid ? (
        <div data-testid="media-grid-card" className="card media-lib-card">
          <div data-testid="media-grid" ref={gridRef} className="card-body" style={{ padding: GRID_GAP }}>
            {inPlaylistView ? (
              playlistLoading ? <div data-testid="media-loading" style={{ padding: 20, gridColumn: "1 / -1", color: "var(--muted)" }}>Loading playlist…</div> : !playlistDetail ? <div data-testid="media-error" style={{ padding: 20, gridColumn: "1 / -1", color: "var(--danger)" }}>Playlist not found</div> : filtered.length === 0 ? (filtersActive ? filterEmptyNotice : <div data-testid="media-empty" className="empty" style={{ padding: 20, gridColumn: "1 / -1" }}><i className="bi bi-collection-play" /> Empty playlist — add files from Media</div>) : !gridW ? <div data-testid="media-grid-measuring" style={{ padding: 20, color: "var(--muted)" }}>Measuring…</div> : (
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
                {(gridVisibleWithWidths.length > 0 || (gridVisibleWithWidths.length === 0 && filtered.length === 0 && (folder || playlists.length === 0))) && (
                  <div data-testid="media-grid-files" style={{ display: "flex", flexWrap: "wrap", gap: GRID_GAP }}
                    onContextMenu={(e) => {
                      // Empty-area context menu: keep selection, allow stack actions
                      if (e.target && e.target.closest && e.target.closest('[data-testid="media-tile-file"], [data-testid="media-tile-pile"], [data-testid="media-tile-folder"]')) return;
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, entry: { kind: "file", it: null, key: null } });
                      setCtxMenuStackId(null);
                    }}
                    onDragOver={(e) => {
                      if (sort !== "custom" || inPlaylistView || filtersActive || (!dragKeyRef.current && !dragKeysRef.current)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const skip = dragKeysRef.current && dragKeysRef.current.length ? new Set(dragKeysRef.current) : dragKeyRef.current;
                      const info = nearestDropInfo(e.currentTarget, e.clientX, e.clientY, skip);
                      if (sameDropInfo(dropInfo, info)) return;
                      setDropInfo(info);
                    }}
                    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && dropInfo) setDropInfo(null); }}
                    onDrop={(e) => {
                      if (sort !== "custom" || inPlaylistView || filtersActive || (!dragKeyRef.current && !dragKeysRef.current)) return;
                      e.preventDefault();
                      const dk = dragKeyRef.current;
                      const dks = dragKeysRef.current;
                      setDropInfo(null);
                      const skip = dks && dks.length ? new Set(dks) : dk;
                      const info = nearestDropInfo(e.currentTarget, e.clientX, e.clientY, skip);
                      if (dks && dks.length) {
                        if (info) moveCustomKeys(dks, info.key, info.side === "after");
                      } else if (info && info.key !== dk) {
                        // Spread member dropped outside the open pile leaves it.
                        detachIfOutsideSpread([dk], info.key);
                        // Outsider dropped inside the open pile joins it (at the
                        // drop index via the reorder below).
                        if (spreadStackId) {
                          const mem = pileMemberKeys(spreadStackId);
                          if (mem.includes(info.key) && !mem.includes(dk)) {
                            addStackItems(spreadStackId, [dk], folder).then(() => refreshStacksAndAnnotate()).catch(() => {});
                          }
                        }
                        moveCustomKey(dk, info.key, info.side === "after");
                      }
                    }}
                  >
                    {filtered.length === 0 ? (!loading && !err ? (filtersActive ? filterEmptyNotice : <div data-testid="media-empty" className="empty" style={{ padding: 20, gridColumn: "1 / -1", width: "100%", textAlign: "center" }}><i className="bi bi-inbox" /> {folder ? "This folder is empty" : "No files — download something!"}</div>) : null) : gridVisibleWithWidths.map((entry) => (entry.kind === "pile" ? renderPile(entry) : renderTile(entry.it, 0, entry.w, entry.h, spreadMemberAnim(entry.key))))}
                  </div>
                )}
                {filtered.length > 0 && fileRows.length === 0 && !inPlaylistView && (filtersActive ? filterEmptyNotice : <div data-testid="media-empty" className="empty" style={{ padding: 12 }}><i className="bi bi-inbox" /> No files in this folder</div>)}
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
                {filtered.length === 0 ? (filtersActive ? filterEmptyNotice : <div data-testid="media-empty" className="empty" style={{ padding: 20, gridColumn: "1 / -1" }}><i className="bi bi-collection-play" /> Empty playlist — add files from Media</div>) : (
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
              {loading && items.length === 0 ? <div data-testid="media-loading" style={{ padding: 20, gridColumn: "1 / -1", color: "var(--muted)" }}>Loading…</div> : (isEmptyForList ? (!loading && !err ? (filtersActive ? filterEmptyNotice : <div data-testid="media-empty" className="empty" style={{ padding: 20, gridColumn: "1 / -1" }}><i className="bi bi-inbox" /> {folder ? "This folder is empty" : "No files — download something!"}</div>) : null) : (
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
        title={promptState.id && String(promptState.id).startsWith("stack:") ? "Rename stack" : "Rename playlist"}
        message={promptState.id && String(promptState.id).startsWith("stack:") ? `Enter a new name for "${folderStacks.find((s) => s.id === String(promptState.id).slice(6))?.name || ""}"` : `Enter new name for "${playlists.find((p) => p.id === promptState.id)?.name || ""}"`}
        defaultValue={promptState.value}
        placeholder={promptState.id && String(promptState.id).startsWith("stack:") ? "Stack name" : "Playlist name"}
        onCancel={() => setPromptState({ open: false, id: null, value: "" })}
        onConfirm={async (v) => {
          if (promptState.id && String(promptState.id).startsWith("stack:")) {
            await handleStackPromptConfirm(v);
            return;
          }
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
        title={String(confirmState.id || "").startsWith("stack:") ? "Unstack" : "Delete playlist"}
        message={String(confirmState.id || "").startsWith("stack:") ? `Delete stack "${confirmState.name}"? Files stay in Media.` : `Delete playlist "${confirmState.name}"? Files stay in Media.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmState({ open: false, id: null, name: "" })}
        onConfirm={async () => {
          if (String(confirmState.id || "").startsWith("stack:")) {
            await handleStackDeleteConfirm();
            return;
          }
          try {
            await deletePlaylist(confirmState.id);
            setConfirmState({ open: false, id: null, name: "" });
          } catch (e) {
            setAlertState({ open: true, title: "Delete failed", message: e.message || String(e) });
          }
        }}
      />
      <MediaContextMenu
        menu={ctxMenu}
        stacks={folderStacks}
        selCount={selectedKeysForStack.size}
        onClose={() => setCtxMenu(null)}
        onStack={() => stackSelectionNow()}
        onOpen={() => {
          const entry = ctxMenu && ctxMenu.entry;
          if (!entry) return;
          if (entry.kind === "file" && entry.it) openItem(entry.it);
          else if (entry.kind === "pile" && entry.members && entry.members.length) openViewer(entry.members[0]);
        }}
        onDelete={() => {
          const entry = ctxMenu && ctxMenu.entry;
          if (!entry) return;
          if (entry.kind === "file" && entry.it) { setDeleteTarget(entry.it); return; }
          if (entry.kind === "pile") { confirmStackDelete(entry.stackId); return; }
          // Empty-area / selection: delete selected files
          const keys = [...selectedKeysForStack];
          const targets = keys.map((k) => filtered.find((it) => rowKey(it) === k)).filter(Boolean);
          if (targets.length === 1) setDeleteTarget(targets[0]);
          else if (targets.length > 1) setMultiDeleteTarget(targets);
        }}
        onAddToStack={(stackId, stackName) => {
          const keys = [...selectedKeysForStack];
          if (!keys.length && ctxMenu && ctxMenu.entry && ctxMenu.entry.kind === "file" && ctxMenu.entry.it) keys.push(rowKey(ctxMenu.entry.it));
          if (!keys.length) return;
          (async () => {
            try {
              await addStackItems(stackId, keys, folder);
              // Move: files already stacked elsewhere leave those stacks
              // (server dissolves any left with a lone file).
              const leaving = new Map();
              for (const k of keys) {
                const it = filtered.find((x) => rowKey(x) === k);
                const st = it && Array.isArray(it.stacks) ? it.stacks : [];
                for (const s of st) {
                  if (s.id === stackId) continue;
                  if (!leaving.has(s.id)) leaving.set(s.id, []);
                  leaving.get(s.id).push(k);
                }
              }
              for (const [sid, ks] of leaving) {
                try { await removeStackItems(sid, ks, folder); } catch {}
              }
            } catch (e) {
              setAlertState({ open: true, title: "Add failed", message: e.message || String(e) });
              return;
            }
            refreshStacksAndAnnotate();
          })();
        }}
        onRename={() => {
          const entry = ctxMenu && ctxMenu.entry;
          const id = entry && entry.kind === "pile" ? entry.stackId : ctxMenuStackId;
          if (!id) return;
          setPromptState({ open: true, id: `stack:${id}`, value: folderStacks.find((s) => s.id === id)?.name || "" });
        }}
        onUnstack={() => {
          const entry = ctxMenu && ctxMenu.entry;
          const id = entry && entry.kind === "pile" ? entry.stackId : ctxMenuStackId;
          if (id) confirmStackDelete(id);
        }}
        onRemoveFromStack={() => {
          const entry = ctxMenu && ctxMenu.entry;
          const id = entry && entry.kind === "pile" ? entry.stackId : ctxMenuStackId;
          if (!id) return;
          let keys = [...selectedKeysForStack];
          if (entry && entry.kind === "file" && entry.it) {
            const rk = rowKey(entry.it);
            if (!keys.includes(rk)) keys = [rk];
          }
          if (!keys.length) return;
          handleRemoveFromStack(id, keys);
        }}
      />
      {yArmKey && !viewerOpen && (
        <div
          data-testid="media-y-confirm"
          onClick={() => { setYArmKey(null); yArmRef.current = null; lastYRef.current = 0; }}
          style={{ position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 120, fontSize: 12, fontWeight: 600, color: "#fff", background: "#ef4444", padding: "6px 12px", borderRadius: 999, border: "1px solid rgba(255,255,255,.2)", whiteSpace: "nowrap", cursor: "pointer" }}
        >
          Press y again to confirm delete
        </div>
      )}
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
      <ConfirmModal
        open={!!multiDeleteTarget}
        title="Delete selected files"
        message={multiDeleteTarget ? `Delete ${multiDeleteTarget.length} files? This removes them from /media.` : ""}
        confirmLabel="Delete"
        danger
        onCancel={() => setMultiDeleteTarget(null)}
        onConfirm={confirmMultiDelete}
      />
      </div>
    </div>
  );
}