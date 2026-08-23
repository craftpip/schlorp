import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

function fmtSize(bytes) {
  if (bytes == null) return "";
  const n = Number(bytes);
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function toMediaUrl(folder, name) {
  const base = folder ? `${folder.replace(/\/$/, "")}/${name}` : name;
  return `/media/${encodeURIComponent(base).replace(/%2F/g, "/")}`;
}
function timeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  if (!d) return "";
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

export default function Media() {
  const [searchParams, setSearchParams] = useSearchParams();
  const folder = searchParams.get("folder") || "";
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");

  const load = async (f) => {
    setLoading(true); setErr("");
    try {
      const r = await fetch(`/api/media?folder=${encodeURIComponent(f)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "failed");
      setItems(j.items || []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(folder); }, [folder]);

  const crumbs = folder ? folder.split("/").filter(Boolean) : [];
  const filtered = (() => {
    const raw = filter.trim();
    if (!raw) return items;
    const isNeg = raw.startsWith("!");
    const term = (isNeg ? raw.slice(1).trim() : raw).toLowerCase();
    if (!term) return items;
    return items.filter((it) => {
      const hit = it.name.toLowerCase().includes(term);
      return isNeg ? !hit : hit;
    });
  })();

  const goFolder = (name) => setSearchParams({ folder: folder ? `${folder}/${name}` : name });
  const goUp = () => {
    if (!folder) return;
    const parts = folder.split("/").filter(Boolean);
    parts.pop();
    const nf = parts.join("/");
    setSearchParams(nf ? { folder: nf } : {});
  };
  const goCrumb = (idx) => {
    const nf = crumbs.slice(0, idx + 1).join("/");
    setSearchParams({ folder: nf });
  };
  const delFile = async (name) => {
    if (!confirm(`Delete "${name}"? This removes the file from /media.`)) return;
    const r = await fetch(`/api/media?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) alert(j.error || "delete failed");
    else load(folder);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}><i className="bi bi-collection-play" style={{ marginRight: 8 }} /> Media library</div>
        <span className="badge text-bg-secondary">{items.length} items</span>
        <span style={{ flex: 1 }} />
        <input className="form-control form-control-sm" style={{ maxWidth: 200, height: 31 }} placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn btn-sm btn-outline-secondary" style={{ height: 31, display: "inline-flex", alignItems: "center" }} onClick={() => load(folder)} disabled={loading}><i className="bi bi-arrow-clockwise" /> Refresh</button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        <button className="btn btn-sm btn-outline-secondary" onClick={() => load("")} disabled={!folder}><i className="bi bi-house" /> Media</button>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--muted)" }}>/</span>
            <button className="btn btn-sm btn-outline-secondary" onClick={() => goCrumb(i)}>{c}</button>
          </span>
        ))}
        {folder && <button className="btn btn-sm btn-outline-secondary" onClick={goUp} style={{ marginLeft: 8 }}><i className="bi bi-arrow-90deg-up" /> Up</button>}
      </div>

      {err && <div className="card" style={{ padding: 12, color: "var(--danger)", marginBottom: 12 }}>{err}</div>}

      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 0, fontSize: 12, fontWeight: 700, color: "var(--muted)", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
            <span>Name</span><span>Size</span><span>Time</span><span style={{ marginLeft: 12 }}>Actions</span>
          </div>
          {loading ? <div style={{ padding: 20, color: "var(--muted)" }}>Loading…</div> : filtered.length === 0 ? <div className="empty" style={{ padding: 20 }}><i className="bi bi-inbox" /> No files — download something!</div> : (
            <div>
              {filtered.map((it) => (
                <div key={it.name} style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 10, alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border)", background: it.dir ? "var(--surface-2)" : "var(--surface)" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                    <i className={`bi ${it.dir ? "bi-folder-fill" : "bi-file-earmark-play"}`} style={{ color: it.dir ? "#f59e0b" : "var(--accent)" }} />
                    {it.dir ? (
                      <button onClick={() => goFolder(it.name)} title={it.name} style={{ background: "none", border: 0, color: "var(--text)", fontWeight: 600, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</button>
                    ) : (
                      <span title={it.name} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{it.name}</span>
                    )}
                  </div>
                  <span className="small" style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtSize(it.size)}</span>
                  <span className="small" style={{ color: "var(--muted)", whiteSpace: "nowrap" }} title={it.mtime ? new Date(it.mtime).toLocaleString() : ""}>{timeAgo(it.mtime)}</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    {it.dir ? (
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => goFolder(it.name)}><i className="bi bi-folder2-open" /> Open</button>
                    ) : (
                      <>
                        <a className="btn btn-sm btn-primary" href={toMediaUrl(folder, it.name)} target="_blank" rel="noopener"><i className="bi bi-box-arrow-up-right" /> Open</a>
                        <button className="btn btn-sm btn-outline-secondary" onClick={() => delFile(it.name)} style={{ color: "var(--muted)", borderColor: "var(--border)" }}><i className="bi bi-trash" style={{ color: "#f87171" }} /> Delete</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
