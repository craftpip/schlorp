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
  if (!menu) return null;
  const { entry, stackId } = menu;
  const isPile = entry && entry.kind === "pile";
  const isPlaylistFile = !!(entry && entry.kind === "file" && entry.it && entry.it._isPlaylistItem);
  const count = isPile ? entry.count : entry && entry.kind === "file" ? 1 : 0;
  // Selection count wins: right-clicking with files multi-selected stacks the selection.
  const fileCount = selCount > 1 ? selCount : (entry && entry.kind === "file" ? 1 : count);
  // Stacks the right-clicked file already belongs to (✓ marked; picking
  // another one moves it there). A right-clicked pile counts as its own stack.
  const memberOf = new Set(
    (entry && entry.kind === "file" && entry.it && Array.isArray(entry.it.stacks) ? entry.it.stacks : []).map((s) => s.id)
  );
  if (isPile && entry.stackId) memberOf.add(entry.stackId);
  // Split list: the item's own stacks go on top, then all the remaining
  // stacks (no cap — the card body scrolls when many stacks exist).
  const own = stacks.filter((s) => memberOf.has(s.id));
  const rest = stacks.filter((s) => !memberOf.has(s.id));
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
          {!noStacks && <MenuItem data-testid="media-ctx-stack-create" label={`Stack ${fileCount} item${fileCount === 1 ? "" : "s"}`} icon="bi-layers" disabled={fileCount < 2} onClick={() => { onClose(); onStack(); }} />}
          {!noStacks && (own.length > 0 || rest.length > 0) && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 8px 4px" }}>
                <i className="bi bi-layers" style={{ fontSize: 11, color: "var(--muted)" }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>Stacks in this folder</span>
              </div>
              <div data-testid="media-ctx-stack-grid" className="media-ctx-grid">
              {own.map((s) => (
                <StackCell key={s.id} s={s} member disabled={fileCount < 1} onOpen={() => { onClose(); onOpenStack(s.id); }} onClick={() => { onClose(); onAddToStack(s.id, s.name); }} />
              ))}
              {rest.map((s) => (
                <StackCell key={s.id} s={s} disabled={fileCount < 1} onOpen={() => { onClose(); onOpenStack(s.id); }} onClick={() => { onClose(); onAddToStack(s.id, s.name); }} />
              ))}
            </div>
            </>
          )}
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
          {!noStacks && !isPile && stackId && (
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

function StackCell({ s, member, disabled, onClick, onOpen }) {
  const [hovered, setHovered] = useState(false);
  const [pressing, setPressing] = useState(false);
  const [slide, setSlide] = useState(0);
  // Transform origin for the hover expand: corner/edge cells grow inward so
  // the enlarged preview stays inside the grid container instead of
  // overflowing outside it.
  const [origin, setOrigin] = useState("center");
  const timerRef = useRef(null);
  // Slideshow frames: full member thumbs when provided, else the single cover.
  const frames = Array.isArray(s.thumbs) && s.thumbs.length ? s.thumbs : (s.thumb ? [s.thumb] : []);
  const clearSlideTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };
  useEffect(() => clearSlideTimer, []);
  // Preload slideshow frames on hover so cycling doesn't flicker.
  useEffect(() => {
    if (!hovered || frames.length < 2) return;
    for (const src of frames) {
      const im = new Image();
      im.decoding = "async";
      im.src = src;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered]);
  const startHover = (e) => {
    if (disabled) return;
    // Pick the transform origin from the cell's position inside the grid:
    // left-column cells expand rightward, right-column leftward, top-row
    // downward, bottom-row upward — corners grow diagonally inward.
    try {
      const el = e && e.currentTarget;
      const grid = el && el.closest ? el.closest(".media-ctx-grid") : null;
      if (el && grid) {
        const r = el.getBoundingClientRect();
        const g = grid.getBoundingClientRect();
        if (r.width && r.height && g.width && g.height) {
          const cx = (r.left + r.width / 2 - g.left) / g.width;
          const cy = (r.top + r.height / 2 - g.top) / g.height;
          const x = cx < 0.33 ? "left" : cx > 0.67 ? "right" : "center";
          const y = cy < 0.33 ? "top" : cy > 0.67 ? "bottom" : "center";
          setOrigin(x === "center" && y === "center" ? "center" : `${y} ${x}`);
        }
      }
    } catch {}
    setHovered(true);
    setSlide(0);
    clearSlideTimer();
    if (frames.length > 1) {
      try {
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      } catch {}
      timerRef.current = setInterval(() => {
        setSlide((i) => (i + 1) % frames.length);
      }, 750);
    }
  };
  const stopHover = () => {
    clearSlideTimer();
    setHovered(false);
    setPressing(false);
    setSlide(0);
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
  const transform = hovered ? (pressing ? "scale(1.55)" : "scale(1.65)") : (pressing ? "scale(.93)" : "");
  return (
    <div
      data-testid="media-ctx-add-stack"
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
      style={{ position: "relative", width: "100%", aspectRatio: "6 / 5", borderRadius: 8, overflow: "hidden", background: "#000", border: `1px solid ${hovered ? "var(--accent)" : member ? "var(--accent)" : "var(--border)"}`, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, transform, transformOrigin: origin, zIndex: hovered ? 10 : "auto", boxShadow: hovered ? "0 12px 32px rgba(0,0,0,.45)" : "none", transition: "transform .18s ease, box-shadow .18s ease, border-color .18s ease", outline: "none" }}
    >
      {current ? (
        <img src={current} alt="" loading="lazy" decoding="async" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      ) : (
        <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "var(--surface-2)" }}>
          <i className="bi bi-layers" style={{ fontSize: 16, color: "var(--muted)" }} />
        </span>
      )}
      <span style={{ position: "absolute", top: 3, right: 3, fontSize: 10, fontWeight: 700, lineHeight: 1, color: "#fff", background: "rgba(0,0,0,.65)", padding: "3px 5px", borderRadius: 999, pointerEvents: "none" }}>{s.count ?? 0}</span>
      {member && (
        <span style={{ position: "absolute", top: 3, left: 3, fontSize: 11, lineHeight: 1, color: "#fff", background: "var(--accent)", padding: "3px 4px", borderRadius: 999, pointerEvents: "none" }}>✓</span>
      )}
      {hovered && frames.length > 1 && (
        <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 3, padding: "6px 4px 5px", background: "linear-gradient(transparent, rgba(0,0,0,.55))", pointerEvents: "none" }}>
          {frames.map((_, i) => (
            <span key={i} style={{ width: i === slide ? 10 : 4, height: 4, borderRadius: 999, background: i === slide ? "#fff" : "rgba(255,255,255,.5)", transition: "width .18s ease" }} />
          ))}
        </span>
      )}
    </div>
  );
}