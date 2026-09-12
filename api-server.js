#!/usr/bin/env node
require("dotenv").config({ quiet: true });

const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const { run } = require("./scan-videos/index");
const { buildBrowserFromLocalProfile } = require("./scan-videos/browser");
const { scanSavedPage } = require("./scan-videos/scan-saved");
const { loadAppConfig, normalizeAccountName, resolveAccountConfig, resolveProfileConfig, getStateFilePath, normalizeCdpUrl } = require("./scan-videos/config");
const { WebSocketServer } = require("ws");
const http = require("http");
const { EventEmitter } = require("events");

const ffmpegBin =
  process.env.FFMPEG_BIN ||
  (() => {
    try {
      require("child_process").execSync("which ffmpeg", { stdio: "ignore" });
      return "ffmpeg";
    } catch {
      return null;
    }
  })();

const ffprobeBin =
  process.env.FFPROBE_BIN ||
  (() => {
    try {
      require("child_process").execSync("which ffprobe", { stdio: "ignore" });
      return "ffprobe";
    } catch {
      return null;
    }
  })();

const app = express();
const rootDir = __dirname;
const mediaDir = path.join(rootDir, "media");
const webDistDir = path.join(rootDir, "web", "dist");
const port = Number(process.env.PORT) || 6767;
const apiJobTimeoutMs = parsePositiveInt(process.env.API_JOB_TIMEOUT_MS, 1800000);
const VNC_FLAG_PATH = process.env.VNC_FLAG || "/data/browser/.vnc-enabled";
const VNC_PORT_NUM = Number(process.env.VNC_PORT) || 6777;
const NOVNC_PORT_NUM = Number(process.env.NOVNC_PORT) || 6778;
let UI_PANEL_PASSWORD = String(process.env.UI_PANEL_PASSWORD || process.env.ADMIN_PASSWORD || "").trim();

let shuttingDown = false;
let jobCounter = 0;
let activeJob = null;
let scanActiveJob = null;
let queueActiveJob = null;
const scanningUrls = new Set();
let sharedBrowser = null;
let browserInitPromise = null;
const browsersByAccount = new Map();
const manualBrowsersByAccount = new Map();
const manualBrowserTimeoutMs = parsePositiveInt(process.env.MANUAL_BROWSER_TIMEOUT_MS, 900000);

const cdpStatusCache = new Map(); // accountName -> { status, cdpUrl, wsEndpoint, error, latencyMs, checkedAt }
const CDP_STATUS_TTL_MS = 15000;

async function getCdpStatusForAccount(accountName, { force = false } = {}) {
  const name = normalizeAccountName(accountName);
  try {
    const appConfig = await loadAppConfig();
    const cfg = resolveAccountConfig(name, appConfig.accounts);
    const cdpUrl = String(cfg.cdpUrl || "").trim();
    if (!cdpUrl) {
      const entry = { status: "not_configured", cdpUrl: "", wsEndpoint: null, error: null, latencyMs: 0, checkedAt: new Date().toISOString() };
      cdpStatusCache.set(name, entry);
      return entry;
    }
    const cached = cdpStatusCache.get(name);
    if (!force && cached && cached.cdpUrl === cdpUrl && cached.checkedAt) {
      const age = Date.now() - new Date(cached.checkedAt).getTime();
      if (age < CDP_STATUS_TTL_MS && cached.status !== "checking") return cached;
    }
    const checking = { status: "checking", cdpUrl, wsEndpoint: cached?.wsEndpoint || null, error: null, latencyMs: 0, checkedAt: new Date().toISOString() };
    cdpStatusCache.set(name, checking);
    try {
      const { checkCdpStatus } = require("./scan-videos/browser");
      const result = await checkCdpStatus(cdpUrl);
      const entry = result.ok
        ? { status: "up", cdpUrl, wsEndpoint: result.wsEndpoint, error: null, latencyMs: result.latencyMs, checkedAt: new Date().toISOString() }
        : { status: "down", cdpUrl, wsEndpoint: null, error: result.error, latencyMs: result.latencyMs, checkedAt: new Date().toISOString() };
      cdpStatusCache.set(name, entry);
      return entry;
    } catch (e) {
      const entry = { status: "down", cdpUrl, wsEndpoint: null, error: e.message || String(e), latencyMs: 0, checkedAt: new Date().toISOString() };
      cdpStatusCache.set(name, entry);
      return entry;
    }
  } catch (e) {
    return { status: "down", cdpUrl: "", wsEndpoint: null, error: e.message || String(e), latencyMs: 0, checkedAt: new Date().toISOString() };
  }
}

function getCachedCdpStatus(accountName) {
  const name = normalizeAccountName(accountName);
  const cached = cdpStatusCache.get(name);
  if (cached) return cached;
  return { status: "not_configured", cdpUrl: "", wsEndpoint: null, error: null, latencyMs: 0, checkedAt: null };
}

async function refreshCdpStatusInBackground(accountName) {
  void getCdpStatusForAccount(accountName, { force: false }).catch(() => {});
}

// --- Web queue (active = queued|running, completed = done|error) ---
const webQueueFile = path.join(rootDir, ".web-queue.json");
let webQueue = { active: [], completed: [], gap: { minMs: 0, maxMs: 0 } };
const queueEmitter = new EventEmitter();
let queueWorkerRunning = false;
let queueLoaded = false;
let queuePaused = false;
let cancelRequestedId = null;
let gapWaitState = null;

function browserIsAlive(browser) {
  if (!browser) return false;
  try {
    if (browser.isConnected && !browser.isConnected()) return false;
  } catch {
    return false;
  }
  const proc = browser.process ? browser.process() : null;
  if (proc && proc.pid) {
    try {
      process.kill(proc.pid, 0);
    } catch {
      return false;
    }
  }
  return true;
}

