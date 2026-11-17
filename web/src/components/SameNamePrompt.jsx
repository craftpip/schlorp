import { useEffect, useState, useSyncExternalStore } from "react";

// "A file with this name is already there" — shared by uploads and moves.
// Callers `await askSameName({...})` and get "replace" | "keep" | "skip";
// they keep working on other files meanwhile (the queue never stops), and
// the popup walks through the open questions one at a time. "Do the same
// for the rest" answers every waiting and later question of that kind until
// the batch ends (endSameNameBatch).

const store = { queue: [], all: { upload: null, move: null }, listeners: new Set() };
let snapshot = { queue: store.queue };
function emit() { snapshot = { queue: store.queue }; for (const l of store.listeners) l(); }
function subscribe(l) { store.listeners.add(l); return () => store.listeners.delete(l); }

export function askSameName(q) {
  const kind = q.kind === "move" ? "move" : "upload";
  if (store.all[kind]) return Promise.resolve(store.all[kind]);
  return new Promise((resolve) => {
    store.queue = [...store.queue, { ...q, kind, id: Math.random().toString(36).slice(2), resolve }];
    emit();
  });
}
function answer(id, choice, forAll) {
  const item = store.queue.find((x) => x.id === id);
  if (!item) return;
  const done = forAll ? store.queue.filter((x) => x.kind === item.kind) : [item];
  if (forAll) store.all[item.kind] = choice;
  store.queue = store.queue.filter((x) => !done.includes(x));
  emit();
  for (const x of done) x.resolve(choice);
}
// A batch (upload queue drained, move finished): "for the rest" resets.
export function endSameNameBatch(kind) { store.all[kind === "move" ? "move" : "upload"] = null; }
export function pendingSameName(kind) { return store.queue.filter((x) => x.kind === kind).length; }

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtTime(ms) {
  if (!Number.isFinite(ms) || !ms) return "";
  try { return new Date(ms).toLocaleString(); } catch { return ""; }
}

export default function SameNamePrompt() {
  const { queue } = useSyncExternalStore(subscribe, () => snapshot);
  const cur = queue[0] || null;
  const sameKind = cur ? queue.filter((x) => x.kind === cur.kind).length : 0;
  const [forAll, setForAll] = useState(false);
  useEffect(() => { setForAll(false); }, [cur && cur.id]);
  useEffect(() => {
    if (!cur) return;
    // Capture on window: the popup sits over other dialogs (Move…), whose
    // own Escape must not fire too.
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); answer(cur.id, "skip", false); return; }
      // Keys meant for the page (WASD, delete…) don't leak through the popup.
      if (!["Tab", "Enter", " "].includes(e.key)) e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cur]);
  if (!cur) return null;
  const ex = cur.existing || {};
  const inc = cur.incoming || {};
  const sameSize = Number.isFinite(ex.size) && ex.size === inc.size;
  const where = cur.folder ? `“${cur.folder}”` : "Media (root)";
  const verb = cur.kind === "move" ? "Moving" : "Uploading";
  const col = (label, f) => (
    <div style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>{label}</div>
      <div style={{ fontSize: 13, marginTop: 2 }}>{fmtBytes(f.size)}</div>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>{fmtTime(f.mtime)}</div>
    </div>
  );
  const btn = (choice, label, cls, testid) => (
    <button type="button" data-testid={testid} className={`btn btn-sm ${cls}`} onClick={() => answer(cur.id, choice, forAll)}>{label}</button>
  );
  return (
    <div data-testid="same-name-prompt" style={{ position: "fixed", inset: 0, zIndex: 150, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(6,8,18,0.45)" }}>
      <div className="media-ctx-card" style={{ width: "min(440px, 100%)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,.3)", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, display: "flex", gap: 8, alignItems: "flex-start" }}>
            <i className="bi bi-files" style={{ color: "#f59e0b" }} />
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>“{cur.name}” is already in {where}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            {verb} continues with the other files while you decide.{sameSize ? " Both are the same size — probably the same file." : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {col("Already there", ex)}
          {col(cur.kind === "move" ? "Being moved" : "Being uploaded", inc)}
        </div>
        {sameKind > 1 && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
            <input data-testid="same-name-all" type="checkbox" checked={forAll} onChange={(e) => setForAll(e.target.checked)} />
            Do the same for the other {sameKind - 1} file{sameKind - 1 === 1 ? "" : "s"} with a taken name
          </label>
        )}
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {btn("skip", "Skip", "btn-outline-secondary", "same-name-skip")}
          {btn("keep", "Keep both", "btn-outline-primary", "same-name-keep")}
          {btn("replace", "Replace", "btn-danger", "same-name-replace")}
        </div>
      </div>
    </div>
  );
}
