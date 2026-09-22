import { useEffect, useRef, useState } from "react";

export default function MediaContextMenu({ menu, onClose, stacks, selCount, onStack, onOpen, onOpenStack, onMove, canMove, moveLabel, onCreateFolder, onDelete, onAddToStack, onRename, onUnstack, onRemoveFromStack, noStacks, onGotoFile }) {
  // Scroll lock while the popup is open (same as ConfirmModal) so the grid
  // behind the backdrop doesn't scroll (plan 024).
  useEffect(() => {
    if (!menu) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [menu]);
  // Touch-drag highlight (mobile has no hover): while a finger drags across
  // the stack grid, the cell under the finger gets the expanded slideshow.
  // Declared before the early return so hook order stays stable.
  const [touchActiveId, setTouchActiveId] = useState(null);
  if (!menu) return null;
  const { entry, stackId } = menu;
  const isPile = entry && entry.kind === "pile";
  // menu.stackId is never set by the parent (it keeps ctxMenuStackId
  // separately), so fall back to the file's own stack membership — this is
  // what shows "Remove from stack" for a stacked file shown as a normal
  // tile (spread/open stack).
  const fileStackId = stackId || (entry && entry.kind === "file" && entry.it && Array.isArray(entry.it.stacks) && entry.it.stacks.length ? entry.it.stacks[0].id : null);
  const isPlaylistFile = !!(entry && entry.kind === "file" && entry.it && entry.it._isPlaylistItem);
  const count = isPile ? entry.count : entry && entry.kind === "file" ? 1 : 0;
  // Selection count wins: right-clicking with files multi-selected stacks the selection.
  const fileCount = selCount > 1 ? selCount : (entry && entry.kind === "file" ? 1 : count);
  // Stacks the right-clicked file already belongs to (outlined white;
  // picking another one moves it there). A right-clicked pile counts as its
  // own stack.
  const memberOf = new Set(
    (entry && entry.kind === "file" && entry.it && Array.isArray(entry.it.stacks) ? entry.it.stacks : []).map((s) => s.id)
  );
  if (isPile && entry.stackId) memberOf.add(entry.stackId);
  const handleGridTouchMove = (e) => {
    const t = e && e.touches && e.touches[0];
    if (!t) return;
    let id = null;
    try {
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const cell = el && el.closest ? el.closest("[data-stack-id]") : null;
      id = cell ? cell.getAttribute("data-stack-id") : null;
    } catch {}
    setTouchActiveId((prev) => (prev === id ? prev : id));
  };
  const clearTouchActive = () => setTouchActiveId(null);
  return (
    <div
      data-testid="media-context-menu"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 120, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "rgba(6,8,18,0.55)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", userSelect: "none", WebkitUserSelect: "none" }}
    >
      <div
        className="media-ctx-card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(520px, 100%)", maxHeight: "calc(100vh - 48px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,.25)" }}
      >
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 4, fontSize: 13 }}>
          {isPlaylistFile && onGotoFile && (
            <>
              <MenuItem data-testid="media-ctx-goto-file" label="Goto file" icon="bi-file-earmark" onClick={() => { onClose(); onGotoFile(); }} />
              <Divider />
            </>
          )}
          {!noStacks && stacks.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 8px 4px" }}>
                <i className="bi bi-layers" style={{ fontSize: 11, color: "var(--muted)" }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>Stacks in this folder</span>
              </div>
              <div data-testid="media-ctx-stack-grid" className="media-ctx-grid" onTouchMove={handleGridTouchMove} onTouchEnd={clearTouchActive} onTouchCancel={clearTouchActive} style={stacks.length <= 6 ? { gridTemplateColumns: "repeat(3, 1fr)" } : undefined}>
              {stacks.map((s) => (
                <StackCell key={s.id} s={s} member={memberOf.has(s.id)} touchActive={touchActiveId === s.id} noExpand={stacks.length <= 6} disabled={fileCount < 1} onOpen={() => { onClose(); onOpenStack(s.id); }} onClick={() => { onClose(); onAddToStack(s.id, s.name); }} />
              ))}
            </div>
            </>
          )}
          {!noStacks && fileCount > 1 && <MenuItem data-testid="media-ctx-stack-create" label={`Stack ${fileCount} item${fileCount === 1 ? "" : "s"}`} icon="bi-layers" onClick={() => { onClose(); onStack(); }} />}
          {!noStacks && <Divider />}
          <MenuItem label="Open" icon="bi-box-arrow-up-right" onClick={() => { onClose(); onOpen(); }} />
          {!isPlaylistFile && <MenuItem data-testid="media-ctx-create-folder" label="Create folder" icon="bi-folder-plus" onClick={() => { onClose(); onCreateFolder(); }} />}
          <MenuItem data-testid="media-ctx-move" label={moveLabel || (isPile ? "Move stack" : "Move files")} icon="bi-arrows-move" disabled={!canMove} onClick={() => { onClose(); onMove(); }} />
          <MenuItem label="Delete" icon="bi-trash" danger onClick={() => { onClose(); onDelete(); }} />
          {!noStacks && isPile && (
            <>
              <Divider />
              <MenuItem label="Rename stack" icon="bi-pencil" onClick={() => { onClose(); onRename(); }} />
              <MenuItem label="Unstack (keep files)" icon="bi-x-circle" onClick={() => { onClose(); onUnstack(); }} />
              <MenuItem label="Remove from stack" icon="bi-dash-circle" onClick={() => { onClose(); onRemoveFromStack(); }} />
            </>
          )}
          {!noStacks && !isPile && fileStackId && (
            <>
              <Divider />
              <MenuItem label="Remove from stack" icon="bi-dash-circle" onClick={() => { onClose(); onRemoveFromStack(); }} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MenuItem({ label, icon, danger, disabled, onClick, children, ...rest }) {
  const pressOn = (e) => {
    if (disabled) return;
    e.currentTarget.style.background = "rgba(99,102,241,.22)";
    e.currentTarget.style.transform = "scale(.985)";
  };
  const pressOffHover = (e) => {
    if (disabled) return;
    e.currentTarget.style.background = "rgba(99,102,241,.12)";
    e.currentTarget.style.transform = "";
  };
  return (
    <div
      {...rest}
      className={`media-ctx-item${rest.className ? ` ${rest.className}` : ""}`}
      data-disabled={disabled ? "true" : "false"}
      onClick={disabled ? (e) => e.stopPropagation() : onClick}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = "rgba(99,102,241,.12)"; }}
      onMouseLeave={(e) => { if (!disabled) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = ""; } }}
      onMouseDown={pressOn}
      onMouseUp={pressOffHover}
      onTouchStart={pressOn}
      onTouchEnd={pressOffHover}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer", color: danger ? "#f87171" : "var(--text)", opacity: disabled ? 0.4 : 1, fontSize: 13 }}
    >
      {icon && <i className={`bi ${icon}`} style={{ fontSize: 12, color: danger ? "inherit" : "var(--muted)" }} />}
      <span>{label}</span>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "var(--border)", margin: "4px 6px" }} />;
}