// --- Web queue persistence ---
async function loadWebQueue() {
  try {
    const raw = await fs.readFile(webQueueFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("invalid");
    webQueue.active = Array.isArray(parsed.active) ? parsed.active : [];
    webQueue.completed = Array.isArray(parsed.completed) ? parsed.completed : [];
    const g = parsed.gap && typeof parsed.gap === "object" ? parsed.gap : {};
    webQueue.gap = { minMs: Number(g.minMs) || 0, maxMs: Number(g.maxMs) || 0 };
    // stale running -> error
    let changed = false;
    for (const it of webQueue.active) {
      if (it.status === "running") {
        it.status = "error";
        it.error = "Interrupted — server restarted";
        it.stage = "error";
        it.finishedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await saveWebQueue();
  } catch (e) {
    if (e.code !== "ENOENT") console.error("[queue] load failed:", e.message);
    webQueue = { active: [], completed: [], gap: { minMs: 0, maxMs: 0 } };
  }
  // move any done/error mistakenly in active to completed (migration)
  const stillActive = [];
  for (const it of webQueue.active) {
    if (it.status === "done" || it.status === "error") webQueue.completed.unshift(it);
    else stillActive.push(it);
  }
  if (stillActive.length !== webQueue.active.length) {
    webQueue.active = stillActive;
    await saveWebQueue();
  }
  queueLoaded = true;
}
let saveWebQueueChain = Promise.resolve();
let queueFileChain = Promise.resolve();
async function withQueueFile(fn) {
  let result, error;
  const task = async () => {
    try { result = await fn(); } catch (e) { error = e; }
  };
  queueFileChain = queueFileChain.then(task, task);
  await queueFileChain;
  if (error) throw error;
  return result;
}
async function saveWebQueue() {
  const snapshot = JSON.stringify(webQueue, null, 2);
  const dir = path.dirname(webQueueFile);
  const task = async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(webQueueFile, snapshot, "utf8");
  };
  saveWebQueueChain = saveWebQueueChain.then(task, task);
  await saveWebQueueChain;
}
function wsBroadcast(obj) {
  const data = JSON.stringify(obj);
  if (!wss) return;
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(data);
  }
}
function wsBroadcastQueue() {
  wsBroadcast({ type: "queue:snapshot", active: webQueue.active, completed: webQueue.completed, gap: webQueue.gap || { minMs: 0, maxMs: 0 }, gapWait: gapWaitState, paused: queuePaused });
}
function wsBroadcastProgress(id, stage, pct, detail, filePath) {
  wsBroadcast({ type: "job:progress", id, stage, pct, detail, filePath });
}
function wsBroadcastLog(id, chunk) {
  wsBroadcast({ type: "job:log", id, chunk });
}
async function queueAddUrls(urls, folder, maxQuality, account) {
  if (!queueLoaded) await loadWebQueue();
  const now = Date.now();
  const added = [];
  const seen = new Set();
  const acct = normalizeAccountName(account || "default");
  // only skip what is literally in-flight right now; everything else queues visibly
  for (const it of webQueue.active) {
    const u1 = it.url ? normalizeSyncUrl(it.url) : "";
    const u2 = it.link ? normalizeSyncUrl(it.link) : "";
    if (u1) seen.add(u1);
    if (u2) seen.add(u2);
  }
  for (let i = 0; i < urls.length; i++) {
    const url = String(urls[i] || "").trim();
    if (!url) continue;
    const norm = normalizeSyncUrl(url);
    if (!norm) continue;
    if (seen.has(norm)) continue;
    // dedupe within this batch
    if (added.some((a) => normalizeSyncUrl(a.url) === norm)) continue;
    seen.add(norm);
    const id = `${now}-${i}-${Math.random().toString(36).slice(2, 6)}`;
    const item = {
      id,
      url,
      link: url,
      folder: String(folder || "").trim(),
      maxQuality: maxQuality ?? null,
      account: acct,
      status: "queued",
      stage: "queued",
      pct: 0,
      createdAt: new Date().toISOString(),
      logs: [],
    };
    webQueue.active.push(item);
    added.push(item);
  }
  if (added.length) {
    await saveWebQueue();
    wsBroadcastQueue();
    queueEmitter.emit("wake");
    ensureQueueWorker();
  }
  return added;
}
async function waitGap(initialMs) {
  let totalMs = initialMs;
  let startedAt = Date.now();
  let cancelled = false;
  // live re-read: config edits mid-wait redraw the target (measured from original start)
  const onChange = () => {
    const cfg = webQueue.gap || { minMs: 0, maxMs: 0 };
    if ((cfg.maxMs || 0) <= 0) { cancelled = true; return; }
    const min = Math.max(0, cfg.minMs || 0);
    const max = Math.max(min, cfg.maxMs);
    totalMs = min + Math.floor(Math.random() * (max - min + 1));
  };
  queueEmitter.on("gapchange", onChange);
  console.log(`[queue] gap: waiting ${Math.round(totalMs / 60000)} min before next download`);
  try {
    while (!cancelled) {
      const remaining = totalMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      gapWaitState = { waiting: true, remainingSec: Math.ceil(remaining / 1000), paused: queuePaused };
      wsBroadcast({ type: "queue:gap", waiting: true, remainingSec: gapWaitState.remainingSec, paused: queuePaused });
      if (queuePaused) {
        const frozen = remaining;
        await new Promise((res) => {
          const onResume = () => { queueEmitter.off("resume", onResume); res(); };
          queueEmitter.once("resume", onResume);
          setTimeout(() => { queueEmitter.off("resume", onResume); res(); }, 30000);
        });
        startedAt = Date.now() - (totalMs - frozen);
        continue;
      }
      await new Promise((res) => setTimeout(res, Math.min(1000, remaining)));
    }
  } finally {
    queueEmitter.off("gapchange", onChange);
    gapWaitState = null;
    wsBroadcast({ type: "queue:gap", waiting: false });
    console.log("[queue] gap finished — starting next download");
  }
}
async function queueWorkerLoop() {
  if (queueWorkerRunning) return;
  queueWorkerRunning = true;
  console.log("[queue] worker started");
  while (true) {
    if (queuePaused) {
      await new Promise((res) => {
        const onResume = () => { queueEmitter.off("resume", onResume); res(); };
        queueEmitter.once("resume", onResume);
        setTimeout(() => { queueEmitter.off("resume", onResume); res(); }, 30000);
      });
      if (queuePaused) continue;
    }
    if (!queueLoaded) await loadWebQueue();
    const item = webQueue.active.find((it) => it.status === "queued");
    if (!item) {
      await new Promise((res) => {
        const onWake = () => {
          queueEmitter.off("wake", onWake);
          res();
        };
        queueEmitter.once("wake", onWake);
        setTimeout(() => {
          queueEmitter.off("wake", onWake);
          res();
        }, 30000);
      });
      if (queuePaused) continue;
      const still = webQueue.active.find((it) => it.status === "queued");
      if (!still) continue;
      else {
        const next = webQueue.active.find((it) => it.status === "queued");
        if (!next) continue;
      }
    }
    const nextItem = webQueue.active.find((it) => it.status === "queued");
    if (!nextItem) continue;
    // process nextItem
    nextItem.status = "running";
    nextItem.stage = "browser";
    nextItem.pct = 5;
    nextItem.startedAt = new Date().toISOString();
    await saveWebQueue();
    wsBroadcastQueue();
    wsBroadcastProgress(nextItem.id, "browser", 5, "acquiring browser");
    let outputDir;
    try {
      outputDir = resolveMediaOutputDir(nextItem.folder);
    } catch (e) {
      nextItem.status = "error";
      nextItem.stage = "error";
      nextItem.error = e.message;
      nextItem.finishedAt = new Date().toISOString();
      // move to completed
      webQueue.active = webQueue.active.filter((it) => it.id !== nextItem.id);
      webQueue.completed.unshift(nextItem);
      await saveWebQueue();
      wsBroadcastQueue();
      continue;
    }
    const maxQuality = (() => {
      try {
        return resolveMaxQuality(nextItem.maxQuality);
      } catch {
        return null;
      }
    })();
    const jobId = ++jobCounter;
    queueActiveJob = { id: jobId, type: "queue", startedAt: Date.now(), queueId: nextItem.id };
    const logToWs = (msg) => {
      const text = String(msg ?? "");
      if (!text) return;
      nextItem.logs.push(text);
      if (nextItem.logs.length > 500) nextItem.logs.shift();
      wsBroadcastLog(nextItem.id, text);
      const lower = text.toLowerCase();
      let stage = null;
      let pct = null;
      if (lower.includes("preparing browser") || lower.includes("acquiring browser")) {
        stage = "browser";
        pct = 10;
      } else if (lower.includes("browser ready")) {
        stage = "navigating";
        pct = 20;
      } else if (lower.includes("navigating") || lower.includes("page.goto")) {
        stage = "navigating";
        pct = 25;
      } else if (lower.includes("auto-capture") || lower.includes("capturing")) {
        stage = "capturing";
        pct = 40;
      } else if (lower.includes("extracting") || lower.includes("extractor")) {
        stage = "extracting";
        pct = 55;
      } else if (lower.includes("downloading") || lower.includes("downloadmedia")) {
        stage = "downloading";
        pct = 70;
      } else if (lower.includes("ffmpeg") || lower.includes("muxing")) {
        stage = "muxing";
        pct = 90;
      }
      if (stage) {
        nextItem.stage = stage;
        nextItem.pct = pct;
        wsBroadcastProgress(nextItem.id, stage, pct, text.slice(0, 200));
      }
      console.log(`[queue:${nextItem.id}] ${text.split("\n")[0].slice(0, 200)}`);
    };
    let browser = null;
    let hlsTimer = null;
    const queueAccount = normalizeAccountName(nextItem.account || "default");
    const queueIsDefault = queueAccount === "default";
    const queueRecycle = queueIsDefault ? closeSharedBrowser : () => closeBrowserForAccount(queueAccount);
    const startHlsTick = () => {
      if (hlsTimer) return;
      hlsTimer = setInterval(() => {
        if (nextItem.stage !== "downloading" || nextItem.pct >= 90) return;
        nextItem.pct = Math.min(90, nextItem.pct + 1);
        wsBroadcastProgress(nextItem.id, "downloading", nextItem.pct, nextItem.detail || "HLS · ffmpeg (streaming)");
        void saveWebQueue();
      }, 2500);
      if (hlsTimer.unref) hlsTimer.unref();
    };
    const stopHlsTick = () => { if (hlsTimer) clearInterval(hlsTimer); hlsTimer = null; };
    try {
      logToWs("[queue] preparing browser...");
      if (queueAccount !== "default") {
        browser = await getBrowserForAccount(queueAccount, `queue-${nextItem.id}`);
        logToWs(`[queue] using account "${queueAccount}" browser`);
      } else {
        browser = await getSharedBrowser(logToWs);
      }
      logToWs("[queue] browser ready, starting scan...");
      nextItem.stage = "navigating";
      nextItem.pct = 20;
      wsBroadcastProgress(nextItem.id, "navigating", 20, nextItem.url);
      const result = await runWithJobTimeout(
        run({
          urls: [nextItem.url],
          linkOnly: false,
          outputDir,
          maxQuality,
          browser,
          account: queueAccount,
          autoContinuePrompts: true,
          waitForCompletionPrompt: false,
          log: logToWs,
          onProgress: (p) => {
            let detail = p.detail || "";
            // never show raw candidate URL as detail for downloading — show method instead
            if (p.stage === "downloading" && !detail) {
              if (p.candidate && String(p.candidate).includes("m3u8")) detail = "HLS · ffmpeg";
              else if (p.candidate) detail = "Direct";
            }
            if (p.filePath && !nextItem.filePath) {
              nextItem.filePath = p.filePath;
              wsBroadcastProgress(nextItem.id, nextItem.stage || "downloading", nextItem.pct, nextItem.detail || detail, p.filePath);
              wsBroadcastQueue();
            }
            const isHls = detail.includes("HLS");
            if (p.stage === "downloading") {
              if (isHls && p.pct == null) {
                nextItem.stage = "downloading";
                nextItem.detail = detail;
                if (p.filePath) nextItem.filePath = p.filePath;
                if (nextItem.pct < 70) nextItem.pct = 70;
                wsBroadcastProgress(nextItem.id, "downloading", nextItem.pct, detail, p.filePath || nextItem.filePath);
                startHlsTick();
                return;
              }
              const downloadPct = Math.max(0, Math.min(100, Number(p.pct) || 0));
              const overall = 70 + Math.round(downloadPct * 0.3);
              nextItem.stage = "downloading";
              nextItem.pct = overall;
              nextItem.detail = detail;
              if (p.filePath) nextItem.filePath = p.filePath;
              wsBroadcastProgress(nextItem.id, "downloading", overall, detail, p.filePath || nextItem.filePath);
              if (!isHls) stopHlsTick();
            } else if (p.stage) {
              nextItem.stage = p.stage;
              if (p.pct != null) nextItem.pct = p.pct;
              nextItem.detail = detail;
              if (p.filePath) nextItem.filePath = p.filePath;
              wsBroadcastProgress(nextItem.id, p.stage, p.pct ?? nextItem.pct, detail, p.filePath || nextItem.filePath);
            }
          },
        }),
        {
          timeoutMs: apiJobTimeoutMs,
          jobId,
          jobType: "queue",
          log: logToWs,
          recycleBrowser: queueRecycle,
        }
      );
      const failed = Array.isArray(result?.failedTargets) ? result.failedTargets : [];
      if (failed.length) {
        throw new Error(failed[0].reason || "No media downloaded");
      }
      // parse downloaded file paths from logs (fallback)
      const allLogs = nextItem.logs.join("\n");
      const matches = [...allLogs.matchAll(/Downloaded media to:\s*(.+)/g)].map((m) => m[1].trim());
      nextItem.filePath = matches[matches.length - 1] || null;
      nextItem.status = "done";
      nextItem.stage = "done";
      nextItem.pct = 100;
      nextItem.finishedAt = new Date().toISOString();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.error(`[queue:${nextItem.id}] failed: ${msg}`);
      nextItem.status = "error";
      nextItem.stage = "error";
      nextItem.pct = 100;
      nextItem.error = msg;
      nextItem.finishedAt = new Date().toISOString();
      logToWs(`[queue] failed: ${msg}`);
      // recycle per-account or shared browser if disconnected
      try {
        if (queueAccount !== "default") {
          const b = browsersByAccount.get(queueAccount);
          if (b && b.isConnected && !b.isConnected()) await closeBrowserForAccount(queueAccount, b);
        } else if (sharedBrowser && sharedBrowser.isConnected && !sharedBrowser.isConnected()) {
          await closeSharedBrowser();
        }
      } catch {}
    } finally {
      stopHlsTick();
      queueActiveJob = null;
      // move from active to completed
      webQueue.active = webQueue.active.filter((it) => it.id !== nextItem.id);
      webQueue.completed.unshift(nextItem);
      // keep completed capped at 500
      if (webQueue.completed.length > 500) webQueue.completed.length = 500;
      await saveWebQueue();
      wsBroadcastQueue();
    }
    // inter-download gap (only when another item is queued)
    const gapCfg = webQueue.gap || { minMs: 0, maxMs: 0 };
    if ((gapCfg.maxMs || 0) > 0 && webQueue.active.some((it) => it.status === "queued")) {
      const min = Math.max(0, gapCfg.minMs || 0);
      const max = Math.max(min, gapCfg.maxMs);
      await waitGap(min + Math.floor(Math.random() * (max - min + 1)));
    }
  }
}
function ensureQueueWorker() {
  if (!queueWorkerRunning) void queueWorkerLoop();
}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// ---- Public: SPA assets (React app, must load before auth check) ----
const fsSync = require("fs");
app.use(express.static(webDistDir));
app.get("/", (_req, res) => {
  const distIndex = path.join(webDistDir, "index.html");
  if (fsSync.existsSync(distIndex)) {
    return res.sendFile(distIndex);
  }
  return res.status(503).send("web/dist not built — run npm run build in /web");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    shuttingDown,
    busy: Boolean(activeJob || scanActiveJob || queueActiveJob),
    browserReady: Boolean(sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()),
    accountBrowsersReady: Array.from(browsersByAccount.values()).filter(
      (browser) => browser && browser.isConnected && browser.isConnected()
    ).length,
    manualBrowsers: Array.from(manualBrowsersByAccount.keys()),
  });
});

app.get("/api/auth/status", (_req, res) => {
  const pw = String(process.env.UI_PANEL_PASSWORD || process.env.ADMIN_PASSWORD || UI_PANEL_PASSWORD || "").trim();
  res.json({ ok: true, protected: !!pw });
});
app.post("/api/auth", (req, res) => {
  const expected = String(process.env.UI_PANEL_PASSWORD || process.env.ADMIN_PASSWORD || UI_PANEL_PASSWORD || "").trim();
  if (!expected) return res.json({ ok: true });
  const provided = String(req.body?.password || "").trim();
  if (provided === expected) {
    res.cookie("xdl_session", expected, { httpOnly: true, sameSite: "lax", path: "/" });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Invalid password" });
});
app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("xdl_session", { path: "/" });
  res.json({ ok: true });
});

// ---- VNC helpers (public status, protected control) ----
const { exec: execCb } = require("child_process");
const { promisify: _promisify } = require("util");
const execAsync = _promisify(execCb);
const fsSyncVnc = require("fs");

let vncOpChain = Promise.resolve();
function withVncLock(fn) {
  let result, error;
  const task = async () => {
    try { result = await fn(); } catch (e) { error = e; }
  };
  vncOpChain = vncOpChain.then(task, task);
  return vncOpChain.then(() => { if (error) throw error; return result; });
}
function isVncFlagEnabled() {
  try {
    if (fsSyncVnc.existsSync(VNC_FLAG_PATH)) return fsSyncVnc.readFileSync(VNC_FLAG_PATH, "utf8").trim() === "1";
  } catch {}
  return String(process.env.ENABLE_VNC || "0") === "1";
}
async function isVncProcessRunning() {
  async function canConnect(port) {
    try {
      const net = require("net");
      const ok = await new Promise((resolve) => {
        const s = net.createConnection({ host: "127.0.0.1", port, timeout: 800 }, () => { s.end(); resolve(true); });
        s.on("error", () => resolve(false));
        s.on("timeout", () => { s.destroy(); resolve(false); });
      });
      return ok;
    } catch { return false; }
  }
  const vncUp = await canConnect(VNC_PORT_NUM);
  if (!vncUp) return false;
  const novncUp = await canConnect(NOVNC_PORT_NUM);
  return novncUp;
}
app.get("/vnc/status", async (_req, res) => {
  const enabled = isVncFlagEnabled();
  const running = await isVncProcessRunning();
  res.json({ ok: true, enabled, running, vncPort: VNC_PORT_NUM, novncPort: NOVNC_PORT_NUM });
});

// ---- Auth middleware: everything below this line requires a password when set ----
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...v] = part.split("=");
    if (k) out[k.trim()] = decodeURIComponent(v.join("="));
  }
  return out;
}
app.use((req, res, next) => {
  const expected = String(process.env.UI_PANEL_PASSWORD || process.env.ADMIN_PASSWORD || UI_PANEL_PASSWORD || "").trim();
  if (!expected) return next();
  // Public endpoints
  if (req.path === "/api/auth/status" || req.path === "/api/auth" || req.path === "/health" || req.path.startsWith("/health") || req.path === "/vnc/status") return next();
  // Check header auth, query param, or session cookie
  const provided = String(req.headers["x-panel-password"] || req.headers["x-admin-password"] || req.headers["x-admin-token"] || req.query?.password || "");
  if (provided === expected) return next();
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.xdl_session === expected) return next();
  // Unauthenticated browser GET → serve login page (index.html). API/POST → JSON 401.
  if (req.method === "GET") {
    const distIndex = path.join(webDistDir, "index.html");
    return fsSync.existsSync(distIndex) ? res.sendFile(distIndex) : res.status(503).send("web/dist not built");
  }
  return res.status(401).json({ ok: false, error: "Password is required" });
});

// ---- Protected: media files, SPA page routes (React enforces auth client-side on hard reload) ----
app.get("/scan-saved", (_req, res) => {
  res.redirect("/dashboard");
});
app.use("/media", express.static(mediaDir, {
  // Some downloaded `.gif` files are actually MP4 bytes (saved from a .gif
  // URL). Sniff the magic bytes so the player gets a playable MIME type:
  // `ftyp` at offset 4 => MP4 container => serve as video/mp4.
  setHeaders: (res, filePath) => {
    if (/\.gif$/i.test(filePath)) {
      let fd = null;
      try {
        fd = fsSync.openSync(filePath, "r");
        const buf = Buffer.alloc(12);
        if (fsSync.readSync(fd, buf, 0, 12, 0) >= 8 && buf.subarray(4, 8).toString("latin1") === "ftyp") {
          res.setHeader("Content-Type", "video/mp4");
        }
      } catch {
        // ignore sniffing errors — fall through with default content type
      } finally {
        if (fd !== null) {
          try { fsSync.closeSync(fd); } catch {}
        }
      }
    }
  },
}));
function fileEntryTimes(stat) {
  const birth =
    stat.birthtime && Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
      ? stat.birthtime
      : null;
  const created = birth || stat.ctime || stat.mtime;
  return {
    mtime: stat.mtime.toISOString(),
    created: created.toISOString(),
  };
}

