const fs = require("fs/promises");
const path = require("path");
const { EventEmitter } = require("events");

const QUEUE_FILE = path.resolve(__dirname, ".queue.json");

let state = { active: [], completed: [] };
let saveTimer = null;
let workerRunning = false;
const emitter = new EventEmitter();

// broadcast injected from api-server
let broadcast = () => {};
let getBrowser = null;
let runDownload = null;
let resolveMediaOutputDir = null;
let resolveMaxQuality = null;

function setDeps(deps) {
  broadcast = deps.broadcast || broadcast;
  getBrowser = deps.getBrowser;
  runDownload = deps.runDownload;
  resolveMediaOutputDir = deps.resolveMediaOutputDir;
  resolveMaxQuality = deps.resolveMaxQuality;
}

async function loadQueue() {
  try {
    const raw = await fs.readFile(QUEUE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      state.active = Array.isArray(parsed.active) ? parsed.active : [];
      state.completed = Array.isArray(parsed.completed) ? parsed.completed : [];
      // migrate old .download-queue pending/completed? not needed
      // reset stale running → error
      let migrated = false;
      for (const it of state.active) {
        if (it.status === "running") {
          it.status = "error";
          it.stage = "error";
          it.error = "Interrupted — server restarted. Hit Retry.";
          it.finishedAt = new Date().toISOString();
          migrated = true;
        }
        if (!it.stage) it.stage = it.status;
        if (!Array.isArray(it.logs)) it.logs = [];
      }
      if (migrated) await saveQueue();
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.error("[queue] load failed:", e.message);
    state = { active: [], completed: [] };
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fs.mkdir(path.dirname(QUEUE_FILE), { recursive: true });
      await fs.writeFile(QUEUE_FILE, JSON.stringify(state, null, 2), "utf8");
    } catch (e) {
      console.error("[queue] save failed:", e.message);
    }
  }, 200);
}

async function saveQueue() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    await fs.mkdir(path.dirname(QUEUE_FILE), { recursive: true });
    await fs.writeFile(QUEUE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("[queue] save failed:", e.message);
  }
}

function snapshot() {
  return {
    active: state.active.map(sanitizeItem),
    completed: state.completed.map(sanitizeItem),
  };
}

function sanitizeItem(it) {
  return {
    id: it.id,
    url: it.url,
    folder: it.folder || "",
    maxQuality: it.maxQuality ?? null,
    status: it.status,
    stage: it.stage || it.status,
    progress: it.progress ?? 0,
    error: it.error || null,
    filePath: it.filePath || null,
    filePaths: it.filePaths || [],
    createdAt: it.createdAt,
    startedAt: it.startedAt || null,
    finishedAt: it.finishedAt || null,
    logs: (it.logs || []).slice(-200),
  };
}

function broadcastSnapshot() {
  broadcast({ type: "queue:snapshot", data: snapshot() });
}

function broadcastActive() {
  broadcast({ type: "active:update", data: state.active.map(sanitizeItem) });
  broadcast({ type: "queue:snapshot", data: snapshot() });
}
function broadcastCompleted() {
  broadcast({ type: "completed:update", data: state.completed.map(sanitizeItem) });
  broadcast({ type: "queue:snapshot", data: snapshot() });
}

function addItems(urls, folder, maxQuality) {
  const now = Date.now();
  const added = [];
  for (let i = 0; i < urls.length; i++) {
    const url = String(urls[i] || "").trim();
    if (!url) continue;
    try { new URL(url); } catch { continue; }
    // dedupe in active + completed by url
    const exists = state.active.some(x => x.url === url) || state.completed.some(x => x.url === url && x.status === "done");
    if (exists) continue;
    const id = `${now}-${i}-${Math.random().toString(36).slice(2,6)}`;
    const item = {
      id,
      url,
      folder: String(folder || "").trim(),
      maxQuality: maxQuality ?? null,
      status: "queued",
      stage: "queued",
      progress: 0,
      logs: [],
      filePaths: [],
      createdAt: new Date().toISOString(),
    };
    state.active.push(item);
    added.push(item);
  }
  if (added.length) {
    scheduleSave();
    broadcastSnapshot();
    emitter.emit("added");
    ensureWorker();
  }
  return added;
}

function removeActive(id) {
  const idx = state.active.findIndex(x => x.id === id);
  if (idx === -1) return false;
  const it = state.active[idx];
  if (it.status === "running") return false; // cannot remove running
  state.active.splice(idx, 1);
  scheduleSave();
  broadcastSnapshot();
  return true;
}

function removeCompleted(id) {
  const idx = state.completed.findIndex(x => x.id === id);
  if (idx === -1) return false;
  state.completed.splice(idx, 1);
  scheduleSave();
  broadcastCompleted();
  return true;
}

