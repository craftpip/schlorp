import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function Saved() {
  const [accounts, setAccounts] = useState([]);
  const [lists, setLists] = useState([]);
  const [pending, setPending] = useState([]);
  const [completed, setCompleted] = useState([]);
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [account, setAccount] = useState("default");
  const [crawlProgress, setCrawlProgress] = useState({});
  const [schedule, setSchedule] = useState("30m");
  const [editingIdx, setEditingIdx] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editLastSeenUrl, setEditLastSeenUrl] = useState("");
  const [globalBusy, setGlobalBusy] = useState(null);
  const [msg, setMsg] = useState("");
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = (t) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };

  const [listsState, setListsState] = useState({});
  const onCrawlAndDownloadAll = async () => {
    setGlobalBusy("crawl");
    for (let i = 0; i < lists.length; i++) { await onCrawl(i, { isBatch: true }); }
    // re-read pending after crawls
    const fresh = await fetch("/sync-config").then((r) => r.json()).then((j) => j.queue?.pending || []).catch(() => []);
    if (!fresh.length) { setGlobalBusy(null); return; }
    setGlobalBusy("download");
    const byFolder = {};
    for (const p of fresh) { const f = p.folder || ""; (byFolder[f] = byFolder[f] || []).push(p.url); }
    for (const [f, us] of Object.entries(byFolder)) { await fetch("/queue/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: us, folder: f }) }); }
    for (const p of fresh) { await fetch("/sync-queue/pending/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: p.url }) }); }
    showToast("Download has been queued"); load(); setGlobalBusy(null); setTimeout(() => navigate("/dashboard"), 900);
  };
  const onCrawlAndDownload = async (idx) => {
    await onCrawl(idx);
    await onDownload(idx);
  };
  const load = async () => {
    try {
      const r = await fetch("/sync-config");
      const j = await r.json();
      if (j.ok) {
        setLists(j.config?.savedLists || []);
        setPending(j.queue?.pending || []);
        setCompleted(j.queue?.completed || []);
        setListsState(j.lists || {});
      }
      const ar = await fetch("/accounts").then((x) => x.json());
      if (ar.ok) setAccounts(ar.accounts || []);
    } catch {}
  };
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "crawl:progress" && m.url) {
          setCrawlProgress((prev) => ({ ...prev, [m.url]: { stage: m.stage, detail: m.detail, count: m.count } }));
          if (m.stage === "done") setTimeout(() => setCrawlProgress((prev) => { const n = { ...prev }; delete n[m.url]; return n; }), 4000);
        }
      } catch {}
    };
    return () => ws.close();
  }, []);

  const onCrawlAll = async () => {
    setGlobalBusy("crawl");
    let chain = Promise.resolve();
    for (let i = 0; i < lists.length; i++) {
      chain = chain.then(() => onCrawl(i, { isBatch: true }));
    }
    await chain;
    setGlobalBusy(null);
  };
  const onDownloadAll = async () => { if (!pending.length) return; setGlobalBusy("download"); const byFolder = {}; for (const p of pending) { const f = p.folder || ""; (byFolder[f] = byFolder[f] || []).push(p.url); } for (const [f, us] of Object.entries(byFolder)) { await fetch("/queue/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: us, folder: f }) }); } for (const p of pending) { await fetch("/sync-queue/pending/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: p.url }) }); }
    showToast("Download has been queued"); load(); setGlobalBusy(null); setTimeout(() => navigate("/dashboard"), 900); };
  const [busyIdx, setBusyIdx] = useState(null);
  const startEdit = (idx) => {
    const l = lists[idx];
    const st = listsState[l.url] || {};
    setUrl(l.url || ""); setFolder(l.folder || ""); setAccount(l.account || "default"); setSchedule(l.schedule || "30m"); setEditLastSeenUrl(st.lastSeenUrl || ""); setEditingIdx(idx); setShowAdd(false);
  };
  const cancelEdit = () => { setEditingIdx(null); setShowAdd(false); setUrl(""); setFolder(""); setAccount("default"); setSchedule("30m"); setEditLastSeenUrl(""); };
  const crawlInProgress = (skipIdx, opts = {}) =>
    (!opts.isBatch && globalBusy === "crawl") ||
    (!!busyIdx && String(busyIdx).startsWith("crawl-") && busyIdx !== skipIdx) ||
    Object.values(crawlProgress).some((p) => p && p.stage !== "done");

  const onCrawl = async (idx, opts = {}) => {
    if (crawlInProgress(`crawl-${idx}`, opts)) { showToast("Another crawl is currently in progress"); return; }
    const l = lists[idx];
    setBusyIdx(`crawl-${idx}`); setMsg("");
    try {
      // Server reads the lastSeen marker itself, queues new items and advances
      // the marker — this request is the whole crawl → queue step.
      const res = await fetch("/scan-saved", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: l.url, account: l.account || "default", folder: l.folder || "" }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "crawl failed");
      setMsg(`Crawled ${j.totalUrls} · queued ${j.queued ?? 0} new${j.skippedPending ? ` · ${j.skippedPending} already in queue` : ""}`);
      load();
    } catch (e) { setMsg(e.message); }
    finally { setBusyIdx(null); setCrawlProgress((prev) => { const n = { ...prev }; delete n[l.url]; return n; }); }
  };
  const formatCrawlDetail = (d) => {
    const s = String(d || "");
    const m = s.match(/urls\s*=\s*(\d+).*matchedStopUrls\s*=\s*(\d+).*iterations\s*=\s*(\d+).*reason\s*=\s*([a-z_]+)/i);
    if (m) {
      const urls = m[1], matched = m[2], iter = m[3], reason = m[4];
      const reasonText = reason === "stop_url_found" ? "stopped at last seen" : reason.replace(/_/g, " ");
      return `Found ${urls} · ${matched} matched · ${iter} page${iter === "1" ? "" : "s"} · ${reasonText}`;
    }
    return s;
  };
  const navigate = useNavigate();
  const onDownload = async (idx) => {
    const l = lists[idx];
    const folder = l.folder || "";
    const pendingForFolder = pending.filter((p) => (p.folder || "") === folder);
    if (!pendingForFolder.length) { setMsg(`No pending for ${folder || "—"}`); return; }
    setBusyIdx(`dl-${idx}`);
    try {
      const urls = pendingForFolder.map((p) => p.url);
      await fetch("/queue/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls, folder }) });
      // remove from sync pending after enqueue — only this folder's items
      for (const u of urls) {
        await fetch("/sync-queue/pending/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: u }) });
      }
      showToast("Download has been queued"); load(); setTimeout(() => navigate("/dashboard"), 900);
    } catch (e) { setMsg(e.message); }
    finally { setBusyIdx(null); }
  };
  const onAddList = async (e) => {
    e.preventDefault();
    setMsg("");
    const entry = { url: url.trim(), folder: folder.trim(), account: account.trim() || "default", schedule: schedule.trim() || "30m" };
    const nextLists = editingIdx !== null ? lists.map((l, i) => i === editingIdx ? entry : l) : [...lists, entry];
    const body = { savedLists: nextLists };
    // need to send full config: accounts + savedLists
    const r = await fetch("/accounts").then((x) => x.json()).catch(() => ({ accounts: [] }));
    const cfgRes = await fetch("/sync-config").then((x) => x.json()).catch(() => ({}));
    const allAccounts = cfgRes.config?.accounts || [];
    const res = await fetch("/sync-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: allAccounts, savedLists: body.savedLists }) });
    const j = await res.json();
    if (!res.ok) { setMsg(j.error || "failed"); return; }
    // save lastSeen if editing
    if (editingIdx !== null) {
      const targetUrl = lists[editingIdx]?.url || url.trim();
      const newLastSeen = editLastSeenUrl.trim();
      try {
        if (newLastSeen) {
          await fetch("/collections/set-last-seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: targetUrl, lastSeenUrl: newLastSeen }) });
        } else {
          await fetch("/collections/clear-memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: targetUrl }) });
        }
      } catch {}
    }
    setMsg(editingIdx !== null ? "List updated ✓" : "List added ✓");
    setUrl(""); setFolder(""); setAccount("default"); setSchedule("30m"); setEditLastSeenUrl("");
    setEditingIdx(null); setShowAdd(false);
    load();
    setTimeout(() => setMsg(""), 3000);
  };
  const onRemoveList = async (idx) => {
    const next = lists.filter((_, i) => i !== idx);
    const cfg = await fetch("/sync-config").then((x) => x.json());
    await fetch("/sync-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: cfg.config?.accounts || [], savedLists: next }) });
    load();
  };
  const onAddQueue = async (e) => {
    e.preventDefault();
    const urls = queueUrls.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!urls.length) return;
    await fetch("/sync-queue/pending/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls, folder: queueFolder }) });
    setQueueUrls(""); load();
  };
  const onRemovePending = async (u) => {
    await fetch("/sync-queue/pending/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: u }) });
    load();
  };
  const onClearCompleted = async () => {
    await fetch("/sync-queue/clear", { method: "POST" });
    load();
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}><i className="bi bi-bookmark-star" style={{ marginRight: 8 }} />Collections</div>
        <span className="badge text-bg-secondary">{lists.length} lists</span>
        <span className="badge text-bg-secondary">{pending.length} pending</span>
        <span style={{ flex: 1 }} />
        {!showAdd ? (
          <button type="button" className="btn btn-primary" onClick={() => { if (editingIdx !== null) cancelEdit(); setShowAdd(true); }}><i className="bi bi-plus-lg" /> Add collection</button>
        ) : (
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setShowAdd(false)}><i className="bi bi-x-lg" /> Close</button>
        )}
      </div>
      {showAdd && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 16, background: "var(--surface)", marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Add collection</div>
          <form onSubmit={onAddList} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <label className="form-label">Collection URL</label>
              <input className="form-control" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.instagram.com/username/saved/list/123/" required />
            </div>
            <div>
              <label className="form-label">Folder</label>
              <input className="form-control" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. favorites" />
            </div>
            <div>
              <label className="form-label">Account</label>
              <select className="form-control" value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="default">default</option>
                {accounts.filter((a) => a.name !== "default").map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Sync every</label>
              <select className="form-control" value={schedule} onChange={(e) => setSchedule(e.target.value)}>
                <option value="5m">5 min</option>
                <option value="15m">15 min</option>
                <option value="30m">30 min</option>
                <option value="1h">1 hour</option>
                <option value="6h">6 hours</option>
                <option value="12h">12 hours</option>
                <option value="24h">24 hours</option>
                <option value="2d">2 days</option>
                <option value="3d">3 days</option>
                <option value="7d">7 days</option>
                <option value="14d">14 days</option>
                <option value="30d">30 days</option>
                <option value="manual">Manual only</option>
              </select>
            </div>
            <button type="submit" className="btn btn-primary" style={{ height: 38, alignSelf: "flex-end" }}><i className="bi bi-check-lg" /> Add</button>
          </form>
          {msg && <div style={{ marginTop: 8, color: msg.includes("✓") ? "var(--success)" : "var(--danger)", fontSize: 13 }}>{msg}</div>}
        </div>
      )}

      <div style={{ display: "grid", gap: 16 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600 }}>Configured lists</div>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onCrawlAll} disabled={globalBusy === "crawl" || !lists.length}><i className="bi bi-search" /> {globalBusy === "crawl" ? "Crawling all…" : "Crawl all"}</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={onDownloadAll} disabled={globalBusy === "download" || !pending.length}><i className="bi bi-download" /> {globalBusy === "download" ? "…" : `Download all${pending.length ? ` (${pending.length})` : ""}`}</button>
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onCrawlAndDownloadAll} disabled={!!globalBusy || !lists.length}><i className="bi bi-arrow-repeat" /> Crawl & Download all</button>
          </div>
          {lists.length === 0 ? <div className="empty"><i className="bi bi-inbox" /> No lists — add one above.</div> : (
            <div style={{ display: "grid", gap: 8 }}>
              {lists.map((l, i) => {
                const st = listsState[l.url] || {};
                const pendingForFolder = pending.filter((p) => (p.folder || "") === (l.folder || "")).length;
                const timeAgo = (() => {
                  if (!st.lastRunAt) return "never crawled";
                  const diff = Date.now() - new Date(st.lastRunAt).getTime();
                  const m = Math.floor(diff / 60000);
                  if (m < 1) return "just now";
                  if (m < 60) return `${m}m ago`;
                  const h = Math.floor(m / 60);
                  if (h < 24) return `${h}h ago`;
                  const d = Math.floor(h / 24);
                  return `${d}d ago`;
                })();
                return (
                  <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 12, background: "var(--surface)" }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, wordBreak: "break-all" }}>{l.url}</div>
                        <div style={{ fontSize: 13, color: "var(--muted)" }}>folder: {l.folder || "—"} · account: {l.account || "default"} · every: {l.schedule || "30m"}</div>
                      </div>
                      <div style={{ textAlign: "right", minWidth: 110, flexShrink: 0 }}>
                        <div><span className="badge text-bg-secondary">{pendingForFolder} pending</span></div>
                        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{timeAgo}</div>
                      </div>
                    </div>
                    {crawlProgress[l.url] && (
                      <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 600, marginTop: 8, display: "flex", gap: 8, alignItems: "center", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px" }}>
                        <span className="badge text-bg-primary" style={{ fontSize: 10 }}>live</span>
                        {formatCrawlDetail(crawlProgress[l.url].detail)} {crawlProgress[l.url].count != null ? `· ${crawlProgress[l.url].count} items` : ""}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => onCrawl(i)} disabled={busyIdx === `crawl-${i}`}><i className="bi bi-search" /> {busyIdx === `crawl-${i}` ? "Crawling…" : "Crawl"}</button>
                      {pendingForFolder > 0 && <button className="btn btn-sm btn-primary" onClick={() => onDownload(i)} disabled={busyIdx === `dl-${i}`}><i className="bi bi-download" /> {busyIdx === `dl-${i}` ? "…" : `Download (${pendingForFolder})`}</button>}
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => onCrawlAndDownload(i)} disabled={!!busyIdx}><i className="bi bi-arrow-repeat" /> Crawl & Download</button>
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => editingIdx === i ? cancelEdit() : startEdit(i)}><i className={editingIdx === i ? "bi bi-x-lg" : "bi bi-pencil"} /> {editingIdx === i ? "Close edit" : "Edit"}</button>
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => onRemoveList(i)}><i className="bi bi-x-lg" /> Remove</button>
                    </div>
                    {editingIdx === i && (
                      <div style={{ marginTop: 14, padding: 14, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10 }}>
                        <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>Edit collection</div>
                        <form onSubmit={onAddList} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                          <div style={{ flex: 1, minWidth: 200 }}>
                            <label className="form-label">Collection URL</label>
                            <input className="form-control" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.instagram.com/username/saved/list/123/" required />
                          </div>
                          <div>
                            <label className="form-label">Folder</label>
                            <input className="form-control" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. favorites" />
                          </div>
                          <div>
                            <label className="form-label">Account</label>
                            <select className="form-control" value={account} onChange={(e) => setAccount(e.target.value)}>
                              <option value="default">default</option>
                              {accounts.filter((a) => a.name !== "default").map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="form-label">Sync every</label>
                            <select className="form-control" value={schedule} onChange={(e) => setSchedule(e.target.value)}>
                              <option value="5m">5 min</option>
                              <option value="15m">15 min</option>
                              <option value="30m">30 min</option>
                              <option value="1h">1 hour</option>
                              <option value="6h">6 hours</option>
                              <option value="12h">12 hours</option>
                              <option value="24h">24 hours</option>
                              <option value="2d">2 days</option>
                              <option value="3d">3 days</option>
                              <option value="7d">7 days</option>
                              <option value="14d">14 days</option>
                              <option value="30d">30 days</option>
                              <option value="manual">Manual only</option>
                            </select>
                          </div>
                          <button type="submit" className="btn btn-primary" style={{ height: 38, alignSelf: "flex-end" }}><i className="bi bi-check-lg" /> Update</button>
                        </form>
                        <div style={{ marginTop: 12 }}>
                          <label className="form-label">Last seen URL <span style={{ color: "var(--faint)", fontWeight: 400 }}>(where next crawl stops)</span></label>
                          <input className="form-control" value={editLastSeenUrl} onChange={(e) => setEditLastSeenUrl(e.target.value)} placeholder="https://www.instagram.com/p/XXXX/ — leave empty to scan all" />
                          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Current: {st.lastSeenUrl || "— none —"} · {st.lastScannedCount ?? 0} posts · {st.lastRunAt ? new Date(st.lastRunAt).toLocaleString() : "never"}</div>
                        </div>
                        <div style={{ marginTop: 10, padding: 10, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Last crawled memory</div>
                          <div style={{ fontSize: 11, color: "var(--muted)", wordBreak: "break-all" }}>{st.lastSeenUrl || "— none —"}</div>
                          <button type="button" className="btn btn-sm btn-outline-danger" style={{ marginTop: 8 }} onClick={async () => { await fetch("/collections/clear-memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: l.url }) }); setMsg("Memory cleared ✓ — next crawl scans all"); load(); }}><i className="bi bi-trash" /> Clear memory (scan all next time)</button>
                        </div>
                        {msg && <div style={{ marginTop: 8, color: msg.includes("✓") ? "var(--success)" : "var(--danger)", fontSize: 13 }}>{msg}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ fontWeight: 600 }}>Sync queue</div>
            <span className="badge text-bg-secondary">{pending.length} pending</span>
            <span style={{ flex: 1 }} />
          </div>
          {pending.length === 0 ? <div className="empty"><i className="bi bi-inbox" /> Nothing pending — crawl a collection first.</div> : pending.map((it, idx) => (
            <div key={idx} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, background: "var(--surface)", display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <div style={{ flex: 1, fontSize: 12, wordBreak: "break-all" }}>{it.url}</div>
              <span className="small" style={{ color: "var(--muted)" }}>{it.folder || ""}</span>
              <button className="btn btn-sm btn-outline-secondary" onClick={() => onRemovePending(it.url)}><i className="bi bi-x-lg" /></button>
            </div>
          ))}
        </div>
      </div>
      {toast && (
        <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 1050, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 22px", boxShadow: "0 8px 30px rgba(0,0,0,.45)", fontWeight: 600, fontSize: 14, maxWidth: "80vw" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
