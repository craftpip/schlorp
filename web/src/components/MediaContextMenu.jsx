export default function MediaContextMenu({ menu, onClose, stacks, selCount, onStack, onOpen, onDelete, onAddToStack, onRename, onUnstack, onRemoveFromStack }) {
  if (!menu) return null;
  const { entry, stackId } = menu;
  const isPile = entry && entry.kind === "pile";
  const count = isPile ? entry.count : entry && entry.kind === "file" ? 1 : 0;
  // Selection count wins: right-clicking with files multi-selected stacks the selection.
  const fileCount = selCount > 1 ? selCount : (entry && entry.kind === "file" ? 1 : count);
  // Stacks the right-clicked file already belongs to (✓ marked; picking
  // another one moves it there).
  const memberOf = new Set(
    (entry && entry.kind === "file" && entry.it && Array.isArray(entry.it.stacks) ? entry.it.stacks : []).map((s) => s.id)
  );
  return (
    <div
      data-testid="media-context-menu"
      ref={undefined}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 100, minWidth: 180, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.35)", padding: 4, fontSize: 13 }}
    >
      <MenuItem data-testid="media-ctx-stack-create" label={`Stack ${fileCount} item${fileCount === 1 ? "" : "s"}`} icon="bi-layers" disabled={fileCount < 2} onClick={() => { onClose(); onStack(); }} />
      {stacks.length > 0 && stacks.map((s) => (
        <MenuItem key={s.id} data-testid="media-ctx-add-stack" label={`${memberOf.has(s.id) ? "✓ " : ""}${s.name}`} icon={memberOf.has(s.id) ? "bi-check-lg" : "bi-layers"} disabled={fileCount < 1} onClick={() => { onClose(); onAddToStack(s.id, s.name); }}>
          <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>{s.count ?? s.items?.length ?? 0}</span>
        </MenuItem>
      ))}
      <Divider />
      <MenuItem label="Open" icon="bi-box-arrow-up-right" onClick={() => { onClose(); onOpen(); }} />
      <MenuItem label="Delete" icon="bi-trash" danger onClick={() => { onClose(); onDelete(); }} />
      {isPile && (
        <>
          <Divider />
          <MenuItem label="Rename stack" icon="bi-pencil" onClick={() => { onClose(); onRename(); }} />
          <MenuItem label="Unstack (keep files)" icon="bi-x-circle" onClick={() => { onClose(); onUnstack(); }} />
          <MenuItem label="Remove from stack" icon="bi-dash-circle" onClick={() => { onClose(); onRemoveFromStack(); }} />
        </>
      )}
      {!isPile && stackId && (
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