function StackCell({ s, member, disabled, onClick, onOpen, touchActive, noExpand }) {
  const [hovered, setHovered] = useState(false);
  const [pressing, setPressing] = useState(false);
  const [slide, setSlide] = useState(0);
  // Transform origin for the hover expand: corner/edge cells grow inward so
  // the enlarged preview stays inside the grid container instead of
  // overflowing outside it.
  const [origin, setOrigin] = useState("center");
  // Adaptive hover scale: clamped so the enlarged cell still fits inside the
  // grid viewport (a lone full-width stack has no room to grow — it keeps
  // the slideshow but skips the scale instead of clipping top/bottom).
  const [hoverScale, setHoverScale] = useState(1.65);
  const cellRef = useRef(null);
  const timerRef = useRef(null);
  // Slideshow frames: full member thumbs when provided, else the single cover.
  const frames = Array.isArray(s.thumbs) && s.thumbs.length ? s.thumbs : (s.thumb ? [s.thumb] : []);
  // Expanded either by mouse hover/focus or by touch-dragging across the cell.
  const expanded = hovered || !!touchActive;
  const clearSlideTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };
  useEffect(() => clearSlideTimer, []);
  // Slideshow runs while expanded (mouse or touch).
  useEffect(() => {
    if (!expanded || disabled || frames.length < 2) return;
    try {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    } catch {}
    timerRef.current = setInterval(() => {
      setSlide((i) => (i + 1) % frames.length);
    }, 750);
    return () => { clearSlideTimer(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, disabled, frames.length]);
  // Preload slideshow frames on expand so cycling doesn't flicker.
  useEffect(() => {
    if (!expanded || frames.length < 2) return;
    for (const src of frames) {
      const im = new Image();
      im.decoding = "async";
      im.src = src;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  // Pick the transform origin from the cell's position inside the grid:
  // left-column cells expand rightward, right-column leftward, top-row
  // downward, bottom-row upward — corners grow diagonally inward. Also clamps
  // the expand to the visible grid viewport (minus its padding) so a large
  // cell (e.g. the only stack, full-width) can't overflow and get its
  // top/bottom cut off.
  const fitToGrid = (el) => {
    try {
      const grid = el && el.closest ? el.closest(".media-ctx-grid") : null;
      if (!el || !grid) return;
      const r = el.getBoundingClientRect();
      const g = grid.getBoundingClientRect();
      if (r.width && r.height && g.width && g.height) {
        const cx = (r.left + r.width / 2 - g.left) / g.width;
        const cy = (r.top + r.height / 2 - g.top) / g.height;
        const x = cx < 0.33 ? "left" : cx > 0.67 ? "right" : "center";
        const y = cy < 0.33 ? "top" : cy > 0.67 ? "bottom" : "center";
        setOrigin(x === "center" && y === "center" ? "center" : `${y} ${x}`);
      }
      const vw = grid.clientWidth || g.width;
      const vh = grid.clientHeight || g.height;
      if (vw && vh && r.width && r.height) {
        const fit = Math.min((vw - 16) / r.width, (vh - 16) / r.height, 1.65);
        setHoverScale(Number.isFinite(fit) ? Math.max(1, Math.round(fit * 100) / 100) : 1.65);
      }
    } catch {}
  };
  // Touch-drag activation: when the finger slides onto this cell, expand it
  // like a hover; sliding off collapses back to the default first image.
  useEffect(() => {
    if (touchActive && !disabled) {
      if (cellRef.current) fitToGrid(cellRef.current);
      setSlide(0);
    } else if (!touchActive && !hovered) {
      setSlide(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touchActive]);
  const startHover = (e) => {
    if (disabled) return;
    if (e && e.currentTarget) fitToGrid(e.currentTarget);
    setHovered(true);
    setSlide(0);
  };
  const stopHover = () => {
    setHovered(false);
    setPressing(false);
    if (!touchActive) setSlide(0);
  };
  const pressOn = () => {
    if (disabled) return;
    setPressing(true);
  };
  const pressOff = () => {
    if (disabled) return;
    setPressing(false);
  };
  const current = frames.length ? frames[Math.min(slide, frames.length - 1)] : null;
  // Roomy layout (<=6 stacks, 3 per row): cells are already big, so hover /
  // touch-drag only runs the slideshow without the scale-up.
  const canGrow = hoverScale > 1.01 && !noExpand;
  // Member stacks (the right-clicked item already belongs) render slightly
  // larger with a white outline instead of a checkmark badge.
  const idleMemberScale = member && !expanded && !pressing ? "scale(1.06)" : "";
  const transform = expanded
    ? (canGrow ? `scale(${pressing ? Math.max(1, Math.round((hoverScale - 0.1) * 100) / 100) : hoverScale})` : "")
    : (pressing ? "scale(.93)" : idleMemberScale);
  return (
    <div
      ref={cellRef}
      data-testid="media-ctx-add-stack"
      data-stack-id={s.id}
      title={s.name}
      tabIndex={disabled ? -1 : 0}
      onClick={disabled ? (e) => e.stopPropagation() : onClick}
      onMouseEnter={startHover}
      onMouseLeave={stopHover}
      onFocus={startHover}
      onBlur={stopHover}
      onMouseDown={pressOn}
      onMouseUp={pressOff}
      onTouchStart={pressOn}
      onTouchEnd={pressOff}
      style={{ position: "relative", width: "100%", aspectRatio: "6 / 5", borderRadius: 8, overflow: "hidden", background: "#000", border: `1px solid ${expanded && !member ? "var(--accent)" : member ? "#fff" : "var(--border)"}`, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, transform, transformOrigin: origin, zIndex: expanded || member ? 10 : "auto", boxShadow: expanded ? "0 12px 32px rgba(0,0,0,.45)" : member ? "0 0 0 2px rgba(255,255,255,.9)" : "none", transition: "transform .18s ease, box-shadow .18s ease, border-color .18s ease", outline: "none" }}
    >
      {current ? (
        <img src={current} alt="" loading="lazy" decoding="async" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      ) : (
        <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "var(--surface-2)" }}>
          <i className="bi bi-layers" style={{ fontSize: 16, color: "var(--muted)" }} />
        </span>
      )}
      <span style={{ position: "absolute", top: 3, right: 3, fontSize: 10, fontWeight: 700, lineHeight: 1, color: "#fff", background: "rgba(0,0,0,.65)", padding: "3px 5px", borderRadius: 999, pointerEvents: "none" }}>{s.count ?? 0}</span>
      {expanded && frames.length > 1 && (
        <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 3, padding: "6px 4px 5px", background: "linear-gradient(transparent, rgba(0,0,0,.55))", pointerEvents: "none" }}>
          {frames.map((_, i) => (
            <span key={i} style={{ width: i === slide ? 10 : 4, height: 4, borderRadius: 999, background: i === slide ? "#fff" : "rgba(255,255,255,.5)", transition: "width .18s ease" }} />
          ))}
        </span>
      )}
    </div>
  );
}