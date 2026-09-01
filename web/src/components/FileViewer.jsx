import { useState, useEffect, useRef } from "react";

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
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const [rate, setRate] = useState(() => { try { const v = parseFloat(localStorage.getItem("xdl_viewer_rate")); if (!Number.isNaN(v) && v >= 0.1 && v <= 1) return v; } catch {} return 1; });
  const [isPlaying, setIsPlaying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [origin, setOrigin] = useState("50% 50%");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isFs, setIsFs] = useState(false);
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
  const lastYRef = useRef(0);
  const yConfirmTimerRef = useRef(null);
  const doDeleteFileRef = useRef(null);
  const randCursorRef = useRef(-1);
  const fmtTime = (s) => { if (!s || Number.isNaN(s)) return "0:00"; const m = Math.floor(s/60); const sec = String(Math.floor(s%60)).padStart(2,"0"); return `${m}:${sec}`; };
  const mediaUrl = effSrc;
  const navRef = useRef(mediaUrl);
  const [loadedUrl, setLoadedUrl] = useState(mediaUrl);
  const loadTimerRef = useRef(null);
  useEffect(() => {
    navRef.current = mediaUrl;
    if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    loadTimerRef.current = setTimeout(() => { if (navRef.current === mediaUrl) setLoadedUrl(mediaUrl); }, 150);
    return () => { if (loadTimerRef.current) clearTimeout(loadTimerRef.current); };
  }, [mediaUrl]);
  const loading = mediaUrl !== loadedUrl;
  const titleEff = effTitle;
  const filePathEff = effFilePath;
  const urlEff = effUrl;
  const ext = String(filePathEff || effSrc || "").split(".").pop()?.toLowerCase() || "";
  const isVideo = /^(mp4|webm|mkv|mov|m4v|avi|mpg|mpeg|3gp|flv|ts|m3u8)$/i.test(ext);
  const isAudio = /^(mp3|m4a|aac|ogg|wav|flac|opus)$/i.test(ext);
  const isImage = /^(jpg|jpeg|png|gif|webp|bmp|avif)$/i.test(ext);
  const isFormatKnown = isVideo || isAudio || isImage;
  const hasPrev = idx != null && idx > 0;
  const hasNext = idx != null && viewable && idx < viewable.length - 1;
  const total = viewable ? viewable.length : 0;

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
  useEffect(() => { try { localStorage.setItem("xdl_viewer_endMode", endMode); } catch {} }, [endMode]);
  useEffect(() => { setZoom(1); setOrigin("50% 50%"); setPan({x:0,y:0}); setCurrent(0); setDuration(0); setYConfirm(false); lastYRef.current = 0; if (yConfirmTimerRef.current) { clearTimeout(yConfirmTimerRef.current); yConfirmTimerRef.current = null; } setTimeout(() => videoRef.current?.focus(), 50); }, [loadedUrl]);
  useEffect(() => () => { if (yConfirmTimerRef.current) clearTimeout(yConfirmTimerRef.current); }, []);
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
      if (videoRef.current) { videoRef.current.currentTime = 0; videoRef.current.play().catch(() => {}); }
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
  const handleWheel = (e) => {
    if (e.shiftKey) {
      if ((isVideo || isAudio) && videoRef.current) {
        e.preventDefault();
        const d = seekFrames ? 1/30 : 1;
        const raw = (e.deltaY !== 0 ? e.deltaY : e.deltaX !== 0 ? e.deltaX : e.wheelDelta ? -e.wheelDelta : 0);
        if (raw === 0) return;
        const delta = raw < 0 ? d : -d;
        const v = videoRef.current;
        const nt = Math.max(0, Math.min(duration || v.duration || Infinity, v.currentTime + delta));
        v.currentTime = nt;
        setCurrent(nt);
        return;
      }
      e.preventDefault();
      return;
    }
    if (isAudio) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const delta = e.deltaY < 0 ? 0.25 : -0.25;
    const newZoom = Math.min(4, Math.max(1, Math.round((zoom + delta) * 4) / 4));
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
  const handleMouseDown = (e) => {
    if (!isImage && videoRef.current) {
      wasPlayingRef.current = !videoRef.current.paused;
      if (wasPlayingRef.current) videoRef.current.pause();
    }
    if (zoom === 1 || isAudio) {
      if (!isImage) e.preventDefault();
      return;
    }
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
    e.preventDefault();
  };
  const handleMouseMove = (e) => {
    if (!dragRef.current.dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPan({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
  };
  const handleMouseUp = () => {
    const wasDragging = dragRef.current.dragging;
    dragRef.current.dragging = false;
    if (wasPlayingRef.current && videoRef.current && !isImage) {
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
    touchRef.current = { startX: t.clientX, startY: t.clientY, startTime: videoRef.current?.currentTime || 0, isSeeking: false, isHorizontal: null, startPan: { ...pan }, lastDx: 0 };
    if (!isImage && videoRef.current) {
      wasPlayingRef.current = !videoRef.current.paused;
      if (wasPlayingRef.current) videoRef.current.pause();
    }
  };
  const handleTouchMove = (e) => {
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - touchRef.current.startX;
    const dy = t.clientY - touchRef.current.startY;
    if (zoom > 1) {
      setPan({ x: touchRef.current.startPan.x + dx, y: touchRef.current.startPan.y + dy });
      e.preventDefault();
      return;
    }
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8 && videoRef.current) {
      if (seekFrames) {
        // per-frame: 24px = 1 frame, step one frame at a time without skipping
        const frames = Math.trunc(dx / 24);
        const lastFrames = Math.trunc((touchRef.current.lastDx || 0) / 24);
        const deltaFrames = frames - lastFrames;
        if (deltaFrames !== 0) {
          const nt = Math.max(0, Math.min(duration || 1e9, videoRef.current.currentTime + deltaFrames * (1/30)));
          videoRef.current.currentTime = nt;
          setCurrent(nt);
          touchRef.current.lastDx = dx - (dx % 24);
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
    const dx = t.clientX - touchRef.current.startX;
    const dy = t.clientY - touchRef.current.startY;
    const isRandom = endModeRef.current === "random";
    const wasNav = Math.abs(dy) > 25 && Math.abs(dy) > Math.abs(dx) && (isRandom ? total > 1 : ((dy < 0 && hasNext) || (dy > 0 && hasPrev)));
    if (wasNav) {
      wasPlayingRef.current = false;
      if (dy < 0) dispatchNextRef.current();
      else if (dy > 0) dispatchPrevRef.current();
      return;
    }
    if (wasPlayingRef.current && videoRef.current && !isImage) {
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
      if (k === "Escape") {
        if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); e.preventDefault(); return; }
        e.preventDefault(); onClose();
      } else if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault(); toggleFullscreen();
      } else if (e.key.toLowerCase() === "q" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault(); onClose();
      } else if (e.key.toLowerCase() === "e" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); setSeekFrames((v) => !v); }
      } else if ((e.code === "Space" || e.key === " " || e.key === "Spacebar") && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (!isImage && videoRef.current) {
          e.preventDefault();
          if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; jogWasPlayingRef.current = false; videoRef.current.pause(); }
          else { if (videoRef.current.paused) videoRef.current.play(); else videoRef.current.pause(); }
        }
       } else if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); setMuted((v) => !v); }
      } else if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); cycleEndModeRef.current(); }
      } else if (e.key.toLowerCase() === "c" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); stepRate(-0.1); }
      } else if (e.key.toLowerCase() === "v" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && !e.target.isContentEditable) { e.preventDefault(); stepRate(0.1); }
      } else if ((e.key === "<" || (e.key === "," && e.shiftKey)) && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); stepRate(-0.1);
      } else if ((e.key === ">" || (e.key === "." && e.shiftKey)) && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); stepRate(0.1);
      } else if (isLeft) {
        if (isImage) { e.preventDefault(); dispatchPrevRef.current(); }
        else if (videoRef.current) {
          e.preventDefault(); const v = videoRef.current;
          if (e.shiftKey) {
            v.currentTime = Math.max(0, v.currentTime - 5);
          } else if (seekFrames) {
            if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; }
            else { jogWasPlayingRef.current = !v.paused; }
            v.pause();
            const gen = ++jogGenRef.current;
            let steps = 0; const max = 30;
            jogRef.current = setInterval(() => {
              if (steps >= max || jogGenRef.current !== gen) { clearInterval(jogRef.current); if (jogGenRef.current === gen) { jogRef.current = null; if (jogWasPlayingRef.current) { jogWasPlayingRef.current = false; v.play().catch(() => {}); } } return; }
              v.currentTime = Math.max(0, v.currentTime - 1/30); steps++;
            }, 33 / rate);
          } else { v.currentTime = Math.max(0, v.currentTime - 1); }
        }
      } else if (isRight) {
        if (isImage) { e.preventDefault(); dispatchNextRef.current(); }
        else if (videoRef.current) {
          e.preventDefault(); const v = videoRef.current;
          if (e.shiftKey) {
            v.currentTime = Math.min(duration || v.duration || Infinity, v.currentTime + 5);
          } else if (seekFrames) {
            if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; }
            else { jogWasPlayingRef.current = !v.paused; }
            v.pause();
            const gen = ++jogGenRef.current;
            let steps = 0; const max = 30;
            jogRef.current = setInterval(() => {
              if (steps >= max || jogGenRef.current !== gen) { clearInterval(jogRef.current); if (jogGenRef.current === gen) { jogRef.current = null; if (jogWasPlayingRef.current) { jogWasPlayingRef.current = false; v.play().catch(() => {}); } } return; }
              v.currentTime = Math.min(duration || v.duration || Infinity, v.currentTime + 1/30); steps++;
            }, 33 / rate);
          } else { v.currentTime = Math.min(duration || v.duration || Infinity, v.currentTime + 1); }
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
  }, [onClose, hasPrev, hasNext, onPrev, onNext, isImage, duration, seekFrames, rate]);
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
    const onShiftDown = (e) => {
      if (e.key !== "Shift" || e.repeat) return;
      if (e.target && ((e.target.tagName === "INPUT" && e.target.type !== "range") || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;
      if (isImage || !videoRef.current || videoRef.current.paused) return;
      if (shiftWasPlayingRef.current) return;
      shiftWasPlayingRef.current = true;
      videoRef.current.pause();
    };
    const onShiftUp = (e) => {
      if (e.key !== "Shift") return;
      if (e.target && ((e.target.tagName === "INPUT" && e.target.type !== "range") || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) { shiftWasPlayingRef.current = false; return; }
      if (!shiftWasPlayingRef.current || !videoRef.current || isImage) { shiftWasPlayingRef.current = false; return; }
      shiftWasPlayingRef.current = false;
      videoRef.current.play().catch(() => {});
    };
    const stopJog = () => {
      if (jogRef.current) { clearInterval(jogRef.current); jogRef.current = null; }
      if (jogWasPlayingRef.current && videoRef.current) { jogWasPlayingRef.current = false; videoRef.current.play().catch(() => {}); }
    };
    const onBlur = () => { shiftWasPlayingRef.current = false; stopJog(); };
    window.addEventListener("keydown", onShiftDown);
    window.addEventListener("keyup", onShiftUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onShiftDown);
      window.removeEventListener("keyup", onShiftUp);
      window.removeEventListener("blur", onBlur);
      stopJog();
    };
  }, [isImage]);

  const doDeleteFile = async () => {
    const { folder, base } = parseFolderBase(filePathEff);
    if (!base) return;
    if (deleting) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/media?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(base)}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "delete failed");
      // Stay at current index: after deletion the next file slides into this position.
      // Only navigate if we deleted the last item (no next) or it was the only file.
      if (total <= 1) onClose();
      else if (!hasNext && hasPrev) onPrev();
      // else hasNext -> stay at same idx; onDeleted reload will make that idx point to next file
      if (onDeleted) onDeleted(filePathEff);
    } catch (e) { alert(e.message); }
    finally { setDeleting(false); }
  };
  const handleDelete = async () => {
    const { base } = parseFolderBase(filePathEff);
    if (!base) return;
    if (!confirm(`Delete "${base}"? This removes the file from /media.`)) return;
    await doDeleteFile();
  };
  doDeleteFileRef.current = doDeleteFile;

  return (
    <div
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", alignItems: "stretch", justifyContent: "stretch", padding: 0, margin: 0, background: "rgba(6,8,18,0.72)", backdropFilter: "blur(8px)" }}
    >
      <div
        ref={viewerRef}
        onClick={(e) => e.stopPropagation()}
        style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--surface)", border: "none", borderRadius: 0, overflow: "hidden", boxShadow: "none", margin: 0, boxSizing: "border-box", position: "relative" }}
      >
        <div className="fv-header" style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 5, display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "transparent", border: "none", pointerEvents: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, pointerEvents: "auto" }}>
            <button type="button" tabIndex={-1} className="btn btn-sm" onClick={(e) => { e.stopPropagation(); dispatchPrevRef.current(); }} onTouchStart={(e) => e.stopPropagation()} disabled={endMode !== "random" && !hasPrev} title="Previous (↑)" style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><i className="bi bi-chevron-up" /></button>
            <span className="badge" style={{ fontFamily: "var(--mono)", fontSize: 11, minWidth: 54, justifyContent: "center", background: "rgba(0,0,0,.55)", border: "1px solid rgba(255,255,255,.18)", color: "#fff", backdropFilter: "blur(6px)" }}>{endMode === "random" && randHistory.length > 1 ? `${randCursor + 1}/${randHistory.length} · ` : ""}{idx + 1} / {total}</span>
            <button type="button" tabIndex={-1} className="btn btn-sm" onClick={(e) => { e.stopPropagation(); dispatchNextRef.current(); }} onTouchStart={(e) => e.stopPropagation()} disabled={endMode !== "random" && !hasNext} title="Next (↓)" style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><i className="bi bi-chevron-down" /></button>
          </div>
          <span style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, pointerEvents: "auto" }}>
            {yConfirm && <span style={{ fontSize: 11, fontWeight: 600, color: "#fff", background: "#ef4444", padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,.2)", whiteSpace: "nowrap" }}>Press y again to confirm delete</span>}
            <button type="button" tabIndex={-1} onClick={handleDelete} disabled={deleting} className="btn btn-sm" aria-label="Delete file" title={yConfirm ? "Press y again to confirm — or click to delete" : "Delete file (press y twice)"} style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: yConfirm ? "1px solid #ef4444" : "1px solid rgba(255,255,255,.18)", background: yConfirm ? "#ef4444" : "rgba(0,0,0,.55)", color: yConfirm ? "#fff" : "#ff8080", backdropFilter: "blur(6px)", animation: yConfirm ? "pulse 0.6s ease infinite" : "none" }}><i className="bi bi-trash" /></button>
            <button type="button" tabIndex={-1} onClick={onClose} className="btn btn-sm" aria-label="Close" style={{ width: 36, height: 36, padding: 0, borderRadius: 999, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)", color: "#fff", backdropFilter: "blur(6px)" }}><i className="bi bi-x-lg" /></button>
          </div>
        </div>

        <style>{`@keyframes pulse{0%{transform:scale(1)}50%{transform:scale(1.08)}100%{transform:scale(1)}} video::-webkit-media-controls-panel,video::-webkit-media-controls-enclosure{ background: transparent !important; background-image: none !important; box-shadow: none !important; } video::-webkit-media-controls-timeline{ background: transparent !important; }
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
        <div ref={containerRef} onWheel={handleWheel} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} title={zoom>1 ? "Drag to pan · scroll to zoom" : "Scroll to zoom · drag to pan when zoomed · swipe up/down prev/next, left/right seek"} style={{ position: "relative", flex: "1 1 auto", minHeight: 0, overflow: "hidden", background: "#080a14", display: "flex", alignItems: "center", justifyContent: "center", padding: isImage ? 16 : 0, cursor: "default", touchAction: "none" }}>
          {zoom>1 && <span style={{ position: "absolute", top: 10, right: 10, zIndex: 3, background: "rgba(0,0,0,.6)", color: "#fff", padding: "4px 8px", borderRadius: 6, fontSize: 11, fontFamily: "var(--mono)" }}>{Math.round(zoom*100)}%</span>}
          {loading ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}><i className="bi bi-hourglass-split" /> Loading…</div>
          ) : isImage ? (
            <img src={loadedUrl} alt={titleEff} onContextMenu={(e) => e.preventDefault()} draggable={false} style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000", borderRadius: 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: origin, transition: zoom===1 ? "transform 0.15s" : "none", WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }} />
          ) : isAudio ? (
            <div style={{ width: "100%", padding: 24, display: "grid", placeItems: "center" }}>
              <audio key={loadedUrl} ref={videoRef} src={loadedUrl} autoPlay style={{ width: "100%", display: "none" }} onTimeUpdate={(e)=> setCurrent(e.currentTarget.currentTime)} onLoadedMetadata={(e)=> setDuration(e.currentTarget.duration)} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} />
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
              onClick={(e)=> e.stopPropagation()}
              style={{ width: "100%", height: "100%", background: "#000", display: "block", objectFit: "contain", transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: origin, transition: zoom===1 ? "transform 0.15s" : "none", WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none", outline: "none" }}
              onTimeUpdate={(e)=> setCurrent(e.currentTarget.currentTime)}
              onLoadedMetadata={(e)=> setDuration(e.currentTarget.duration)}
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
        </div>

        <div className="fv-controls" style={{ padding: "8px 10px", borderTop: "1px solid var(--border)", background: "var(--surface)", display: "grid", gap: 6 }}>
          {(isVideo || isAudio) && (
            <div className="fv-timeline" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", minWidth: 32 }}>{fmtTime(current)}</span>
              <input type="range" tabIndex={-1} min={0} max={duration || 0} step={0.1} value={current} onChange={(e)=> { const v=parseFloat(e.target.value); if(videoRef.current){ videoRef.current.currentTime=v; setCurrent(v);} }} onMouseUp={(e)=>e.target.blur()} onTouchEnd={(e)=>e.target.blur()} style={{ flex: 1, accentColor: "#6366f1", height: 4 }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", minWidth: 32 }}>{fmtTime(duration)}</span>
              <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={toggleFullscreen} title="Fullscreen (f)" style={{ padding: "4px 8px", fontSize: 11 }}><i className="bi bi-arrows-fullscreen" /></button>
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
            {(isVideo || isAudio) && (
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <button type="button" tabIndex={-1} className="btn btn-sm" onClick={cycleEndMode} title={`End mode: ${endMode} (r)`} style={{ padding: "4px 6px", fontSize: 11, minWidth: 52, borderRadius: 6, border: "1px solid " + (endMode !== "none" ? "transparent" : "var(--border)"), background: endMode === "next" ? "#6366f1" : endMode === "repeat" ? "#10b981" : endMode === "random" ? "#8b5cf6" : "var(--surface-2)", color: endMode !== "none" ? "#fff" : "var(--muted)" }}>
                  <i className={`bi ${endMode === "next" ? "bi-skip-forward-fill" : endMode === "repeat" ? "bi-repeat" : endMode === "random" ? "bi-shuffle" : "bi-arrow-repeat"}`} /> {endMode === "next" ? "Next" : endMode === "repeat" ? "Loop" : endMode === "random" ? "Shuffle" : "End"}
                </button>
                <button type="button" tabIndex={-1} className="btn btn-sm btn-outline-secondary" onClick={() => setMuted((m) => !m)} title={muted ? "Unmute (m)" : "Mute (m)"} style={{ color: muted ? "#f87171" : undefined, minWidth: 36, padding: "4px 6px", fontSize: 11 }}><i className={`bi ${muted ? "bi-volume-mute-fill" : "bi-volume-up-fill"}`} /></button>
                <button type="button" tabIndex={-1} className="fv-10s btn btn-sm btn-outline-secondary" onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 10); videoRef.current?.focus(); }} title="Back 10s" style={{ padding: "4px 6px", fontSize: 11 }}><i className="bi bi-skip-backward" /> 10s</button>
                <button type="button" tabIndex={-1} className="btn btn-sm btn-primary" onClick={() => { if (!videoRef.current) return; if (videoRef.current.paused) videoRef.current.play(); else videoRef.current.pause(); videoRef.current?.focus(); }} style={{ padding: "4px 8px", fontSize: 11 }}>
                  <i className={`bi ${isPlaying ? "bi-pause-fill" : "bi-play-fill"}`} /> {isPlaying ? "Pause" : "Play"}
                </button>
                <button type="button" tabIndex={-1} className="fv-10s btn btn-sm btn-outline-secondary" onClick={() => { if (videoRef.current) videoRef.current.currentTime += 10; videoRef.current?.focus(); }} title="Forward 10s" style={{ padding: "4px 6px", fontSize: 11 }}>10s <i className="bi bi-skip-forward" /></button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
