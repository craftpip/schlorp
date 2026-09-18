export default function MediaContextMenu({ menu, onClose, stacks, selCount, onStack, onOpen, onDelete, onAddToStack, onRename, onUnstack, onRemoveFromStack, noStacks }) {
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
  // Split list: the item's own stacks go on top, then the remaining stacks
  // (up to 5) below.
  const own = stacks.filter((s) => memberOf.has(s.id));
  const rest = stacks.filter((s) => !memberOf.has(s.id));
  const restShown = rest.slice(0, 5);
  return (
    <div
      data-testid="media-context-menu"
      ref={undefined}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 100, minWidth: 200, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.35)", padding: 4, fontSize: 13 }}
    >
      {!noStacks && <MenuItem data-testid="media-ctx-stack-create" label={`Stack ${fileCount} item${fileCount === 1 ? "" : "s"}`} icon="bi-layers" disabled={fileCount < 2} onClick={() => { onClose(); onStack(); }} />}
      {!noStacks && (own.length > 0 || restShown.length > 0) && (
        <div data-testid="media-ctx-stack-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 60px)", gap: 6, padding: "6px 6px 0" }}>
          {own.map((s) => (
            <StackCell key={s.id} s={s} member disabled={fileCount < 1} onClick={() => { onClose(); onAddToStack(s.id, s.name); }} />
          ))}
          {restShown.map((s) => (
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
      style={{ position: "relative", width: 60, height: 48, borderRadius: 6, overflow: "hidden", background: "#000", border: `1px solid ${member ? "var(--accent)" : "var(--border)"}`, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1 }}
    >
      {s.thumb ? (
        <img src={s.thumb} alt="" loading="lazy" decoding="async" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      ) : (
        <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "var(--surface-2)" }}>
          <i className="bi bi-layers" style={{ fontSize: 16, color: "var(--muted)" }} />
        </span>
      )}
      <span style={{ position: "absolute", top: 2, right: 2, fontSize: 9, fontWeight: 700, lineHeight: 1, color: "#fff", background: "rgba(0,0,0,.65)", padding: "2px 4px", borderRadius: 999, pointerEvents: "none" }}>{s.count ?? 0}</span>
      {member && (
        <span style={{ position: "absolute", top: 2, left: 2, fontSize: 10, lineHeight: 1, color: "#fff", background: "var(--accent)", padding: "2px 3px", borderRadius: 999, pointerEvents: "none" }}>✓</span>
      )}
    </div>
  );
}