async function walkMediaFlat(dir, relPrefix, out, depth) {
  if (depth > 32) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (depth + 1 > 32) continue;
      await walkMediaFlat(fullPath, rel, out, depth + 1);
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      name: entry.name,
      rel,
      dir: false,
      size: stat.size,
      ...fileEntryTimes(stat),
    });
  }
}

async function listMediaDir(resolved, flat) {
  const items = [];
  if (flat) {
    await walkMediaFlat(resolved, "", items, 0);
  } else {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(resolved, entry.name);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      items.push({
        name: entry.name,
        dir: entry.isDirectory(),
        size: stat.size,
        ...fileEntryTimes(stat),
      });
    }
    items.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      if (!a.dir && !b.dir) return new Date(b.mtime) - new Date(a.mtime);
      return a.name.localeCompare(b.name);
    });
  }
  const posterByStem = new Map();
  for (const it of items) {
    const m = /^(.*)-poster\.(jpe?g|png|webp|avif|gif)$/i.exec(it.rel || it.name);
    if (m && !posterByStem.has(m[1].toLowerCase())) posterByStem.set(m[1].toLowerCase(), it);
  }
  for (const it of items) {
    if (it.dir) continue;
    const key = (it.rel || it.name).replace(/\.[^.]+$/, "").toLowerCase();
    const poster = posterByStem.get(key);
    it.thumb = poster ? (poster.rel || poster.name) : null;
  }
  return items;
}

