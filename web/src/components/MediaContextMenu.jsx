import { useEffect } from "react";

export default function MediaContextMenu({ menu, onClose, stacks, selCount, onStack, onOpen, onDelete, onAddToStack, onRename, onUnstack, onRemoveFromStack, noStacks }) {
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
          {!noStacks && <MenuItem data-testid="media-ctx-stack-create" label={`Stack ${fileCount} item${fileCount === 1 ? "" : "s"}`} icon="bi-layers" disabled={fileCount < 2} onClick={() => { onClose(); onStack(); }} />}
          {!noStacks && (own.length > 0 || rest.length > 0) && (
            <div data-testid="media-ctx-stack-grid" className="media-ctx-grid">
              {own.map((s) => (
                <StackCell key={s.id} s={s} member disabled={fileCount < 1} onClick={() => { onClose(); onAddToStack(s.id, s.name); }} />
              ))}
              {rest.map((s) => (
                <StackCell key={s.id} s={s} disabled={fileCount < 1} onClick={() => { onClose(); onAddToStack(s.id, s.name); }} />
              ))}
            </div>
          )}
          {!noStacks && <Divider />}
          <MenuItem label="Open" icon="bi-box-arrow-up-right" onClick={() => { onClose(); onOpen(); }} />
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
  return (
    <div
      {...rest}
      onClick={disabled ? (e) => e.stopPropagation() : onClick}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = "rgba(99,102,241,.12)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
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

function StackCell({ s, member, disabled, onClick }) {
  return (
    <div
      data-testid="media-ctx-add-stack"
      title={s.name}
      onClick={disabled ? (e) => e.stopPropagation() : onClick}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.borderColor = "var(--accent)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = ""; }}
      style={{ position: "relative", width: "100%", aspectRatio: "6 / 5", borderRadius: 8, overflow: "hidden", background: "#000", border: `1px solid ${member ? "var(--accent)" : "var(--border)"}`, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1 }}
    >
      {s.thumb ? (
        <img src={s.thumb} alt="" loading="lazy" decoding="async" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      ) : (
        <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "var(--surface-2)" }}>
          <i className="bi bi-layers" style={{ fontSize: 16, color: "var(--muted)" }} />
        </span>
      )}
      <span style={{ position: "absolute", top: 3, right: 3, fontSize: 10, fontWeight: 700, lineHeight: 1, color: "#fff", background: "rgba(0,0,0,.65)", padding: "3px 5px", borderRadius: 999, pointerEvents: "none" }}>{s.count ?? 0}</span>
      {member && (
        <span style={{ position: "absolute", top: 3, left: 3, fontSize: 11, lineHeight: 1, color: "#fff", background: "var(--accent)", padding: "3px 4px", borderRadius: 999, pointerEvents: "none" }}>✓</span>
      )}
    </div>
  );
}