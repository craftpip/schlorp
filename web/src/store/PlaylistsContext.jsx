import { createContext, useContext, useEffect, useState, useCallback } from "react";

const PlaylistsContext = createContext(null);

export function playlistKeyForMedia(folder, rowKey) {
  const fk = String(folder || "").replace(/\/$/, "");
  const rk = String(rowKey || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rk) return "";
  return fk ? `${fk}/${rk}` : rk;
}

export function PlaylistsProvider({ children }) {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/playlists");
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "failed to load playlists");
      setPlaylists(Array.isArray(j.playlists) ? j.playlists : []);
      setError("");
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createPlaylist = useCallback(async (name) => {
    const r = await fetch("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "create failed");
    await refresh();
    return j.playlist;
  }, [refresh]);

  const renamePlaylist = useCallback(async (id, name) => {
    const r = await fetch(`/api/playlists/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "rename failed");
    await refresh();
    return j.playlist;
  }, [refresh]);

  const deletePlaylist = useCallback(async (id) => {
    const r = await fetch(`/api/playlists/${encodeURIComponent(id)}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "delete failed");
    await refresh();
  }, [refresh]);

  const toggleItem = useCallback(async (id, key) => {
    const r = await fetch(`/api/playlists/${encodeURIComponent(id)}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "toggle failed");
    await refresh();
    return j.member;
  }, [refresh]);

  const addItem = useCallback(async (id, key) => {
    const r = await fetch(`/api/playlists/${encodeURIComponent(id)}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "add failed");
    await refresh();
    return j.added;
  }, [refresh]);

  const removeItem = useCallback(async (id, key) => {
    const r = await fetch(`/api/playlists/${encodeURIComponent(id)}/items`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "remove failed");
    await refresh();
    return j.removed;
  }, [refresh]);

  const isMember = useCallback((playlistId, key) => {
    const pl = playlists.find((p) => p.id === playlistId);
    if (!pl) return false;
    return (pl.items || []).includes(key);
  }, [playlists]);

  return (
    <PlaylistsContext.Provider value={{ playlists, loading, error, refresh, createPlaylist, renamePlaylist, deletePlaylist, toggleItem, addItem, removeItem, isMember }}>
      {children}
    </PlaylistsContext.Provider>
  );
}

export function usePlaylists() {
  const v = useContext(PlaylistsContext);
  if (!v) throw new Error("usePlaylists outside provider");
  return v;
}
