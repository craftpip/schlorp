import { useEffect, useState } from "react";

// Folder-explorer dialog for "Move files" (plan 026). Starts at the current
// folder, lists subfolders only; folder names enter, Up climbs, breadcrumb
// jumps, per-row Move buttons target subfolders, footer Move here targets
// the displayed folder itself.
export default function MoveDialog({ open, items, sourceFolder, heading, onMoveTarget, onClose, onDone }) {
  const names = Array.isArray(items) ? items : [];
  // Browsed location. The parent remounts the dialog (via `key`) on every
  // open, so the initial state is always the menu-click sourceFolder.
  const [cwd, setCwd] = useState(sourceFolder || "");
  const [dirs, setDirs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetchErr, setFetchErr] = useState("");
  const [moving, setMoving] = useState(false);

  // Scroll lock + Escape, same family as MediaContextMenu / ConfirmModal.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // Subfolders of the browsed location.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setFetchErr("");
      try {
        const r = await fetch(`/api/media?folder=${encodeURIComponent(cwd)}`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error((j && j.error) || "load failed");
        if (!cancelled) setDirs((Array.isArray(j.items) ? j.items : []).filter((it) => it && it.dir));
      } catch (e) {
        if (!cancelled) { setDirs([]); setFetchErr(e.message || String(e)); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, cwd]);

  if (!open) return null;

  const crumbs = cwd ? cwd.split("/").filter(Boolean) : [];
  const parentOf = (name) => {
    const s = String(name || "");
    const i = s.lastIndexOf("/");
    return i === -1 ? (sourceFolder || "") : s.slice(0, i);
  };
  // Move here targets the displayed folder: disabled when every item
  // already lives there (the server skips those per-file anyway).
  const allHere = names.length > 0 && names.every((n) => parentOf(n) === cwd);
  const goUp = () => {
    const i = cwd.lastIndexOf("/");
    setCwd(i === -1 ? "" : cwd.slice(0, i));
  };

  const moveInto = async (target) => {
    if (moving) return;
    setMoving(true);
    try {
      // Stack mode: the parent owns the request (POST /api/stacks/:id/move).
      if (onMoveTarget) {
        const j = await onMoveTarget(target);
        onDone(j);
        return;
      }
      const r = await fetch("/api/media/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: sourceFolder || "", target, names }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error((j && j.error) || "move failed");
      onDone(j);
    } catch (e) {
      onDone({ ok: false, moved: 0, results: names.map((n) => ({ name: String(n).split("/").pop(), moved: false, error: e.message || String(e) })) });
    } finally {
      setMoving(false);
    }
  };

  return (
    <div
      data-testid="media-move-dialog"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 130, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "rgba(6,8,18,0.55)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", userSelect: "none", WebkitUserSelect: "none" }}
    >
      <div
        className="media-ctx-card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(480px, 100%)", maxHeight: "calc(100vh - 48px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,.25)" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {heading || `Move ${names.length} item${names.length === 1 ? "" : "s"}`}
          </div>
          <button data-testid="media-move-close" type="button" className="btn btn-sm btn-outline-secondary" onClick={onClose} title="Close" style={{ padding: "2px 8px" }}>
            <i className="bi bi-x-lg" />
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "10px 14px 0" }}>
          <button data-testid="media-move-root" type="button" className={`btn btn-sm ${!cwd ? "btn-primary" : "btn-outline-secondary"}`} disabled={!cwd} onClick={() => setCwd("")}>
            <i className="bi bi-house" /> Media
          </button>
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--muted)" }}>/</span>
              {i === crumbs.length - 1 ? (
                <span data-testid="media-move-crumb-current" className="btn btn-sm btn-primary" style={{ pointerEvents: "none" }}>{c}</span>
              ) : (
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setCwd(crumbs.slice(0, i + 1).join("/"))}>{c}</button>
              )}
            </span>
          ))}
          <button data-testid="media-move-up" type="button" className="btn btn-sm btn-outline-secondary" onClick={goUp} disabled={!cwd} style={{ marginLeft: "auto" }} title="Up one level">
            <i className="bi bi-arrow-90deg-up" /> Up
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 10, fontSize: 13 }}>
          {loading && <div className="small text-muted" style={{ padding: "8px 4px" }}>Loading folders…</div>}
          {!loading && fetchErr && <div className="small text-danger" style={{ padding: "8px 4px" }}>{fetchErr}</div>}
          {!loading && !fetchErr && dirs.length === 0 && (
            <div className="small text-muted" style={{ padding: "8px 4px" }}>No subfolders here</div>
          )}
          {!loading && !fetchErr && dirs.map((d) => (
            <div key={d.name} data-testid="media-move-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6 }}>
              <button
                data-testid="media-move-enter"
                type="button"
                onClick={() => setCwd(cwd ? `${cwd}/${d.name}` : d.name)}
                title={`Open ${d.name}`}
                style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", fontSize: 13, textAlign: "left" }}
              >
                <i className="bi bi-folder-fill" style={{ fontSize: 14, color: "var(--muted)", flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
              </button>
              <button
                data-testid="media-move-into"
                type="button"
                className="btn btn-sm btn-outline-primary"
                disabled={moving}
                onClick={() => moveInto(cwd ? `${cwd}/${d.name}` : d.name)}
                style={{ flexShrink: 0 }}
              >
                Move
              </button>
            </div>
          ))}
        </div>
        <div style={{ padding: 12, display: "flex", gap: 8, justifyContent: "flex-end", background: "var(--surface-2)", borderTop: "1px solid var(--border)" }}>
          <button data-testid="media-move-cancel" type="button" className="btn btn-sm btn-outline-secondary" onClick={onClose} style={{ padding: "6px 14px" }}>
            Cancel
          </button>
          <button
            data-testid="media-move-here"
            type="button"
            className="btn btn-sm btn-primary"
            disabled={moving || allHere}
            onClick={() => moveInto(cwd)}
            title={allHere ? "Items already live here" : `Move into ${cwd || "Media"}`}
            style={{ padding: "6px 14px" }}
          >
            {moving ? "Moving…" : "Move here"}
          </button>
        </div>
      </div>
    </div>
  );
}