app.get("/api/media", async (req, res) => {
  try {
    const folder = String(req.query?.folder || "").trim();
    const flat = String(req.query?.flat || "") === "1";
    const resolved = resolveMediaOutputDir(folder);
    const items = await listMediaDir(resolved, flat);
    return res.json({ ok: true, folder, flat, items });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});
app.delete("/api/media", async (req, res) => {
  try {
    const folder = String(req.query?.folder || req.body?.folder || "").trim();
    const name = String(req.query?.name || req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    if (name.includes("/") || name.includes("\\")) return res.status(400).json({ ok: false, error: "invalid name" });
    const dir = resolveMediaOutputDir(folder);
    const fullPath = path.join(dir, name);
    const rel = path.relative(mediaDir, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return res.status(400).json({ ok: false, error: "invalid path" });
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) return res.status(404).json({ ok: false, error: "not found" });
    if (stat.isDirectory()) return res.status(400).json({ ok: false, error: "use folder delete for dirs" });
    await fs.unlink(fullPath);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});
// --- GIF → MP4 streaming conversion (cache in tmp, single-flight per key) ---
const gifCacheDir = path.join(require("os").tmpdir(), "xdl-gifcache");
const gifInFlight = new Map();
const { spawn } = require("child_process");
const crypto = require("crypto");

app.get("/api/gifvideo", async (req, res) => {
  try {
    if (!ffmpegBin) {
      return res.status(500).json({ ok: false, error: "ffmpeg not installed" });
    }
    const folder = String(req.query?.folder || "");
    const name = String(req.query?.name || "");
    if (!name || !/\.gif$/i.test(name)) {
      return res.status(400).json({ ok: false, error: "name must be a .gif file" });
    }
    const dir = resolveMediaOutputDir(folder);
    const srcPath = path.join(dir, name);
    const rel = path.relative(mediaDir, srcPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return res.status(400).json({ ok: false, error: "invalid path" });
    }
    const stat = await fs.stat(srcPath).catch(() => null);
    if (!stat) return res.status(404).json({ ok: false, error: "not found" });
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "not a file" });

    const key = `${stat.mtimeMs}:${rel}`;
    const hash = crypto.createHash("sha1").update(key).digest("hex").slice(0, 20);
    const outPath = path.join(gifCacheDir, `${hash}.mp4`);

    if (!fsSync.existsSync(outPath)) {
      const existing = gifInFlight.get(hash);
      if (existing) {
        await existing.catch(() => {});
      } else {
        const job = (async () => {
          await fs.mkdir(gifCacheDir, { recursive: true });
          await new Promise((resolve, reject) => {
            const cp = spawn(ffmpegBin, ["-y", "-i", srcPath, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", "-pix_fmt", "yuv420p", outPath], {
              stdio: "ignore",
            });
            const timer = setTimeout(() => cp.kill("SIGKILL"), 180000);
            cp.on("error", reject);
            cp.on("close", (code) => {
              clearTimeout(timer);
              code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`));
            });
          });
          await fs.mkdir(gifCacheDir, { recursive: true });
        })();
        gifInFlight.set(hash, job);
        try {
          await job;
        } catch (error) {
          await fs.unlink(outPath).catch(() => {});
          throw error;
        } finally {
          gifInFlight.delete(hash);
        }
      }
    }
    return res.sendFile(outPath);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// --- Embedded video thumbnail (attached_pic only, zero re-encode, cached) ---
// Serves the cover art embedded inside the video file itself (e.g. mp4
// `attached pic` stream). No frame extraction, no transcoding: ffprobe detects
// the attached-pic stream, ffmpeg copies its bytes out with `-c copy`.
// Files without an embedded thumbnail → 404 so the client falls back to icon.
const thumbCacheDir = path.join(require("os").tmpdir(), "xdl-thumbcache");
const thumbInFlight = new Map();
const THUMB_VIDEO_EXTS = new Set(
  ["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "3gp", "flv", "ts", "m2ts", "wmv", "ogv"]
);

app.get("/api/mediathumb", async (req, res) => {
  try {
    const folder = String(req.query?.folder || "");
    // `key` is the Media rowKey: `rel` in flat mode (may contain "/"),
    // plain file name otherwise. `name` kept as an alias for non-flat callers.
    const key = String(req.query?.key || req.query?.name || req.query?.rel || "").replace(/\\/g, "/").trim();
    if (!key) {
      return res.status(400).json({ ok: false, error: "key (file) required" });
    }
    if (key.startsWith("/") || key.includes("..")) {
      return res.status(400).json({ ok: false, error: "invalid path" });
    }
    const dir = resolveMediaOutputDir(folder);
    const srcPath = path.join(dir, ...key.split("/").filter(Boolean));
    const rel = path.relative(mediaDir, srcPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return res.status(400).json({ ok: false, error: "invalid path" });
    }
    const stat = await fs.stat(srcPath).catch(() => null);
    if (!stat) return res.status(404).json({ ok: false, error: "not found" });
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "not a file" });
    const ext = String(key.split(".").pop() || "").toLowerCase();
    if (!THUMB_VIDEO_EXTS.has(ext)) {
      return res.status(404).json({ ok: false, error: "not a video file" });
    }
    if (!ffmpegBin || !ffprobeBin) {
      return res.status(503).json({ ok: false, error: "ffmpeg/ffprobe not installed" });
    }

    const cacheSeed = `${stat.mtimeMs}:${stat.size}:${rel}`;
    const hash = crypto.createHash("sha1").update(cacheSeed).digest("hex").slice(0, 20);

    const sendCached = async () => {
      const entries = await fs.readdir(thumbCacheDir).catch(() => []);
      const hit = entries.find((n) => n.startsWith(`${hash}.`));
      if (!hit) return false;
      res.set("Cache-Control", "public, max-age=86400, immutable");
      return res.sendFile(path.join(thumbCacheDir, hit));
    };
    if (await sendCached()) return;

    if (thumbInFlight.has(hash)) {
      try { await thumbInFlight.get(hash); } catch {}
      if (await sendCached()) return;
      return res.status(404).json({ ok: false, error: "no embedded thumbnail" });
    }

    const job = (async () => {
      await fs.mkdir(thumbCacheDir, { recursive: true });
      const { execFile: _execFile } = require("child_process");
      const { promisify: _promisify } = require("util");
      const execFileAsync = _promisify(_execFile);
      // Cheap probe: stream metadata only, no decoding.
      const { stdout } = await execFileAsync(
        ffprobeBin,
        ["-v", "error", "-show_streams", "-of", "json", srcPath],
        { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }
      );
      let streams = [];
      try { streams = JSON.parse(stdout || "{}").streams || []; } catch { streams = []; }
      const attached = streams.find((s) => {
        const disp = s && s.disposition;
        if (disp && Number(disp.attached_pic) === 1) return true;
        // Fallback: image-codec stream that is not the primary video track.
        if (s && s.codec_type === "video" && /^(mjpeg|png|jpg|jpeg|webp)$/i.test(String(s.codec_name || ""))) {
          if (Number(s.index) > 0) return true;
        }
        return false;
      });
      if (!attached) {
        const err = new Error("no embedded thumbnail");
        err.code = "NO_ATTACHED_PIC";
        throw err;
      }
      const streamIndex = Number(attached.index);
      const outExt = /png/i.test(String(attached.codec_name || "")) ? "png"
        : /webp/i.test(String(attached.codec_name || "")) ? "webp" : "jpg";
      const outPath = path.join(thumbCacheDir, `${hash}.${outExt}`);
      if (!fsSync.existsSync(outPath)) {
        await new Promise((resolve, reject) => {
          const cp = spawn(ffmpegBin, ["-y", "-v", "error", "-i", srcPath, "-map", `0:${streamIndex}`, "-c", "copy", outPath], {
            stdio: "ignore",
          });
          const timer = setTimeout(() => cp.kill("SIGKILL"), 30000);
          cp.on("error", reject);
          cp.on("close", (code) => {
            clearTimeout(timer);
            code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`));
          });
        });
        const outStat = await fs.stat(outPath).catch(() => null);
        if (!outStat || !outStat.size) {
          await fs.unlink(outPath).catch(() => {});
          throw new Error("thumbnail extraction produced no output");
        }
      }
      return outPath;
    })();
    thumbInFlight.set(hash, job);
    let outPath = null;
    try {
      outPath = await job;
    } catch (error) {
      if (error && error.code === "NO_ATTACHED_PIC") {
        return res.status(404).json({ ok: false, error: "no embedded thumbnail" });
      }
      throw error;
    } finally {
      thumbInFlight.delete(hash);
    }
    res.set("Cache-Control", "public, max-age=86400, immutable");
    return res.sendFile(outPath);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/vnc/enable", async (_req, res) => {
  try {
    await withVncLock(async () => {
      await execAsync("/usr/local/bin/vnc-start");
      for (let i = 0; i < 10; i++) {
        if (await isVncProcessRunning()) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    });
    const running = await isVncProcessRunning();
    res.json({ ok: true, enabled: true, running });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/vnc/disable", async (_req, res) => {
  try {
    await withVncLock(async () => {
      await execAsync("/usr/local/bin/vnc-stop");
      await new Promise((r) => setTimeout(r, 600));
    });
    res.json({ ok: true, enabled: false, running: false });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/config", (_req, res) => {
  const home = process.env.HOME || "/home/boniface";
  const groups = [
    {
      name: "Security",
      vars: [
        { key: "UI_PANEL_PASSWORD", value: "", def: "(blank = no password)", desc: "Admin panel password — blank disables auth", isPassword: true, hasValue: !!UI_PANEL_PASSWORD, placeholder: UI_PANEL_PASSWORD ? "•••• (set — type new to change)" : "blank = no password" },
      ],
    },
    {
      name: "Core",
      vars: [
        { key: "PORT", value: process.env.PORT || "6767", def: "6767", desc: "API server port" },
        { key: "HEADLESS", value: process.env.HEADLESS ?? (!process.env.DISPLAY ? "1 (inferred)" : "0 (inferred)"), def: "!DISPLAY", desc: "Browser headless mode" },
        { key: "API_HEADLESS", value: process.env.API_HEADLESS || "(falls back to HEADLESS)", def: "HEADLESS", desc: "Headless for API" },
        { key: "BROWSER_USER_DATA_DIR", value: process.env.BROWSER_USER_DATA_DIR || `${home}/.config/cloakbrowser-profile`, def: "~/.config/cloakbrowser-profile", desc: "Chrome profile dir" },
        { key: "BROWSER_PROFILE_DIR", value: process.env.BROWSER_PROFILE_DIR || "Default", def: "Default", desc: "Profile subdir" },
        { key: "BROWSER_PATH", value: process.env.BROWSER_PATH || "(auto)", def: "(auto)", desc: "Custom Chrome binary" },
        { key: "CLOAKBROWSER_CACHE_DIR", value: process.env.CLOAKBROWSER_CACHE_DIR || "/data/cloakbrowser", def: "/data/cloakbrowser", desc: "CloakBrowser cache" },
        { key: "INSTAGRAM_USER_AGENT", value: process.env.INSTAGRAM_USER_AGENT || "(iPhone Safari default)", def: "iPhone Safari", desc: "Custom UA for Instagram" },
        { key: "AUTO_CONTINUE", value: process.env.AUTO_CONTINUE ?? (!process.stdin.isTTY ? "1 (inferred)" : "0 (inferred)"), def: "!isTTY", desc: "Auto-continue prompts" },
        { key: "AUTO_CONTINUE_WAIT_MS", value: process.env.AUTO_CONTINUE_WAIT_MS || "0", def: "0", desc: "ms to wait before auto-continue" },
      ],
    },
    {
      name: "Capture Timing",
      vars: [
        { key: "AUTO_CAPTURE_TIMEOUT_MS", value: process.env.AUTO_CAPTURE_TIMEOUT_MS || "30000", def: "30000", desc: "Max wait for media signals" },
        { key: "AUTO_CAPTURE_QUIET_MS", value: process.env.AUTO_CAPTURE_QUIET_MS || "1800", def: "1800", desc: "Quiet period before proceed" },
        { key: "AUTO_CAPTURE_POLL_MS", value: process.env.AUTO_CAPTURE_POLL_MS || "250", def: "250", desc: "Poll interval" },
      ],
    },
    {
      name: "Timeouts",
      vars: [
        { key: "API_JOB_TIMEOUT_MS", value: process.env.API_JOB_TIMEOUT_MS || "1800000", def: "1800000 (30m)", desc: "Max API job duration" },
        { key: "DOWNLOAD_FETCH_TIMEOUT_MS", value: process.env.DOWNLOAD_FETCH_TIMEOUT_MS || "300000", def: "300000 (5m)", desc: "HTTP fetch timeout" },
        { key: "FFMPEG_TIMEOUT_MS", value: process.env.FFMPEG_TIMEOUT_MS || "900000", def: "900000 (15m)", desc: "ffmpeg timeout" },
        { key: "FFPROBE_TIMEOUT_MS", value: process.env.FFPROBE_TIMEOUT_MS || "120000", def: "120000 (2m)", desc: "ffprobe timeout" },
        { key: "MANUAL_BROWSER_TIMEOUT_MS", value: process.env.MANUAL_BROWSER_TIMEOUT_MS || "900000", def: "900000 (15m)", desc: "Manual browser auto-close" },
      ],
    },
    {
      name: "Instagram / Sync",
      vars: [
        { key: "INSTAGRAM_429_COOLDOWN_MS", value: process.env.INSTAGRAM_429_COOLDOWN_MS || "300000", def: "300000 (5m)", desc: "Cooldown after 429" },
        { key: "SAVED_SYNC_STATE_FILE", value: process.env.SAVED_SYNC_STATE_FILE || ".saved-sync-state.json", def: ".saved-sync-state.json", desc: "Per-list scan state file" },
        { key: "SAVED_SYNC_QUEUE_FILE", value: process.env.SAVED_SYNC_QUEUE_FILE || ".download-queue.json", def: ".download-queue.json", desc: "Sync daemon queue file" },
        { key: "SAVED_SYNC_RETRY_DELAY_MS", value: process.env.SAVED_SYNC_RETRY_DELAY_MS || "3000", def: "3000", desc: "Retry delay" },
        { key: "SAVED_SYNC_RETRY_COUNT", value: process.env.SAVED_SYNC_RETRY_COUNT || "20", def: "20", desc: "Retry count" },
        { key: "API_BASE", value: process.env.API_BASE || "http://localhost:3001", def: "http://localhost:3001", desc: "Base URL for sync daemon" },
        { key: "SNAPSHOT_DIR", value: process.env.SNAPSHOT_DIR || "media/.debug-snapshots", def: "media/.debug-snapshots", desc: "Snapshot dir on scrape miss" },
      ],
    },
    {
      name: "VNC / Docker",
      vars: [
        { key: "ENABLE_VNC", value: process.env.ENABLE_VNC || "0", def: "0", desc: "Start VNC at boot (flag file overrides)" },
        { key: "VNC_FLAG", value: process.env.VNC_FLAG || "/data/browser/.vnc-enabled", def: "/data/browser/.vnc-enabled", desc: "Persisted VNC toggle" },
        { key: "VNC_PORT", value: process.env.VNC_PORT || "6777", def: "6777", desc: "VNC port" },
        { key: "NOVNC_PORT", value: process.env.NOVNC_PORT || "6778", def: "6778", desc: "noVNC port" },
        { key: "DISPLAY", value: process.env.DISPLAY || ":99", def: ":99", desc: "X display" },
      ],
    },
  ];
  res.json({ ok: true, groups });
});
app.post("/api/config", async (req, res) => {
  const key = String(req.body?.key || "").trim();
  const value = req.body?.value == null ? "" : String(req.body.value);
  const allowed = new Set([
    "PORT","HEADLESS","API_HEADLESS","BROWSER_USER_DATA_DIR","BROWSER_PROFILE_DIR","BROWSER_PATH","CLOAKBROWSER_CACHE_DIR","INSTAGRAM_USER_AGENT","AUTO_CONTINUE","AUTO_CONTINUE_WAIT_MS",
    "AUTO_CAPTURE_TIMEOUT_MS","AUTO_CAPTURE_QUIET_MS","AUTO_CAPTURE_POLL_MS",
    "API_JOB_TIMEOUT_MS","DOWNLOAD_FETCH_TIMEOUT_MS","FFMPEG_TIMEOUT_MS","FFPROBE_TIMEOUT_MS","MANUAL_BROWSER_TIMEOUT_MS",
    "INSTAGRAM_429_COOLDOWN_MS","SAVED_SYNC_STATE_FILE","SAVED_SYNC_QUEUE_FILE","SAVED_SYNC_RETRY_DELAY_MS","SAVED_SYNC_RETRY_COUNT","API_BASE","SNAPSHOT_DIR",
    "ENABLE_VNC","VNC_FLAG","VNC_PORT","NOVNC_PORT","DISPLAY","UI_PANEL_PASSWORD",
  ]);
  if (!key || !allowed.has(key)) return res.status(400).json({ ok: false, error: `Key not allowed: ${key}` });
  if (/[\n\r]/.test(key) || /[\n\r]/.test(value)) return res.status(400).json({ ok: false, error: "Invalid characters" });
  const envPath = path.join(rootDir, ".env");
  try {
    let content = "";
    try { content = await fs.readFile(envPath, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const lines = content ? content.split("\n") : [];
    let found = false;
    const next = lines.map((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      const eq = line.indexOf("=");
      if (eq === -1) return line;
      const k = line.slice(0, eq).trim();
      if (k === key) { found = true; return `${key}=${value}`; }
      return line;
    });
    if (!found) {
      if (next.length && next[next.length - 1] !== "") next.push("");
      next[next.length - 1] === "" ? next[next.length - 1] = `${key}=${value}` : next.push(`${key}=${value}`);
      // ensure no double empty
      const cleaned = next.filter((l, i, a) => !(l === "" && a[i + 1] === ""));
      next.length = 0; next.push(...cleaned);
    }
    // trim trailing empty handling
    let out = next.join("\n");
    if (!out.endsWith("\n")) out += "\n";
    await fs.writeFile(envPath, out, "utf8");
    process.env[key] = value;
    if (key === "UI_PANEL_PASSWORD") UI_PANEL_PASSWORD = String(value).trim();
    res.json({ ok: true, key, value });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/accounts", async (_req, res) => {
  try {
    const appConfig = await loadAppConfig();
    const defaults = resolveProfileConfig();

    const accounts = [{ name: "default", userDataDir: defaults.userDataDir, profileDir: defaults.profileDir, cdpUrl: "" }];
    // default may have cdpUrl stored
    const defaultCfg = appConfig.accounts.find((a) => a && String(a.name).toLowerCase() === "default");
    if (defaultCfg && defaultCfg.cdpUrl) {
      try { accounts[0].cdpUrl = normalizeCdpUrl(defaultCfg.cdpUrl); } catch { accounts[0].cdpUrl = String(defaultCfg.cdpUrl || "").trim(); }
    }
    for (const account of appConfig.accounts) {
      if (!account || !account.name) continue;
      if (String(account.name).toLowerCase() === "default") continue;
      let cdpUrl = "";
      try { cdpUrl = account.cdpUrl ? normalizeCdpUrl(account.cdpUrl) : ""; } catch { cdpUrl = String(account.cdpUrl || "").trim(); }
      accounts.push({
        name: account.name,
        userDataDir: account.userDataDir || defaults.userDataDir,
        profileDir: account.profileDir || defaults.profileDir,
        cdpUrl,
      });
    }

    const enriched = accounts.map((account) => {
      const manual = manualBrowsersByAccount.get(account.name);
      const accountBrowser = browsersByAccount.get(account.name);
      const isShared = account.name === "default" && sharedBrowser;
      const cdpCached = getCachedCdpStatus(account.name);
      // trigger background refresh if stale and has cdpUrl
      if (account.cdpUrl) {
        const age = cdpCached.checkedAt ? Date.now() - new Date(cdpCached.checkedAt).getTime() : Infinity;
        if (!cdpCached.checkedAt || age > CDP_STATUS_TTL_MS) refreshCdpStatusInBackground(account.name);
        // if cache mismatched url, refresh
        if (cdpCached.cdpUrl !== account.cdpUrl) refreshCdpStatusInBackground(account.name);
      }
      const cdpStatus = account.cdpUrl ? (cdpCached.cdpUrl === account.cdpUrl ? cdpCached.status : "checking") : "not_configured";
      return {
        ...account,
        cdpStatus,
        cdpCheckedAt: cdpCached.checkedAt,
        cdpError: cdpCached.error,
        cdpWsEndpoint: cdpCached.wsEndpoint,
        cdpLatencyMs: cdpCached.latencyMs,
        manualOpen: browserIsAlive(manual && manual.browser),
        sharedOpen: Boolean(isShared && browserIsAlive(sharedBrowser)),
        accountBrowserOpen: browserIsAlive(accountBrowser),
        openedAt: manual ? manual.openedAt : null,
      };
    });

    return res.json({ ok: true, accounts: enriched });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/accounts", async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(name)) {
      return res.status(400).json({ ok: false, error: "Account name must be letters/digits/dashes, 1-40 chars, no spaces." });
    }
    const key = name.toLowerCase();
    if (key === "default") {
      return res.status(400).json({ ok: false, error: "\"default\" is the built-in account; use another name." });
    }

    let cdpUrl = "";
    if (body.cdpUrl != null && String(body.cdpUrl).trim()) {
      try { cdpUrl = normalizeCdpUrl(body.cdpUrl); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    }

    const state = await readStateFile();
    const accounts = Array.isArray(state.config?.accounts) ? state.config.accounts : [];
    if (accounts.some((a) => a && String(a.name || "").trim().toLowerCase() === key)) {
      return res.status(409).json({ ok: false, error: `An account named "${name}" already exists.` });
    }

    const defaults = resolveProfileConfig();
    const baseDir = path.dirname(defaults.userDataDir);
    const autoUserDataDir = path.join(baseDir, `account-${key}`);
    const userDataDir = String(body.userDataDir || "").trim() || autoUserDataDir;
    const profileDir = String(body.profileDir || "Default").trim() || "Default";

    const account = { name, userDataDir, profileDir };
    if (cdpUrl) account.cdpUrl = cdpUrl;
    accounts.push(account);
    state.config = state.config || {};
    state.config.accounts = accounts;
    state.updatedAt = new Date().toISOString();
    await writeStateFile(state);
    if (cdpUrl) refreshCdpStatusInBackground(name);

    return res.status(201).json({ ok: true, account });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.put("/accounts/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    const key = name.toLowerCase();
    const body = req.body || {};
    const state = await readStateFile();
    const accounts = Array.isArray(state.config?.accounts) ? state.config.accounts : [];
    let idx = accounts.findIndex((a) => a && String(a.name || "").trim().toLowerCase() === key);
    // allow updating default even though it's not in accounts array — create entry if cdpUrl is being set
    const isDefault = key === "default";
    let existing = idx !== -1 ? accounts[idx] : null;
    if (!existing && !isDefault) return res.status(404).json({ ok: false, error: `Account "${name}" not found` });

    // cdpUrl handling: if field present in body, update; null/empty clears it
    let nextCdpUrl;
    if (Object.prototype.hasOwnProperty.call(body, "cdpUrl")) {
      const raw = body.cdpUrl == null ? "" : String(body.cdpUrl).trim();
      if (!raw) {
        nextCdpUrl = "";
      } else {
        try { nextCdpUrl = normalizeCdpUrl(raw); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
      }
    } else {
      nextCdpUrl = existing ? String(existing.cdpUrl || "").trim() : "";
    }

    let nextProfileDir = existing ? String(existing.profileDir || "Default") : "Default";
    if (Object.prototype.hasOwnProperty.call(body, "profileDir")) {
      nextProfileDir = String(body.profileDir || "Default").trim() || "Default";
    }
    let nextUserDataDir = existing ? String(existing.userDataDir || "").trim() : "";
    if (Object.prototype.hasOwnProperty.call(body, "userDataDir")) {
      nextUserDataDir = String(body.userDataDir || "").trim();
    }

    const prevCdpUrl = existing ? String(existing.cdpUrl || "").trim() : "";
    if (isDefault && idx === -1) {
      // create default entry to store cdpUrl (userDataDir/profileDir stay defaults)
      const defaults = resolveProfileConfig();
      const entry = { name: "default", userDataDir: nextUserDataDir || defaults.userDataDir, profileDir: nextProfileDir, cdpUrl: nextCdpUrl };
      if (!nextCdpUrl) delete entry.cdpUrl;
      accounts.push(entry);
    } else {
      const updated = { ...existing, profileDir: nextProfileDir, userDataDir: nextUserDataDir };
      if (nextCdpUrl) updated.cdpUrl = nextCdpUrl;
      else delete updated.cdpUrl;
      // if was cdpUrl and cleared, keep other fields
      accounts[idx] = updated;
      // if default and cdpUrl cleared and userDataDir/profileDir are defaults, we could remove the entry entirely to keep file clean
      if (isDefault && !nextCdpUrl) {
        const defaults = resolveProfileConfig();
        const isDefaultDirs = (updated.userDataDir || defaults.userDataDir) === defaults.userDataDir && (updated.profileDir || "Default") === defaults.profileDir;
        if (isDefaultDirs) {
          accounts.splice(idx, 1);
        }
      }
    }

    state.config = state.config || {};
    state.config.accounts = accounts;
    state.updatedAt = new Date().toISOString();
    await writeStateFile(state);

    // if cdpUrl changed, close any existing browser for that account so next job reconnects
    if (prevCdpUrl !== nextCdpUrl) {
      try { await closeBrowserForAccount(name); } catch {}
      try { await closeManualBrowser(name); } catch {}
      if (isDefault) try { await closeSharedBrowser(); } catch {}
      cdpStatusCache.delete(normalizeAccountName(name));
      if (nextCdpUrl) refreshCdpStatusInBackground(name);
    }

    const updatedAccount = accounts.find((a) => String(a.name).toLowerCase() === key) || { name, cdpUrl: nextCdpUrl, profileDir: nextProfileDir, userDataDir: nextUserDataDir };
    return res.json({ ok: true, account: updatedAccount });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/accounts/:name/cdp/check", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    const result = await getCdpStatusForAccount(name, { force: true });
    return res.json({ ok: true, cdpUrl: result.cdpUrl, status: result.status, wsEndpoint: result.wsEndpoint, error: result.error, latencyMs: result.latencyMs, checkedAt: result.checkedAt });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/accounts/:name/cdp/status", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    const cached = getCachedCdpStatus(name);
    // if no cached and has cdpUrl, trigger background refresh
    try {
      const appConfig = await loadAppConfig();
      const cfg = resolveAccountConfig(name, appConfig.accounts);
      if (cfg.cdpUrl && !cached.checkedAt) refreshCdpStatusInBackground(name);
    } catch {}
    return res.json({ ok: true, ...cached });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/accounts/default/reset", async (_req, res) => {
  try {
    await closeSharedBrowser();
    await closeManualBrowser("default");
    await closeBrowserForAccount("default");
    const defaults = resolveProfileConfig();
    const profilePath = path.join(defaults.userDataDir, defaults.profileDir);
    try { await fs.rm(profilePath, { recursive: true, force: true }); } catch {}
    await fs.mkdir(profilePath, { recursive: true });
    return res.json({ ok: true, reset: "default" });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});
app.delete("/accounts/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    const key = name.toLowerCase();
    if (key === "default") {
      return res.status(400).json({ ok: false, error: "The built-in \"default\" account cannot be deleted. Use Reset instead." });
    }

    await closeManualBrowser(name);
    await closeBrowserForAccount(name);
    cdpStatusCache.delete(normalizeAccountName(name));

    const state = await readStateFile();
    const accounts = Array.isArray(state.config?.accounts) ? state.config.accounts : [];
    state.config = state.config || {};
    state.config.accounts = accounts.filter(
      (a) => a && String(a.name || "").trim().toLowerCase() !== key
    );
    state.updatedAt = new Date().toISOString();
    await writeStateFile(state);

    return res.json({ ok: true, account: name });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/sync-config", async (_req, res) => {
  try {
    const state = await readStateFile();
    const queue = await readQueueFile();
    return res.json({
      ok: true,
      config: state.config || { accounts: [], savedLists: [] },
      lists: state.lists || {},
      queue: { pending: queue.pending, completed: queue.completed },
      crawlAll: crawlAllState,
      updatedAt: state.updatedAt || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/sync-config", async (req, res) => {
  try {
    const body = req.body || {};
    const accounts = normalizeAccountsInput(body.accounts);
    const savedLists = normalizeSavedListsInput(body.savedLists);

    const state = await readStateFile();
    if (!state.config || typeof state.config !== "object") {
      state.config = { accounts: [], savedLists: [] };
    }
    state.config.accounts = accounts;
    state.config.savedLists = savedLists;
    state.updatedAt = new Date().toISOString();
    await writeStateFile(state);
    // trigger real-time sync soon after list change
    setTimeout(() => { void backgroundSyncTick(); }, 5000);

    return res.json({ ok: true, config: state.config });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});
// ---- Crawl-all batch: runs server-side so a page refresh cannot stop it ----
let crawlAllState = null;

async function selfPost(pathname, body) {
  const headers = { "Content-Type": "application/json" };
  const pw = String(process.env.UI_PANEL_PASSWORD || process.env.ADMIN_PASSWORD || "").trim();
  if (pw) headers["x-panel-password"] = pw;
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST", headers, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function broadcastCrawlAll() {
  wsBroadcast({ type: "crawl-all", crawlAll: crawlAllState ? { ...crawlAllState } : null });
}

async function runCrawlAllBatch() {
  try {
    const st = await readStateFile();
    const lists = (Array.isArray(st.config?.savedLists) ? st.config.savedLists : []).filter((l) => l && String(l.url || "").trim());
    crawlAllState.total = lists.length;
    broadcastCrawlAll();
    for (let i = 0; i < lists.length; i++) {
      if (!crawlAllState.running || crawlAllState.cancelled) break;
      const l = lists[i];
      crawlAllState.idx = i;
      crawlAllState.url = String(l.url).trim();
      crawlAllState.folder = String(l.folder || "");
      broadcastCrawlAll();
      console.log(`[crawl-all] ${i + 1}/${lists.length} ${crawlAllState.folder || crawlAllState.url}`);
      try {
        await selfPost("/scan-saved", { url: crawlAllState.url, account: String(l.account || "default"), folder: crawlAllState.folder });
      } catch (e) {
        crawlAllState.error = `${crawlAllState.folder || crawlAllState.url}: ${e.message}`;
        console.error(`[crawl-all] failed: ${crawlAllState.error}`);
        broadcastCrawlAll();
      }
    }
    if (crawlAllState.downloadAfter && crawlAllState.running && !crawlAllState.cancelled) {
      crawlAllState.phase = "download";
      crawlAllState.url = "";
      crawlAllState.folder = "";
      broadcastCrawlAll();
      const queue = await readQueueFile();
      const pend = Array.isArray(queue.pending) ? queue.pending : [];
      const byFolder = {};
      for (const p of pend) { const f = String(p.folder || ""); (byFolder[f] = byFolder[f] || []).push(p.url); }
      for (const [f, us] of Object.entries(byFolder)) await selfPost("/queue/add", { urls: us, folder: f });
      for (const p of pend) await selfPost("/sync-queue/pending/remove", { url: p.url });
      console.log(`[crawl-all] queued ${pend.length} item(s) for download`);
    }
  } catch (e) {
    crawlAllState.error = e.message;
    console.error(`[crawl-all] batch error: ${e.message}`);
  } finally {
    crawlAllState.running = false;
    crawlAllState.finishedAt = new Date().toISOString();
    broadcastCrawlAll();
    console.log(`[crawl-all] done${crawlAllState.cancelled ? " (cancelled)" : ""}`);
  }
}

app.post("/collections/crawl-all", async (req, res) => {
  if (shuttingDown) return res.status(503).json({ ok: false, error: "Server is shutting down." });
  if (crawlAllState && crawlAllState.running) {
    return res.status(409).json({ ok: false, error: "Crawl-all already running.", crawlAll: crawlAllState });
  }
  if (scanActiveJob) {
    return res.status(429).json({ ok: false, error: `Another scan is currently running (job ${scanActiveJob.id}). Try again when it finishes.` });
  }
  const st = await readStateFile();
  const total = (Array.isArray(st.config?.savedLists) ? st.config.savedLists : []).filter((l) => l && String(l.url || "").trim()).length;
  if (!total) return res.json({ ok: true, started: false, total: 0, crawlAll: null });
  crawlAllState = {
    running: true,
    phase: "crawl",
    idx: -1,
    total,
    url: "",
    folder: "",
    error: null,
    cancelled: false,
    downloadAfter: Boolean(req.body?.downloadAfter),
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  broadcastCrawlAll();
  void runCrawlAllBatch();
  return res.json({ ok: true, started: true, total, downloadAfter: crawlAllState.downloadAfter, crawlAll: { ...crawlAllState } });
});

app.post("/collections/crawl-all/cancel", (_req, res) => {
  if (crawlAllState && crawlAllState.running) {
    crawlAllState.cancelled = true;
    broadcastCrawlAll();
  }
  return res.json({ ok: true, cancelled: Boolean(crawlAllState && crawlAllState.running) });
});

app.post("/collections/clear-memory", async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });
    const state = await readStateFile();
    if (state.lists[url]) {
      delete state.lists[url].lastSeenUrl;
      delete state.lists[url].lastRunAt;
      delete state.lists[url].lastScannedCount;
      await writeStateFile(state);
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});
app.post("/collections/set-last-seen", async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    const lastSeenUrl = String(req.body?.lastSeenUrl || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });
    if (!lastSeenUrl) return res.status(400).json({ ok: false, error: "lastSeenUrl required" });
    try { new URL(lastSeenUrl); } catch { return res.status(400).json({ ok: false, error: "lastSeenUrl must be a valid URL" }); }
    const state = await readStateFile();
    if (!state.lists[url]) state.lists[url] = {};
    state.lists[url].lastSeenUrl = lastSeenUrl;
    state.lists[url].lastRunAt = new Date().toISOString();
    if (!Number.isFinite(Number(state.lists[url].lastScannedCount))) state.lists[url].lastScannedCount = 0;
    await writeStateFile(state);
    return res.json({ ok: true, lastSeenUrl });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});
app.post("/collections/resume", async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    const account = String(req.body?.account || "").trim();
    if (url) {
      await clearFlagForCollections(url);
      return res.json({ ok: true });
    }
    if (account) {
      await clearFlagForCollections(account, { isAccount: true });
      return res.json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: "url or account required" });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/sync-queue/clear", async (_req, res) => {
  try {
    const result = await withQueueFile(async () => {
      const queue = await readQueueFile();
      const cleared = Array.isArray(queue.completed) ? queue.completed.length : 0;
      queue.completed = [];
      await writeQueueFile(queue);
      return cleared;
    });
    return res.json({ ok: true, cleared: result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/sync-queue/pending/add", async (req, res) => {
  try {
    const body = req.body || {};
    const rawUrls = Array.isArray(body.urls) ? body.urls.map((value) => String(value || "").trim()).filter(Boolean) : [];
    if (!rawUrls.length) {
      return res.status(400).json({ ok: false, error: "Field 'urls' is required (array of URLs)." });
    }
    const folder = String(body.folder || "").trim();
    const result = await withQueueFile(async () => {
      const queue = await readQueueFile();
      const pendingSet = new Set();
      for (const item of queue.pending) {
        if (item && item.url) pendingSet.add(normalizeSyncUrl(item.url));
      }
      let added = 0;
      let skipped = 0;
      for (const rawUrl of rawUrls) {
        const normalized = normalizeSyncUrl(rawUrl);
        if (!normalized || pendingSet.has(normalized)) {
          skipped += 1;
          continue;
        }
        pendingSet.add(normalized);
        queue.pending.push({ url: rawUrl, folder, addedAt: new Date().toISOString() });
        added += 1;
      }
      await writeQueueFile(queue);
      return { added, skipped, pending: queue.pending.length };
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/sync-queue/pending/remove", async (req, res) => {
  try {
    const body = req.body || {};
    const target = String(body.url || "").trim();
    if (!target) {
      return res.status(400).json({ ok: false, error: "Field 'url' is required." });
    }
    const removed = await withQueueFile(async () => {
      const queue = await readQueueFile();
      const normalizedTarget = normalizeSyncUrl(target);
      const before = queue.pending.length;
      queue.pending = queue.pending.filter((item) => {
        if (!item || !item.url) return false;
        const itemUrl = String(item.url).trim();
        return !(itemUrl === target || normalizeSyncUrl(itemUrl) === normalizedTarget);
      });
      const removed = before - queue.pending.length;
      await writeQueueFile(queue);
      return removed;
    });
    return res.json({ ok: true, removed });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/open-browser", async (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ ok: false, error: "Server is shutting down." });
  }

  const accountName = normalizeAccountName(req.body?.account || req.query?.account);
  // CDP profiles have no VNC — reject with guidance
  try {
    const appConfig = await loadAppConfig();
    const cfg = resolveAccountConfig(accountName, appConfig.accounts);
    if (cfg.cdpUrl) {
      const st = await getCdpStatusForAccount(accountName, { force: true });
      return res.status(400).json({ ok: false, error: `CDP profile "${accountName}" has no VNC — remote browser is ${st.status}. Use Test to check CDP.`, cdpStatus: st.status, cdpError: st.error });
    }
  } catch {}

  const existing = manualBrowsersByAccount.get(accountName);
  if (existing && existing.browser) {
    try {
      const connected = existing.browser.isConnected ? existing.browser.isConnected() : true;
      const pages = connected ? await existing.browser.pages().catch(() => []) : [];
      if (connected && pages.length > 0) {
        return res.status(409).json({
          ok: false,
          error: `A manual browser is already open for account "${accountName}". Close it first.`,
        });
      }
      await closeManualBrowser(accountName, existing.browser);
    } catch {}
  }

  const minutes = parsePositiveInt(req.body?.minutes ?? req.query?.minutes, 0);
  const timeoutMs = minutes > 0 ? minutes * 60000 : manualBrowserTimeoutMs;

  const jobId = ++jobCounter;
  activeJob = { id: jobId, type: "open-browser", startedAt: Date.now() };

  let clientDisconnected = false;
  const logToClientAndConsole = (message) => {
    const text = String(message == null ? "" : message);
    if (!text) return;

    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    for (const line of lines) {
      console.log(`[open-browser:${jobId}] ${line}`);
    }

    if (!clientDisconnected && !res.writableEnded) {
      res.write(text.endsWith("\n") ? text : `${text}\n`);
    }
  };

  req.on("aborted", () => {
    clientDisconnected = true;
  });

  res.on("close", () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
    }
  });

  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  let browser = null;
  try {
    await withVncLock(async () => {
      try { await execAsync("/usr/local/bin/vnc-start"); } catch {}
      for (let i = 0; i < 10; i++) {
        if (await isVncProcessRunning()) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    });
    logToClientAndConsole(`[open-browser] Opening visible browser for account "${accountName}" (auto-close after ${Math.round(timeoutMs / 60000)} min)...`);

    if (accountName === "default" && sharedBrowser) {
      logToClientAndConsole("[open-browser] Closing shared browser so the profile is not locked...");
      await closeSharedBrowser();
    }

    const appConfig = await loadAppConfig();
    const config = resolveAccountConfig(accountName, appConfig.accounts);
    logToClientAndConsole(`[open-browser] Profile: ${config.userDataDir}/${config.profileDir}`);

    browser = await buildBrowserFromLocalProfile({
      headless: false,
      account: accountName,
      log: logToClientAndConsole,
    });

    const openedAt = Date.now();
    let timer = null;
    manualBrowsersByAccount.set(accountName, { browser, openedAt, timer });

    browser.on("disconnected", () => {
      const entry = manualBrowsersByAccount.get(accountName);
      if (entry && entry.browser === browser) {
        if (entry.timer) clearTimeout(entry.timer);
        manualBrowsersByAccount.delete(accountName);
        // Do NOT call vnc-stop here — frontend handles VNC lifecycle
      }
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    const handlePageClose = async () => {
      try {
        const pages = await browser.pages().catch(() => []);
        if (!pages.length) {
          console.log(`[open-browser:${jobId}] last page closed for "${accountName}" — closing browser`);
          await closeManualBrowser(accountName, browser);
        }
      } catch {}
    };
    page.on("close", handlePageClose);
    browser.on("targetdestroyed", async () => {
      try {
        const pages = await browser.pages().catch(() => []);
        if (!pages.length) {
          console.log(`[open-browser:${jobId}] target destroyed, no pages left for "${accountName}" — closing`);
          await closeManualBrowser(accountName, browser);
        }
      } catch {}
    });

    logToClientAndConsole(
      "\n[open-browser] Browser is open and visible in the VNC session. It starts on a blank tab."
    );
    logToClientAndConsole(
      `[open-browser] Use http://${req.hostname.split(":")[0]}:6778/vnc.html to control it.`
    );
    logToClientAndConsole(
      `[open-browser] It will auto-close in ${Math.round(timeoutMs / 60000)} min unless closed sooner.`
    );

    const entry = manualBrowsersByAccount.get(accountName);
    timer = setTimeout(() => {
      console.log(`[open-browser:${jobId}] Auto-close timer expired (${Math.round(timeoutMs / 60000)} min). Closing browser for "${accountName}".`);
      void closeManualBrowser(accountName, browser);
    }, timeoutMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
    if (entry) {
      entry.timer = timer;
    }

    logToClientAndConsole("\n[open-browser] Browser ready. Keep using the VNC session, or press Close browser when done.\n");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`[open-browser:${jobId}] failed: ${message}`);
    logToClientAndConsole(`\n[open-browser] process failed: ${message}`);
    await closeManualBrowser(accountName, browser);
  } finally {
    activeJob = null;
    if (!res.writableEnded) {
      res.end();
    }
  }
});

app.post("/close-browser", async (req, res) => {
  const accountName = normalizeAccountName(req.body?.account || req.query?.account);
  const entry = manualBrowsersByAccount.get(accountName);
  if (!entry || !entry.browser) {
    return res.json({ ok: true, alreadyClosed: true, account: accountName });
  }

  try {
    await closeManualBrowser(accountName, entry.browser);
    return res.json({ ok: true, alreadyClosed: false, account: accountName });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/download", async (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ ok: false, error: "Server is shutting down." });
  }

  if (activeJob) {
    return res.status(429).json({
      ok: false,
      error: `Another task is currently running (job ${activeJob.id}, type=${activeJob.type}). Try again when it finishes.`,
    });
  }

  const manualDefault = manualBrowsersByAccount.get("default");
  if (manualDefault && manualDefault.browser && manualDefault.browser.isConnected && manualDefault.browser.isConnected()) {
    return res.status(409).json({
      ok: false,
      error: "A manual browser is open on the default profile. Close it before downloading.",
    });
  }

  const link = String(req.body?.link || req.query?.link || "").trim();
  if (!link) {
    return res.status(400).json({ ok: false, error: "Field 'link' is required." });
  }

  let outputDir = mediaDir;
  let maxQuality = null;
  let folder = "";
  try {
    folder = String(req.body?.folder || req.query?.folder || "").trim();
    outputDir = resolveMediaOutputDir(folder);
    maxQuality = resolveMaxQuality(req.body?.maxQuality ?? req.query?.maxQuality);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
  const account = normalizeAccountName(req.body?.account || req.query?.account || folder === "reddit" ? "elk" : "default");
  // check manual browser for that account
  const manualForAccount = manualBrowsersByAccount.get(account);
  if (manualForAccount && manualForAccount.browser && manualForAccount.browser.isConnected && manualForAccount.browser.isConnected()) {
    return res.status(409).json({
      ok: false,
      error: `A manual browser is open on account "${account}". Close it before downloading.`,
    });
  }

  const jobId = ++jobCounter;
  activeJob = { id: jobId, type: "download", startedAt: Date.now() };

  let clientDisconnected = false;
  const logToClientAndConsole = (message) => {
    const text = String(message == null ? "" : message);
    if (!text) return;

    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    for (const line of lines) {
      console.log(`[scan:${jobId}] ${line}`);
    }

    if (!clientDisconnected && !res.writableEnded) {
      res.write(text.endsWith("\n") ? text : `${text}\n`);
    }
  };

  req.on("aborted", () => {
    clientDisconnected = true;
  });

  res.on("close", () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
    }
  });

  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    logToClientAndConsole("[api] preparing browser...");
    const isDefaultAccount = account === "default";
    const browser = isDefaultAccount
      ? await getSharedBrowser(logToClientAndConsole)
      : await getBrowserForAccount(account, `download-${jobId}`);
    logToClientAndConsole(`[api] browser ready (${account}), starting scan...\n`);

    const recycle = isDefaultAccount ? closeSharedBrowser : () => closeBrowserForAccount(account);
    const result = await runWithJobTimeout(
      run({
        urls: [link],
        linkOnly: false,
        outputDir,
        maxQuality,
        browser,
        account,
        autoContinuePrompts: true,
        waitForCompletionPrompt: false,
        log: logToClientAndConsole,
      }),
      {
        timeoutMs: apiJobTimeoutMs,
        jobId,
        jobType: "download",
        log: logToClientAndConsole,
        recycleBrowser: recycle,
      }
    );

    const failedTargets = Array.isArray(result?.failedTargets) ? result.failedTargets : [];
    for (const failure of failedTargets) {
      logToClientAndConsole(`\n[api] No media downloaded for: ${failure.url} (${failure.reason})`);
    }
    logToClientAndConsole(
      `\n[api] process finished (exit=${failedTargets.length ? 1 : 0}, signal=none)`
    );
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`[scan:${jobId}] failed: ${message}`);
    logToClientAndConsole(`\n[api] process failed: ${message}`);

    try {
      if (account !== "default") {
        const b = browsersByAccount.get(account);
        if (b && b.isConnected && !b.isConnected()) await closeBrowserForAccount(account, b);
      } else if (sharedBrowser && sharedBrowser.isConnected && !sharedBrowser.isConnected()) {
        await closeSharedBrowser();
      }
    } catch {}
  } finally {
    activeJob = null;
    if (!res.writableEnded) {
      res.end();
    }
  }
});

app.post("/scan-saved", async (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ ok: false, error: "Server is shutting down." });
  }

  if (scanActiveJob) {
    return res.status(429).json({
      ok: false,
      error: `Another scan is currently running (job ${scanActiveJob.id}). Try again when it finishes.`,
    });
  }

  const targetUrl = String(req.body?.url || req.query?.url || "").trim();
  if (!targetUrl) {
    return res.status(400).json({ ok: false, error: "Field 'url' is required." });
  }

  try {
    new URL(targetUrl);
  } catch {
    return res.status(400).json({ ok: false, error: "Field 'url' must be a valid absolute URL." });
  }

  if (scanningUrls.has(targetUrl)) {
    return res.status(429).json({ ok: false, error: `Scan for this collection is already running. Wait for it to finish.` });
  }

  const account = normalizeAccountName(req.body?.account || req.query?.account);
  const endUrls = normalizeEndUrls(req.body?.endUrls ?? req.query?.endUrls);
  const folderParam = String(req.body?.folder || req.query?.folder || "").trim();
  // UI crawls never send endUrls — the server always uses the freshly stored
  // lastSeenUrl so the marker can never be stale or wrong.
  let effectiveEndUrls = endUrls;
  if (folderParam && !effectiveEndUrls.length) {
    try {
      const stNow = await readStateFile();
      const lsMarker = String((stNow.lists[targetUrl] || {}).lastSeenUrl || "").trim();
      if (lsMarker) effectiveEndUrls = [lsMarker];
    } catch {}
  }
  const jobId = ++jobCounter;
  scanActiveJob = { id: jobId, type: "scan-saved", startedAt: Date.now() };
  scanningUrls.add(targetUrl);

  const manualForAccount = manualBrowsersByAccount.get(account);
  if (manualForAccount && manualForAccount.browser && manualForAccount.browser.isConnected && manualForAccount.browser.isConnected()) {
    activeJob = null;
    return res.status(409).json({
      ok: false,
      error: `A manual browser is open on account "${account}". Close it before scanning.`,
    });
  }

  wsBroadcast({ type: "crawl:progress", url: targetUrl, stage: "crawling", detail: "Opening collection…" });
  try {
    const browser = account === "default"
      ? await getSharedBrowser((message) => {
          const text = String(message == null ? "" : message).trim();
          if (!text) return;
          console.log(`[scan-saved:${jobId}] ${text}`);
        })
      : await getBrowserForAccount(account, jobId);

    const result = await runWithJobTimeout(
      scanSavedPage({
        browser,
        targetUrl,
        endUrls: effectiveEndUrls,
        log: (message) => {
          const text = String(message == null ? "" : message).trim();
          if (!text) return;
          console.log(`[scan-saved:${jobId}] ${text}`);
          // forward live crawl log (scrolling, items found)
          wsBroadcast({ type: "crawl:progress", url: targetUrl, stage: "crawling", detail: text.slice(0, 200) });
          if (text.toLowerCase().includes("found") || text.toLowerCase().includes("scroll")) {
            wsBroadcast({ type: "crawl:log", url: targetUrl, text: text.slice(0, 300) });
          }
        },
      }),
      {
        timeoutMs: apiJobTimeoutMs,
        jobId,
        jobType: "scan-saved",
        recycleBrowser:
          account === "default"
            ? closeSharedBrowser
            : () => closeBrowserForAccount(account, browser),
      }
    );
    const foundCount = Array.isArray(result.urls) ? result.urls.length : 0;
    let collectInfo = null;
    if (folderParam) {
      collectInfo = await crawlCollectAndQueue(targetUrl, folderParam, result.urls, foundCount, account);
      wsBroadcast({ type: "crawl:progress", url: targetUrl, stage: "done", detail: `Found ${foundCount} · queued ${collectInfo.added}`, count: foundCount });
      console.log(`[scan-saved:${jobId}] ${folderParam}: found=${foundCount} new=${collectInfo.newCount} queued=${collectInfo.added} alreadyPending=${collectInfo.skippedPending}`);
    } else {
      wsBroadcast({ type: "crawl:progress", url: targetUrl, stage: "done", detail: `Found ${foundCount} items`, count: foundCount });
      // persist last crawl time/count for Collections page (so "x ago" updates without refresh via background sync)
      try {
        const st = await readStateFile();
        const key = String(targetUrl).trim();
        if (st.lists[key] || (Array.isArray(st.config?.savedLists) && st.config.savedLists.some((l) => String(l.url).trim() === key))) {
          const resultUrls = Array.isArray(result.urls) ? result.urls.map((u) => String(u).trim()) : [];
          const firstPostUrl = resultUrls.find((u) => /instagram\.com\/(?:p|reel|tv)\//i.test(u) || /reddit\.com\/r\/[^/]+\/comments\//i.test(u)) || resultUrls[0] || "";
          st.lists[key] = { ...(st.lists[key] || {}), ...(firstPostUrl ? { lastSeenUrl: firstPostUrl } : {}), lastRunAt: new Date().toISOString(), lastScannedCount: foundCount, folder: st.lists[key]?.folder || "" };
          if (st.lists[key].paused) { delete st.lists[key].paused; delete st.lists[key].lastError; delete st.lists[key].lastErrorAt; }
          await writeStateFile(st);
        }
      } catch {}
    }
    await clearFlagForCollections(account, { isAccount: true }).catch(() => {});

    return res.json({
      ok: true,
      ...result,
      ...(collectInfo ? { queued: collectInfo.added, skippedPending: collectInfo.skippedPending, pendingTotal: collectInfo.pendingTotal, newCount: collectInfo.newCount } : {}),
    });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const isRedirect = /redirected from saved page|Make sure this browser profile is logged/i.test(message);
      if (isRedirect) {
        await flagCollectionsForAccount(account, `Login expired — redirected`).catch(() => {});
        wsBroadcast({ type: "crawl:progress", url: targetUrl, stage: "error", detail: `Login expired — paused all for ${account}` });
      }
      const statusCode = Number(error && error.status) === 429 || /429|too many requests/i.test(message) ? 429 : 500;
      console.error(`[scan-saved:${jobId}] failed: ${message}`);
      wsBroadcast({ type: "crawl:progress", url: targetUrl, stage: "error", detail: message.slice(0, 200) });
      return res.status(statusCode).json({ ok: false, error: message, flagged: isRedirect });
    } finally {
    scanActiveJob = null;
    scanningUrls.delete(targetUrl);
  }
});

// --- Queue API ---
app.get("/queue", async (_req, res) => {
  if (!queueLoaded) await loadWebQueue();
  res.json({ ok: true, active: webQueue.active, completed: webQueue.completed, gap: webQueue.gap || { minMs: 0, maxMs: 0 }, gapWait: gapWaitState, paused: queuePaused });
});
app.post("/queue/add", async (req, res) => {
  const urls = Array.isArray(req.body?.urls)
    ? req.body.urls
    : req.body?.url
      ? [req.body.url]
      : Array.isArray(req.body?.links)
        ? req.body.links
        : [];
  const folder = String(req.body?.folder || "").trim();
  const account = String(req.body?.account || "").trim() || "default";
  const maxQuality = req.body?.maxQuality ?? null;
  const link = String(req.body?.link || "").trim();
  const allUrls = link ? [link, ...urls] : urls;
  const normalized = allUrls.map((u) => String(u || "").trim()).filter(Boolean);
  if (!normalized.length) return res.status(400).json({ ok: false, error: "No URLs provided" });
  const added = await queueAddUrls(normalized, folder, maxQuality, account);
  res.json({ ok: true, added: added.length, active: webQueue.active, completed: webQueue.completed });
});
app.post("/queue/remove", async (req, res) => {
  const id = String(req.body?.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  if (!queueLoaded) await loadWebQueue();
  const beforeA = webQueue.active.length;
  const beforeC = webQueue.completed.length;
  webQueue.active = webQueue.active.filter((it) => it.id !== id);
  webQueue.completed = webQueue.completed.filter((it) => it.id !== id);
  if (webQueue.active.length !== beforeA || webQueue.completed.length !== beforeC) {
    wsBroadcastQueue();
    await saveWebQueue();
  }
  res.json({ ok: true });
});
app.post("/queue/retry", async (req, res) => {
  const id = String(req.body?.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  if (!queueLoaded) await loadWebQueue();
  const item = webQueue.completed.find((it) => it.id === id);
  if (!item) return res.status(404).json({ ok: false, error: "not found in completed" });
  if (item.status !== "error" && item.status !== "done") return res.status(400).json({ ok: false, error: "only error/done can be retried" });
  webQueue.completed = webQueue.completed.filter((it) => it.id !== id);
  const retried = { ...item, status: "queued", stage: "queued", pct: 0, error: undefined, finishedAt: undefined, logs: [] };
  webQueue.active.push(retried);
  wsBroadcastQueue();
  await saveWebQueue();
  queueEmitter.emit("wake");
  ensureQueueWorker();
  res.json({ ok: true, item: retried });
});
app.post("/queue/clear", async (req, res) => {
  const which = String(req.body?.which || "completed").trim();
  if (!queueLoaded) await loadWebQueue();
  if (which === "completed" || which === "all") webQueue.completed = [];
  if (which === "all") {
    webQueue.active = webQueue.active.filter((it) => it.status === "running");
  }
  if (which === "active") webQueue.active = webQueue.active.filter((it) => it.status === "running");
  wsBroadcastQueue();
  await saveWebQueue();
  res.json({ ok: true });
});
app.post("/queue/cancel", async (req, res) => {
  const id = String(req.body?.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  if (!queueLoaded) await loadWebQueue();
  const running = webQueue.active.find((it) => it.id === id && it.status === "running");
  if (!running) return res.status(404).json({ ok: false, error: "no running item with that id" });
  cancelRequestedId = id;
  queueEmitter.emit("cancel", id);
  // try to abort browser to interrupt page.goto/download quickly
  try { if (sharedBrowser) await closeSharedBrowser(); } catch {}
  res.json({ ok: true, cancelling: id });
});
app.post("/queue/pause", async (_req, res) => {
  queuePaused = true;
  wsBroadcast({ type: "queue:paused", paused: true });
  res.json({ ok: true, paused: true });
});
app.post("/queue/resume", async (_req, res) => {
  queuePaused = false;
  queueEmitter.emit("resume");
  queueEmitter.emit("wake");
  wsBroadcast({ type: "queue:paused", paused: false });
  res.json({ ok: true, paused: false });
});
app.post("/queue/gap", async (req, res) => {
  const minS = Math.max(0, Number(req.body?.minSeconds) || 0);
  const maxS = Math.max(0, Number(req.body?.maxSeconds) || 0);
  if (minS > 0 && maxS <= 0) { res.status(400).json({ ok: false, error: "maxSeconds required when minSeconds set" }); return; }
  webQueue.gap = { minMs: Math.round(minS * 1000), maxMs: Math.round(Math.max(maxS, minS) * 1000) };
  await saveWebQueue();
  wsBroadcastQueue();
  queueEmitter.emit("gapchange");
  res.json({ ok: true, gap: webQueue.gap });
});

// SPA fallback for BrowserRouter — must be AFTER all /api, /queue, /health routes
app.get("/{*splat}", (req, res, next) => {
  if (req.path === "/media" || req.path === "/media/") {
    const distIndex = path.join(webDistDir, "index.html");
    if (fsSync.existsSync(distIndex)) return res.sendFile(distIndex);
    return next();
  }
  if (req.path.startsWith("/api/") || req.path.startsWith("/queue") || req.path.startsWith("/media/") || req.path === "/health" || req.path === "/ws" || req.path.startsWith("/health")) return next();
  const distIndex = path.join(webDistDir, "index.html");
  if (fsSync.existsSync(distIndex)) return res.sendFile(distIndex);
  return next();
});

let wss = null;
const server = http.createServer(app);
wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", async (ws) => {
  if (!queueLoaded) await loadWebQueue();
  ws.send(JSON.stringify({ type: "queue:snapshot", active: webQueue.active, completed: webQueue.completed, gap: webQueue.gap || { minMs: 0, maxMs: 0 }, gapWait: gapWaitState, paused: queuePaused }));
  ws.send(
    JSON.stringify({
      type: "health",
      ok: true,
      shuttingDown,
      busy: Boolean(activeJob || scanActiveJob || queueActiveJob),
      browserReady: Boolean(sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()),
    })
  );
  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg.type === "queue:add" && Array.isArray(msg.urls)) {
        await queueAddUrls(msg.urls, msg.folder, msg.maxQuality);
      }
    } catch {}
  });
});
// broadcast health every 5s
setInterval(() => {
  if (!wss) return;
  wsBroadcast({
    type: "health",
    ok: true,
    shuttingDown,
    busy: Boolean(activeJob || scanActiveJob || queueActiveJob),
    browserReady: Boolean(sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()),
  });
}, 5000);

server.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
  void loadWebQueue().then(() => ensureQueueWorker());
  void getSharedBrowser((message) => {
    const text = String(message == null ? "" : message).trim();
    if (!text) return;
    console.log(`[browser] ${text}`);
  }).catch((error) => {
    console.error(`[browser] initial launch failed: ${error.message}`);
  });
  // background sync: real-time collection scanning inside app (replaces sync container)
  void startBackgroundSync();
});

setupShutdownHandlers(server);

function parseScheduleToMs(schedule) {
  const s = String(schedule || "30m").trim().toLowerCase();
  if (s === "manual" || s === "off" || s === "never") return Infinity;
  const m = s.match(/^(\d+)\s*(m|min|h|hour|d|day)?$/);
  if (m) {
    const n = Number(m[1]);
    const unit = (m[2] || "m").toLowerCase();
    if (unit.startsWith("h")) return n * 60 * 60 * 1000;
    if (unit.startsWith("d")) return n * 24 * 60 * 60 * 1000;
    return n * 60 * 1000;
  }
  // fallback cron-like "0 */6 * * *" not parsed — treat as 30m
  return 30 * 60 * 1000;
}
let syncRunning = false;
async function backgroundSyncTick() {
  if (syncRunning) return;
  if (crawlAllState && crawlAllState.running) {
    console.log("[sync] skip tick — crawl-all batch running");
    return;
  }
  syncRunning = true;
  try {
    const state = await readStateFile();
    const lists = Array.isArray(state.config?.savedLists) ? state.config.savedLists : [];
    if (!lists.length) return;
    console.log(`[sync] checking ${lists.length} collection(s)`);
    for (const item of lists) {
      // respect per-list schedule
      const schedule = String(item.schedule || "30m");
      const intervalMs = parseScheduleToMs(schedule);
      if (!Number.isFinite(intervalMs)) continue; // manual
      const curUrl = String(item.url || "").trim();
      const listState = state.lists[curUrl] || {};
      if (listState.paused) {
        console.log(`[sync] skip ${item.folder || curUrl} — paused: ${listState.lastError || "flagged"}`);
        continue;
      }
      const lastRun = listState.lastRunAt ? new Date(listState.lastRunAt).getTime() : 0;
      if (Date.now() - lastRun < intervalMs) {
        console.log(`[sync] skip ${item.folder || curUrl} — schedule ${schedule}, next in ${Math.round((intervalMs - (Date.now() - lastRun))/60000)}m`);
        continue;
      }
      if (shuttingDown) break;
      const targetUrl = curUrl;
      if (!targetUrl) continue;
      const account = normalizeAccountName(item.account);
      const folder = String(item.folder || "").trim();
      const lastSeen = String(listState.lastSeenUrl || "").trim();
      const endUrls = lastSeen ? [lastSeen] : [];
      console.log(`[sync] scanning ${folder || targetUrl} (account:${account}) stop:${lastSeen || "<none>"})`);
      let browser = null;
      try {
        browser = account === "default" ? await getSharedBrowser((m) => console.log(`[sync:${account}] ${m}`)) : await getBrowserForAccount(account, `sync-${Date.now()}`);
        const result = await scanSavedPage({ browser, targetUrl, endUrls, log: (m) => console.log(`[sync] ${m}`) });
        const urls = Array.isArray(result.urls) ? result.urls.map((u) => String(u).trim()).filter(Boolean) : [];
        // success — clear login-expired flags for all collections of this account
        for (const u of (state.config?.savedLists || []).filter((x) => String(x.account || "default").trim() === account).map((x) => String(x.url).trim())) {
          if (state.lists[u]?.paused || state.lists[u]?.lastError) {
            delete state.lists[u].paused;
            delete state.lists[u].lastError;
            delete state.lists[u].lastErrorAt;
          }
        }
        if (!urls.length) {
          console.log(`[sync] ${folder} → 0 new`);
          state.lists[targetUrl] = { ...(state.lists[targetUrl] || {}), lastRunAt: new Date().toISOString(), folder };
          await writeStateFile(state);
          continue;
        }
        // filter to only new until lastSeen
        const firstPostUrl = urls.find((u) => /instagram\.com\/(?:p|reel|tv)\//i.test(u) || /reddit\.com\/r\/[^/]+\/comments\//i.test(u)) || urls[0] || "";
        let newUrls = urls;
        if (lastSeen) {
          const idx = urls.findIndex((u) => normalizeSyncUrl(u) === normalizeSyncUrl(lastSeen));
          if (idx !== -1) newUrls = urls.slice(0, idx);
        }
        if (!newUrls.length) {
          console.log(`[sync] ${folder} → 0 new (up to lastSeen)`);
          state.lists[targetUrl] = { ...(state.lists[targetUrl] || {}), lastRunAt: new Date().toISOString(), folder };
          await writeStateFile(state);
          continue;
        }
        const addedItems = await queueAddUrls(newUrls, folder, null, account);
        console.log(`[sync] ${folder} → ${newUrls.length} new, ${addedItems.length} enqueued to web queue (account:${account})`);
        state.lists[targetUrl] = { ...(state.lists[targetUrl] || {}), ...(firstPostUrl ? { lastSeenUrl: firstPostUrl } : {}), lastRunAt: new Date().toISOString(), folder };
        await writeStateFile(state);
        wsBroadcast({ type: "sync:tick", folder, added: addedItems.length, total: newUrls.length });
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        const isRedirect = /redirected from saved page|Make sure this browser profile is logged/i.test(msg);
        if (isRedirect) {
          console.error(`[sync] ${folder} redirect/login expired: ${msg}`);
          await flagCollectionsForAccount(account, `Login expired — redirected to ${msg.slice(0, 120)}`);
          try { const fresh = await readStateFile(); Object.assign(state, fresh); } catch {}
        } else {
          console.error(`[sync] ${folder} failed: ${msg}`);
        }
      }
    }
  } catch (e) {
    console.error(`[sync] tick failed: ${e.message}`);
  } finally {
    syncRunning = false;
  }
}
function startBackgroundSync() {
  // run 30s after boot, then every 5 min
  setTimeout(() => {
    void backgroundSyncTick();
    setInterval(() => { void backgroundSyncTick(); }, 5 * 60 * 1000);
  }, 30 * 1000);
  console.log("[sync] background sync scheduled (30s → every 5m)");
}

async function getSharedBrowser(log) {
  if (sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }

  if (browserInitPromise) {
    return browserInitPromise;
  }

  const headless = parseBooleanInput(process.env.API_HEADLESS, parseBooleanInput(process.env.HEADLESS, true));

  // if default account has cdpUrl, use CDP path via buildBrowserFromLocalProfile with account
  let useDefaultCdp = false;
  try {
    const appConfig = await loadAppConfig();
    const defCfg = resolveAccountConfig("default", appConfig.accounts);
    if (defCfg.cdpUrl) useDefaultCdp = true;
  } catch {}

  const launchOpts = useDefaultCdp ? { headless, account: "default", log } : { headless, log };
  if (useDefaultCdp && log) log(`Using default account CDP`);

  browserInitPromise = buildBrowserFromLocalProfile(launchOpts)
    .then((browser) => {
      sharedBrowser = browser;
      browser.on("disconnected", () => {
        console.log("[browser] disconnected");
        sharedBrowser = null;
      });
      return browser;
    })
    .finally(() => {
      browserInitPromise = null;
    });

  return browserInitPromise;
}

function isCdpBrowser(browser) {
  return Boolean(browser && browser.__isCdp);
}

async function closeSharedBrowser() {
  if (!sharedBrowser) return;

  const browser = sharedBrowser;
  sharedBrowser = null;
  try {
    if (isCdpBrowser(browser) && typeof browser.disconnect === "function") await browser.disconnect();
    else await browser.close();
  } catch {
    // ignore
  }
}

async function closeBrowserForAccount(accountName, expectedBrowser) {
  const browser = browsersByAccount.get(accountName);
  if (!browser || (expectedBrowser && browser !== expectedBrowser)) return;

  browsersByAccount.delete(accountName);
  try {
    if (isCdpBrowser(browser) && typeof browser.disconnect === "function") await browser.disconnect();
    else await browser.close();
  } catch {
    // ignore
  }
}

async function getBrowserForAccount(accountName, jobId) {
  const existing = browsersByAccount.get(accountName);
  if (existing && existing.isConnected && existing.isConnected()) {
    return existing;
  }
  if (existing) {
    // stale disconnected entry
    browsersByAccount.delete(accountName);
    try { if (isCdpBrowser(existing) && typeof existing.disconnect === "function") await existing.disconnect(); else await existing.close(); } catch {}
  }

  const appConfig = await loadAppConfig();
  const config = resolveAccountConfig(accountName, appConfig.accounts);
  const headless = parseBooleanInput(process.env.API_HEADLESS, parseBooleanInput(process.env.HEADLESS, true));

  if (config.cdpUrl) console.log(`[browser] connecting via CDP for account "${accountName}" (${config.cdpUrl})`);
  else console.log(`[browser] launching browser for account "${accountName}" (${config.userDataDir}/${config.profileDir})`);
  const browser = await buildBrowserFromLocalProfile({
    headless,
    account: accountName,
    log: (msg) => console.log(`[browser:${accountName}] ${msg}`),
  });

  browser.on("disconnected", () => {
    console.log(`[browser] account "${accountName}" disconnected`);
    browsersByAccount.delete(accountName);
  });

  browsersByAccount.set(accountName, browser);
  return browser;
}

async function closeAllAccountBrowsers() {
  for (const [name, browser] of browsersByAccount) {
    console.log(`[browser] closing account "${name}" browser`);
    await closeBrowserForAccount(name, browser);
  }
}

async function closeManualBrowser(accountName, expectedBrowser) {
  const entry = manualBrowsersByAccount.get(accountName);
  if (!entry || (expectedBrowser && entry.browser !== expectedBrowser)) return;

  manualBrowsersByAccount.delete(accountName);
  if (entry.timer) clearTimeout(entry.timer);
  try {
    if (isCdpBrowser(entry.browser) && typeof entry.browser.disconnect === "function") await entry.browser.disconnect();
    else await entry.browser.close();
  } catch {
    // ignore
  }
  // VNC is stopped by the frontend (Profiles useEffect) when it sees no manualOpen accounts.
  // Do NOT call vnc-stop here — it races with vnc-start from concurrent open-browser calls.
}

async function closeAllManualBrowsers() {
  for (const [name] of manualBrowsersByAccount) {
    console.log(`[browser] closing manual browser for account "${name}"`);
    await closeManualBrowser(name);
  }
}

function setupShutdownHandlers(serverInstance) {
  const handleSignal = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down...`);

    await new Promise((resolve) => {
      serverInstance.close(() => resolve());
    });

    await closeSharedBrowser();
    await closeAllManualBrowsers();
    await closeAllAccountBrowsers();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });

  process.on("SIGINT", () => {
    void handleSignal("SIGINT");
  });
}

function parseBooleanInput(value, fallback) {
  if (typeof value === "boolean") return value;
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function runWithJobTimeout(promise, options = {}) {
  const timeoutMs = parsePositiveInt(options.timeoutMs, 0);
  if (!timeoutMs) {
    return promise;
  }

  const jobType = String(options.jobType || "job");
  const jobId = options.jobId != null ? options.jobId : "?";
  const log = typeof options.log === "function" ? options.log : null;
  const recycleBrowser =
    typeof options.recycleBrowser === "function" ? options.recycleBrowser : closeSharedBrowser;

  let timer = null;
  let timedOut = false;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      timedOut = true;
      const message = `[api] ${jobType} job ${jobId} timed out after ${timeoutMs}ms. Recycling browser session.`;
      if (log) log(message);
      console.error(message);
      await recycleBrowser();
      reject(new Error(`${jobType} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      await recycleBrowser();
    }
  }
}

function resolveMediaOutputDir(folder) {
  if (!folder) return mediaDir;

  const normalizedFolder = String(folder).replace(/\\/g, "/").trim();
  const resolved = path.resolve(mediaDir, normalizedFolder);
  const relative = path.relative(mediaDir, resolved);

  if (!relative || relative === ".") return mediaDir;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid folder. Use a path inside media, e.g. 'hello' or 'hello/sub'.");
  }

  return resolved;
}

function resolveMaxQuality(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Invalid max quality. Use a positive integer like 720 or 1080.");
  }
  return Math.floor(parsed);
}

function getQueueFilePath() {
  return (
    process.env.SAVED_SYNC_QUEUE_FILE ||
    path.resolve(rootDir, ".download-queue.json")
  );
}

async function readStateFile() {
  try {
    const raw = await fs.readFile(getStateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { config: { accounts: [], savedLists: [] }, lists: {}, updatedAt: null };
    }
    if (!parsed.config || typeof parsed.config !== "object") {
      parsed.config = { accounts: [], savedLists: [] };
    }
    if (!Array.isArray(parsed.config.accounts)) parsed.config.accounts = [];
    if (!Array.isArray(parsed.config.savedLists)) parsed.config.savedLists = [];
    if (!parsed.lists || typeof parsed.lists !== "object") parsed.lists = {};
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { config: { accounts: [], savedLists: [] }, lists: {}, updatedAt: null };
    }
    throw error;
  }
}

async function writeStateFile(state) {
  const filePath = getStateFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

async function readQueueFile() {
  try {
    const raw = await fs.readFile(getQueueFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { pending: [], completed: [] };
    if (!Array.isArray(parsed.pending)) parsed.pending = [];
    if (!Array.isArray(parsed.completed)) parsed.completed = [];
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") return { pending: [], completed: [] };
    throw error;
  }
}

async function writeQueueFile(queue) {
  const snapshot = JSON.stringify(queue, null, 2);
  const filePath = getQueueFilePath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, snapshot, "utf8");
}

// One authority for the UI crawl flow: slice new items above the stored
// lastSeenUrl, queue them into sync pending (skipping only URLs already in
// that visible list), then advance lastSeenUrl to the newest post found.
async function crawlCollectAndQueue(targetUrl, folder, scannedUrls, foundCount, account) {
  const urls = (Array.isArray(scannedUrls) ? scannedUrls : []).map((u) => String(u || "").trim()).filter(Boolean);
  const st = await readStateFile();
  const listState = st.lists[targetUrl] || {};
  const lastSeen = String(listState.lastSeenUrl || "").trim();
  let newUrls = urls;
  if (lastSeen) {
    const idx = urls.findIndex((u) => normalizeSyncUrl(u) === normalizeSyncUrl(lastSeen));
    if (idx !== -1) newUrls = urls.slice(0, idx);
  }
  const queuedResult = await withQueueFile(async () => {
    const queue = await readQueueFile();
    const pendingSet = new Set();
    for (const item of queue.pending) {
      if (item && item.url) pendingSet.add(normalizeSyncUrl(item.url));
    }
    let added = 0;
    let skippedPending = 0;
    const acct = normalizeAccountName(account || "default");
    for (const url of newUrls) {
      const norm = normalizeSyncUrl(url);
      if (!norm) continue;
      if (pendingSet.has(norm)) { skippedPending += 1; continue; }
      pendingSet.add(norm);
      queue.pending.push({ url, folder: String(folder || "").trim(), account: acct, addedAt: new Date().toISOString() });
      added += 1;
    }
    await writeQueueFile(queue);
    return { added, skippedPending, pendingTotal: queue.pending.length };
  });
  const firstPostUrl = urls.find((u) => /instagram\.com\/(?:p|reel|tv)\//i.test(u) || /reddit\.com\/r\/[^/]+\/comments\//i.test(u)) || urls[0] || "";
  try {
    const st2 = await readStateFile();
    st2.lists[targetUrl] = {
      ...(st2.lists[targetUrl] || {}),
      ...(firstPostUrl ? { lastSeenUrl: firstPostUrl } : {}),
      lastRunAt: new Date().toISOString(),
      lastScannedCount: Number.isFinite(foundCount) ? foundCount : urls.length,
      folder: st2.lists[targetUrl]?.folder || String(folder || "").trim(),
    };
    await writeStateFile(st2);
  } catch {}
  return { ...queuedResult, newCount: newUrls.length };
}

function normalizeSyncUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    parsed.hash = "";
    return parsed.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeAccountsInput(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const result = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const name = String(raw.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = {
      name,
      profileDir: String(raw.profileDir || "Default").trim() || "Default",
      userDataDir: String(raw.userDataDir || "").trim(),
    };
    const rawCdp = raw.cdpUrl != null ? String(raw.cdpUrl).trim() : "";
    if (rawCdp) {
      try { entry.cdpUrl = normalizeCdpUrl(rawCdp); } catch {}
    }
    result.push(entry);
  }
  return result;
}

function normalizeSavedListsInput(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const result = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const url = String(raw.url || "").trim();
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const schedule = String(raw.schedule || raw.cron || "30m").trim() || "30m";
    result.push({
      url,
      folder: String(raw.folder || "").trim(),
      account: String(raw.account || "").trim() || "default",
      schedule,
    });
  }
  return result;
}

function normalizeEndUrls(rawValue) {
  if (Array.isArray(rawValue)) {
    return Array.from(
      new Set(
        rawValue
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )
    );
  }

  const text = String(rawValue == null ? "" : rawValue);
  if (!text.trim()) return [];

  return Array.from(
    new Set(
      text
        .split(/\r?\n|,/)
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

async function flagCollectionsForAccount(account, errorMsg) {
  const st = await readStateFile();
  const acc = String(account || "default").trim() || "default";
  const err = String(errorMsg || "Instagram login expired — redirected").trim();
  const now = new Date().toISOString();
  let changed = false;
  for (const item of st.config?.savedLists || []) {
    if (String(item.account || "default").trim() !== acc) continue;
    const url = String(item.url || "").trim();
    if (!url) continue;
    st.lists[url] = st.lists[url] || {};
    st.lists[url].lastError = err;
    st.lists[url].lastErrorAt = now;
    st.lists[url].paused = true;
    changed = true;
  }
  if (changed) {
    st.updatedAt = now;
    await writeStateFile(st);
    console.log(`[flag] paused all collections for account "${acc}" due to: ${err}`);
  }
  return changed;
}

async function clearFlagForCollections(targetUrlOrAccount, opts = {}) {
  const isAccount = opts.isAccount;
  const st = await readStateFile();
  let changed = false;
  if (isAccount) {
    const acc = String(targetUrlOrAccount || "default").trim() || "default";
    for (const item of st.config?.savedLists || []) {
      if (String(item.account || "default").trim() !== acc) continue;
      const url = String(item.url || "").trim();
      if (st.lists[url]) {
        if (st.lists[url].paused || st.lists[url].lastError) {
          delete st.lists[url].paused;
          delete st.lists[url].lastError;
          delete st.lists[url].lastErrorAt;
          changed = true;
        }
      }
    }
  } else {
    const url = String(targetUrlOrAccount || "").trim();
    if (url && st.lists[url]) {
      if (st.lists[url].paused || st.lists[url].lastError) {
        delete st.lists[url].paused;
        delete st.lists[url].lastError;
        delete st.lists[url].lastErrorAt;
        changed = true;
      }
    }
  }
  if (changed) {
    st.updatedAt = new Date().toISOString();
    await writeStateFile(st);
  }
  return changed;
}
