const LIBRARY_SHORTCUTS = [
  { keys: ["g"], desc: "Toggle grid / list view" },
  { keys: ["j"], desc: "Toggle flatten (list all files recursively)" },
  { keys: ["t"], desc: "Cycle type filter (All → Img → Vid → GIF)" },
  { keys: ["↑", "w"], desc: "Move selection up" },
  { keys: ["↓", "s"], desc: "Move selection down" },
  { keys: ["←", "a"], desc: "Go up one folder" },
  { keys: ["→", "d", "Enter", "Space"], desc: "Open selected folder / file" },
  { keys: ["/"], desc: "Show this shortcut guide" },
  { keys: ["Esc"], desc: "Close this guide" },
];

const VIEWER_SHORTCUTS = [
  { keys: ["←", "a"], desc: "Previous image · seek back (1s, 1 frame in frame mode, 5s with ⇧)" },
  { keys: ["→", "d"], desc: "Next image · seek forward (1s, 1 frame in frame mode, 5s with ⇧)" },
  { keys: ["↑", "w"], desc: "Previous file" },
  { keys: ["↓", "s"], desc: "Next file" },
  { keys: ["Space"], desc: "Play / pause" },
  { keys: ["f"], desc: "Fullscreen" },
  { keys: ["m"], desc: "Mute / unmute" },
  { keys: ["e"], desc: "Toggle frame-seek mode (1s ↔ 1 frame)" },
  { keys: ["r"], desc: "Cycle end mode (End → Next → Loop → Shuffle)" },
  { keys: ["c", "<"], desc: "Slower playback (−0.1×)" },
  { keys: ["v", ">"], desc: "Faster playback (+0.1×)" },
  { keys: ["y", "y"], desc: "Delete file (press twice to confirm)" },
  { keys: ["q", "Esc"], desc: "Close player" },
  { keys: ["/"], desc: "Show this shortcut guide" },
  { keys: ["hold ⇧"], desc: "Hold to pause video (resume on release)" },
];

function Group({ title, sub, rows, dimmed }) {
  return (
    <div style={{ opacity: dimmed ? 0.55 : 1, minWidth: 0 }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: "var(--text)", marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>{sub}</div>
      <div style={{ display: "grid", gap: 2 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "3px 0" }}>
            <span style={{ display: "flex", gap: 3, minWidth: 118, flexShrink: 0, flexWrap: "wrap" }}>
              {r.keys.map((kk, j) => (
                <kbd key={j} style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text)", whiteSpace: "nowrap" }}>{kk}</kbd>
              ))}
            </span>
            <span style={{ fontSize: 12, color: "var(--muted)", minWidth: 0 }}>{r.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ShortcutsHelp({ active, onClose }) {
  return (
    <div
      data-testid="shortcuts-help"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 120, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(6,8,18,0.72)", backdropFilter: "blur(8px)" }}
    >
      <style>{`@media (max-width: 760px){ .shcut-cols{ grid-template-columns: 1fr !important; } }`}</style>
      <div
        data-testid="shortcuts-help-card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(980px, 96vw)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 18px", boxShadow: "0 12px 40px rgba(0,0,0,.5)" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <i className="bi bi-keyboard" style={{ color: "var(--accent)" }} />
          <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>Keyboard shortcuts</span>
          <span style={{ flex: 1 }} />
          <button data-testid="shortcuts-help-close" type="button" className="btn btn-sm btn-outline-secondary" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <div className="shcut-cols" style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 24, alignItems: "start" }}>
          <Group title="Library" sub="Available when no player is open" rows={LIBRARY_SHORTCUTS} dimmed={active === "viewer"} />
          <Group title="Player open" sub="Available while viewing a file" rows={VIEWER_SHORTCUTS} dimmed={active === "library"} />
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: "var(--muted)" }}>Press <kbd style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "1px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface-2)" }}>/</kbd> again or <kbd style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "1px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface-2)" }}>Esc</kbd> to close.</div>
      </div>
    </div>
  );
}
