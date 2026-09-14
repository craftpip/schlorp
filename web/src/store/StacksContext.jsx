import { createContext, useContext, useState, useCallback } from "react";

const StacksContext = createContext(null);

function folderKey(folder) {
  return String(folder || "").trim().replace(/\/+$/, "");
}

export function StacksProvider({ children }) {
  const [stacksByFolder, setStacksByFolder] = useState({}); // folderKey → stacks[]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async (folder) => {
    const fk = folderKey(folder);
    try {
      const r = await fetch(`/api/stacks?folder=${encodeURIComponent(fk)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "failed to load stacks");
      const stacks = Array.isArray(j.stacks) ? j.stacks : [];
      setStacksByFolder((prev) => ({ ...prev, [fk]: stacks }));
      setError("");
      return stacks;
    } catch (e) {
      setError(e.message || String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const createStack = useCallback(async ({ name, folder, items }) => {
    const r = await fetch("/api/stacks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, folder: folderKey(folder), items }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "create failed");
    await refresh(folder);
    return j.stack;
  }, [refresh]);

  const renameStack = useCallback(async (id, name, folder) => {
    const r = await fetch(`/api/stacks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, folder: folderKey(folder) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "rename failed");
    await refresh(folder);
    return j.stack;
  }, [refresh]);

  const deleteStack = useCallback(async (id, folder) => {
    const r = await fetch(`/api/stacks/${encodeURIComponent(id)}?folder=${encodeURIComponent(folderKey(folder))}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "delete failed");
    await refresh(folder);
  }, [refresh]);

  const addItems = useCallback(async (id, keys, folder) => {
    const r = await fetch(`/api/stacks/${encodeURIComponent(id)}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys, folder: folderKey(folder) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "add failed");
    await refresh(folder);
    return j.added || 0;
  }, [refresh]);

  const removeItems = useCallback(async (id, keys, folder) => {
    const r = await fetch(`/api/stacks/${encodeURIComponent(id)}/items`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys, folder: folderKey(folder) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "remove failed");
    await refresh(folder);
    return j.removed || 0;
  }, [refresh]);

  const stacksForFolder = useCallback((folder) => {
    return stacksByFolder[folderKey(folder)] || [];
  }, [stacksByFolder]);

  return (
    <StacksContext.Provider value={{ stacksByFolder, loading, error, refresh, createStack, renameStack, deleteStack, addItems, removeItems, stacksForFolder }}>
      {children}
    </StacksContext.Provider>
  );
}

export function useStacks() {
  const v = useContext(StacksContext);
  if (!v) throw new Error("useStacks outside provider");
  return v;
}