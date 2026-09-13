import { useState } from "react";
import { usePlaylists } from "../store/PlaylistsContext.jsx";

export default function PlaylistHoverMenu({ mediaKey, placement = "right", onCreated, showIndex = false }) {
  const { playlists, createPlaylist, toggleItem } = usePlaylists();
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  const [toggling, setToggling] = useState(null);

  const handleToggle = async (pl) => {
    if (!mediaKey) return;
    setToggling(pl.id);
    setErr("");
    try {
      await toggleItem(pl.id, mediaKey);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setToggling(null);
    }
  };

  const handleCreate = async () => {
    const name = String(draft || "").trim();
    if (!name) return;
    setCreating(true);
    setErr("");
    try {
      const pl = await createPlaylist(name);
      setDraft("");
      if (pl && mediaKey) {
        // auto-add to new playlist
        try { await toggleItem(pl.id, mediaKey); } catch {}
      }
      if (onCreated) onCreated(pl);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setCreating(false);
    }
  };

  const isMember = (pl) => (pl.items || []).includes(mediaKey);

  return (
    <div
      data-testid="playlist-hover-menu"
      onClick={(e) => e.stopPropagation()}
      style={{
        width: 200,
        maxHeight: 260,
        display: "flex",
        flexDirection: "column",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 6px 18px rgba(0,0,0,.16)",
        overflow: "hidden",
        fontSize: 12,
      }}
    >
      <div style={{ overflowY: "auto", maxHeight: 150, padding: 4, display: "flex", flexDirection: "column", gap: 1 }}>
        {playlists.length === 0 ? (
          <div style={{ padding: "10px 8px", color: "var(--muted)", fontSize: 12, textAlign: "center" }}>No playlists yet — create one below.</div>
        ) : (
          playlists.map((pl, idx) => {
            const member = isMember(pl);
            const num = showIndex && idx < 9 ? idx + 1 : null;
            return (
              <button
                key={pl.id}
                data-testid={`playlist-menu-item-${pl.id}`}
                type="button"
                onClick={() => handleToggle(pl)}
                disabled={toggling === pl.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 6px",
                  borderRadius: 6,
                  border: 0,
                  background: member ? "rgba(99,102,241,.12)" : "transparent",
                  color: "var(--text)",
                  cursor: "pointer",
                  textAlign: "left",
                  width: "100%",
                }}
              >
                {num != null ? (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px", flex: "0 0 auto", lineHeight: 1.5 }}>{num}</span>
                ) : (
                  <i className={`bi ${member ? "bi-check-circle-fill" : "bi-circle"}`} style={{ color: member ? "#6366f1" : "var(--muted)", fontSize: 12, flex: "0 0 auto" }} />
                )}
                {num != null && <i className={`bi ${member ? "bi-check-circle-fill" : "bi-circle"}`} style={{ color: member ? "#6366f1" : "var(--muted)", fontSize: 12, flex: "0 0 auto" }} />}
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: member ? 600 : 500, fontSize: 12 }} title={pl.name}>
                  {pl.name}
                </span>
                <span style={{ fontSize: 10, color: "var(--muted)", flex: "0 0 auto" }}>· {pl.count ?? (pl.items ? pl.items.length : 0)}</span>
              </button>
            );
          })
        )}
      </div>
      <div style={{ padding: 4, borderTop: "1px solid var(--border)", background: "var(--surface-2)", display: "flex", gap: 4, alignItems: "center" }}>
        <input
          data-testid="playlist-menu-new-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleCreate(); } }}
          placeholder="New playlist…"
          maxLength={60}
          style={{ flex: 1, minWidth: 0, padding: "4px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 11 }}
        />
        <button
          data-testid="playlist-menu-create-btn"
          type="button"
          onClick={handleCreate}
          disabled={creating || !String(draft || "").trim()}
          className="btn btn-sm btn-primary"
          style={{ padding: "4px 8px", fontSize: 11, whiteSpace: "nowrap" }}
        >
          {creating ? "..." : "Create"}
        </button>
      </div>
      {err && <div style={{ padding: "4px 6px", color: "#ef4444", fontSize: 10, background: "rgba(239,68,68,.08)" }}>{err}</div>}
    </div>
  );
}