function retryCompleted(id) {
  const idx = state.completed.findIndex(x => x.id === id);
  if (idx === -1) return null;
  const it = state.completed[idx];
  if (it.status !== "error" && it.status !== "done") return null;
  state.completed.splice(idx, 1);
  const newItem = {
    ...it,
    id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    status: "queued",
    stage: "queued",
    progress: 0,
    error: null,
    filePath: null,
    filePaths: [],
    logs: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
  state.active.push(newItem);
  scheduleSave();
  broadcastSnapshot();
  emitter.emit("added");
  ensureWorker();
  return newItem;
}

function retryActiveFailed(id) {
  const it = state.active.find(x => x.id === id);
  if (!it || it.status !== "error") return null;
  it.status = "queued";
  it.stage = "queued";
  it.progress = 0;
  it.error = null;
  it.logs = [];
  scheduleSave();
  broadcastActive();
  emitter.emit("added");
  ensureWorker();
  return it;
}

function clearCompleted() {
  const n = state.completed.length;
  state.completed = [];
  scheduleSave();
  broadcastSnapshot();
  return n;
}

function clearActiveDone() {
  const before = state.active.length;
  state.active = state.active.filter(x => x.status !== "done" && x.status !== "error");
  const removed = before - state.active.length;
  if (removed) { scheduleSave(); broadcastSnapshot(); }
  return removed;
}

function ensureWorker() {
  if (workerRunning) return;
  workerRunning = true;
  // run in background
  (async () => {
    while (true) {
      const next = state.active.find(x => x.status === "queued");
      if (!next) { workerRunning = false; return; }
      await processItem(next);
    }
  })().catch(e => { console.error("[queue] worker crash:", e); workerRunning = false; });
}

async function processItem(item) {
  item.status = "running";
  item.stage = "browser";
  item.progress = 5;
  item.startedAt = new Date().toISOString();
  item.logs = [];
  scheduleSave();
  broadcastActive();
  broadcast({ type: "job:progress", data: { id: item.id, stage: item.stage, progress: item.progress } });

  let outputDir;
  let maxQuality = item.maxQuality;
  try {
    outputDir = resolveMediaOutputDir ? resolveMediaOutputDir(item.folder) : path.join(__dirname, "media");
  } catch (e) {
    failItem(item, e.message);
    return;
  }

  const appendLog = (chunk) => {
    const text = String(chunk || "");
    if (!text) return;
    item.logs.push(text);
    if (item.logs.length > 500) item.logs.splice(0, item.logs.length - 500);
    broadcast({ type: "job:log", data: { id: item.id, chunk: text } });
  };

  const onProgress = (stage, data) => {
    item.stage = stage;
    const pctMap = { browser:10, navigating:15, capturing:25, extracting:35, downloading:60, muxing:90, done:100 };
    if (pctMap[stage] != null) item.progress = pctMap[stage];
    if (data && typeof data.progress === "number") item.progress = data.progress;
    broadcast({ type: "job:progress", data: { id: item.id, stage, progress: item.progress, detail: data?.detail } });
  };

  try {
    onProgress("navigating", {});
    const browser = getBrowser ? await getBrowser(appendLog) : null;
    if (!browser) throw new Error("Browser unavailable");

    onProgress("capturing", {});
    // runDownload wraps scan-videos run with progress callback
    const result = runDownload
      ? await runDownload({ url: item.url, outputDir, maxQuality, browser, log: appendLog, onProgress })
      : null;

    // collect file paths from result or logs
    const filePaths = [];
    if (result && Array.isArray(result.downloadedFiles)) filePaths.push(...result.downloadedFiles);
    // fallback parse logs for "Downloaded media to:"
    for (const line of item.logs.join("\n").split("\n")) {
      const m = line.match(/Downloaded media to:\s*(.+)$/);
      if (m) filePaths.push(m[1].trim());
    }

    if (filePaths.length) {
      item.status = "done";
      item.stage = "done";
      item.progress = 100;
      item.filePath = filePaths[0];
      item.filePaths = filePaths;
      item.finishedAt = new Date().toISOString();
      // move to completed
      const idx = state.active.findIndex(x => x.id === item.id);
      if (idx !== -1) state.active.splice(idx, 1);
      state.completed.unshift({ ...item, logs: item.logs.slice(-100) });
      // keep completed capped at 200
      if (state.completed.length > 200) state.completed.splice(200);
      await saveQueue();
      broadcastSnapshot();
      broadcast({ type: "job:progress", data: { id: item.id, stage:"done", progress:100 } });
      // notify media changed
      broadcast({ type: "media:changed", data: {} });
    } else {
      throw new Error("No media downloaded — see logs");
    }
  } catch (e) {
    failItem(item, e.message || String(e));
  }
}

function failItem(item, reason) {
  item.status = "error";
  item.stage = "error";
  item.error = String(reason || "Unknown error").slice(0, 500);
  item.finishedAt = new Date().toISOString();
  item.progress = 0;
  const idx = state.active.findIndex(x => x.id === item.id);
  if (idx !== -1) state.active.splice(idx, 1);
  state.completed.unshift({ ...item, logs: item.logs.slice(-100) });
  if (state.completed.length > 200) state.completed.splice(200);
  scheduleSave();
  broadcastSnapshot();
  broadcast({ type: "job:progress", data: { id: item.id, stage:"error", progress:0, detail: item.error } });
}

function getState() { return state; }

module.exports = {
  loadQueue,
  saveQueue,
  snapshot,
  broadcastSnapshot,
  addItems,
  removeActive,
  removeCompleted,
  retryCompleted,
  retryActiveFailed,
  clearCompleted,
  clearActiveDone,
  ensureWorker,
  setDeps,
  getState,
  emitter,
};
