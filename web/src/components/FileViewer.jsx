import { useState, useEffect, useRef, useCallback } from "react";
import ShortcutsHelp from "./ShortcutsHelp";
import PlaylistHoverMenu from "./PlaylistHoverMenu.jsx";
import { usePlaylists } from "../store/PlaylistsContext.jsx";
import ConfirmModal from "./ConfirmModal.jsx";
import AlertModal from "./AlertModal.jsx";

const ROT_STORE_KEY = "xdl_viewer_rotations";
function readFileRotation(fp) {
  if (!fp) return 0;
  try {
    const map = JSON.parse(localStorage.getItem(ROT_STORE_KEY) || "{}");
    const v = Number(map[fp]);
    return v === 90 || v === 180 || v === 270 ? v : 0;
  } catch { return 0; }
}
function saveFileRotation(fp, deg) {
  if (!fp) return;
  try {
    const map = JSON.parse(localStorage.getItem(ROT_STORE_KEY) || "{}");
    if (deg % 360 === 0) delete map[fp];
    else map[fp] = deg;
    localStorage.setItem(ROT_STORE_KEY, JSON.stringify(map));
  } catch {}
}
const TRACK_CAP = 480;
const TRACK_TPL = 40;
const TRACK_ROI = 52;
const TRACK_DEAD = 0.6;
const TRACK_PAN_SMOOTH = 0.45;
const TRACK_STICK = 1500;
const TRACK_JUMP = 12;
const TRACK_TEX_MIN = 150;
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function rotDeg(x, y, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return [x, y];
  const a = (d * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}
function capturePatch(img, rw, rh, cx, cy, size) {
  const tw = Math.min(size, rw), th = Math.min(size, rh);
  const tx0 = clamp(Math.round(cx - tw / 2), 0, rw - tw);
  const ty0 = clamp(Math.round(cy - th / 2), 0, rh - th);
  const d = img.data, m = new Int32Array(tw * th);
  let vi = 0;
  for (let y = 0; y < th; y++) {
    let fi = ((ty0 + y) * rw + tx0) << 2;
    for (let x = 0; x < tw; x++) { m[vi] = (d[fi] * 3 + d[fi + 1] * 6 + d[fi + 2]) >> 3; vi++; fi += 4; }
  }
  return { tpl: m, tplW: tw, tplH: th };
}
function captureTemplate(img, st, cx, cy) {
  const p = capturePatch(img, img.width, img.height, cx, cy, TRACK_TPL);
  st.tpl = p.tpl; st.tplW = p.tplW; st.tplH = p.tplH;
}
function refreshGrid(img, st) {
  const rw = st.rw, rh = st.rh, s = 32, m = s / 2 + 4;
  const pts = [[m, m], [rw / 2, m], [rw - m, m], [m, rh / 2], [rw - m, rh / 2], [m, rh - m], [rw / 2, rh - m], [rw - m, rh - m]];
  st.grid = pts.map(([x, y]) => {
    const p = capturePatch(img, rw, rh, x, y, s);
    p.fx = clamp(x, 0, rw - 1); p.fy = clamp(y, 0, rh - 1);
    return p;
  });
}
function blendTemplate(img, st, cx, cy, alpha) {
  if (!st.tpl) return;
  const rw = img.width, rh = img.height;
  const tplW = st.tplW, tplH = st.tplH;
  const tx0 = clamp(Math.round(cx - tplW / 2), 0, rw - tplW);
  const ty0 = clamp(Math.round(cy - tplH / 2), 0, rh - tplH);
  const d = img.data;
  let vi = 0;
  for (let y = 0; y < tplH; y++) {
    let fi = ((ty0 + y) * rw + tx0) << 2;
    for (let x = 0; x < tplW; x++) {
      const l = (d[fi] * 3 + d[fi + 1] * 6 + d[fi + 2]) >> 3;
      st.tpl[vi] += (l - st.tpl[vi]) * alpha;
      vi++; fi += 4;
    }
  }
}
function ssdAt(lum, st, base) {
  const tpl = st.tpl, tplW = st.tplW, tplH = st.tplH, rw = st.rw;
  let vi = 0, s = 0;
  for (let ty = 0; ty < tplH; ty++) {
    let li = base + ty * rw;
    for (let tx = 0; tx < tplW; tx++) { const dd = lum[li] - tpl[vi]; s += dd * dd; li++; vi++; }
  }
  return s;
}
function bestTemplateSearch(img, st, predX, predY, wide, roi) {
  const len = st.rw * st.rh;
  let lum = st.lum;
  if (!lum || lum.length < len) { lum = new Int32Array(len); st.lum = lum; }
  const d = img.data;
  for (let n = 0, fi = 0; fi < d.length; fi += 4, n++) lum[n] = (d[fi] * 3 + d[fi + 1] * 6 + d[fi + 2]) >> 3;
  const halfX = st.tplW >> 1, halfY = st.tplH >> 1;
  const step = wide ? 6 : 3;
  const rng = roi || TRACK_ROI;
  const minX = wide ? halfX : Math.max(halfX, Math.round(predX) - rng);
  const maxX = wide ? st.rw - halfX : Math.min(st.rw - halfX, Math.round(predX) + rng);
  const minY = wide ? halfY : Math.max(halfY, Math.round(predY) - rng);
  const maxY = wide ? st.rh - halfY : Math.min(st.rh - halfY, Math.round(predY) + rng);
  let best = Infinity, bestRaw = Infinity, bx = Math.round(predX), by = Math.round(predY);
  if (maxX < minX || maxY < minY) return { x: bx, y: by, score: bestRaw };
  for (let cy = minY; cy <= maxY; cy += step) {
    const baseY = (cy - halfY) * st.rw;
    for (let cx = minX; cx <= maxX; cx += step) {
      const s = ssdAt(lum, st, baseY + cx - halfX);
      const p = s + TRACK_STICK * ((cx - predX) * (cx - predX) + (cy - predY) * (cy - predY));
      if (p < best) { best = p; bestRaw = s; bx = cx; by = cy; }
    }
  }
  for (let dy = -2; dy <= 2; dy++) {
    const cy = clamp(by + dy, minY, maxY);
    const baseY = (cy - halfY) * st.rw;
    for (let dx = -2; dx <= 2; dx++) {
      const cx = clamp(bx + dx, minX, maxX);
      const s = ssdAt(lum, st, baseY + cx - halfX);
      const p = s + TRACK_STICK * ((cx - predX) * (cx - predX) + (cy - predY) * (cy - predY));
      if (p < best) { best = p; bestRaw = s; bx = cx; by = cy; }
    }
  }
  return { x: bx, y: by, score: bestRaw };
}
function parseFolderBase(fp) {
  const raw = String(fp || "");
  const idx = raw.indexOf("/media/");
  const without = idx !== -1 ? raw.slice(idx + 7) : raw.replace(/^\/+/, "").replace(/^media\//, "");
  const parts = without.split("/").filter(Boolean);
  if (!parts.length) return { folder: "", base: "" };
  const base = parts.pop();
  return { folder: parts.join("/"), base };
}
function toMediaUrlLocal(fp) {
  if (!fp) return "";
  const s = String(fp);
  const idx = s.indexOf("/media/");
  if (idx !== -1) return s.slice(idx);
  return s.startsWith("/media/") ? s : s.startsWith("media/") ? `/${s}` : s.startsWith("/") ? s : `/${s}`;
}
function deriveTitleLocal(url, filePath) {
  if (filePath) {
    const base = String(filePath).split("/").pop() || "";
    return base.replace(/-\d+\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim() || url;
  }
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    const decoded = decodeURIComponent(seg).replace(/[-_]+/g, " ").trim();
    if (decoded.length > 3) return decoded.length > 60 ? decoded.slice(0, 60) + "…" : decoded;
    return u.hostname.replace(/^www\./, "") + u.pathname.slice(0, 40);
  } catch { return url; }
}
export default function FileViewer({ src, title, filePath, url, file, viewable, idx, onPrev, onNext, onGoto, onClose, onDeleted }) {
  const effFilePath = filePath || file?.filePath || "";
  const effUrl = url || file?.url || "";
  const effSrc = src || (effFilePath ? toMediaUrlLocal(effFilePath) : "");
  const effTitle = title || deriveTitleLocal(effUrl, effFilePath);
  const filePathEff = effFilePath;
  const videoRef = useRef(null);
  const imgRef = useRef(null);
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const [rate, setRate] = useState(() => { try { const v = parseFloat(localStorage.getItem("xdl_viewer_rate")); if (!Number.isNaN(v) && v >= 0.1 && v <= 1) return v; } catch {} return 1; });
  const [isPlaying, setIsPlaying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [origin, setOrigin] = useState("50% 50%");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotate, setRotate] = useState(0);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const rotLoadedRef = useRef("");
  const [isFs, setIsFs] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [trackLost, setTrackLost] = useState(false);
  const [trackHover, setTrackHover] = useState(false);
  const [trackArmed, setTrackArmed] = useState(false);
  const trackArmedRef = useRef(false);
  const trackingRef = useRef(false);
  const trackGenRef = useRef(0);
  const trackViewRef = useRef({ tracking: false, zoom: 1, pan: { x: 0, y: 0 }, transform: "" });
  const trackSmoothRef = useRef(TRACK_PAN_SMOOTH);
  const trackStateRef = useRef(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });
  const wasPlayingRef = useRef(false);
  const shiftWasPlayingRef = useRef(false);
  const jogRef = useRef(null);
  const jogWasPlayingRef = useRef(false);
  const jogGenRef = useRef(0);

  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekFrames, setSeekFrames] = useState(() => { try { return localStorage.getItem("xdl_viewer_seekFrames") === "1"; } catch { return false; } });
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("xdl_viewer_muted") === "1"; } catch { return false; } });
  const [endMode, setEndMode] = useState(() => { try { const v = localStorage.getItem("xdl_viewer_endMode"); if (v === "stop") return "next"; if (v === "repeat" || v === "random") return v; return "none"; } catch { return "none"; } });
  const [randHistory, setRandHistory] = useState([]);
  const [randCursor, setRandCursor] = useState(-1);
  const randHistoryRef = useRef([]);
  const [yConfirm, setYConfirm] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [fHeld, setFHeld] = useState(false);
  const fHeldRef = useRef(false);
  const { playlists: fvPlaylists, toggleItem: fvToggleItem } = usePlaylists();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [alertState, setAlertState] = useState({ open: false, title: "", message: "" });
  const playlistHoverRef = useRef(null);
  const playlistCloseTimer = useRef(null);
  // `.gif` files that are actually MP4 bytes (mislabeled at download time)
  // fail in <img> — flip to a <video> element on image error.
  const [gifAsVideo, setGifAsVideo] = useState(false);
  const lastYRef = useRef(0);
  const yConfirmTimerRef = useRef(null);
  const doDeleteFileRef = useRef(null);
  const randCursorRef = useRef(-1);
  const fmtTime = (s) => { if (!s || Number.isNaN(s)) return "0:00"; const m = Math.floor(s/60); const sec = String(Math.floor(s%60)).padStart(2,"0"); return `${m}:${sec}`; };
  const mediaUrl = effSrc;
  const navRef = useRef(mediaUrl);
  const [loadedUrl, setLoadedUrl] = useState(mediaUrl);
  const loadTimerRef = useRef(null);
  const seekRef = useRef(null);
  const animRef = useRef(null);
  const rafRef = useRef(null);
  const pendingSeekRef = useRef(null);
  const pressedRef = useRef(false);
  const isDraggingRef = useRef(false);
  const pressStartRef = useRef({ x: 0, y: 0 });
  const [mediaReady, setMediaReady] = useState(false);
  useEffect(() => {
    navRef.current = mediaUrl;
    if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    loadTimerRef.current = setTimeout(() => { if (navRef.current === mediaUrl) setLoadedUrl(mediaUrl); }, 150);
    return () => { if (loadTimerRef.current) clearTimeout(loadTimerRef.current); };
  }, [mediaUrl]);
  const loading = mediaUrl !== loadedUrl;
  const titleEff = effTitle;
  const urlEff = effUrl;
  const ext = String(filePathEff || effSrc || "").split(".").pop()?.toLowerCase() || "";
  const isVideo = /^(mp4|webm|mkv|mov|m4v|avi|mpg|mpeg|3gp|flv|ts|m3u8)$/i.test(ext);
  const isAudio = /^(mp3|m4a|aac|ogg|wav|flac|opus)$/i.test(ext);
  const isImage = /^(jpg|jpeg|png|gif|webp|bmp|avif)$/i.test(ext);
  const isGif = ext === "gif";
  const gifAsVideoEff = isGif && gifAsVideo;
  const showImage = isImage && !gifAsVideoEff;
  const isFormatKnown = isVideo || isAudio || isImage;
  const hasPrev = idx != null && idx > 0;
  const hasNext = idx != null && viewable && idx < viewable.length - 1;
  const total = viewable ? viewable.length : 0;
  const transposed = rotate === 90 || rotate === 270;
  const mediaW = transposed && stageSize.w && stageSize.h ? stageSize.h : "100%";
  const mediaH = transposed && stageSize.w && stageSize.h ? stageSize.w : "100%";
  const videoishRef = useRef(false);
  videoishRef.current = isVideo || gifAsVideoEff;
  const showImageRef = useRef(false);
  showImageRef.current = showImage;
  const rotateRef = useRef(0);
  rotateRef.current = rotate;
  const stageSizeRef = useRef({ w: 0, h: 0 });
  stageSizeRef.current = stageSize;

  const stepRate = (delta) => {
    setRate((r) => Math.min(1, Math.max(0.1, Math.round((r + delta) * 10) / 10)));
  };
  const toggleFullscreen = () => {
    const el = viewerRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen().then(() => el.requestFullscreen().catch(() => {})).catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate, loadedUrl]);
  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted, loadedUrl]);
  useEffect(() => { try { localStorage.setItem("xdl_viewer_muted", muted ? "1" : "0"); } catch {} }, [muted]);
  useEffect(() => { try { localStorage.setItem("xdl_viewer_rate", String(rate)); } catch {} }, [rate]);
  useEffect(() => { try { localStorage.setItem("xdl_viewer_seekFrames", seekFrames ? "1" : "0"); } catch {} }, [seekFrames]);
  const stopTracking = useCallback(() => {
    if (!trackingRef.current && !trackStateRef.current) { setTracking(false); return; }
    trackingRef.current = false;
    trackGenRef.current++;
    const st = trackStateRef.current;
    trackStateRef.current = null;
    if (st) {
      if (st.raf) cancelAnimationFrame(st.raf);
      const v = videoRef.current;
      if (v && st.onSeeked) v.removeEventListener("seeked", st.onSeeked);
    }
    trackViewRef.current = { tracking: false, zoom: 1, pan: { x: 0, y: 0 }, transform: "" };
    setTracking(false);
    setTrackLost(false);
    setTrackHover(false);
    setZoom(1);
    setOrigin("50% 50%");
    setPan({ x: 0, y: 0 });
  }, []);
  useEffect(() => { try { localStorage.setItem("xdl_viewer_endMode", endMode); } catch {} }, [endMode]);
  useEffect(() => { if (rotLoadedRef.current !== filePathEff) return; saveFileRotation(filePathEff, rotate); }, [rotate, filePathEff]);
  useEffect(() => { stopTracking(); rotLoadedRef.current = filePathEff; setZoom(1); setOrigin("50% 50%"); setPan({x:0,y:0}); setRotate(readFileRotation(filePathEff)); setCurrent(0); setDuration(0); setGifAsVideo(false); setMediaReady(false); setYConfirm(false); lastYRef.current = 0; animRef.current = null; pendingSeekRef.current = null; if (yConfirmTimerRef.current) { clearTimeout(yConfirmTimerRef.current); yConfirmTimerRef.current = null; } setTimeout(() => videoRef.current?.focus(), 50); }, [loadedUrl, filePathEff, stopTracking]);
  // Drive the seekbar with requestAnimationFrame: read the video's live
  // currentTime every frame so the thumb glides instead of stepping with the
  // ~4/s timeupdate events. Any seek (keyboard, wheel, ±10s, track click, or
  // loop restart) sets a pending target that the thumb flies to with a short
  // easeOut glide; an active pointer drag cancels the flight and tracks the
  // pointer directly.
  const seekTo = useCallback((nt) => {
    const v = videoRef.current;
    if (!v) return;
    const lim = Number.isFinite(v.duration) ? v.duration : 1e9;
    const t = Math.max(0, Math.min(lim, typeof nt === "number" && Number.isFinite(nt) ? nt : 0));
    pendingSeekRef.current = t;
    v.currentTime = t;
    setCurrent(t);
  }, []);
  useEffect(() => {
    const frame = () => {
      rafRef.current = requestAnimationFrame(frame);
      const el = seekRef.current;
      const v = videoRef.current;
      if (!v || !el) return;
      const max = Number.isFinite(v.duration) ? v.duration : duration || 0;
      const now = performance.now();
      const a = animRef.current;
      if (a) {
        if (pendingSeekRef.current != null && Math.abs(pendingSeekRef.current - a.to) > 0.01) {
          const cur = a.from + (a.to - a.from) * (1 - Math.pow(1 - Math.min(1, (now - a.start) / a.dur), 3));
          a.from = cur;
          a.to = Math.max(0, Math.min(max, pendingSeekRef.current));
          a.start = now;
          pendingSeekRef.current = null;
        }
        const q = Math.min(1, (now - a.start) / a.dur);
        const eased = 1 - Math.pow(1 - q, 3);
        const shown = a.from + (a.to - a.from) * eased;
        if (Math.abs(el.valueAsNumber - shown) > 0.005) el.value = String(shown);
        if (q >= 1) animRef.current = null;
        return;
      }
      if (pendingSeekRef.current != null) {
        const to = Math.max(0, Math.min(max, pendingSeekRef.current));
        if (Math.abs(to - el.valueAsNumber) > 0.01) animRef.current = { from: el.valueAsNumber, to, start: now, dur: 280 };
        else pendingSeekRef.current = null;
        return;
      }
      const t = v.currentTime;
      if (Math.abs(el.valueAsNumber - t) > 0.01 && t <= max) el.value = String(t);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); animRef.current = null; pendingSeekRef.current = null; };
  }, [loadedUrl, duration]);
  // The loading gate above unmounts the <img> while debouncing, then remounts
  // it — grid thumbnails are the full photo bytes, so the remount is usually
  // cache-complete before insertion and onLoad never fires. Detect that so a
  // navigated-to photo never sticks at opacity 0 behind the spinner.
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0) setMediaReady(true);
  }, [loadedUrl]);
  useEffect(() => () => { if (yConfirmTimerRef.current) clearTimeout(yConfirmTimerRef.current); if (playlistCloseTimer.current) clearTimeout(playlistCloseTimer.current); }, []);
  const navigatingViaRandomRef = useRef(false);
  useEffect(() => {
    if (navigatingViaRandomRef.current) { navigatingViaRandomRef.current = false; return; }
    setRandHistory([]);
    setRandCursor(-1);
    randHistoryRef.current = [];
    randCursorRef.current = -1;
  }, [idx]);
  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === viewerRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const showPlaylistRef = useRef(showPlaylist);
  useEffect(() => { showPlaylistRef.current = showPlaylist; }, [showPlaylist]);
  const endModeRef = useRef(endMode);
  endModeRef.current = endMode;
  const viewableRef = useRef(viewable);
  viewableRef.current = viewable;
  const idxRef = useRef(idx);
  idxRef.current = idx;
  const onGotoRef = useRef(onGoto);
  onGotoRef.current = onGoto;
  const onNextRef = useRef(onNext);
  onNextRef.current = onNext;
  const onPrevRef = useRef(onPrev);
  onPrevRef.current = onPrev;
  const hasNextRef = useRef(hasNext);
  hasNextRef.current = hasNext;

  const pickRandomDifferent = (total, exclude) => {
    if (total <= 1) return exclude;
    const r = Math.floor(Math.random() * (total - 1));
    return r >= exclude ? r + 1 : r;
  };

  const dispatchNext = () => {
    const v = viewableRef.current;
    if (!v || !v.length) return;
    if (endModeRef.current === "random") {
      const cur = randCursorRef.current;
      const hist = randHistoryRef.current;
      if (cur < hist.length - 1) {
        const next = cur + 1;
        setRandCursor(next);
        randCursorRef.current = next;
        navigatingViaRandomRef.current = true;
        onGotoRef.current(hist[next]);
      } else {
        const newIdx = pickRandomDifferent(v.length, idxRef.current);
        const newHist = [...hist.slice(0, cur + 1), newIdx];
        setRandHistory(newHist);
        setRandCursor(cur + 1);
        randHistoryRef.current = newHist;
        randCursorRef.current = cur + 1;
        navigatingViaRandomRef.current = true;
        onGotoRef.current(newIdx);
      }
    } else {
      onNextRef.current();
    }
  };

  const dispatchPrev = () => {
    const v = viewableRef.current;
    if (!v || !v.length) return;
    if (endModeRef.current === "random") {
      const cur = randCursorRef.current;
      const hist = randHistoryRef.current;
      if (cur > 0) {
        const prev = cur - 1;
        setRandCursor(prev);
        randCursorRef.current = prev;
        navigatingViaRandomRef.current = true;
        onGotoRef.current(hist[prev]);
      } else {
        const newIdx = pickRandomDifferent(v.length, idxRef.current);
        const newHist = [newIdx, ...hist];
        setRandHistory(newHist);
        setRandCursor(0);
        randHistoryRef.current = newHist;
        randCursorRef.current = 0;
        navigatingViaRandomRef.current = true;
        onGotoRef.current(newIdx);
      }
    } else {
      onPrevRef.current();
    }
  };

  const dispatchNextRef = useRef(dispatchNext);
  dispatchNextRef.current = dispatchNext;
  const dispatchPrevRef = useRef(dispatchPrev);
  dispatchPrevRef.current = dispatchPrev;

  const handleVideoEndedRef = useRef(null);
  handleVideoEndedRef.current = () => {
    const mode = endModeRef.current;
    const v = viewableRef.current;
    const i = idxRef.current;
    const hasN = hasNextRef.current;
    setIsPlaying(false);
    if (mode === "next") {
      if (hasN) onNextRef.current();
    } else if (mode === "repeat") {
      if (videoRef.current) { seekTo(0); videoRef.current.play().catch(() => {}); }
    } else if (mode === "random" && v && v.length > 1) {
      const newIdx = pickRandomDifferent(v.length, i);
      const cur = randCursorRef.current;
      const hist = randHistoryRef.current;
      const newHist = [...hist.slice(0, cur + 1), newIdx];
      setRandHistory(newHist);
      setRandCursor(cur + 1);
      randHistoryRef.current = newHist;
      randCursorRef.current = cur + 1;
      navigatingViaRandomRef.current = true;
      if (onGotoRef.current) onGotoRef.current(newIdx);
    }
  };
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const handler = () => { if (handleVideoEndedRef.current) handleVideoEndedRef.current(); };
    el.addEventListener("ended", handler);
    return () => el.removeEventListener("ended", handler);
  }, [loadedUrl]);
  const cycleEndMode = () => setEndMode((m) => m === "none" ? "next" : m === "next" ? "repeat" : m === "repeat" ? "random" : "none");
  const cycleEndModeRef = useRef(cycleEndMode);
  cycleEndModeRef.current = cycleEndMode;
  const computeCenterPan = (st, z, rect, rot) => {
    const v = videoRef.current;
    if (!v) return { x: 0, y: 0 };
    const rotT = rot === 90 || rot === 270;
    const sw = rect.width, sh = rect.height;
    const dimW = rotT ? sh : sw, dimH = rotT ? sw : sh;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return { x: 0, y: 0 };
    const fit = Math.min(dimW / vw, dimH / vh);
    const cw = vw * fit, ch = vh * fit;
    const [rdx, rdy] = rotDeg((dimW - cw) / 2 + st.fx * st.cPerCanvas - dimW / 2, (dimH - ch) / 2 + st.fy * st.cPerCanvas - dimH / 2, rot);
    return { x: -rdx * z + (st.offX || 0), y: -rdy * z + (st.offY || 0) };
  };
  const handleWheel = (e) => {
    if (e.shiftKey) {
      if ((isVideo || isAudio || gifAsVideoEff) && videoRef.current) {
        e.preventDefault();
        const d = seekFrames ? 1/30 : 1;
        const raw = (e.deltaY !== 0 ? e.deltaY : e.deltaX !== 0 ? e.deltaX : e.wheelDelta ? -e.wheelDelta : 0);
        if (raw === 0) return;
        const delta = raw < 0 ? d : -d;
        const v = videoRef.current;
        const nt = Math.max(0, Math.min(duration || v.duration || Infinity, v.currentTime + delta));
        seekTo(nt);
        return;
      }
      e.preventDefault();
      return;
    }
    if (isAudio) return;
    if (trackingRef.current) {
      const st = trackStateRef.current;
      if (!st) return;
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const perLine = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1;
      const z = Math.min(4, Math.max(1, trackViewRef.current.zoom * Math.exp(-e.deltaY * perLine * 0.0022)));
      if (z === trackViewRef.current.zoom) return;
      const rot = rotateRef.current;
      const pan = computeCenterPan(st, z, rect, rot);
      trackViewRef.current.zoom = z;
      trackViewRef.current.pan = pan;
      trackViewRef.current.transform = `translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${z})`;
      const v = videoRef.current;
      if (v) v.style.transform = trackViewRef.current.transform;
      setZoom(z);
      setPan(pan);
      return;
    }
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const perLine = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1;
    const newZoom = Math.min(4, Math.max(1, zoom * Math.exp(-e.deltaY * perLine * 0.0022)));
    if (newZoom === zoom) return;
    if (newZoom === 1) { setZoom(1); setPan({x:0,y:0}); setOrigin("50% 50%"); return; }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const Cx = e.clientX - cx;
    const Cy = e.clientY - cy;
    const ratio = newZoom / zoom;
    const newPan = { x: Cx - (Cx - pan.x) * ratio, y: Cy - (Cy - pan.y) * ratio };
    setZoom(newZoom);
    setPan(newPan);
    setOrigin("50% 50%");
  };
  const resetZoom = () => { setZoom(1); setOrigin("50% 50%"); setPan({x:0,y:0}); };
  const rotateFile = () => setRotate((r) => (r + 90) % 360);
  const handleStageClick = (e) => {
    if (!trackArmedRef.current) return;
    const v = videoRef.current;
    if (!v || v.tagName !== "VIDEO" || showImageRef.current) return;
    e.preventDefault();
    startTracking(e.clientX, e.clientY);
  };
  const startTracking = (clientX, clientY) => {
    const v = videoRef.current;
    if (!v || v.tagName !== "VIDEO" || showImageRef.current) return;
    const rect = containerRef.current && containerRef.current.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) return;
    const rot = rotateRef.current;
    const rotT = rot === 90 || rot === 270;
    const sw = rect.width, sh = rect.height;
    const dimW = rotT ? sh : sw, dimH = rotT ? sw : sh;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const fit = Math.min(dimW / vw, dimH / vh);
    const cw = vw * fit, ch = vh * fit;
    const eff = trackingRef.current ? trackViewRef.current : { zoom, pan };
    const z = eff.zoom;
    const ix = (clientX - rect.left - sw / 2 - eff.pan.x) / z;
    const iy = (clientY - rect.top - sh / 2 - eff.pan.y) / z;
    const [ux, uy] = rotDeg(ix, iy, -rot);
    const elX = ux + dimW / 2, elY = uy + dimH / 2;
    const tlX = (dimW - cw) / 2, tlY = (dimH - ch) / 2;
    const cpx = elX - tlX, cpy = elY - tlY;
    if (cpx < 3 || cpy < 3 || cpx > cw - 3 || cpy > ch - 3) return;
    stopTracking();
    const st = {
      canvas: document.createElement("canvas"),
      ctx: null, rw: 0, rh: 0, cPerCanvas: 1, lum: null,
      tpl: null, tplW: 0, tplH: 0,
      fx: 0, fy: 0, vx: 0, vy: 0, age: 0, recapture: false, offX: 0, offY: 0, lost: false, misses: 0, frames: 0,
      rvfc: typeof v.requestVideoFrameCallback === "function",
      raf: 0, tTime: -1, gen: ++trackGenRef.current,
      onSeeked: () => { const s = trackStateRef.current; if (s) { s.recapture = true; s.vx = 0; s.vy = 0; } },
    };
    const k = Math.min(TRACK_CAP / cw, TRACK_CAP / ch, 1);
    const rw = Math.max(4, Math.round(cw * k)), rh = Math.max(4, Math.round(ch * k));
    st.canvas.width = rw; st.canvas.height = rh;
    st.rw = rw; st.rh = rh;
    st.cPerCanvas = cw / rw;
    st.ctx = st.canvas.getContext("2d", { willReadFrequently: true });
    st.ctx.drawImage(v, 0, 0, rw, rh);
    const img = st.ctx.getImageData(0, 0, rw, rh);
    st.fx = clamp(cpx / st.cPerCanvas, 0, rw - 1);
    st.fy = clamp(cpy / st.cPerCanvas, 0, rh - 1);
    captureTemplate(img, st, st.fx, st.fy);
    let tMean = 0;
    const tLen = st.tpl ? st.tpl.length : 0;
    for (let ti = 0; ti < tLen; ti++) tMean += st.tpl[ti];
    tMean = tLen ? tMean / tLen : 0;
    let tVar = 0;
    for (let ti = 0; ti < tLen; ti++) { const dd = st.tpl[ti] - tMean; tVar += dd * dd; }
    st.tex = tLen ? tVar / tLen : 0;
    refreshGrid(img, st);
    st.offX = clientX - rect.left - sw / 2;
    st.offY = clientY - rect.top - sh / 2;
    trackStateRef.current = st;
    trackingRef.current = true;
    const cz = Math.max(1, zoom);
    const pan0 = computeCenterPan(st, cz, rect, rot);
    trackViewRef.current = { tracking: true, zoom: cz, pan: pan0, transform: `translate(${pan0.x}px, ${pan0.y}px) rotate(${rot}deg) scale(${cz})` };
    v.style.transformOrigin = "50% 50%";
    v.style.transform = trackViewRef.current.transform;
    v.addEventListener("seeked", st.onSeeked);
    trackArmedRef.current = false;
    setTrackArmed(false);
    setTrackLost(false);
    setTrackHover(false);
    setZoom(cz);
    setPan(pan0);
    setOrigin("50% 50%");
    setTracking(true);
    st.step = () => {
      if (trackGenRef.current !== st.gen || !trackingRef.current) return;
      if (st.rvfc) { v.requestVideoFrameCallback(st.step); trackingTick(); }
      else { st.raf = requestAnimationFrame(st.step); trackingTick(); }
    };
    st.step();
  };
  const trackingTick = () => {
    const st = trackStateRef.current;
    if (!st || !trackingRef.current || st.gen !== trackGenRef.current) return;
    const v = videoRef.current;
    if (!v || v.tagName !== "VIDEO") { stopTracking(); return; }
    if (!st.rvfc && v.currentTime === st.tTime) return;
    st.tTime = v.currentTime;
    const rect = containerRef.current && containerRef.current.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) return;
    const rot = rotateRef.current;
    const rotT = rot === 90 || rot === 270;
    const sw = rect.width, sh = rect.height;
    const dimW = rotT ? sh : sw, dimH = rotT ? sw : sh;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const fit = Math.min(dimW / vw, dimH / vh);
    const cw = vw * fit, ch = vh * fit;
    const k = Math.min(TRACK_CAP / cw, TRACK_CAP / ch, 1);
    const rw = Math.max(4, Math.round(cw * k)), rh = Math.max(4, Math.round(ch * k));
    if (st.canvas.width !== rw || st.canvas.height !== rh) { st.canvas.width = rw; st.canvas.height = rh; }
    st.rw = rw; st.rh = rh;
    st.cPerCanvas = cw / rw;
    const ctx = st.ctx;
    ctx.drawImage(v, 0, 0, rw, rh);
    const img = ctx.getImageData(0, 0, rw, rh);
    if (st.recapture) {
      st.recapture = false;
      captureTemplate(img, st, st.fx, st.fy);
      refreshGrid(img, st);
      st.vx = 0; st.vy = 0;
    }
    if (st.frames % 90 === 0) refreshGrid(img, st);
    const res = (!st.lost || (st.frames % 4 === 0)) ? bestTemplateSearch(img, st, st.fx + st.vx * 0.5, st.fy + st.vy * 0.5, st.lost) : null;
    const resOK = res && res.score / (st.tplW * st.tplH) < 3600;
    let resDX = 0, resDY = 0, resD = Infinity;
    if (resOK) { resDX = res.x - st.fx; resDY = res.y - st.fy; resD = Math.hypot(resDX, resDY); }
    let medDx = 0, medDy = 0, gridOK = false;
    if ((!resOK || resD > TRACK_JUMP) && st.grid) {
      const gdx = [], gdy = [];
      for (const g of st.grid) {
        const gr = bestTemplateSearch(img, { rw: st.rw, rh: st.rh, tpl: g.tpl, tplW: g.tplW, tplH: g.tplH, lum: st.lum }, g.fx, g.fy, false, 28);
        if (gr.score / (g.tplW * g.tplH) < 3600) {
          const ddx = gr.x - g.fx, ddy = gr.y - g.fy;
          if (Math.hypot(ddx, ddy) < TRACK_JUMP) {
            g.fx += ddx * 0.5; g.fy += ddy * 0.5;
            gdx.push(ddx); gdy.push(ddy);
          }
        }
      }
      if (gdx.length >= 3) {
        gdx.sort((a, b) => a - b); gdy.sort((a, b) => a - b);
        medDx = gdx[gdx.length >> 1]; medDy = gdy[gdy.length >> 1];
        gridOK = true;
      }
    }
    if (resOK && resD <= TRACK_JUMP) {
      const wasLost = st.lost;
      st.lost = false; st.misses = 0;
      if (wasLost) { captureTemplate(img, st, res.x, res.y); refreshGrid(img, st); st.vx = 0; st.vy = 0; setTrackLost(false); }
      if (resD > TRACK_DEAD) {
        const k = (resD - TRACK_DEAD) / resD;
        st.vx = st.vx * 0.7 + resDX * k * 0.3;
        st.vy = st.vy * 0.7 + resDY * k * 0.3;
        st.fx += resDX * k * 0.3;
        st.fy += resDY * k * 0.3;
        st.age++;
        if (resD < 8 && st.age % 40 === 0) blendTemplate(img, st, res.x, res.y, 0.05);
      }
    } else if (gridOK) {
      st.misses = 0;
      const gd = Math.hypot(medDx, medDy);
      st.vx = st.vx * 0.7 + medDx * 0.3;
      st.vy = st.vy * 0.7 + medDy * 0.3;
      if (gd > TRACK_DEAD) {
        const k = (gd - TRACK_DEAD) / gd;
        st.fx += medDx * k * 0.3;
        st.fy += medDy * k * 0.3;
      }
    } else if (res) {
      st.misses++;
      st.vx *= 0.9; st.vy *= 0.9;
      if (!st.lost && st.misses >= 10) { st.lost = true; st.vx = 0; st.vy = 0; setTrackLost(true); }
    }
    st.frames++;
    const cz = trackViewRef.current.zoom;
    const target = computeCenterPan(st, cz, rect, rot);
    const cur = trackViewRef.current.pan;
    const pan = { x: cur.x + (target.x - cur.x) * trackSmoothRef.current, y: cur.y + (target.y - cur.y) * trackSmoothRef.current };
    const prev = trackViewRef.current.pan;
    if (Math.abs(pan.x - prev.x) > 0.01 || Math.abs(pan.y - prev.y) > 0.01) {
      trackViewRef.current.pan = pan;
      trackViewRef.current.transform = `translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${cz})`;
      if (v.style.transform !== trackViewRef.current.transform) v.style.transform = trackViewRef.current.transform;
    }
  };
  // React registers wheel listeners as passive, so preventDefault() inside
  // onWheel is ignored and the window scrolls during zoom. Drive zoom through
  // a native non-passive listener instead.
  const handleWheelRef = useRef(null);
  handleWheelRef.current = handleWheel;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheelNative = (e) => { if (handleWheelRef.current) handleWheelRef.current(e); };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, []);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => { const r = el.getBoundingClientRect(); setStageSize({ w: r.width, h: r.height }); };
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const handleMouseDown = (e) => {
    if (!showImage && videoRef.current) {
      wasPlayingRef.current = !videoRef.current.paused;
      if (wasPlayingRef.current) videoRef.current.pause();
    }
    if (trackingRef.current) {
      const st = trackStateRef.current;
      dragRef.current = { dragging: true, trackDrag: true, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, downX: e.clientX, downY: e.clientY, origOffX: st ? st.offX || 0 : 0, origOffY: st ? st.offY || 0 : 0 };
      e.preventDefault();
      return;
    }
    if (zoom === 1 || isAudio) {
      if (!showImage) e.preventDefault();
      return;
    }
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
    e.preventDefault();
  };
  const handleMouseMove = (e) => {
    if (!dragRef.current.dragging) return;
    if (dragRef.current.trackDrag) {
      const st = trackStateRef.current;
      if (!st || !trackingRef.current) return;
      const ddx = e.clientX - dragRef.current.lastX;
      const ddy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX; dragRef.current.lastY = e.clientY;
      st.offX = (st.offX || 0) + ddx;
      st.offY = (st.offY || 0) + ddy;
      const tv = trackViewRef.current;
      tv.pan = { x: tv.pan.x + ddx, y: tv.pan.y + ddy };
      const rot = rotateRef.current;
      tv.transform = `translate(${tv.pan.x}px, ${tv.pan.y}px) rotate(${rot}deg) scale(${tv.zoom})`;
      const v = videoRef.current;
      if (v) v.style.transform = tv.transform;
      setPan({ x: tv.pan.x, y: tv.pan.y });
      return;
    }
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPan({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
  };
  const handleMouseUp = () => {
    const wasDragging = dragRef.current.dragging;
    dragRef.current.dragging = false;
    if (wasPlayingRef.current && videoRef.current && !showImage) {
      const v = videoRef.current;
      wasPlayingRef.current = false;
      v.play().catch(() => {});
    } else if (!wasDragging) {
      wasPlayingRef.current = false;
    }
  };
  const touchRef = useRef({ startX: 0, startY: 0, startTime: 0, isSeeking: false, isHorizontal: null, startPan: { x: 0, y: 0 } });
  const handleTouchStart = (e) => {
    const t = e.touches[0];
    if (!t) return;
    touchRef.current = { startX: t.clientX, startY: t.clientY, startTime: videoRef.current?.currentTime || 0, isSeeking: false, isHorizontal: null, startPan: { ...pan }, lastDx: 0, pinchActive: false, wasMultiTouch: false };
    if (e.touches.length > 1) {
      touchRef.current.wasMultiTouch = true;
      if (!showImage && wasPlayingRef.current && videoRef.current) {
        wasPlayingRef.current = false;
        videoRef.current.play().catch(() => {});
      }
      return;
    }
    if (!showImage && videoRef.current) {
      wasPlayingRef.current = !videoRef.current.paused;
      if (wasPlayingRef.current) videoRef.current.pause();
    }
  };
  const handleTouchMove = (e) => {
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - touchRef.current.startX;
    const dy = t.clientY - touchRef.current.startY;
    if (e.touches.length >= 2) {
      e.preventDefault();
      const a = e.touches[0], b = e.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const midX = (a.clientX + b.clientX) / 2, midY = (a.clientY + b.clientY) / 2;
      const pr = touchRef.current;
      if (!pr.pinchActive) {
        pr.pinchActive = true;
        pr.pinchPrevDist = dist;
        pr.pinchPrevZoom = zoom;
        pr.pinchPrevPan = { ...pan };
        pr.pinchPrevMid = { x: midX, y: midY };
      }
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const newZoom = Math.min(4, Math.max(1, pr.pinchPrevZoom * (dist / pr.pinchPrevDist)));
        let nextPan = { x: 0, y: 0 };
        if (newZoom === 1) {
          setZoom(1);
          setPan({ x: 0, y: 0 });
          setOrigin("50% 50%");
        } else {
          const ratio = newZoom / pr.pinchPrevZoom;
          const ax = pr.pinchPrevMid.x - cx;
          const ay = pr.pinchPrevMid.y - cy;
          nextPan = {
            x: (midX - cx) - (ax - pr.pinchPrevPan.x) * ratio,
            y: (midY - cy) - (ay - pr.pinchPrevPan.y) * ratio,
          };
          setZoom(newZoom);
          setPan(nextPan);
          setOrigin("50% 50%");
        }
        pr.pinchPrevZoom = newZoom;
        pr.pinchPrevPan = nextPan;
        pr.pinchPrevMid = { x: midX, y: midY };
        pr.pinchPrevDist = dist;
      }
      return;
    }
    if (zoom > 1) {
      setPan({ x: touchRef.current.startPan.x + dx, y: touchRef.current.startPan.y + dy });
      e.preventDefault();
      return;
    }
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8 && videoRef.current) {
      if (seekFrames) {
        // per-frame: 8px = 1 frame, step one frame at a time without skipping
        const frames = Math.trunc(dx / 8);
        const lastFrames = Math.trunc((touchRef.current.lastDx || 0) / 8);
        const deltaFrames = frames - lastFrames;
        if (deltaFrames !== 0) {
          const nt = Math.max(0, Math.min(duration || 1e9, videoRef.current.currentTime + deltaFrames * (1/30)));
          videoRef.current.currentTime = nt;
          setCurrent(nt);
          touchRef.current.lastDx = dx - (dx % 8);
        }
      } else {
        const delta = dx * 0.06;
        const nt = Math.max(0, Math.min(duration || 1e9, touchRef.current.startTime + delta));
        videoRef.current.currentTime = nt;
        setCurrent(nt);
      }
      e.preventDefault();
      return;
    }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) e.preventDefault();
  };
  const handleTouchEnd = (e) => {
    const t = e.changedTouches[0];
    if (!t) return;
    const pr = touchRef.current;
    const dx = t.clientX - pr.startX;
    const dy = t.clientY - pr.startY;
    const isRandom = endModeRef.current === "random";
    const wasNav = zoom === 1 && !pr.wasMultiTouch && Math.abs(dy) > 25 && Math.abs(dy) > Math.abs(dx) && (isRandom ? total > 1 : ((dy < 0 && hasNext) || (dy > 0 && hasPrev)));
    if (wasNav) {
      wasPlayingRef.current = false;
      if (dy < 0) dispatchNextRef.current();
      else if (dy > 0) dispatchPrevRef.current();
      return;
    }
    if (pr.wasMultiTouch && e.touches && e.touches.length === 1) {
      const r = e.touches[0];
      pr.startX = r.clientX;
      pr.startY = r.clientY;
      pr.startTime = videoRef.current?.currentTime || 0;
      pr.startPan = { ...pan };
      pr.lastDx = 0;
    }
    if (wasPlayingRef.current && videoRef.current && !showImage) {
      const v = videoRef.current;
      wasPlayingRef.current = false;
      v.play().catch(() => {});
    } else {
      wasPlayingRef.current = false;
    }
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      const k = e.key;
      const isLeft = k === "ArrowLeft" || k === "a" || k === "A";
      const isRight = k === "ArrowRight" || k === "d" || k === "D";
      const isUp = k === "ArrowUp" || k === "w" || k === "W";
      const isDown = k === "ArrowDown" || k === "s" || k === "S";
      if ((k === "/" || k === "?") && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault(); setShowHelp((v) => !v); return;
      }
      if (k === "Escape") {
        if (showPlaylistRef.current) { e.preventDefault(); setShowPlaylist(false); return; }
        if (showHelp) { e.preventDefault(); setShowHelp(false); return; }
        if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); e.preventDefault(); return; }
        e.preventDefault(); onClose();
      } else if (e.key.toLowerCase() === "q" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault(); onClose();
      } else if (e.key.toLowerCase() === "e" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); setSeekFrames((v) => !v); }
      } else if ((e.code === "Space" || e.key === " " || e.key === "Spacebar") && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Always swallow Space while the viewer is open so the window never scrolls.
        e.preventDefault();
        if ((!showImage) && videoRef.current) {
          if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; jogWasPlayingRef.current = false; videoRef.current.pause(); }
          else { if (videoRef.current.paused) videoRef.current.play(); else videoRef.current.pause(); }
        }
       } else if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); setMuted((v) => !v); }
      } else if (e.key.toLowerCase() === "r" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); cycleEndModeRef.current(); }
      } else if (e.key.toLowerCase() === "r" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); rotateFile(); }
      } else if (e.key.toLowerCase() === "c" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); stepRate(-0.1); }
      } else if (e.key.toLowerCase() === "v" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); stepRate(0.1); }
      } else if ((e.key === "<" || (e.key === "," && e.shiftKey)) && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); stepRate(-0.1);
      } else if ((e.key === ">" || (e.key === "." && e.shiftKey)) && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); stepRate(0.1);
      } else if (isLeft) {
        if (showImage) { e.preventDefault(); dispatchPrevRef.current(); }
        else if (videoRef.current) {
          e.preventDefault(); const v = videoRef.current;
          if (e.shiftKey) {
            seekTo(Math.max(0, v.currentTime - 5));
          } else if (seekFrames) {
            if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; }
            else { jogWasPlayingRef.current = !v.paused; }
            v.pause();
            const gen = ++jogGenRef.current;
            let steps = 0; const max = 30;
            jogRef.current = setInterval(() => {
              if (steps >= max || jogGenRef.current !== gen) { clearInterval(jogRef.current); if (jogGenRef.current === gen) { jogRef.current = null; if (jogWasPlayingRef.current) { jogWasPlayingRef.current = false; v.play().catch(() => {}); } } return; }
              seekTo(Math.max(0, v.currentTime - 1/30)); steps++;
            }, 33 / rate);
          } else { seekTo(Math.max(0, v.currentTime - 1)); }
        }
      } else if (isRight) {
        if (showImage) { e.preventDefault(); dispatchNextRef.current(); }
        else if (videoRef.current) {
          e.preventDefault(); const v = videoRef.current;
          if (e.shiftKey) {
            seekTo(Math.min(duration || v.duration || Infinity, v.currentTime + 5));
          } else if (seekFrames) {
            if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; }
            else { jogWasPlayingRef.current = !v.paused; }
            v.pause();
            const gen = ++jogGenRef.current;
            let steps = 0; const max = 30;
            jogRef.current = setInterval(() => {
              if (steps >= max || jogGenRef.current !== gen) { clearInterval(jogRef.current); if (jogGenRef.current === gen) { jogRef.current = null; if (jogWasPlayingRef.current) { jogWasPlayingRef.current = false; v.play().catch(() => {}); } } return; }
              seekTo(Math.min(duration || v.duration || Infinity, v.currentTime + 1/30)); steps++;
            }, 33 / rate);
          } else { seekTo(Math.min(duration || v.duration || Infinity, v.currentTime + 1)); }
        }
      } else if (isUp) { if (endModeRef.current === "random" || hasPrev) { e.preventDefault(); dispatchPrevRef.current(); } }
      else if (isDown) { if (endModeRef.current === "random" || hasNext) { e.preventDefault(); dispatchNextRef.current(); } }
      else if (e.key.toLowerCase() === "y" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.repeat) return;
        e.preventDefault();
        const now = Date.now();
        if (now - lastYRef.current < 600) {
          lastYRef.current = 0;
          setYConfirm(false);
          if (yConfirmTimerRef.current) { clearTimeout(yConfirmTimerRef.current); yConfirmTimerRef.current = null; }
          if (doDeleteFileRef.current) doDeleteFileRef.current();
        } else {
          lastYRef.current = now;
          setYConfirm(true);
          if (yConfirmTimerRef.current) clearTimeout(yConfirmTimerRef.current);
          yConfirmTimerRef.current = setTimeout(() => { setYConfirm(false); lastYRef.current = 0; yConfirmTimerRef.current = null; }, 600);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose, hasPrev, hasNext, onPrev, onNext, showImage, duration, seekFrames, rate, showHelp, seekTo]);
  // Hold-F: keep the save popup open while F is held; letter toggles the
  // first matching list, 1-9 toggles extras by number.
  // The F fullscreen keybind is disabled (button still available).
  useEffect(() => {
    const isEditable = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const onKeyDown = (e) => {
      if (isEditable(e.target)) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      if (k === "f" || k === "F") {
        if (e.repeat) { e.preventDefault(); return; }
        e.preventDefault();
        e.stopPropagation();
        fHeldRef.current = true;
        setFHeld(true);
        return;
      }
      if (fHeldRef.current && /^[1-9]$/.test(k)) {
        // Digits toggle extras (lists without a letter hotkey: shared first
        // letter beyond the first, or non-letter names), numbered 1-9.
        const extras = fvPlaylists.filter((p, i) => {
          const ch = String(p.name || "").trim().charAt(0).toLowerCase();
          return !(/^[a-z]$/.test(ch) && fvPlaylists.findIndex((q) => String(q.name || "").trim().charAt(0).toLowerCase() === ch) === i);
        });
        const hit = extras[parseInt(k, 10) - 1];
        if (hit && filePathEff) {
          e.preventDefault();
          e.stopPropagation();
          fvToggleItem(hit.id, filePathEff).catch(() => {});
        }
        return;
      }
      if (fHeldRef.current && /^[a-zA-Z]$/.test(k)) {
        // Letter hotkey: toggles the first list starting with that letter
        // (F+O → "orange"). Later lists sharing the letter use 1-9.
        const hit = fvPlaylists.find((p) => String(p.name || "").trim().charAt(0).toLowerCase() === k.toLowerCase());
        if (hit) {
          e.preventDefault();
          e.stopPropagation();
          if (filePathEff) fvToggleItem(hit.id, filePathEff).catch(() => {});
          return;
        }
        // No list starts with this letter — fall through to normal keys.
      }
    };
    const onKeyUp = (e) => {
      const k = e.key;
      if (k === "f" || k === "F") {
        if (fHeldRef.current) {
          fHeldRef.current = false;
          setFHeld(false);
        }
      }
    };
    const onBlur = () => {
      if (fHeldRef.current) {
        fHeldRef.current = false;
        setFHeld(false);
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
  }, [fvPlaylists, filePathEff]);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    try { history.pushState({ viewer: true }, ""); } catch {}
    const onPop = () => onCloseRef.current();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      try { if (history.state && history.state.viewer) history.back(); } catch {}
    };
  }, []);
  useEffect(() => {
    const finePointer = !(typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);
    const onShiftDown = (e) => {
      if (e.key !== "Shift" || e.repeat) return;
      if (e.target && ((e.target.tagName === "INPUT" && e.target.type !== "range") || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
      if (finePointer && videoishRef.current && !showImageRef.current && videoRef.current && videoRef.current.tagName === "VIDEO") {
        trackArmedRef.current = true;
        setTrackArmed(true);
      }
      if (showImageRef.current || !videoRef.current || videoRef.current.paused) return;
      if (shiftWasPlayingRef.current) return;
      shiftWasPlayingRef.current = true;
      videoRef.current.pause();
    };
    const onShiftUp = (e) => {
      if (e.key !== "Shift") return;
      trackArmedRef.current = false;
      setTrackArmed(false);
      if (e.target && ((e.target.tagName === "INPUT" && e.target.type !== "range") || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) { shiftWasPlayingRef.current = false; return; }
      if (!shiftWasPlayingRef.current || !videoRef.current || showImageRef.current) { shiftWasPlayingRef.current = false; return; }
      shiftWasPlayingRef.current = false;
      videoRef.current.play().catch(() => {});
    };
    const stopJog = () => {
      if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; }
      if (jogWasPlayingRef.current && videoRef.current) { jogWasPlayingRef.current = false; videoRef.current.play().catch(() => {}); }
    };
    const onBlur = () => { shiftWasPlayingRef.current = false; stopJog(); trackArmedRef.current = false; setTrackArmed(false); };
    window.addEventListener("keydown", onShiftDown);
    window.addEventListener("keyup", onShiftUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onShiftDown);
      window.removeEventListener("keyup", onShiftUp);
      window.removeEventListener("blur", onBlur);
      stopJog();
    };
  }, [showImage]);
  useEffect(() => () => { trackGenRef.current++; trackingRef.current = false; }, []);

  const doDeleteFile = async () => {
    const { folder, base } = parseFolderBase(filePathEff);
    if (!base) return;
    if (deleting) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/media?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(base)}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "delete failed");
      saveFileRotation(filePathEff, 0);
      // Parent owns viewer position (key-based, plan 014): it moves to the
      // neighbour (next ?? prev) and reloads without jumping to the top.
      // Fall back to local navigation only when no parent handler is wired.
      if (onDeleted) onDeleted(filePathEff);
      else if (total <= 1) onClose();
      else if (!hasNext && hasPrev) onPrev();
    } catch (e) { setAlertState({ open: true, title: "Delete failed", message: e.message }); }
    finally { setDeleting(false); }
  };
  const handleDelete = () => {
    const { base } = parseFolderBase(filePathEff);
    if (!base) return;
    setConfirmOpen(true);
  };
  const handleConfirmDelete = async () => {
    setConfirmOpen(false);
    await doDeleteFile();
  };
  doDeleteFileRef.current = doDeleteFile;

  return (
    <>
    <div
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: "fixed", inset: 0, zIndex: 110, display: "flex", alignItems: "stretch", justifyContent: "stretch", padding: 0, margin: 0, background: "rgba(6,8,18,0.72)", backdropFilter: "blur(8px)" }}
    >
      <div
        ref={viewerRef}
        onClick={(e) => e.stopPropagation()}
        style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--surface)", border: "none", borderRadius: 0, overflow: "hidden", boxShadow: "none", margin: 0, boxSizing: "border-box", position: "relative" }}
      >
        <div className="fv-header" style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 5, display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", background: "transparent", border: "none", pointerEvents: "none" }}>
          <div className="fv-nav" style={{ display: "flex", alignItems: "center", gap: 6, pointerEvents: "auto", position: "relative" }}>
            <button type="button" tabIndex={-1} className="btn btn-sm" onClick={(e) => { e.stopPropagation(); dispatchPrevRef.current(); }} onTouchStart={(e) => e.stopPropagation()} disabled={endMode !== "random" && !hasPrev} title="Previous (↑)" style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><i className="bi bi-chevron-up" /></button>
            <span className="badge" style={{ fontFamily: "var(--mono)", fontSize: 11, minWidth: 54, justifyContent: "center", background: "rgba(0,0,0,.55)", border: "1px solid rgba(255,255,255,.18)", color: "#fff", backdropFilter: "blur(6px)" }}>{endMode === "random" && randHistory.length > 1 ? `${randCursor + 1}/${randHistory.length} · ` : ""}{idx + 1} / {total}</span>
            <button type="button" tabIndex={-1} className="btn btn-sm" onClick={(e) => { e.stopPropagation(); dispatchNextRef.current(); }} onTouchStart={(e) => e.stopPropagation()} disabled={endMode !== "random" && !hasNext} title="Next (↓)" style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><i className="bi bi-chevron-down" /></button>
            {(() => {
              const { base } = parseFolderBase(filePathEff);
              const label = base || titleEff;
              if (!label) return null;
              return (
                <span data-testid="viewer-filename" className="fv-filename" title={label} style={{ position: "absolute", left: "calc(100% + 8px)", top: "50%", transform: "translateY(-50%)", fontSize: 12, fontWeight: 500, color: "#fff", background: "rgba(0,0,0,.55)", border: "1px solid rgba(255,255,255,.18)", backdropFilter: "blur(6px)", padding: "6px 10px", borderRadius: 999, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
              );
            })()}
          </div>
          <span style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, pointerEvents: "auto" }}>
            {yConfirm && <span style={{ fontSize: 11, fontWeight: 600, color: "#fff", background: "#ef4444", padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,.2)", whiteSpace: "nowrap", alignSelf: "center" }}>Press y again to confirm delete</span>}
            <button type="button" tabIndex={-1} onClick={handleDelete} disabled={deleting} className="btn btn-sm" aria-label="Delete file" title={yConfirm ? "Press y again to confirm — or click to delete" : "Delete file (press y twice)"} style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: yConfirm ? "1px solid #ef4444" : "1px solid rgba(255,255,255,.18)", background: yConfirm ? "#ef4444" : "rgba(0,0,0,.55)", color: yConfirm ? "#fff" : "#ff8080", backdropFilter: "blur(6px)", animation: yConfirm ? "pulse 0.6s ease infinite" : "none" }}><i className="bi bi-trash" /></button>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button type="button" tabIndex={-1} onClick={onClose} className="btn btn-sm" aria-label="Close" style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><i className="bi bi-x-lg" /></button>
              <div
                ref={playlistHoverRef}
                onMouseEnter={() => { if (playlistCloseTimer.current) { clearTimeout(playlistCloseTimer.current); playlistCloseTimer.current = null; } setShowPlaylist(true); }}
                onMouseLeave={() => { if (playlistCloseTimer.current) clearTimeout(playlistCloseTimer.current); playlistCloseTimer.current = setTimeout(() => setShowPlaylist(false), 120); }}
                style={{ position: "relative" }}
              >
                {(() => {
                  const vBookmarked = !!filePathEff && fvPlaylists.some((pl) => (pl.items || []).includes(filePathEff));
                  const vOpen = showPlaylist || fHeld;
                  return (
                    <>
                      <button
                        type="button"
                        tabIndex={-1}
                        data-testid="viewer-playlist-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          // coarse pointer (mobile) fallback to tap toggle
                          try { if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) setShowPlaylist((v) => !v); } catch { setShowPlaylist((v) => !v); }
                        }}
                        aria-label="Add to playlist"
                        title="Add to playlist"
                        style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: vOpen ? "rgba(99,102,241,.9)" : vBookmarked ? "rgba(99,102,241,.85)" : "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}
                      >
                        <i className={`bi ${vBookmarked ? "bi-bookmark-fill" : "bi-bookmark"}`} />
                      </button>
                      {vOpen && (
                        <div style={{ position: "absolute", top: 44, right: 0, zIndex: 95 }} onClick={(e) => e.stopPropagation()}>
                          <PlaylistHoverMenu mediaKey={filePathEff} showIndex={fHeld} />
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>

        <style>{`.fv-nav .fv-filename{opacity:0;transition:opacity .15s} .fv-nav:hover .fv-filename{opacity:1} @keyframes pulse{0%{transform:scale(1)}50%{transform:scale(1.08)}100%{transform:scale(1)}} video::-webkit-media-controls-panel,video::-webkit-media-controls-enclosure{ background: transparent !important; background-image: none !important; box-shadow: none !important; } video::-webkit-media-controls-timeline{ background: transparent !important; }
@media (max-width: 640px){
  .fv-header{ padding: 6px 8px !important; gap: 4px !important; }
  .fv-header .btn{ padding: 3px 6px !important; font-size: 10px !important; }
  .fv-controls{ padding: 6px 8px !important; gap: 4px !important; }
  .fv-timeline{ gap: 4px !important; }
  .fv-timeline span{ font-size: 10px !important; min-width: 28px !important; }
  .fv-speed{ gap: 4px !important; }
  .fv-speed input[type="range"]{ width: 70px !important; height: 3px !important; }
  .fv-controls .btn{ padding: 3px 6px !important; font-size: 10px !important; }
  .fv-timeline input[type="range"]{ height: 3px !important; }
  .fv-10s{ display: none !important; }
}
@media (max-width: 480px){
  .fv-header{ flex-wrap: nowrap !important; padding: 6px 8px !important; }
  .fv-header > div:nth-child(2){ display: none !important; }
}`}</style>
        <div ref={containerRef} onClick={handleStageClick} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} style={{ position: "relative", flex: "1 1 auto", minHeight: 0, overflow: "hidden", background: "#080a14", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, cursor: trackArmed ? "crosshair" : tracking ? "grab" : "default", touchAction: "none" }}>
          {zoom>1 && <span style={{ position: "absolute", top: 10, right: 10, zIndex: 3, background: "rgba(0,0,0,.6)", color: "#fff", padding: "4px 8px", borderRadius: 6, fontSize: 11, fontFamily: "var(--mono)" }}>{Math.round(zoom*100)}%</span>}
          {(loading || (!mediaReady && isFormatKnown)) && (
            <span data-testid="viewer-loading" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", zIndex: 2 }}>
              <span className="xdl-thumb-spinner" />
            </span>
          )}
          {loading ? null : showImage ? (
            <img key={loadedUrl} ref={imgRef} src={loadedUrl} alt={titleEff} onContextMenu={(e) => e.preventDefault()} draggable={false} onLoad={() => setMediaReady(true)} onError={isGif ? () => setGifAsVideo(true) : () => setMediaReady(true)} style={{ width: mediaW, height: mediaH, objectFit: "contain", background: "#000", borderRadius: 0, opacity: mediaReady ? 1 : 0, transition: (!tracking && zoom===1) ? "opacity .45s ease, transform 0.15s" : "opacity .45s ease", transform: tracking ? trackViewRef.current.transform : `translate(${pan.x}px, ${pan.y}px) rotate(${rotate}deg) scale(${zoom})`, transformOrigin: origin, WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }} />
          ) : gifAsVideoEff ? (
            <video
              key={loadedUrl}
              ref={videoRef}
              src={loadedUrl}
              autoPlay
              playsInline
              preload="metadata"
              tabIndex={0}
              autoFocus
              onClick={(e)=> { e.stopPropagation(); handleStageClick(e); }}
              onContextMenu={(e) => e.preventDefault()}
              style={{ width: mediaW, height: mediaH, background: "#000", display: "block", objectFit: "contain", opacity: mediaReady ? 1 : 0, transition: (!tracking && zoom===1) ? "opacity .45s ease, transform 0.15s" : "opacity .45s ease", transform: tracking ? trackViewRef.current.transform : `translate(${pan.x}px, ${pan.y}px) rotate(${rotate}deg) scale(${zoom})`, transformOrigin: origin, WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none", cursor: trackArmed ? "crosshair" : "default", outline: "none" }}
              onTimeUpdate={(e)=> setCurrent(e.currentTarget.currentTime)}
              onLoadedMetadata={(e)=> setDuration(e.currentTarget.duration)}
              onLoadedData={() => setMediaReady(true)}
              onCanPlay={() => setMediaReady(true)}
              onError={() => setMediaReady(true)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
          ) : isAudio ? (
            <div style={{ width: "100%", padding: 24, display: "grid", placeItems: "center", opacity: mediaReady ? 1 : 0, transition: "opacity .45s ease" }}>
              <audio key={loadedUrl} ref={videoRef} src={loadedUrl} autoPlay style={{ width: "100%", display: "none" }} onTimeUpdate={(e)=> setCurrent(e.currentTarget.currentTime)} onLoadedMetadata={(e)=> setDuration(e.currentTarget.duration)} onLoadedData={() => setMediaReady(true)} onCanPlay={() => setMediaReady(true)} onError={() => setMediaReady(true)} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} />
              <div style={{ width: "100%", textAlign: "center", color: "var(--muted)", fontSize: 13 }}><i className="bi bi-music-note-beamed" style={{ fontSize: 32, display: "block", marginBottom: 8 }} /> Audio playback — use controls below</div>
            </div>
          ) : isFormatKnown ? (
            <video
              key={loadedUrl}
              ref={videoRef}
              src={loadedUrl}
              autoPlay
              playsInline
              preload="metadata"
              tabIndex={0}
              autoFocus
              onClick={(e)=> { e.stopPropagation(); handleStageClick(e); }}
              style={{ width: mediaW, height: mediaH, background: "#000", display: "block", objectFit: "contain", opacity: mediaReady ? 1 : 0, transition: (!tracking && zoom===1) ? "opacity .45s ease, transform 0.15s" : "opacity .45s ease", transform: tracking ? trackViewRef.current.transform : `translate(${pan.x}px, ${pan.y}px) rotate(${rotate}deg) scale(${zoom})`, transformOrigin: origin, WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none", cursor: trackArmed ? "crosshair" : "default", outline: "none" }}
              onTimeUpdate={(e)=> setCurrent(e.currentTarget.currentTime)}
              onLoadedMetadata={(e)=> setDuration(e.currentTarget.duration)}
              onLoadedData={() => setMediaReady(true)}
              onCanPlay={() => setMediaReady(true)}
              onError={() => setMediaReady(true)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
          ) : (
            <div style={{ width: "100%", padding: 24, display: "grid", placeItems: "center", color: "var(--muted)", fontSize: 13 }}>
              <div style={{ textAlign: "center" }}>
                <i className="bi bi-file-earmark-x" style={{ fontSize: 32, display: "block", marginBottom: 8 }} />
                Cannot preview <span style={{ fontFamily: "var(--mono)" }}>{ext ? ext : "unknown"}</span> in the browser.
                <div style={{ marginTop: 12 }}>
                  <a href={loadedUrl} target="_blank" rel="noopener noreferrer" download className="btn btn-sm btn-outline-secondary"><i className="bi bi-download" /> Open / download original</a>
                </div>
              </div>
            </div>
          )}
          {tracking && (
            <>
            <span onClick={(e) => { e.stopPropagation(); const d = dragRef.current; if (d && d.downX !== undefined && Math.hypot(e.clientX - d.downX, e.clientY - d.downY) > 6) return; stopTracking(); }} onMouseEnter={() => setTrackHover(true)} onMouseLeave={() => setTrackHover(false)} style={{ position: "absolute", left: `calc(50% + ${((trackStateRef.current && trackStateRef.current.offX) || 0)}px)`, top: `calc(50% + ${((trackStateRef.current && trackStateRef.current.offY) || 0)}px)`, width: 22, height: 22, transform: "translate(-50%,-50%)", border: `1.5px solid rgba(${trackLost ? "248,113,113" : "129,140,248"},${trackHover ? ".95" : ".35"})`, borderRadius: "50%", boxShadow: `0 0 0 3px rgba(0,0,0,${trackHover ? ".5" : ".2"})`, zIndex: 3, pointerEvents: "auto", cursor: "pointer" }}>
              <span style={{ position: "absolute", left: "50%", top: "50%", width: 5, height: 5, transform: "translate(-50%,-50%)", borderRadius: "50%", background: `rgba(${trackLost ? "248,113,113" : "129,140,248"},${trackHover ? ".95" : ".45"})` }} />
            </span>
            <div style={{ position: "absolute", right: 12, bottom: 12, zIndex: 4, background: "rgba(0,0,0,.35)", border: "1px solid rgba(255,255,255,.12)", color: "#fff", fontSize: 11, padding: "5px 10px", borderRadius: 999, pointerEvents: "none", whiteSpace: "nowrap", backdropFilter: "blur(2px)" }}>{trackLost ? "Tracking lost — move subject back into view · " : ((trackStateRef.current && trackStateRef.current.tex < TRACK_TEX_MIN) ? "Low-detail spot — pick a busier area · " : "Tracking on — ")}smooth <input type="number" min={0} max={10} step={0.5} defaultValue={(1 - TRACK_PAN_SMOOTH) * 10} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onFocus={(e) => e.target.select()} onChange={(e) => { const s = parseFloat(e.target.value); if (!Number.isFinite(s)) return; trackSmoothRef.current = Math.max(0.05, 1 - Math.min(10, Math.max(0, s)) / 10); }} style={{ width: 44, fontSize: 11, background: "rgba(255,255,255,.12)", border: "1px solid rgba(255,255,255,.25)", borderRadius: 6, color: "#fff", textAlign: "center", padding: "1px 4px", pointerEvents: "auto", outline: "none" }} />{trackLost ? " · drag to move · click to re-place" : " · drag to move · scroll to adjust zoom · click the dot to stop"}</div>
            </>
          )}
        </div>

        <div className="fv-controls" style={{ padding: "8px 10px", borderTop: "1px solid var(--border)", background: "var(--surface)", display: "grid", gap: 6 }}>
            {(isVideo || isAudio || gifAsVideoEff) && (
            <div className="fv-timeline" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", minWidth: 32 }}>{fmtTime(current)}</span>
              <input ref={seekRef} type="range" tabIndex={-1} min={0} max={duration || 0} step="any" defaultValue={0} onChange={(e)=> { const v=parseFloat(e.target.value); if(!videoRef.current) return; if (isDraggingRef.current) { animRef.current = null; pendingSeekRef.current = null; videoRef.current.currentTime = v; setCurrent(v); } else { seekTo(v); } }} onPointerDown={(e)=>{ pressedRef.current = true; isDraggingRef.current = false; pressStartRef.current = { x: e.clientX, y: e.clientY }; }} onPointerMove={(e)=>{ if (pressedRef.current) { const dx = e.clientX - pressStartRef.current.x; const dy = e.clientY - pressStartRef.current.y; if (Math.hypot(dx, dy) > 4) isDraggingRef.current = true; } }} onPointerUp={()=>{ pressedRef.current = false; isDraggingRef.current = false; }} onPointerCancel={()=>{ pressedRef.current = false; isDraggingRef.current = false; }} onMouseUp={(e)=>e.target.blur()} onTouchEnd={(e)=>e.target.blur()} onBlur={()=>{ pressedRef.current = false; isDraggingRef.current = false; }} style={{ flex: 1, accentColor: "#6366f1", height: 4 }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", minWidth: 32 }}>{fmtTime(duration)}</span>
              <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={toggleFullscreen} title="Fullscreen" style={{ padding: "4px 8px", fontSize: 11 }}><i className="bi bi-arrows-fullscreen" /></button>
            </div>
          )}
          <div className="fv-speed" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span className="badge text-bg-primary" style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "2px 6px" }}>{rate.toFixed(1)}×</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
              <input type="range" tabIndex={-1} min="0.1" max="1" step="0.1" value={rate} onChange={(e) => setRate(parseFloat(e.target.value))} onMouseUp={(e)=>e.target.blur()} onTouchEnd={(e)=>e.target.blur()} style={{ width: 90, accentColor: "#6366f1", height: 4 }} />
            </div>
            <div style={{ display: "flex", gap: 3, alignItems: "center", border: "1px solid var(--border)", borderRadius: 6, padding: 2, background: "var(--surface-2)" }}>
              <button type="button" tabIndex={-1} onClick={() => setSeekFrames(false)} className={`btn btn-sm ${!seekFrames ? "btn-primary" : "btn-outline-secondary"}`} style={{ padding: "2px 6px", fontSize: 11, minWidth: 32 }} title="Seek by 1 second (←/→)">1s</button>
              <button type="button" tabIndex={-1} onClick={() => setSeekFrames(true)} className={`btn btn-sm ${seekFrames ? "btn-primary" : "btn-outline-secondary"}`} style={{ padding: "2px 6px", fontSize: 11, minWidth: 32 }} title="Seek by 1 frame (~33ms)">1f</button>
            </div>
            <span style={{ flex: 1 }} />
            {tracking && (
              <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={stopTracking} title="Stop tracking and reset the view" style={{ padding: "4px 8px", fontSize: 11 }}><i className="bi bi-bullseye" /> Tracking</button>
            )}
            {(isImage || isVideo || gifAsVideoEff) && (
              <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={rotateFile} title={`Rotate 90° (⇧R)` + (rotate ? ` · now ${rotate}°` : "")} style={{ padding: "4px 8px", fontSize: 11 }}><i className="bi bi-arrow-clockwise" /> Rotate</button>
            )}
            <button type="button" tabIndex={-1} className="btn btn-sm" onClick={cycleEndMode} title={`End mode: ${endMode} (r)`} style={{ padding: "4px 6px", fontSize: 11, minWidth: 52, borderRadius: 6, border: "1px solid " + (endMode !== "none" ? "transparent" : "var(--border)"), background: endMode === "next" ? "#6366f1" : endMode === "repeat" ? "#10b981" : endMode === "random" ? "#8b5cf6" : "var(--surface-2)", color: endMode !== "none" ? "#fff" : "var(--muted)" }}>
              <i className={`bi ${endMode === "next" ? "bi-skip-forward-fill" : endMode === "repeat" ? "bi-repeat" : endMode === "random" ? "bi-shuffle" : "bi-arrow-repeat"}`} /> {endMode === "next" ? "Next" : endMode === "repeat" ? "Loop" : endMode === "random" ? "Shuffle" : "End"}
            </button>
          {(isVideo || isAudio || gifAsVideoEff) && (
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {(isVideo || isAudio || gifAsVideoEff) && (
                  <>
                    <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={() => setMuted((m) => !m)} title={muted ? "Unmute (m)" : "Mute (m)"} style={{ color: muted ? "#f87171" : undefined, minWidth: 36, padding: "4px 6px", fontSize: 11 }}><i className={`bi ${muted ? "bi-volume-mute-fill" : "bi-volume-up-fill"}`} /></button>
                    <button type="button" tabIndex={-1} className="fv-10s btn btn-sm btn-outline-secondary" onClick={() => { if (videoRef.current) seekTo(videoRef.current.currentTime - 10); videoRef.current?.focus(); }} title="Back 10s" style={{ padding: "4px 6px", fontSize: 11 }}><i className="bi bi-skip-backward" /> 10s</button>
                  </>
                )}
                <button type="button" tabIndex={-1} className="btn btn-sm btn-primary" onClick={() => { if (!videoRef.current) return; if (videoRef.current.paused) videoRef.current.play(); else videoRef.current.pause(); videoRef.current?.focus(); }} style={{ padding: "4px 8px", fontSize: 11 }}>
                  <i className={`bi ${isPlaying ? "bi-pause-fill" : "bi-play-fill"}`} /> {isPlaying ? "Pause" : "Play"}
                </button>
                {(isVideo || isAudio || gifAsVideoEff) && (
                  <button type="button" tabIndex={-1} className="fv-10s btn btn-sm btn-outline-secondary" onClick={() => { if (videoRef.current) seekTo(videoRef.current.currentTime + 10); videoRef.current?.focus(); }} title="Forward 10s" style={{ padding: "4px 6px", fontSize: 11 }}>10s <i className="bi bi-skip-forward" /></button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
    {showHelp && <ShortcutsHelp active="viewer" onClose={() => setShowHelp(false)} />}
    <ConfirmModal
      open={confirmOpen}
      title="Delete file"
      message={`Delete "${parseFolderBase(filePathEff).base}"? This removes the file from /media.`}
      confirmLabel="Delete"
      danger
      onCancel={() => setConfirmOpen(false)}
      onConfirm={handleConfirmDelete}
    />
    <AlertModal open={alertState.open} title={alertState.title || "Error"} message={alertState.message} onClose={() => setAlertState({ open: false, title: "", message: "" })} />
    </>
  );
}
