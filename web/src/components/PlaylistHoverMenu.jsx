import { useState } from "react";
import { usePlaylists } from "../store/PlaylistsContext.jsx";

export default function PlaylistHoverMenu({ mediaKey, placement = "right", onCreated }) {
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
        width: 260,
        maxHeight: 320,
        display: "flex",
        flexDirection: "column",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,.18)",
        overflow: "hidden",
        fontSize: 13,
      }}
    >
      <div style={{ padding: "8px 10px", fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: ".04em", textTransform: "uppercase", borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
        Add to playlist
      </div>
      <div style={{ overflowY: "auto", maxHeight: 180, padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>
        {playlists.length === 0 ? (
          <div style={{ padding: "10px 8px", color: "var(--muted)", fontSize: 12, textAlign: "center" }}>No playlists yet — create one below.</div>
        ) : (
          playlists.map((pl) => {
            const member = isMember(pl);
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
                  gap: 8,
                  padding: "7px 8px",
                  borderRadius: 8,
                  border: 0,
                  background: member ? "rgba(99,102,241,.12)" : "transparent",
                  color: "var(--text)",
                  cursor: "pointer",
                  textAlign: "left",
                  width: "100%",
                }}
              >
                <i className={`bi ${member ? "bi-check-circle-fill" : "bi-circle"}`} style={{ color: member ? "#6366f1" : "var(--muted)", fontSize: 14, flex: "0 0 auto" }} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: member ? 600 : 500 }} title={pl.name}>
                  {pl.name}
                </span>
                <span style={{ fontSize: 11, color: "var(--muted)", flex: "0 0 auto" }}>· {pl.count ?? (pl.items ? pl.items.length : 0)}</span>
              </button>
            );
          })
        )}
      </div>
      <div style={{ padding: 8, borderTop: "1px solid var(--border)", background: "var(--surface-2)", display: "flex", gap: 6, alignItems: "center" }}>
        <input
          data-testid="playlist-menu-new-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleCreate(); } }}
          placeholder="New playlist…"
          maxLength={60}
          style={{ flex: 1, minWidth: 0, padding: "6px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 12 }}
        />
        <button
          data-testid="playlist-menu-create-btn"
          type="button"
          onClick={handleCreate}
          disabled={creating || !String(draft || "").trim()}
          className="btn btn-sm btn-primary"
          style={{ padding: "6px 10px", fontSize: 12, whiteSpace: "nowrap" }}
        >
          {creating ? "..." : "Create"}
        </button>
      </div>
      {err && <div style={{ padding: "6px 10px", color: "#ef4444", fontSize: 11, background: "rgba(239,68,68,.08)" }}>{err}</div>}
      <div style={{ padding: "4px 8px", fontSize: 10, color: "var(--muted)", textAlign: "center", borderTop: "1px solid var(--border)" }} title={mediaKey}>
        {mediaKey ? mediaKey.split("/").pop() : ""}
      </div>
    </div>
  );
}
