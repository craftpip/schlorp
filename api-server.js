#!/usr/bin/env node
require("dotenv").config({ quiet: true });

const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const { run } = require("./scan-videos/index");
const { buildBrowserFromLocalProfile } = require("./scan-videos/browser");
const { scanSavedPage } = require("./scan-videos/scan-saved");
const { sanitizeMoveKey, isInsideMedia, mediaRelOf, resolveMoveSource, findCompanionPosters, splitStacksByCoverage, stashMovedSlot, takeMovedSlot } = require("./scan-videos/media-move");
const { loadAppConfig, normalizeAccountName, resolveAccountConfig, resolveProfileConfig, getStateFilePath, normalizeCdpUrl, ensureDefaultStateFiles } = require("./scan-videos/config");
const { generatePosterThumbnail, selectPosterTargets, posterStemOf, isVideoFileName, POSTER_SIBLING_RE } = require("./scan-videos/download");
const { WebSocketServer } = require("ws");
const http = require("http");
const { EventEmitter } = require("events");
const { getStatus: getUpdateStatus, performUpdate } = require("./updater");

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
const websiteDir = path.join(rootDir, "website");
const port = Number(process.env.PORT) || 6767;
const apiJobTimeoutMs = parsePositiveInt(process.env.API_JOB_TIMEOUT_MS, 1800000);
// Media grid range-ruler (plan 034): files per range segment. Read live per
// request so .env / Settings edits apply without a restart.
function mediaRangeSize() {
  const n = Number.parseInt(process.env.MEDIA_RANGE_SIZE || "100", 10);
  return Number.isFinite(n) ? Math.min(5000, Math.max(10, n)) : 100;
}
// Keyboard shortcut hint pills on buttons (KEYBOARD_HINTS). Read live per
// request so .env / Settings edits apply without a restart.
function keyboardHints() {
  return String(process.env.KEYBOARD_HINTS == null ? "1" : process.env.KEYBOARD_HINTS) !== "0";
}
const VNC_FLAG_PATH = process.env.VNC_FLAG || "/data/browser/.vnc-enabled";
const VNC_PORT_NUM = Number(process.env.VNC_PORT) || 6777;
const NOVNC_PORT_NUM = Number(process.env.NOVNC_PORT) || 6778;
// Settings that the container environment (docker-compose `environment:`)
// sets: they win over .env on every start, so the Settings page shows them
// as locked instead of letting a change silently revert after a restart.
const ENV_FROM_CONTAINER = (() => {
  let fileVals = {};
  try { fileVals = require("dotenv").parse(require("fs").readFileSync(path.join(__dirname, ".env"))); } catch {}
  const out = new Set();
  for (const [k, v] of Object.entries(process.env)) if (fileVals[k] === undefined || fileVals[k] !== v) out.add(k);
  return out;
})();
// --- Panel login (plan 040): password hash + optional 5x5 pattern ---
// The password is never kept in plain text: a one-time migration moves any
// UI_PANEL_PASSWORD / ADMIN_PASSWORD from .env into a scrypt hash (done
// synchronously here, before the server accepts requests) and blanks .env.
const { createPatternAuth } = require("./scan-videos/pattern-auth");
const patternAuth = createPatternAuth({ rootDir });
(() => {
  const plain = String(process.env.UI_PANEL_PASSWORD || process.env.ADMIN_PASSWORD || "").trim();
  if (!plain) return;
  try {
    if (patternAuth.migratePlainPasswordSync(plain)) console.log("[auth] panel password moved from .env into a hash (.xdl-auth.json)");
    const envPath = path.join(rootDir, ".env");
    const fsM = require("fs");
    if (fsM.existsSync(envPath)) {
      const txt = fsM.readFileSync(envPath, "utf8");
      const next = txt.replace(/^(\s*(?:export\s+)?(UI_PANEL_PASSWORD|ADMIN_PASSWORD)\s*=).*$/gm, "$1");
      if (next !== txt) fsM.writeFileSync(envPath, next, "utf8");
    }
  } catch (e) {
    console.error(`[auth] password migration failed: ${e.message}`);
  }
  delete process.env.UI_PANEL_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
})();
function isPanelProtected() {
  return patternAuth.hasPassword();
}
// --- Media encryption (plan 039) ---
const mediaCrypto = require("./scan-videos/media-crypto");
const { createMediaVault } = require("./scan-videos/media-vault");
const mediaVault = createMediaVault({ mediaDir, rootDir, isProtected: isPanelProtected });
let lastPanelActivity = Date.now();
function vaultStatusFull() {
  const sec = patternAuth.publicSettings();
  return { ...mediaVault.status(), hasPattern: !!sec.pattern, preferLogin: sec.preferLogin, autoLockMinutes: sec.autoLockMinutes };
}
// After a successful login, open the media vault with the same secret.
async function unlockVaultAfterLogin(kind, secret) {
  try {
    const st = mediaVault.status();
    if (!st.exists || st.unlocked) return;
    if (kind === "pattern" && !st.patternSlot) return;
    await mediaVault.unlock(kind, secret);
    console.log(`[vault] unlocked by ${kind} login`);
    void flushPendingPosters();
  } catch (e) {
    console.error(`[vault] login could not unlock the vault: ${e.message}`);
  }
}
// Loopback-only token so server-side ffmpeg/ffprobe can read encrypted files
// through the decrypting /media route without the panel password.
const INTERNAL_MEDIA_TOKEN = require("crypto").randomBytes(24).toString("hex");
const INTERNAL_POST_PATHS = new Set(["/scan-saved", "/queue/add", "/sync-queue/pending/remove"]);
function internalMediaUrl(fullPath) {
  const rel = path.relative(mediaDir, fullPath).split(path.sep).map(encodeURIComponent).join("/");
  return `http://127.0.0.1:${port}/media/${rel}`;
}
// ffmpeg/ffprobe input args for a media file: the path itself, or the
// internal decrypting URL when the file is encrypted.
async function ffInputFor(fullPath) {
  const info = await mediaVault.fileInfo(fullPath).catch(() => null);
  // ffprobe: [...args]; ffmpeg: [...pre, "-i", src].
  if (!info || !info.locked) return { locked: false, pre: [], src: fullPath, args: [fullPath] };
  const pre = ["-headers", `X-Xdl-Internal: ${INTERNAL_MEDIA_TOKEN}\r\n`];
  const src = internalMediaUrl(fullPath);
  return { locked: true, pre, src, args: [...pre, src] };
}

let shuttingDown = false;
let jobCounter = 0;
let activeJob = null;
let scanActiveJob = null;
let queueActiveJob = null;
let updateRunning = false;
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
// True once the on-disk queue was read successfully (or confirmed absent on a
// fresh install). While false, saveWebQueue() refuses to write so a failed
// load (e.g. reading the file mid-write during a restart) can never clobber
// good on-disk state with an empty in-memory queue.
let queueStateValid = false;

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
  // The file may be mid-write from a dying process during restarts — retry
  // before giving up instead of falling back to an empty queue on one bad read.
  let parsed = null;
  let missing = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const raw = await fs.readFile(webQueueFile, "utf8");
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") throw new Error("invalid");
      break;
    } catch (e) {
      parsed = null;
      if (e.code === "ENOENT") {
        missing = true;
        break;
      }
      console.error(`[queue] load attempt ${attempt + 1} failed:`, e.message);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (missing || parsed) {
    queueStateValid = true;
    // Fresh install: no queue file yet → start empty instead of crashing on null.
    if (!parsed) parsed = {};
  } else {
    console.error("[queue] load failed after retries — keeping in-memory state, saves suspended");
    queueLoaded = true;
    return;
  }
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
  if (!queueStateValid) {
    console.error("[queue] refusing to save — on-disk state was never read successfully");
    return;
  }
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
      // Encrypt whatever was written — also when the job failed or timed out
      // part-way (ENCRYPT_NEW_MEDIA).
      try {
        const doneLogs = (nextItem.logs || []).join("\n");
        const written = [...doneLogs.matchAll(/Downloaded media to:\s*(.+)/g)].map((m) => m[1].trim());
        await autoEncryptDownloaded(written, logToWs);
      } catch {}
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

// ---- Public: website page (goofy) + SPA assets (must load before auth check) ----
const fsSync = require("fs");
app.use("/website", express.static(websiteDir));
app.get("/website", (_req, res) => {
  const idx = path.join(websiteDir, "index.html");
  if (fsSync.existsSync(idx)) return res.sendFile(idx);
  return res.status(404).send("website not built");
});
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
  res.json({ ok: true, protected: isPanelProtected() });
});
// Runtime client config (plan 034): frontend reads the rail range size here
// so MEDIA_RANGE_SIZE applies without a web rebuild.
app.get("/api/client-config", (_req, res) => {
  res.json({ ok: true, rangeSize: mediaRangeSize(), kbdHints: keyboardHints() });
});
// Password login → random session token (cookie + returned for the
// x-xdl-session header). Also unlocks encrypted media with the same password.
app.post("/api/auth", async (req, res) => {
  try {
    if (!isPanelProtected()) return res.json({ ok: true });
    const pw = await patternAuth.check("password", String(req.body?.password ?? ""), req.ip);
    const token = patternAuth.newSession();
    res.cookie("xdl_session", token, { httpOnly: true, sameSite: "lax", path: "/" });
    await unlockVaultAfterLogin("password", pw);
    lastPanelActivity = Date.now();
    return res.json({ ok: true, token });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message, code: e.code || null });
  }
});
// Which login methods the login box can offer (both are always available
// when a pattern is set; preferLogin picks the tab shown first).
app.get("/api/auth/methods", (_req, res) => {
  const sec = patternAuth.publicSettings();
  res.json({ ok: true, loginPattern: sec.pattern, preferLogin: sec.preferLogin, minDots: sec.minDots });
});
// Pattern login → random session token (memory only; rate-limited).
app.post("/api/auth/pattern", async (req, res) => {
  try {
    if (!isPanelProtected()) return res.json({ ok: true });
    const canonical = await patternAuth.check("pattern", req.body?.pattern, req.ip);
    const token = patternAuth.newSession();
    res.cookie("xdl_session", token, { httpOnly: true, sameSite: "lax", path: "/" });
    await unlockVaultAfterLogin("pattern", canonical);
    lastPanelActivity = Date.now();
    return res.json({ ok: true, token });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message, code: e.code || null });
  }
});
app.post("/api/auth/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  patternAuth.endSession(req.headers["x-xdl-session"]);
  patternAuth.endSession(cookies.xdl_session);
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
    if (!k) continue;
    // A malformed cookie (e.g. "%E0" set by another app on this host) must not
    // turn every request into a 500.
    try { out[k.trim()] = decodeURIComponent(v.join("=")); } catch { /* ignore */ }
  }
  return out;
}
app.use((req, res, next) => {
  // Server-internal calls (ffmpeg reading encrypted media, selfPost) carry a
  // per-process random token and must come from loopback.
  if (req.headers["x-xdl-internal"] === INTERNAL_MEDIA_TOKEN && /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(String(req.socket.remoteAddress || ""))) {
    // Only what the server itself needs: ffmpeg reading /media, and selfPost.
    const internalOk = ((req.method === "GET" || req.method === "HEAD") && req.path.startsWith("/media/"))
      || (req.method === "POST" && INTERNAL_POST_PATHS.has(req.path));
    if (internalOk) return next();
  }
  if (!isPanelProtected()) return next();
  // Public endpoints
  if (req.path === "/api/auth/status" || req.path === "/api/auth" || req.path === "/health" || req.path.startsWith("/health") || req.path === "/vnc/status" || req.path === "/website" || req.path.startsWith("/website/")) return next();
  // Session token from a password or pattern login. Reads (GET/HEAD: media,
  // pages) accept the httpOnly cookie; actions need the x-xdl-session header,
  // which a form or page on another origin/port cannot send (CSRF).
  const cookies = parseCookies(req.headers.cookie);
  const headerOk = patternAuth.validSession(req.headers["x-xdl-session"]);
  const cookieOk = patternAuth.validSession(cookies.xdl_session);
  const isRead = req.method === "GET" || req.method === "HEAD";
  const authed = headerOk || (isRead && cookieOk);
  // Older builds stored the plain password in this cookie — drop stale ones.
  if (cookies.xdl_session && !cookieOk) res.clearCookie("xdl_session", { path: "/" });
  if (authed) {
    // Idle auto-lock clock: background polls don't count as activity.
    if (req.path !== "/api/vault/status" && req.path !== "/api/media/lock/job") lastPanelActivity = Date.now();
    return next();
  }
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
// "Download" from the media panel: `?download=1` makes the browser save the
// file under its own name instead of opening it inline. Applies to plain and
// encrypted files (the decrypting route below keeps this header).
app.use("/media", (req, res, next) => {
  if ((req.method === "GET" || req.method === "HEAD") && String(req.query?.download || "") === "1") {
    let base = "";
    try { base = path.basename(decodeURIComponent(req.path)); } catch {}
    if (base && base !== ".xdl-vault.json") res.attachment(base);
  }
  next();
});
// Encrypted media (plan 039): decrypt on the fly with HTTP Range support.
// Plain files fall through to express.static below.
app.use("/media", async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  let rel;
  try { rel = decodeURIComponent(req.path); } catch { return next(); }
  const fullPath = path.join(mediaDir, rel);
  const relCheck = path.relative(mediaDir, fullPath);
  if (!relCheck || relCheck.startsWith("..") || path.isAbsolute(relCheck)) return next();
  if (path.basename(fullPath) === path.basename(mediaVault.vaultFile)) return res.status(404).end();
  let info;
  try { info = await mediaVault.fileInfo(fullPath); } catch { return next(); }
  if (!info || !info.locked) return next();
  const key = await mediaVault.decryptKey();
  if (!key) return res.status(423).json({ ok: false, error: "media vault is locked — unlock it with your password or pattern" });
  const h = info.header;
  const total = h.plainSize;
  try {
    let type = null;
    if (/\.gif$/i.test(fullPath) && total >= 8) {
      // Same sniff as the static route: mp4 bytes saved as .gif.
      const parts = [];
      for await (const p of mediaCrypto.decryptRange(fullPath, key, { start: 0, end: 11, header: h })) parts.push(p);
      const head = Buffer.concat(parts);
      if (head.length >= 8 && head.subarray(4, 8).toString("latin1") === "ftyp") type = "video/mp4";
    }
    res.type(type || path.extname(fullPath) || "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Xdl-Locked", "1");
    let start = 0;
    let end = total - 1;
    if (req.headers.range && total > 0) {
      const ranges = req.range(total, { combine: true });
      if (ranges === -1) {
        res.setHeader("Content-Range", `bytes */${total}`);
        return res.status(416).end();
      }
      if (Array.isArray(ranges) && ranges.length === 1 && ranges.type === "bytes") {
        start = ranges[0].start;
        end = ranges[0].end;
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      }
    }
    res.setHeader("Content-Length", String(total ? end - start + 1 : 0));
    if (req.method === "HEAD" || total === 0) return res.end();
    const stream = mediaCrypto.createDecryptStream(fullPath, key, { start, end, header: h });
    stream.on("error", (e) => {
      console.error(`[media] decrypt failed for ${relCheck}: ${e.message}`);
      res.destroy(e);
    });
    req.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) return res.status(500).json({ ok: false, error: e.message });
    res.destroy(e);
  }
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
  // Files decrypted again (plan 039) got a new inode — report the original
  // creation time recorded at unlock so gallery date order does not jump.
  const overrideMs = mediaVault.createdOverride(stat);
  const created = overrideMs ? new Date(overrideMs) : birth || stat.ctime || stat.mtime;
  return {
    mtime: stat.mtime.toISOString(),
    created: created.toISOString(),
  };
}

async function walkMediaFlat(dir, relPrefix, out, depth) {
  if (depth > 32) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const stats = await mapLimit(entries, 64, async (entry) => {
    if (entry.isSymbolicLink() || entry.isDirectory()) return null;
    try {
      return await fs.stat(path.join(dir, entry.name));
    } catch {
      return null;
    }
  });
  for (let k = 0; k < entries.length; k++) {
    const entry = entries[k];
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (depth + 1 > 32) continue;
      await walkMediaFlat(fullPath, rel, out, depth + 1);
      continue;
    }
    const stat = stats[k];
    if (!stat || !stat.isFile()) continue;
    out.push({
      name: entry.name,
      rel,
      dir: false,
      size: stat.size,
      ...fileEntryTimes(stat),
    });
  }
}
// Bounded parallel mapper (libuv threadpool-friendly batching for mass stat).
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function listMediaDir(resolved, flat) {
  const items = [];
  if (flat) {
    await walkMediaFlat(resolved, "", items, 0);
  } else {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const stats = await mapLimit(entries, 64, async (entry) => {
      try {
        return await fs.stat(path.join(resolved, entry.name));
      } catch {
        return null;
      }
    });
    for (let k = 0; k < entries.length; k++) {
      const entry = entries[k];
      const stat = stats[k];
      if (!stat) continue;
      items.push({
        name: entry.name,
        dir: entry.isDirectory(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ...fileEntryTimes(stat),
      });
    }
    items.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      if (!a.dir && !b.dir) return b.mtimeMs - a.mtimeMs;
      return a.name.localeCompare(b.name);
    });
    for (const it of items) delete it.mtimeMs;
  }
  // Filter out .xdlstack files from the listing (both branches), plus the
  // media vault and in-flight encrypt/decrypt/upload temp files (plan 039).
  for (let i = items.length - 1; i >= 0; i--) {
    const n = items[i].name;
    if (/\.xdlstack$/i.test(n) || n === ".xdl-vault.json" || /^\..+\.(xenc|xdec|xupl)-[0-9a-f]{8}$/.test(n)) items.splice(i, 1);
  }
  // Lock state (plan 039): encrypted files report their plain size and the
  // creation time stored in the header.
  await mapLimit(items, 64, async (it) => {
    if (it.dir) return;
    const full = path.join(resolved, ...String(it.rel || it.name).split("/").filter(Boolean));
    const info = await mediaVault.fileInfo(full).catch(() => null);
    if (!info || !info.locked) return;
    it.locked = true;
    it.size = info.header.plainSize;
    if (info.header.createdMs > 0) it.created = new Date(info.header.createdMs).toISOString();
  });
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
  // Stack member annotation: sibling .xdlstack membership for non-flat (same
  // folder) and flat (per-folder stack files along the walk).
  try {
    const stackMap = await collectStacksForListing(resolved, flat);
    if (stackMap && stackMap.size) {
      for (const it of items) {
        if (it.dir) continue;
        const key = it.rel || it.name;
        const folderKey = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
        const stacks = stackMap.get(folderKey);
        if (!stacks || !stacks.length) continue;
        const base = key.split("/").pop();
        const mine = stacks.filter((s) => s.members.has(base)).map((s) => ({ id: s.id, name: s.name, count: s.members.size }));
        if (mine.length) it.stacks = mine;
      }
    }
  } catch {}
  return items;
}

// --- Media dimensions (.mediadims.json) ---
// Persistent w/h cache so grid tiles size correctly on first paint (no
// reflow when thumbnails arrive). Keyed by media-relative path, validated
// by mtimeMs+size. Probes never block listings: requests serve cached
// ratios inline, misses warm in the background for the next visit.
const mediadimsFile = path.join(rootDir, ".mediadims.json");
let mediadimsChain = Promise.resolve();
async function withMediadimsFile(fn) {
  let result, error;
  const task = async () => { try { result = await fn(); } catch (e) { error = e; } };
  mediadimsChain = mediadimsChain.then(task, task);
  await mediadimsChain;
  if (error) throw error;
  return result;
}
let mediadimsCache = null; // { mediaRelKey: { w, h, mtimeMs, size } }
async function loadMediadims() {
  if (mediadimsCache) return mediadimsCache;
  try {
    const raw = await fs.readFile(mediadimsFile, "utf8");
    const parsed = JSON.parse(raw);
    mediadimsCache = parsed && typeof parsed === "object" && parsed.dims && typeof parsed.dims === "object" ? parsed.dims : {};
  } catch (e) {
    if (!e || e.code !== "ENOENT") console.error("[mediadims] load failed:", e && e.message);
    mediadimsCache = {};
  }
  return mediadimsCache;
}
async function saveMediadims() {
  await withMediadimsFile(async () => {
    await fs.mkdir(path.dirname(mediadimsFile), { recursive: true });
    await fs.writeFile(mediadimsFile, JSON.stringify({ updatedAt: new Date().toISOString(), dims: mediadimsCache || {} }), "utf8");
  });
}
const DIMS_PROBE_TIMEOUT_MS = 15000;
const DIMS_PROBE_CONCURRENCY = 10;
const DIMS_PROBEABLE_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|mpg|mpeg|3gp|flv|ts|m3u8|jpg|jpeg|png|webp|bmp|avif|gif)$/i;
async function probeFileDims(fullPath) {
  const input = await ffInputFor(fullPath);
  return new Promise((resolve) => {
    if (!ffprobeBin) return resolve(null);
    try {
      require("child_process").execFile(
        ffprobeBin,
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", ...input.args],
        { timeout: DIMS_PROBE_TIMEOUT_MS },
        (err, stdout) => {
          if (err) return resolve(null);
          const nums = String(stdout || "").trim().split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
          if (nums.length >= 2) return resolve({ w: nums[0], h: nums[1] });
          return resolve(null);
        }
      );
    } catch {
      return resolve(null);
    }
  });
}
let dimsWarmQueue = [];
let dimsWarmRunning = false;
function queueDimsWarm(entries) {
  // Move-to-front: the folder just opened jumps ahead of older backlog,
  // so the view in front of the user warms first.
  const incoming = [];
  const seenNew = new Set();
  for (const e of entries) {
    if (!e || !e.key || seenNew.has(e.key)) continue;
    seenNew.add(e.key);
    incoming.push(e);
  }
  if (!incoming.length) return;
  if (dimsWarmQueue.length) dimsWarmQueue = dimsWarmQueue.filter((e) => !seenNew.has(e && e.key));
  dimsWarmQueue.unshift(...incoming);
  if (!dimsWarmRunning) void runDimsWarmQueue().catch(() => {});
}
async function runDimsWarmQueue() {
  dimsWarmRunning = true;
  try {
    while (dimsWarmQueue.length) {
      const batch = dimsWarmQueue.splice(0, DIMS_PROBE_CONCURRENCY);
      const results = await Promise.all(batch.map(async (e) => {
        try {
          if (!DIMS_PROBEABLE_EXT.test(e.key)) return null;
          // Encrypted + vault locked: ffprobe would only get a 423, so skip.
          const lk = await mediaVault.fileInfo(e.fullPath).catch(() => null);
          if (lk && lk.locked && !(await mediaVault.decryptKey())) return null;
          const st = await fs.stat(e.fullPath).catch(() => null);
          if (!st || !st.isFile()) return null;
          if (st.mtimeMs !== e.mtimeMs || st.size !== e.size) return null;
          const d = await probeFileDims(e.fullPath);
          if (!d) return null;
          return { key: e.key, w: d.w, h: d.h, mtimeMs: e.mtimeMs, size: e.size };
        } catch { return null; }
      }));
      const dims = await loadMediadims();
      let mutated = false;
      for (const r of results) {
        if (!r) continue;
        dims[r.key] = { w: r.w, h: r.h, mtimeMs: r.mtimeMs, size: r.size };
        mutated = true;
      }
      if (mutated) await saveMediadims().catch(() => {});
    }
  } finally {
    dimsWarmRunning = false;
    if (dimsWarmQueue.length) void runDimsWarmQueue().catch(() => {});
  }
}
// Cached ratio for one media-relative key (queues a background probe on miss).
async function dimsRatioFor(key, fullPath, stat) {
  const dims = await loadMediadims();
  const hit = dims[key];
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.w > 0 && hit.h > 0) return hit.w / hit.h;
  queueDimsWarm([{ key, fullPath, mtimeMs: stat.mtimeMs, size: stat.size }]);
  return undefined;
}
// Attach cached `ratio` to listMediaDir items (folder-scoped keys); misses warm in background.
async function attachCachedRatios(items, folder) {
  const fk = String(folder || "").replace(/\/$/, "");
  for (const it of items) {
    if (it.dir) continue;
    const rk = it.rel || it.name;
    const key = fk ? `${fk}/${rk}` : rk;
    const fullPath = path.join(mediaDir, ...key.split("/").filter(Boolean));
    const rel = path.relative(mediaDir, fullPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    const ratio = await dimsRatioFor(key, fullPath, stat);
    if (ratio) it.ratio = ratio;
  }
}
app.get("/api/media", async (req, res) => {
  try {
    const folder = String(req.query?.folder || "").trim();
    const flat = String(req.query?.flat || "") === "1";
    const resolved = resolveMediaOutputDir(folder);
    const items = await listMediaDir(resolved, flat);
    await attachCachedRatios(items, folder);
    return res.json({ ok: true, folder, flat, items });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});
// Ratio map for a folder scope (rowKey -> ratio), for clients to merge in
// without a full reload. Missing entries are warming in the background.
app.get("/api/mediadims", async (req, res) => {
  try {
    const folder = String(req.query?.folder || "").trim();
    const flat = String(req.query?.flat || "") === "1";
    const resolved = resolveMediaOutputDir(folder);
    const items = await listMediaDir(resolved, flat);
    await attachCachedRatios(items, folder);
    const dims = {};
    for (const it of items) {
      if (it.dir || !Number.isFinite(it.ratio)) continue;
      dims[it.rel || it.name] = it.ratio;
    }
    return res.json({ ok: true, folder, flat, dims });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

// --- Media custom order (.mediaorder.json) ---
// Per-folder manual tile ordering for grid `sort=custom`. Scoped by folder
// + flat flag; stores rowKeys (flat: rel, else: name) in user order.
const mediaorderFile = path.join(rootDir, ".mediaorder.json");
let mediaorderChain = Promise.resolve();
async function withMediaorderFile(fn) {
  let result, error;
  const task = async () => { try { result = await fn(); } catch (e) { error = e; } };
  mediaorderChain = mediaorderChain.then(task, task);
  await mediaorderChain;
  if (error) throw error;
  return result;
}
let mediaorderCache = null; // { scopes: { scopeKey: [rowKey] } }
let mediaorderSlotsCache = null; // { scopeKey: { rowKey: rememberedIndex } } — gallery move-out slot memory
function mediaorderScope(folder, flat) {
  const f = String(folder || "").trim().replace(/\/+$/, "");
  return `${flat ? "flat:" : "folder:"}${f}`;
}
async function loadMediaorder() {
  if (mediaorderCache) return mediaorderCache;
  try {
    const raw = await fs.readFile(mediaorderFile, "utf8");
    const parsed = JSON.parse(raw);
    mediaorderCache = parsed && typeof parsed === "object" && parsed.scopes && typeof parsed.scopes === "object" ? parsed.scopes : {};
    mediaorderSlotsCache = parsed && typeof parsed === "object" && parsed.movedSlots && typeof parsed.movedSlots === "object" ? parsed.movedSlots : {};
  } catch (e) {
    if (!e || e.code !== "ENOENT") console.error("[mediaorder] load failed:", e && e.message);
    mediaorderCache = {};
    mediaorderSlotsCache = {};
  }
  return mediaorderCache;
}
async function loadMovedSlots() {
  await loadMediaorder();
  if (!mediaorderSlotsCache || typeof mediaorderSlotsCache !== "object") mediaorderSlotsCache = {};
  return mediaorderSlotsCache;
}
async function saveMediaorder() {
  await withMediaorderFile(async () => {
    await fs.mkdir(path.dirname(mediaorderFile), { recursive: true });
    await fs.writeFile(mediaorderFile, JSON.stringify({ updatedAt: new Date().toISOString(), scopes: mediaorderCache || {}, movedSlots: mediaorderSlotsCache || {} }), "utf8");
  });
}
app.get("/api/mediaorder", async (req, res) => {
  try {
    const folder = String(req.query?.folder || "").trim();
    const flat = String(req.query?.flat || "") === "1";
    const scope = mediaorderScope(folder, flat);
    const scopes = await loadMediaorder();
    return res.json({ ok: true, scope, folder, flat, order: Array.isArray(scopes[scope]) ? scopes[scope] : [] });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});
app.put("/api/mediaorder", async (req, res) => {
  try {
    const folder = String(req.body?.folder ?? req.query?.folder ?? "").trim();
    const flatRaw = req.body?.flat ?? req.query?.flat ?? "";
    const flat = flatRaw === true || String(flatRaw) === "1";
    const order = req.body?.order;
    if (!Array.isArray(order)) return res.status(400).json({ ok: false, error: "order array required" });
    const clean = [];
    const seen = new Set();
    for (const k of order) {
      const s = String(k ?? "").trim();
      if (!s || s.includes("\\") || s === "." || s.startsWith("/") || s.includes("..")) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20000) break;
    }
    const scope = mediaorderScope(folder, flat);
    const scopes = await loadMediaorder();
    scopes[scope] = clean;
    // A fresh manual order supersedes remembered move-out slots.
    const slots = await loadMovedSlots();
    if (slots[scope]) delete slots[scope];
    await saveMediaorder();
    return res.json({ ok: true, scope, folder, flat, order: clean });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
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
    // Prune from playlists (best-effort)
    try {
      const canonical = rel.split(path.sep).join("/");
      await withPlaylistFile(async () => {
        const data = await loadPlaylistsRaw();
        let mutated = false;
        for (const pl of data.playlists) {
          const before = pl.items.length;
          pl.items = pl.items.filter((it) => it.key !== canonical);
          if (pl.items.length !== before) {
            mutated = true;
            pl.updatedAt = new Date().toISOString();
          }
        }
        if (mutated) await savePlaylistsRaw(data);
      });
    } catch {}
    // Prune dims cache entry (best-effort)
    try {
      const canonical = rel.split(path.sep).join("/");
      const dims = await loadMediadims();
      if (dims[canonical]) {
        delete dims[canonical];
        await saveMediadims();
      }
    } catch {}
    // Prune custom-order scopes (best-effort): the parent folder's scope
    // loses the basename, flat scopes lose the media-relative key.
    try {
      const canonical = rel.split(path.sep).join("/");
      const parent = path.posix.dirname(canonical);
      const parentFolder = parent === "." ? "" : parent;
      const scopes = await loadMediaorder();
      let mutated = false;
      const folderScope = mediaorderScope(parentFolder, false);
      if (Array.isArray(scopes[folderScope]) && scopes[folderScope].includes(name)) {
        scopes[folderScope] = scopes[folderScope].filter((k) => k !== name);
        mutated = true;
      }
      for (const [scope, arr] of Object.entries(scopes)) {
        if (!scope.startsWith("flat:") || !Array.isArray(arr) || !arr.includes(canonical)) continue;
        scopes[scope] = arr.filter((k) => k !== canonical);
        mutated = true;
      }
      if (mutated) await saveMediaorder();
    } catch {}
    // Prune from sibling stacks (best-effort): strip the deleted filename
    // from any .xdlstack file in the same folder. A lone file is not a
    // stack: release it and drop the stack file.
    try {
      const dir = path.dirname(fullPath);
      const deletedBase = path.basename(fullPath);
      const stackFiles = await readStacksInFolder(dir);
      await withStacksFile(dir, async () => {
        for (const s of stackFiles) {
          if (!s.items.includes(deletedBase)) continue;
          const full = path.join(dir, s.id);
          const data = parseStackFile(await fs.readFile(full, "utf8"));
          data.items = data.items.filter((x) => x !== deletedBase);
          if (data.items.length <= 1) await fs.unlink(full).catch(() => {});
          else await fs.writeFile(full, JSON.stringify(data, null, 2), "utf8");
        }
      });
    } catch {}
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});
// Folder rename (folder chips): moves a subfolder within the same parent.
app.post("/api/media/rename", async (req, res) => {
  try {
    const folder = String(req.body?.folder || "").trim();
    const name = String(req.body?.name || "").trim();
    const newName = String(req.body?.newName || "").trim();
    if (!name || !newName) return res.status(400).json({ ok: false, error: "name and newName required" });
    if (name.includes("/") || name.includes("\\") || newName.includes("/") || newName.includes("\\")) return res.status(400).json({ ok: false, error: "invalid name" });
    if (newName.length > 200) return res.status(400).json({ ok: false, error: "name too long" });
    const dir = resolveMediaOutputDir(folder);
    const fullPath = path.join(dir, name);
    const newPath = path.join(dir, newName);
    const rel = path.relative(mediaDir, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return res.status(400).json({ ok: false, error: "invalid path" });
    const rel2 = path.relative(mediaDir, newPath);
    if (rel2.startsWith("..") || path.isAbsolute(rel2)) return res.status(400).json({ ok: false, error: "invalid path" });
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) return res.status(404).json({ ok: false, error: "not found" });
    if (!stat.isDirectory()) return res.status(400).json({ ok: false, error: "not a folder" });
    if (newName === name) return res.json({ ok: true });
    const exists = await fs.stat(newPath).catch(() => null);
    if (exists) return res.status(400).json({ ok: false, error: "a folder with that name already exists" });
    await fs.rename(fullPath, newPath);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});
// Folder delete (folder chips): recursively removes a subfolder.
app.post("/api/media/folder/delete", async (req, res) => {
  try {
    const folder = String(req.body?.folder || "").trim();
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    if (name.includes("/") || name.includes("\\")) return res.status(400).json({ ok: false, error: "invalid name" });
    const dir = resolveMediaOutputDir(folder);
    const fullPath = path.join(dir, name);
    const rel = path.relative(mediaDir, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return res.status(400).json({ ok: false, error: "invalid path" });
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) return res.status(404).json({ ok: false, error: "not found" });
    if (!stat.isDirectory()) return res.status(400).json({ ok: false, error: "not a folder" });
    await fs.rm(fullPath, { recursive: true, force: true });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});
// Folder create (media grid "Create folder"): creates a subfolder inside the
// current folder. Single path segment only — no nesting in one call.
app.post("/api/media/folder", async (req, res) => {
  try {
    const folder = String(req.body?.folder || "").trim();
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    if (name.includes("/") || name.includes("\\")) return res.status(400).json({ ok: false, error: "invalid name" });
    if (name === "." || name === "..") return res.status(400).json({ ok: false, error: "invalid name" });
    if (name.length > 200) return res.status(400).json({ ok: false, error: "name too long" });
    const dir = resolveMediaOutputDir(folder);
    const fullPath = path.join(dir, name);
    const rel = path.relative(mediaDir, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return res.status(400).json({ ok: false, error: "invalid path" });
    try {
      await fs.mkdir(fullPath);
    } catch (e) {
      if (e && e.code === "EEXIST") return res.status(400).json({ ok: false, error: "a folder with that name already exists" });
      if (e && e.code === "ENOENT") return res.status(400).json({ ok: false, error: "parent folder not found" });
      throw e;
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});
// File move (media grid "Move files", plan 026): moves files within media.
// Best-effort sidecar cleanup mirrors DELETE /api/media above.
async function cleanupMoveSidecar(oldRel, newRel) {
  // Playlists — rewrite item keys oldRel -> newRel
  try {
    await withPlaylistFile(async () => {
      const data = await loadPlaylistsRaw();
      let mutated = false;
      for (const pl of data.playlists) {
        for (const it of pl.items) {
          if (it.key === oldRel) {
            it.key = newRel;
            mutated = true;
            pl.updatedAt = new Date().toISOString();
          }
        }
      }
      if (mutated) await savePlaylistsRaw(data);
    });
  } catch {}
  // Mediadims — migrate the cached entry oldRel -> newRel
  try {
    const dims = await loadMediadims();
    if (dims[oldRel]) {
      dims[newRel] = dims[oldRel];
      delete dims[oldRel];
      await saveMediadims();
    }
  } catch {}
  // Mediaorder — gallery position memory: moving out of a scope stashes the
  // file's manual index; moving back into a scope restores the remembered
  // slot, otherwise the file stays out of the scope and renders in the
  // date-desc bucket (frontend applyViewOrder). Folder scopes are keyed by
  // basename, flat scopes by the media-relative key.
  try {
    const oldParent = path.posix.dirname(oldRel);
    const oldFolder = oldParent === "." ? "" : oldParent;
    const newParent = path.posix.dirname(newRel);
    const newFolder = newParent === "." ? "" : newParent;
    const oldBase = path.posix.basename(oldRel);
    const newBase = path.posix.basename(newRel);
    const scopes = await loadMediaorder();
    const slots = await loadMovedSlots();
    let mutated = false;
    const srcScope = mediaorderScope(oldFolder, false);
    if (Array.isArray(scopes[srcScope])) {
      const at = scopes[srcScope].indexOf(oldBase);
      if (at !== -1) {
        scopes[srcScope] = scopes[srcScope].filter((k) => k !== oldBase);
        stashMovedSlot(slots, srcScope, oldBase, at);
        mutated = true;
      }
    }
    const dstScope = mediaorderScope(newFolder, false);
    const remembered = takeMovedSlot(slots, dstScope, newBase);
    if (remembered !== null) {
      if (!Array.isArray(scopes[dstScope])) scopes[dstScope] = [];
      if (!scopes[dstScope].includes(newBase)) {
        scopes[dstScope].splice(Math.min(remembered, scopes[dstScope].length), 0, newBase);
        mutated = true;
      } else {
        // Already ordered (e.g. drag-saved mid-move): drop the stale memory.
        mutated = true;
      }
    }
    for (const [scope, arr] of Object.entries(scopes)) {
      if (!scope.startsWith("flat:") || !Array.isArray(arr)) continue;
      const at = arr.indexOf(oldRel);
      if (at === -1) continue;
      scopes[scope] = arr.filter((k) => k !== oldRel);
      stashMovedSlot(slots, scope, oldRel, at);
      const back = takeMovedSlot(slots, scope, newRel);
      if (back !== null && !scopes[scope].includes(newRel)) {
        scopes[scope].splice(Math.min(back, scopes[scope].length), 0, newRel);
      }
      mutated = true;
    }
    if (mutated) await saveMediaorder();
  } catch {}
  // Stacks — strip the moved basename from any .xdlstack in the source
  // folder and dissolve stacks left with <=1 member (delete-path logic).
  try {
    const dir = path.dirname(resolveMoveSource(oldRel, mediaDir));
    const movedBase = path.posix.basename(oldRel);
    const stackFiles = await readStacksInFolder(dir);
    await withStacksFile(dir, async () => {
      for (const s of stackFiles) {
        if (!s.items.includes(movedBase)) continue;
        const full = path.join(dir, s.id);
        const data = parseStackFile(await fs.readFile(full, "utf8"));
        data.items = data.items.filter((x) => x !== movedBase);
        if (data.items.length <= 1) await fs.unlink(full).catch(() => {});
        else await fs.writeFile(full, JSON.stringify(data, null, 2), "utf8");
      }
    });
  } catch {}
}
app.post("/api/media/move", async (req, res) => {
  try {
    const folder = String(req.body?.folder || "").trim();
    const target = String(req.body?.target || "").trim();
    const names = Array.isArray(req.body?.names) ? req.body.names.map((n) => String(n).trim()).filter(Boolean) : [];
    if (!names.length) return res.status(400).json({ ok: false, error: "names required" });
    let targetDir;
    try {
      targetDir = resolveMediaOutputDir(target);
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }

    const results = [];
    let moved = 0;
    // Stack-aware move: a stack whose members ALL move out of the same
    // source folder travels with them — its .xdlstack file moves first so
    // the pile re-forms in the target instead of dissolving, and no removal
    // notice applies. Partially-selected stacks keep the strip/dissolve
    // behavior via cleanupMoveSidecar below. A candidate only auto-moves
    // when every member will really move (source exists, no target
    // collision); otherwise it falls back to the partial path and lands in
    // stacksSkipped.
    const stacksMoved = [];
    const stacksSkipped = [];
    try {
      const byDir = new Map(); // srcDir → Set(basename)
      for (const raw of names) {
        const key = sanitizeMoveKey(raw, folder);
        if (!key) continue;
        const src = resolveMoveSource(key, mediaDir);
        if (!isInsideMedia(src, mediaDir)) continue;
        const dir = path.dirname(src);
        if (!byDir.has(dir)) byDir.set(dir, new Set());
        byDir.get(dir).add(path.basename(src));
      }
      const targetStacks = await readStacksInFolder(targetDir).catch(() => []);
      for (const [dir, bases] of byDir) {
        if (dir === targetDir) continue;
        const stacks = await readStacksInFolder(dir).catch(() => []);
        if (!stacks.length) continue;
        const { full } = splitStacksByCoverage(stacks, [...bases]);
        for (const st of full) {
          let movable = true;
          for (const item of st.items) {
            const s = path.join(dir, item);
            const d = path.join(targetDir, item);
            const sStat = await fs.stat(s).catch(() => null);
            if (!sStat || sStat.isDirectory()) { movable = false; break; }
            if (s === d) { movable = false; break; }
            if (await fs.stat(d).catch(() => null)) { movable = false; break; }
          }
          if (!movable) { stacksSkipped.push({ id: st.id, name: st.name, error: "member would not move" }); continue; }
          if (targetStacks.length >= STACK_LIMIT_PER_FOLDER) { stacksSkipped.push({ id: st.id, name: st.name, error: `too many stacks (max ${STACK_LIMIT_PER_FOLDER})` }); continue; }
          if (await fs.stat(path.join(targetDir, st.id)).catch(() => null)) { stacksSkipped.push({ id: st.id, name: st.name, error: "stack already exists in target folder" }); continue; }
          await fs.mkdir(targetDir, { recursive: true });
          await fs.rename(path.join(dir, st.id), path.join(targetDir, st.id));
          targetStacks.push({ id: st.id, name: st.name, items: st.items, count: st.items.length });
          stacksMoved.push({ id: st.id, name: st.name });
        }
      }
    } catch {}
    for (const raw of names) {
      const key = sanitizeMoveKey(raw, folder);
      if (!key) { results.push({ name: raw, moved: false, error: "invalid name" }); continue; }
      const src = resolveMoveSource(key, mediaDir);
      if (!isInsideMedia(src, mediaDir)) { results.push({ name: raw, moved: false, error: "invalid path" }); continue; }
      const stat = await fs.stat(src).catch(() => null);
      if (!stat || stat.isDirectory()) { results.push({ name: path.posix.basename(key), from: key, moved: false, error: "not found" }); continue; }
      const base = path.basename(src);
      const dest = path.join(targetDir, base);
      if (src === dest) { results.push({ name: base, from: key, to: target, moved: false, error: "same folder" }); continue; }
      if (await fs.stat(dest).catch(() => null)) { results.push({ name: base, from: key, to: target, moved: false, error: "target exists" }); continue; }
      await fs.mkdir(targetDir, { recursive: true });
      await fs.rename(src, dest);
      moved++;
      const newRel = mediaRelOf(dest, mediaDir);
      const targetRel = target.replace(/\\/g, "/").replace(/^\/+/, "");
      const entry = { name: base, from: key, to: target, moved: true };
      // Companion poster/thumbnail (<stem>-poster.<img>) travels with the
      // file: same skip-on-collision policy, sidecar cleanup per poster.
      try {
        const siblings = await fs.readdir(path.dirname(src));
        const posters = findCompanionPosters(siblings, base);
        if (posters.length) entry.posters = [];
        for (const poster of posters) {
          const pSrc = path.join(path.dirname(src), poster);
          const pDest = path.join(targetDir, poster);
          const pStat = await fs.stat(pSrc).catch(() => null);
          if (!pStat || pStat.isDirectory()) { entry.posters.push({ name: poster, moved: false, error: "not found" }); continue; }
          if (await fs.stat(pDest).catch(() => null)) { entry.posters.push({ name: poster, moved: false, error: "target exists" }); continue; }
          await fs.rename(pSrc, pDest);
          entry.posters.push({ name: poster, moved: true });
          const oldPRel = path.posix.join(path.posix.dirname(key), poster);
          const newPRel = targetRel ? `${targetRel}/${poster}` : poster;
          try { await cleanupMoveSidecar(oldPRel, newPRel); } catch {}
        }
      } catch {}
      results.push(entry);
      try { await cleanupMoveSidecar(key, newRel); } catch {}
    }
    return res.json({ ok: true, moved, results, stacksMoved, stacksSkipped });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});
// --- Media lock / unlock + upload (plan 039) ---
function vaultHttpError(res, e) {
  const status = e && Number.isInteger(e.status) ? e.status : 500;
  return res.status(status).json({ ok: false, error: e && e.message ? e.message : String(e), code: (e && e.code) || null });
}
// Drop plaintext caches derived from a file that was just encrypted.
async function purgePlainCachesFor(fullPath, beforeStat) {
  try {
    const rel = path.relative(mediaDir, fullPath);
    const thumbHash = crypto.createHash("sha1").update(`${beforeStat.mtimeMs}:${beforeStat.size}:${rel}`).digest("hex").slice(0, 20);
    const entries = await fs.readdir(thumbCacheDir).catch(() => []);
    for (const n of entries) if (n.startsWith(`${thumbHash}.`)) await fs.unlink(path.join(thumbCacheDir, n)).catch(() => {});
    const gifHash = crypto.createHash("sha1").update(`${beforeStat.mtimeMs}:${rel}`).digest("hex").slice(0, 20);
    await fs.unlink(path.join(gifCacheDir, `${gifHash}.mp4`)).catch(() => {});
  } catch {}
}
// Encrypt ("lock") or decrypt ("unlock") one file in place. Returns
// "done" | "skipped" | "missing"; throws on failure.
async function lockMediaFile(fullPath, action) {
  if (!isInsideMedia(fullPath, mediaDir)) throw new Error("invalid path");
  const name = path.basename(fullPath);
  if (!mediaCrypto.isLockableName(name)) return "skipped";
  // Never replace a symlink with an encrypted copy of its target.
  const lst = await fs.lstat(fullPath).catch(() => null);
  if (lst && lst.isSymbolicLink()) return "skipped";
  const info = await mediaVault.fileInfo(fullPath);
  if (!info) return "missing";
  if ((action === "lock") === info.locked) return "skipped";
  // Locking needs only the public key (works while the vault is locked);
  // unlocking needs the private key (opened by the password or pattern).
  const key = action === "lock" ? await mediaVault.encryptKey() : await mediaVault.decryptKey();
  if (!key) throw Object.assign(new Error("media vault is locked — unlock it with your password or pattern"), { status: 423 });
  if (action === "lock") await mediaVault.ensureCopyFor(fullPath);
  let result;
  if (action === "lock") {
    const st = await fs.stat(fullPath);
    result = await mediaCrypto.encryptFileInPlace(fullPath, key, { createdMs: mediaVault.createdOverride(st) || undefined });
    await purgePlainCachesFor(fullPath, result.before);
  } else {
    result = await mediaCrypto.decryptFileInPlace(fullPath, key);
    await mediaVault.setCreatedOverride(result.stat, result.createdMs);
  }
  mediaVault.forget(fullPath);
  // Keep the dims cache valid: same picture, new on-disk size.
  try {
    const relKey = mediaRelOf(fullPath, mediaDir);
    const dims = await loadMediadims();
    if (dims[relKey]) {
      dims[relKey] = { ...dims[relKey], size: result.stat.size, mtimeMs: result.stat.mtimeMs };
      await saveMediadims();
    }
  } catch {}
  return "done";
}
// Poster generation that works for encrypted videos too: ffmpeg reads the
// decrypting URL and the poster gets encrypted like its video.
async function generatePosterForMedia(fullPath, opts = {}) {
  const input = await ffInputFor(fullPath);
  const poster = await generatePosterThumbnail(fullPath, { ...opts, input: input.locked ? { pre: input.pre, src: input.src } : null });
  if (poster && input.locked) {
    try { await lockMediaFile(poster, "lock"); } catch (e) { console.error(`[lock] poster encrypt failed: ${e.message}`); }
  }
  return poster;
}
async function companionPosterPaths(fullPath) {
  const siblings = await fs.readdir(path.dirname(fullPath)).catch(() => []);
  return findCompanionPosters(siblings, path.basename(fullPath)).map((p) => path.join(path.dirname(fullPath), p));
}
async function walkLockable(dir, out, depth = 0) {
  if (depth > 32 || out.length > 200000) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const en of entries) {
    if (en.isSymbolicLink() || en.name.startsWith(".")) continue;
    const full = path.join(dir, en.name);
    if (en.isDirectory()) await walkLockable(full, out, depth + 1);
    else if (en.isFile() && mediaCrypto.isLockableName(en.name)) out.push(full);
  }
}
// Resolve the request's file keys (+ their posters) and folders (recursive).
async function collectLockTargets(folder, keys, dirs) {
  const out = new Set();
  for (const raw of keys) {
    const key = sanitizeMoveKey(raw, folder);
    if (!key) continue;
    const full = resolveMoveSource(key, mediaDir);
    if (!isInsideMedia(full, mediaDir)) continue;
    out.add(full);
    for (const p of await companionPosterPaths(full)) out.add(p);
  }
  const base = resolveMediaOutputDir(folder);
  for (const raw of dirs) {
    const d = String(raw ?? "").replace(/\\/g, "/").trim();
    if (d.split("/").includes("..") || d.startsWith("/")) continue;
    const full = d ? path.resolve(base, ...d.split("/").filter(Boolean)) : base;
    const rel = path.relative(mediaDir, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const list = [];
    await walkLockable(full, list);
    for (const p of list) out.add(p);
  }
  return [...out];
}
let lockJob = null;
let lockJobCounter = 0;
let lockBroadcastAt = 0;
function lockJobSnapshot() {
  if (!lockJob) return null;
  const { id, action, total, done, skipped, failed, current, status, startedAt, finishedAt, errors, label } = lockJob;
  return { id, action, total, done, skipped, failed, current, status, startedAt, finishedAt, errors: errors.slice(0, 20), label };
}
function broadcastLockJob(force) {
  const now = Date.now();
  if (!force && now - lockBroadcastAt < 250) return;
  lockBroadcastAt = now;
  wsBroadcast({ type: "media:lock", job: lockJobSnapshot() });
}
async function runLockJob(job, targets) {
  for (const full of targets) {
    if (job.cancel) break;
    job.current = mediaRelOf(full, mediaDir);
    try {
      const r = await lockMediaFile(full, job.action);
      if (r === "done") job.done += 1;
      else job.skipped += 1;
    } catch (e) {
      job.failed += 1;
      job.errors.push({ file: job.current, error: e.message });
      console.error(`[lock] ${job.action} ${job.current} failed: ${e.message}`);
      if (e.status === 423) break;
    }
    broadcastLockJob(false);
  }
  job.status = job.cancel ? "cancelled" : "done";
  job.current = null;
  job.finishedAt = new Date().toISOString();
  broadcastLockJob(true);
}
// Downloads finished with ENCRYPT_NEW_MEDIA=1: lock each file and its poster.
async function autoEncryptDownloaded(paths, log) {
  if (!mediaVault.encryptNewEnabled() || !paths || !paths.length) return;
  for (const p of new Set(paths)) {
    const full = path.isAbsolute(p) ? p : path.resolve(rootDir, p);
    if (!isInsideMedia(full, mediaDir)) continue;
    for (const target of [full, ...(await companionPosterPaths(full))]) {
      try {
        const r = await lockMediaFile(target, "lock");
        if (r === "done" && log) log(`[encrypt] locked ${mediaRelOf(target, mediaDir)}`);
      } catch (e) {
        console.error(`[encrypt] ${target}: ${e.message}`);
        if (log) log(`[encrypt] failed for ${path.basename(target)}: ${e.message}`);
      }
    }
  }
}
// Session probe for pattern logins (no stored password to replay).
app.get("/api/auth/session", (_req, res) => res.json({ ok: true }));
// Settings → Password & pattern (plan 040 v2).
app.get("/api/security", (_req, res) => {
  res.json({ ok: true, ...patternAuth.publicSettings() });
});
// Set / change / remove the panel password. Changing it re-seals the vault's
// password slot so encrypted files stay readable with the new password.
app.post("/api/security/password", async (req, res) => {
  try {
    const next = String(req.body?.newPassword ?? "");
    let current = null;
    if (isPanelProtected()) current = await patternAuth.check("password", String(req.body?.currentPassword ?? ""), req.ip);
    if (!next) {
      if (mediaVault.exists()) return res.status(400).json({ ok: false, error: "Encrypted media exists — the panel password cannot be removed" });
      await patternAuth.setPassword("");
      patternAuth.endAllSessions();
      return res.json({ ok: true, ...patternAuth.publicSettings() });
    }
    if (mediaVault.exists()) {
      mediaCrypto.checkPassword(next);
      // Old password slot is kept until the login hash is saved too, so a
      // crash in between can't leave files unopenable.
      await mediaVault.setSlot("password", next, { currentPassword: current, keepPrevious: true });
    }
    const settings = await patternAuth.setPassword(next);
    if (mediaVault.exists()) await mediaVault.dropPrevious().catch((e) => console.error(`[vault] could not drop the previous password slot: ${e.message}`));
    // A password change logs out every other session; this browser gets a
    // fresh token (also on the very first password).
    patternAuth.endAllSessions();
    const token = patternAuth.newSession();
    res.cookie("xdl_session", token, { httpOnly: true, sameSite: "lax", path: "/" });
    res.json({ ok: true, ...settings, token });
  } catch (e) { return vaultHttpError(res, e); }
});
// Set / remove the 5x5 pattern (login + vault slot). Needs the password.
app.post("/api/security/pattern", async (req, res) => {
  try {
    const pw = await patternAuth.check("password", String(req.body?.password ?? ""), req.ip);
    const canonical = await patternAuth.setPattern(req.body?.pattern ?? null);
    if (mediaVault.exists()) await mediaVault.setSlot("pattern", canonical, { currentPassword: pw });
    // A pattern change logs out every other session too.
    patternAuth.endAllSessions();
    const token = patternAuth.newSession();
    res.cookie("xdl_session", token, { httpOnly: true, sameSite: "lax", path: "/" });
    res.json({ ok: true, ...patternAuth.publicSettings(), vault: vaultStatusFull(), token });
  } catch (e) { return vaultHttpError(res, e); }
});
app.post("/api/security/prefs", async (req, res) => {
  try {
    res.json({ ok: true, ...(await patternAuth.setPrefs(req.body || {})) });
  } catch (e) { return vaultHttpError(res, e); }
});
// Idle auto-lock: forget the key; the password or pattern opens it again.
setInterval(() => {
  const mins = patternAuth.autoLockMinutes();
  if (!mins) return;
  if (!mediaVault.status().unlocked) return;
  if (Date.now() - lastPanelActivity < mins * 60000) return;
  mediaVault.lockNow();
  lockedThumbCache.clear();
  lockedThumbBytes = 0;
  console.log(`[vault] auto-locked after ${mins} min idle`);
}, 30000).unref();
app.get("/api/vault/status", async (_req, res) => {
  await mediaVault.init();
  res.json({ ok: true, ...vaultStatusFull() });
});
// One-time setup: a random key pair is created and sealed with the panel
// password (and later the pattern). The password must be ≥12 characters.
app.post("/api/vault/setup", async (req, res) => {
  try {
    const pw = await patternAuth.check("password", String(req.body?.password ?? ""), req.ip);
    await mediaVault.setup(pw);
    res.json({ ok: true, ...vaultStatusFull() });
  } catch (e) { return vaultHttpError(res, e); }
});
// Upgrade an encryption key from the earlier separate-passphrase version:
// same key pair (so already-locked files stay readable), sealed with the
// panel password.
app.post("/api/vault/upgrade", async (req, res) => {
  try {
    const pw = await patternAuth.check("password", String(req.body?.password ?? ""), req.ip);
    await mediaVault.upgrade(String(req.body?.passphrase ?? ""), pw);
    console.log("[vault] upgraded from the separate-passphrase format");
    res.json({ ok: true, ...vaultStatusFull() });
  } catch (e) { return vaultHttpError(res, e); }
});
// Unlock with the password or the pattern (rate-limited).
app.post("/api/vault/unlock", async (req, res) => {
  try {
    if (req.body?.pattern) {
      const canonical = await patternAuth.check("pattern", req.body.pattern, req.ip);
      if (!mediaVault.status().patternSlot) return res.status(400).json({ ok: false, error: "Your pattern doesn't unlock files yet — use the password, then re-draw the pattern in Settings" });
      await mediaVault.unlock("pattern", canonical);
    } else {
      const pw = await patternAuth.check("password", String(req.body?.password ?? ""), req.ip);
      await mediaVault.unlock("password", pw);
    }
    lastPanelActivity = Date.now();
    void flushPendingPosters();
    res.json({ ok: true, ...vaultStatusFull() });
  } catch (e) { return vaultHttpError(res, e); }
});
app.post("/api/vault/lock", async (_req, res) => {
  mediaVault.lockNow();
  lockedThumbCache.clear();
  lockedThumbBytes = 0;
  res.json({ ok: true, ...vaultStatusFull() });
});
app.get("/api/media/lock/job", (_req, res) => {
  res.json({ ok: true, job: lockJobSnapshot() });
});
app.post("/api/media/lock/cancel", (_req, res) => {
  if (lockJob && lockJob.status === "running") lockJob.cancel = true;
  res.json({ ok: true, job: lockJobSnapshot() });
});
app.post("/api/media/lock", async (req, res) => {
  try {
    const action = String(req.body?.action || "lock");
    if (action !== "lock" && action !== "unlock") return res.status(400).json({ ok: false, error: "action must be lock or unlock" });
    if (lockJob && lockJob.status === "running") return res.status(409).json({ ok: false, error: "another lock job is running", job: lockJobSnapshot() });
    const folder = String(req.body?.folder || "").trim();
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [];
    const dirs = Array.isArray(req.body?.dirs) ? req.body.dirs.map(String) : [];
    if (!keys.length && !dirs.length) return res.status(400).json({ ok: false, error: "keys or dirs required" });
    // Claim the single job slot BEFORE any await, so two quick requests
    // can't both start a job.
    const label = dirs.length ? (dirs.length === 1 ? `folder ${dirs[0] || folder || "media"}` : `${dirs.length} folders`) : `${keys.length} file${keys.length === 1 ? "" : "s"}`;
    const job = { id: ++lockJobCounter, action, total: 0, done: 0, skipped: 0, failed: 0, current: "Preparing…", status: "running", startedAt: new Date().toISOString(), finishedAt: null, errors: [], label, cancel: false };
    const previousJob = lockJob;
    lockJob = job;
    let targets;
    try {
      // Fail fast on key problems (no password / locked vault) before queuing.
      if (action === "lock") await mediaVault.encryptKey();
      else if (!(await mediaVault.decryptKey())) { lockJob = previousJob; return res.status(423).json({ ok: false, error: "media vault is locked — unlock it with your password or pattern" }); }
      targets = await collectLockTargets(folder, keys, dirs);
    } catch (e) {
      lockJob = previousJob;
      throw e;
    }
    job.total = targets.length;
    job.current = null;
    broadcastLockJob(true);
    void runLockJob(job, targets).catch((e) => {
      job.status = "error";
      job.errors.push({ file: null, error: e.message });
      broadcastLockJob(true);
    });
    return res.json({ ok: true, job: lockJobSnapshot() });
  } catch (e) { return vaultHttpError(res, e); }
});
function sanitizeUploadSegments(raw) {
  const segs = String(raw || "").replace(/\\/g, "/").split("/").map((s) => s.trim()).filter(Boolean);
  if (!segs.length || segs.length > 16) return null;
  for (const s of segs) {
    if (s === "." || s === ".." || s.startsWith(".") || s.length > 200 || /[\0-\x1f]/.test(s)) return null;
  }
  return segs;
}
async function uniqueMediaName(dir, base) {
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let i = 0; i < 10000; i++) {
    const name = i ? `${stem} (${i})${ext}` : base;
    if (!(await fs.stat(path.join(dir, name)).catch(() => null))) return name;
  }
  throw new Error("could not find a free file name");
}
// Raw-body upload: POST /api/media/upload?folder=<f>&path=<relative/file.ext>
// The body is the file's bytes (any size, streamed). Sub-folders in `path`
// (folder drops) are created inside `folder`.
let activeUploads = 0;
app.post("/api/media/upload", async (req, res) => {
  let tmp = null;
  activeUploads += 1;
  try {
    const folder = String(req.query?.folder || "").trim();
    const segs = sanitizeUploadSegments(req.query?.path || req.query?.name);
    if (!segs) return res.status(400).json({ ok: false, error: "invalid file name" });
    if (!mediaCrypto.isLockableName(segs[segs.length - 1])) return res.status(400).json({ ok: false, error: "that file name is reserved" });
    const baseDir = resolveMediaOutputDir(folder);
    const targetDir = path.join(baseDir, ...segs.slice(0, -1));
    const relDir = path.relative(mediaDir, targetDir);
    if (relDir.startsWith("..") || path.isAbsolute(relDir)) return res.status(400).json({ ok: false, error: "invalid path" });
    await fs.mkdir(targetDir, { recursive: true });
    const encrypt = mediaVault.encryptNewEnabled();
    const key = encrypt ? await mediaVault.encryptKey() : null;
    let name = await uniqueMediaName(targetDir, segs[segs.length - 1]);
    tmp = mediaCrypto.tempSiblingPath(path.join(targetDir, name), "xupl");
    if (key) {
      await mediaCrypto.encryptIterableToFile(req, tmp, key, { createdMs: Date.now() });
    } else {
      await require("stream/promises").pipeline(req, fsSync.createWriteStream(tmp, { flags: "wx" }));
    }
    // Commit without ever overwriting: link() fails with EEXIST if another
    // upload/download took the name meanwhile -> try the next free name.
    if (key) await mediaVault.ensureCopyFor(path.join(targetDir, name));
    let finalPath = null;
    for (let attempt = 0; attempt < 50 && !finalPath; attempt++) {
      const candidate = path.join(targetDir, name);
      try {
        await fs.link(tmp, candidate);
        finalPath = candidate;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        name = await uniqueMediaName(targetDir, name);
      }
    }
    if (!finalPath) throw new Error("could not find a free file name");
    await fs.unlink(tmp).catch(() => {});
    tmp = null;
    const rel = mediaRelOf(finalPath, mediaDir);
    res.json({ ok: true, name, rel, locked: !!key });
    if (isVideoFileName(name)) {
      // Encrypted while the vault is locked: ffmpeg can't read it yet, so the
      // poster is made right after the next unlock.
      if (key && !(await mediaVault.decryptKey())) pendingPosters.add(finalPath);
      else void generatePosterForMedia(finalPath).catch(() => {});
    }
  } catch (e) {
    if (tmp) await fs.unlink(tmp).catch(() => {});
    if (!res.headersSent && !req.destroyed) return vaultHttpError(res, e);
  } finally {
    activeUploads -= 1;
  }
});
// Posters waiting for the vault to be unlocked (encrypted while locked).
const pendingPosters = new Set();
async function flushPendingPosters() {
  if (!pendingPosters.size || !(await mediaVault.decryptKey())) return;
  const list = [...pendingPosters];
  pendingPosters.clear();
  for (const f of list) await generatePosterForMedia(f).catch(() => {});
}
// --- Playlists (.playlists.json) ---
const playlistsFile = path.join(rootDir, ".playlists.json");
let playlistsChain = Promise.resolve();
async function withPlaylistFile(fn) {
  let result, error;
  const task = async () => { try { result = await fn(); } catch (e) { error = e; } };
  playlistsChain = playlistsChain.then(task, task);
  await playlistsChain;
  if (error) throw error;
  return result;
}
function normalizePlaylistName(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("playlist name required");
  if (s.length > 60) throw new Error("playlist name too long (max 60)");
  if (/[\n\r]/.test(s)) throw new Error("invalid playlist name");
  return s;
}
function normalizePlaylistKey(raw) {
  const s = String(raw || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!s) throw new Error("key required");
  if (s.includes("..")) throw new Error("invalid key");
  if (s.startsWith("/")) throw new Error("invalid key");
  const normalized = path.posix.normalize(s);
  if (!normalized || normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) throw new Error("invalid key");
  if (normalized.includes("\\")) throw new Error("invalid key");
  return normalized;
}
async function loadPlaylistsRaw() {
  try {
    const raw = await fs.readFile(playlistsFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("invalid playlists file");
    const playlists = Array.isArray(parsed.playlists) ? parsed.playlists : [];
    // sanitize shape
    for (const pl of playlists) {
      if (!pl || typeof pl !== "object") continue;
      pl.id = String(pl.id || "");
      pl.name = String(pl.name || "");
      pl.createdAt = String(pl.createdAt || new Date().toISOString());
      pl.updatedAt = String(pl.updatedAt || pl.createdAt);
      if (!Array.isArray(pl.items)) pl.items = [];
      pl.items = pl.items.filter((it) => it && typeof it.key === "string" && it.key).map((it) => ({ key: normalizePlaylistKey(it.key), addedAt: String(it.addedAt || new Date().toISOString()) }));
    }
    return { playlists: playlists.filter((p) => p.id && p.name), updatedAt: String(parsed.updatedAt || new Date().toISOString()) };
  } catch (e) {
    if (e && e.code === "ENOENT") return { playlists: [], updatedAt: new Date().toISOString() };
    throw e;
  }
}
async function savePlaylistsRaw(data) {
  data.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(playlistsFile), { recursive: true });
  await fs.writeFile(playlistsFile, JSON.stringify(data, null, 2), "utf8");
}
function playlistSummary(pl) {
  return { id: pl.id, name: pl.name, createdAt: pl.createdAt, updatedAt: pl.updatedAt, count: pl.items.length, items: pl.items.map((it) => it.key) };
}
app.get("/api/playlists", async (_req, res) => {
  try {
    const data = await withPlaylistFile(() => loadPlaylistsRaw());
    return res.json({ ok: true, playlists: data.playlists.map(playlistSummary) });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/api/playlists/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const data = await withPlaylistFile(() => loadPlaylistsRaw());
    const pl = data.playlists.find((p) => p.id === id);
    if (!pl) return res.status(404).json({ ok: false, error: "playlist not found" });
    // Enrich items with file stats for Media playlist view
    const enriched = [];
    for (const it of pl.items) {
      const fullPath = path.join(mediaDir, ...it.key.split("/").filter(Boolean));
      const rel = path.relative(mediaDir, fullPath);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) { enriched.push({ key: it.key, addedAt: it.addedAt, missing: true }); continue; }
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat || !stat.isFile()) { enriched.push({ key: it.key, addedAt: it.addedAt, missing: true }); continue; }
      const ft = fileEntryTimes(stat);
      const name = it.key.split("/").pop() || it.key;
      // Poster sibling lookup (same convention as listMediaDir `thumb`):
      // `<stem>-poster.jpg` next to the video, key-relative for /media/ URLs.
      let thumb = null;
      const ext = String(name.split(".").pop() || "").toLowerCase();
      if (["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "3gp", "flv", "ts", "m3u8"].includes(ext)) {
        const stem = name.replace(/\.[^.]+$/, "");
        const dirPrefix = it.key.includes("/") ? it.key.slice(0, it.key.lastIndexOf("/")) : "";
        for (const pext of ["jpg", "jpeg", "png", "webp", "avif", "gif"]) {
          const candKey = (dirPrefix ? `${dirPrefix}/` : "") + `${stem}-poster.${pext}`;
          const candPath = path.join(mediaDir, ...candKey.split("/").filter(Boolean));
          const cstat = await fs.stat(candPath).catch(() => null);
          if (cstat && cstat.isFile()) { thumb = candKey; break; }
        }
      }
      const ratio = await dimsRatioFor(it.key, fullPath, stat);
      const entry = { key: it.key, name, dir: false, size: stat.size, mtime: ft.mtime, created: ft.created, addedAt: it.addedAt, missing: false, thumb };
      if (ratio) entry.ratio = ratio;
      const lockInfo = await mediaVault.fileInfo(fullPath, { size: stat.size, mtimeMs: stat.mtimeMs }).catch(() => null);
      if (lockInfo && lockInfo.locked) {
        entry.locked = true;
        entry.size = lockInfo.header.plainSize;
        if (lockInfo.header.createdMs > 0) entry.created = new Date(lockInfo.header.createdMs).toISOString();
      }
      enriched.push(entry);
    }
    return res.json({ ok: true, playlist: { id: pl.id, name: pl.name, createdAt: pl.createdAt, updatedAt: pl.updatedAt, items: enriched } });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/playlists", async (req, res) => {
  try {
    const name = normalizePlaylistName(req.body?.name);
    return await withPlaylistFile(async () => {
      const data = await loadPlaylistsRaw();
      if (data.playlists.length >= 100) return res.status(400).json({ ok: false, error: "too many playlists (max 100)" });
      const exists = data.playlists.some((p) => p.name.toLowerCase() === name.toLowerCase());
      if (exists) return res.status(409).json({ ok: false, error: "playlist name already exists" });
      const id = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();
      const pl = { id, name, createdAt: now, updatedAt: now, items: [] };
      data.playlists.push(pl);
      await savePlaylistsRaw(data);
      return res.status(201).json({ ok: true, playlist: playlistSummary(pl) });
    });
  } catch (e) {
    const msg = e.message || String(e);
    if (/already exists|too many|required|too long|invalid/i.test(msg)) return res.status(/already exists/i.test(msg) ? 409 : 400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});
app.patch("/api/playlists/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const name = normalizePlaylistName(req.body?.name);
    return await withPlaylistFile(async () => {
      const data = await loadPlaylistsRaw();
      const pl = data.playlists.find((p) => p.id === id);
      if (!pl) return res.status(404).json({ ok: false, error: "playlist not found" });
      const dup = data.playlists.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase());
      if (dup) return res.status(409).json({ ok: false, error: "playlist name already exists" });
      pl.name = name;
      pl.updatedAt = new Date().toISOString();
      await savePlaylistsRaw(data);
      return res.json({ ok: true, playlist: playlistSummary(pl) });
    });
  } catch (e) {
    const msg = e.message || String(e);
    if (/already exists|required|too long|invalid/i.test(msg)) return res.status(/already exists/i.test(msg) ? 409 : 400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});
app.delete("/api/playlists/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    return await withPlaylistFile(async () => {
      const data = await loadPlaylistsRaw();
      const idx = data.playlists.findIndex((p) => p.id === id);
      if (idx === -1) return res.status(404).json({ ok: false, error: "playlist not found" });
      data.playlists.splice(idx, 1);
      await savePlaylistsRaw(data);
      return res.json({ ok: true });
    });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/playlists/:id/items", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const key = normalizePlaylistKey(req.body?.key || req.query?.key);
    return await withPlaylistFile(async () => {
      const data = await loadPlaylistsRaw();
      const pl = data.playlists.find((p) => p.id === id);
      if (!pl) return res.status(404).json({ ok: false, error: "playlist not found" });
      if (pl.items.length >= 5000) return res.status(400).json({ ok: false, error: "playlist full (max 5000)" });
      const exists = pl.items.some((it) => it.key === key);
      if (exists) return res.json({ ok: true, playlist: playlistSummary(pl), added: false });
      pl.items.push({ key, addedAt: new Date().toISOString() });
      pl.updatedAt = new Date().toISOString();
      await savePlaylistsRaw(data);
      return res.json({ ok: true, playlist: playlistSummary(pl), added: true });
    });
  } catch (e) {
    const msg = e.message || String(e);
    if (/key|invalid|full/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});
app.delete("/api/playlists/:id/items", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const key = normalizePlaylistKey(req.body?.key || req.query?.key);
    return await withPlaylistFile(async () => {
      const data = await loadPlaylistsRaw();
      const pl = data.playlists.find((p) => p.id === id);
      if (!pl) return res.status(404).json({ ok: false, error: "playlist not found" });
      const before = pl.items.length;
      pl.items = pl.items.filter((it) => it.key !== key);
      const removed = pl.items.length !== before;
      if (removed) {
        pl.updatedAt = new Date().toISOString();
        await savePlaylistsRaw(data);
      }
      return res.json({ ok: true, playlist: playlistSummary(pl), removed });
    });
  } catch (e) {
    const msg = e.message || String(e);
    if (/key|invalid/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});
app.post("/api/playlists/:id/toggle", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const key = normalizePlaylistKey(req.body?.key || req.query?.key);
    return await withPlaylistFile(async () => {
      const data = await loadPlaylistsRaw();
      const pl = data.playlists.find((p) => p.id === id);
      if (!pl) return res.status(404).json({ ok: false, error: "playlist not found" });
      const idx = pl.items.findIndex((it) => it.key === key);
      let member;
      if (idx !== -1) {
        pl.items.splice(idx, 1);
        member = false;
      } else {
        if (pl.items.length >= 5000) return res.status(400).json({ ok: false, error: "playlist full (max 5000)" });
        pl.items.push({ key, addedAt: new Date().toISOString() });
        member = true;
      }
      pl.updatedAt = new Date().toISOString();
      await savePlaylistsRaw(data);
      return res.json({ ok: true, playlist: playlistSummary(pl), member });
    });
  } catch (e) {
    const msg = e.message || String(e);
    if (/key|invalid|full/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});
// --- Stacks (.xdlstack sibling files) ---
// Each stack is a sibling JSON file `media/<folder>/<name>.xdlstack` grouping
// bare filenames from that same folder (sibling rule). No central store.
const STACK_LIMIT_PER_FOLDER = 100;
const STACK_LIMIT_ITEMS = 5000;
function normalizeStackName(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("stack name required");
  if (s.length > 80) throw new Error("stack name too long (max 80)");
  if (/[\n\r/\\]/.test(s)) throw new Error("invalid stack name");
  if (/\.xdlstack$/i.test(s)) throw new Error("invalid stack name");
  return s;
}
function normalizeStackItem(raw) {
  const s = String(raw || "").trim().replace(/\\/g, "/");
  if (!s) throw new Error("item required");
  if (s.includes("/") || s.includes("..") || s.startsWith(".")) throw new Error("invalid item");
  if (s.endsWith(".xdlstack")) throw new Error("stack files cannot be items");
  return s;
}
function stackFilePath(dir, id) {
  const base = String(id || "").trim();
  if (!/^[^/\\]+\.xdlstack$/i.test(base)) throw new Error("invalid stack id");
  return path.join(dir, base);
}
function parseStackFile(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) throw new Error("invalid stack file");
  const name = String(parsed.name || "").trim();
  if (!name) throw new Error("invalid stack file");
  const items = [];
  for (const it of parsed.items) {
    try { items.push(normalizeStackItem(it)); } catch {}
  }
  return { name, items };
}
const stackChains = new Map(); // dir → Promise chain (per-folder serialization)
function withStacksFile(dir, fn) {
  let result, error;
  const task = async () => { try { result = await fn(); } catch (e) { error = e; } };
  const prev = stackChains.get(dir) || Promise.resolve();
  const next = prev.then(task, task);
  stackChains.set(dir, next);
  return next.then(() => { if (error) throw error; return result; });
}
async function writeStackFile(dir, id, name, items) {
  await withStacksFile(dir, async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, id), JSON.stringify({ name, items }, null, 2), "utf8");
  });
}
async function readStackFile(dir, id) {
  const full = stackFilePath(dir, id);
  const raw = await fs.readFile(full, "utf8");
  const st = await fs.stat(full);
  const parsed = parseStackFile(raw);
  return { id, name: parsed.name, items: parsed.items, count: parsed.items.length, updatedAt: st.mtime.toISOString() };
}
async function readStacksInFolder(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e && e.code === "ENOENT") return out; throw e; }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.xdlstack$/i.test(entry.name)) continue;
    try {
      const parsed = parseStackFile(await fs.readFile(path.join(dir, entry.name), "utf8"));
      out.push({ id: entry.name, name: parsed.name, items: parsed.items, count: parsed.items.length });
    } catch {}
  }
  return out;
}
async function collectStacksForListing(resolved, flat) {
  const map = new Map(); // folderRelKey → [{ id, name, members:Set }]
  const walk = async (dir, relKey) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const stacks = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.xdlstack$/i.test(entry.name)) continue;
      try {
        const parsed = parseStackFile(await fs.readFile(path.join(dir, entry.name), "utf8"));
        stacks.push({ id: entry.name, name: parsed.name, members: new Set(parsed.items) });
      } catch {}
    }
    if (stacks.length) map.set(relKey, stacks);
    if (flat) {
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        await walk(path.join(dir, entry.name), relKey ? `${relKey}/${entry.name}` : entry.name);
      }
    }
  };
  await walk(resolved, "");
  return map;
}
app.get("/api/stacks", async (req, res) => {
  try {
    const folder = String(req.query?.folder || "").trim();
    const dir = resolveMediaOutputDir(folder);
    const stacks = await readStacksInFolder(dir);
    stacks.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return res.json({ ok: true, folder, stacks });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});
app.post("/api/stacks", async (req, res) => {
  try {
    const folder = String(req.body?.folder || "").trim();
    const dir = resolveMediaOutputDir(folder);
    const name = normalizeStackName(req.body?.name);
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!rawItems.length) throw new Error("at least one item required");
    if (rawItems.length > STACK_LIMIT_ITEMS) throw new Error(`stack full (max ${STACK_LIMIT_ITEMS})`);
    const stacks = await readStacksInFolder(dir);
    if (stacks.length >= STACK_LIMIT_PER_FOLDER) throw new Error(`too many stacks (max ${STACK_LIMIT_PER_FOLDER})`);
    if (stacks.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new Error("stack name already exists in this folder");
    const items = [];
    for (const r of rawItems) {
      const item = normalizeStackItem(r);
      const stat = await fs.stat(path.join(dir, item)).catch(() => null);
      if (!stat || !stat.isFile()) throw new Error(`file not found: ${item}`);
      items.push(item);
    }
    const id = `${name}.xdlstack`;
    await writeStackFile(dir, id, name, items);
    const stack = await readStackFile(dir, id);
    return res.status(201).json({ ok: true, stack });
  } catch (error) {
    const msg = error.message || String(error);
    if (/already exists/i.test(msg)) return res.status(409).json({ ok: false, error: msg });
    if (/required|too many|too long|invalid|not found|full|item/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});
app.patch("/api/stacks/:id", async (req, res) => {
  try {
    const folder = String(req.body?.folder || req.query?.folder || "").trim();
    const dir = resolveMediaOutputDir(folder);
    const id = String(req.params.id || "").trim();
    const name = normalizeStackName(req.body?.name);
    const oldPath = stackFilePath(dir, id);
    const stat = await fs.stat(oldPath).catch(() => null);
    if (!stat || !stat.isFile()) return res.status(404).json({ ok: false, error: "stack not found" });
    const stacks = await readStacksInFolder(dir);
    if (stacks.some((s) => s.id !== id && s.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ ok: false, error: "stack name already exists in this folder" });
    const newId = `${name}.xdlstack`;
    await withStacksFile(dir, async () => {
      const parsed = parseStackFile(await fs.readFile(oldPath, "utf8"));
      const newPath = path.join(dir, newId);
      if (oldPath !== newPath) await fs.rename(oldPath, newPath);
      await fs.writeFile(newPath, JSON.stringify({ name, items: parsed.items }, null, 2), "utf8");
    });
    const stack = await readStackFile(dir, newId);
    return res.json({ ok: true, stack });
  } catch (error) {
    const msg = error.message || String(error);
    if (/already exists/i.test(msg)) return res.status(409).json({ ok: false, error: msg });
    if (/stack not found/i.test(msg)) return res.status(404).json({ ok: false, error: msg });
    if (/required|too long|invalid/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});
app.delete("/api/stacks/:id", async (req, res) => {
  try {
    const folder = String(req.query?.folder || req.body?.folder || "").trim();
    const dir = resolveMediaOutputDir(folder);
    const id = String(req.params.id || "").trim();
    const full = stackFilePath(dir, id);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) return res.status(404).json({ ok: false, error: "stack not found" });
    await withStacksFile(dir, async () => { await fs.unlink(full); });
    return res.json({ ok: true });
  } catch (error) {
    const msg = error.message || String(error);
    if (/stack not found/i.test(msg)) return res.status(404).json({ ok: false, error: msg });
    if (/invalid/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});
app.post("/api/stacks/:id/items", async (req, res) => {
  try {
    const folder = String(req.body?.folder || req.query?.folder || "").trim();
    const dir = resolveMediaOutputDir(folder);
    const id = String(req.params.id || "").trim();
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
    const full = stackFilePath(dir, id);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) return res.status(404).json({ ok: false, error: "stack not found" });
    if (!keys.length) return res.json({ ok: true, stack: await readStackFile(dir, id), added: 0 });
    const addedCount = await withStacksFile(dir, async () => {
      const data = parseStackFile(await fs.readFile(full, "utf8"));
      const seen = new Set(data.items);
      const added = [];
      for (const k of keys) {
        const item = normalizeStackItem(k);
        if (seen.has(item)) continue;
        const st = await fs.stat(path.join(dir, item)).catch(() => null);
        if (!st || !st.isFile()) throw new Error(`file not found: ${item}`);
        if (data.items.length >= STACK_LIMIT_ITEMS) throw new Error(`stack full (max ${STACK_LIMIT_ITEMS})`);
        data.items.push(item);
        seen.add(item);
        added.push(item);
      }
      if (added.length) await fs.writeFile(full, JSON.stringify({ name: data.name, items: data.items }, null, 2), "utf8");
      return added.length;
    });
    return res.json({ ok: true, stack: await readStackFile(dir, id), added: addedCount });
  } catch (error) {
    const msg = error.message || String(error);
    if (/stack not found/i.test(msg)) return res.status(404).json({ ok: false, error: msg });
    if (/invalid|not found|full/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});
app.delete("/api/stacks/:id/items", async (req, res) => {
  try {
    const folder = String(req.body?.folder || req.query?.folder || "").trim();
    const dir = resolveMediaOutputDir(folder);
    const id = String(req.params.id || "").trim();
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
    const full = stackFilePath(dir, id);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) return res.status(404).json({ ok: false, error: "stack not found" });
    const removedCount = await withStacksFile(dir, async () => {
      const data = parseStackFile(await fs.readFile(full, "utf8"));
      const del = new Set();
      for (const k of keys) { try { del.add(normalizeStackItem(k)); } catch {} }
      const before = data.items.length;
      data.items = data.items.filter((x) => !del.has(x));
      // A lone file is not a stack: release it and drop the stack file.
      if (data.items.length <= 1) {
        await fs.unlink(full).catch(() => {});
        return { removed: before - data.items.length, dissolved: true };
      }
      if (data.items.length !== before) await fs.writeFile(full, JSON.stringify({ name: data.name, items: data.items }, null, 2), "utf8");
      return { removed: before - data.items.length, dissolved: false };
    });
    if (removedCount.dissolved) return res.json({ ok: true, stack: null, removed: removedCount.removed, dissolved: true });
    return res.json({ ok: true, stack: await readStackFile(dir, id), removed: removedCount.removed });
  } catch (error) {
    const msg = error.message || String(error);
    if (/stack not found/i.test(msg)) return res.status(404).json({ ok: false, error: msg });
    if (/invalid/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
  }
});
// Move a whole stack (plan 032+): the .xdlstack file travels together with
// all of its member files (plus poster companions) into the target folder,
// so the pile re-forms there instead of dissolving in the source.
// Pre-validates every collision before moving anything.
app.post("/api/stacks/:id/move", async (req, res) => {
  try {
    const folder = String(req.body?.folder || req.query?.folder || "").trim();
    const target = String(req.body?.target || "").trim();
    const dir = resolveMediaOutputDir(folder);
    const id = String(req.params.id || "").trim();
    const full = stackFilePath(dir, id);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) return res.status(404).json({ ok: false, error: "stack not found" });
    let targetDir;
    try {
      targetDir = resolveMediaOutputDir(target);
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    if (targetDir === dir) return res.status(400).json({ ok: false, error: "same folder" });
    const data = parseStackFile(await fs.readFile(full, "utf8"));
    const targetStacks = await readStacksInFolder(targetDir);
    if (targetStacks.length >= STACK_LIMIT_PER_FOLDER) return res.status(409).json({ ok: false, error: `too many stacks (max ${STACK_LIMIT_PER_FOLDER})` });
    if (await fs.stat(path.join(targetDir, id)).catch(() => null)) return res.status(409).json({ ok: false, error: `stack "${data.name}" already exists in target folder` });
    const entries = await fs.readdir(dir).catch(() => []);
    // Plan first: every collision aborts before anything moves.
    const plan = [];
    const skipped = [];
    for (const item of data.items) {
      const src = path.join(dir, item);
      const st = await fs.stat(src).catch(() => null);
      if (!st || !st.isFile()) { skipped.push({ name: item, moved: false, error: "not found" }); continue; }
      if (await fs.stat(path.join(targetDir, item)).catch(() => null)) {
        return res.status(409).json({ ok: false, error: `target exists: ${item}` });
      }
      plan.push(item);
    }
    if (!plan.length) return res.status(400).json({ ok: false, error: "no movable files in stack" });
    await fs.mkdir(targetDir, { recursive: true });
    // Stack file first: per-file sidecar cleanup below strips the moved
    // basename from every .xdlstack left in the source folder (other stacks
    // the file also belongs to) — the moved stack is already gone from there.
    await fs.rename(full, path.join(targetDir, id));
    const moved = [];
    let postersMoved = 0;
    for (const item of plan) {
      const src = path.join(dir, item);
      const dest = path.join(targetDir, item);
      const oldRel = mediaRelOf(src, mediaDir);
      await fs.rename(src, dest);
      moved.push(item);
      const newRel = mediaRelOf(dest, mediaDir);
      // Poster companions travel with the file (same skip-on-collision
      // policy as POST /api/media/move).
      try {
        const posters = findCompanionPosters(entries, item);
        for (const poster of posters) {
          const pSrc = path.join(dir, poster);
          const pDest = path.join(targetDir, poster);
          const pStat = await fs.stat(pSrc).catch(() => null);
          if (!pStat || pStat.isDirectory()) continue;
          if (await fs.stat(pDest).catch(() => null)) continue;
          await fs.rename(pSrc, pDest);
          postersMoved++;
          try { await cleanupMoveSidecar(mediaRelOf(pSrc, mediaDir), mediaRelOf(pDest, mediaDir)); } catch {}
        }
      } catch {}
      try { await cleanupMoveSidecar(oldRel, newRel); } catch {}
    }
    const stack = await readStackFile(targetDir, id);
    return res.json({ ok: true, stack, moved, skipped, postersMoved });
  } catch (error) {
    const msg = error.message || String(error);
    if (/stack not found/i.test(msg)) return res.status(404).json({ ok: false, error: msg });
    if (/already exists|too many/i.test(msg)) return res.status(409).json({ ok: false, error: msg });
    if (/same folder|no movable|invalid|target exists/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
    return res.status(500).json({ ok: false, error: msg });
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
    // Encrypted gifs are never transcoded to a plaintext cache file; the
    // client plays the (decrypted) gif itself.
    const gifLock = await mediaVault.fileInfo(srcPath, { size: stat.size, mtimeMs: stat.mtimeMs }).catch(() => null);
    if (gifLock && gifLock.locked) return res.status(404).json({ ok: false, error: "encrypted gif: no video cache" });

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

// In-memory embedded-thumb cache for encrypted videos: hash -> { buf, type } | null (no cover).
const lockedThumbCache = new Map();
const LOCKED_THUMB_MAX = 400;
const LOCKED_THUMB_BYTES = 64 * 1024 * 1024;
let lockedThumbBytes = 0;
function rememberLockedThumb(hash, value) {
  const old = lockedThumbCache.get(hash);
  if (old) lockedThumbBytes -= old.buf.length;
  lockedThumbCache.delete(hash);
  lockedThumbCache.set(hash, value || null);
  if (value) lockedThumbBytes += value.buf.length;
  while (lockedThumbCache.size > LOCKED_THUMB_MAX || lockedThumbBytes > LOCKED_THUMB_BYTES) {
    const k = lockedThumbCache.keys().next().value;
    const v = lockedThumbCache.get(k);
    if (v) lockedThumbBytes -= v.buf.length;
    lockedThumbCache.delete(k);
  }
}
async function extractLockedEmbeddedThumb(srcPath) {
  if (!ffmpegBin || !ffprobeBin) return null;
  const input = await ffInputFor(srcPath);
  const { execFile: _execFile } = require("child_process");
  const execFileAsync = require("util").promisify(_execFile);
  const { stdout } = await execFileAsync(ffprobeBin, ["-v", "error", "-show_streams", "-of", "json", ...input.args], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  let streams = [];
  try { streams = JSON.parse(stdout || "{}").streams || []; } catch { streams = []; }
  const attached = streams.find((s) => {
    const disp = s && s.disposition;
    if (disp && Number(disp.attached_pic) === 1) return true;
    return !!(s && s.codec_type === "video" && /^(mjpeg|png|jpg|jpeg|webp)$/i.test(String(s.codec_name || "")) && Number(s.index) > 0);
  });
  if (!attached) return null;
  const codec = String(attached.codec_name || "");
  const type = /png/i.test(codec) ? "image/png" : /webp/i.test(codec) ? "image/webp" : "image/jpeg";
  const fmt = type === "image/jpeg" ? "mjpeg" : "image2pipe";
  const buf = await new Promise((resolve, reject) => {
    const cp = spawn(ffmpegBin, ["-v", "error", ...input.pre, "-i", input.src, "-map", `0:${Number(attached.index)}`, "-c", "copy", "-f", fmt, "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
    const parts = [];
    let len = 0;
    cp.stdout.on("data", (d) => { len += d.length; if (len > 20 * 1024 * 1024) cp.kill("SIGKILL"); else parts.push(d); });
    const timer = setTimeout(() => cp.kill("SIGKILL"), 30000);
    cp.on("error", reject);
    cp.on("close", (code) => {
      clearTimeout(timer);
      code === 0 && len ? resolve(Buffer.concat(parts)) : reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
  return { buf, type };
}
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

    // Encrypted video (plan 039): extract through the decrypting loopback URL
    // and keep the cover in memory only — never a plaintext file in /tmp.
    const thumbLock = await mediaVault.fileInfo(srcPath, { size: stat.size, mtimeMs: stat.mtimeMs }).catch(() => null);
    if (thumbLock && thumbLock.locked) {
      // Decrypted covers are only shown while the vault is unlocked.
      if (!(await mediaVault.decryptKey())) return res.status(423).json({ ok: false, error: "media vault is locked" });
      const hit = lockedThumbCache.get(hash);
      if (hit === null) return res.status(404).json({ ok: false, error: "no embedded thumbnail" });
      if (hit) {
        res.set("Cache-Control", "private, no-store");
        return res.type(hit.type).send(hit.buf);
      }
      let job = thumbInFlight.get(hash);
      if (!job) {
        job = extractLockedEmbeddedThumb(srcPath).finally(() => thumbInFlight.delete(hash));
        thumbInFlight.set(hash, job);
      }
      // A failure (timeout, vault locked meanwhile...) is not cached; only a
      // real "this video has no embedded cover" (null) is.
      const out = await job.catch(() => undefined);
      if (out === undefined) return res.status(404).json({ ok: false, error: "cover not available right now" });
      rememberLockedThumb(hash, out);
      if (!out) return res.status(404).json({ ok: false, error: "no embedded thumbnail" });
      res.set("Cache-Control", "private, no-store");
      return res.type(out.type).send(out.buf);
    }

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

// --- Manual poster generation (UI Shift+G) ---
// Generates `<stem>-poster.jpg` frame thumbnails for the videos in one folder
// (non-recursive, current directory only). mode "missing" fills gaps only
// (stems with an existing poster sibling are skipped); mode "all" regenerates
// every video (ffmpeg `-y` overwrites in place). Sequential loop; single JSON
// response with generated/skipped/failed tallies.
app.post("/api/posters/generate", async (req, res) => {
  try {
    const folder = String((req.body && req.body.folder) || "").replace(/\\/g, "/").trim();
    const mode = String((req.body && req.body.mode) || "");
    if (mode !== "missing" && mode !== "all") {
      return res.status(400).json({ ok: false, error: "mode must be 'missing' or 'all'" });
    }
    const rawKeys = (req.body && req.body.keys !== undefined) ? req.body.keys : null;
    if (rawKeys !== null && !Array.isArray(rawKeys)) {
      return res.status(400).json({ ok: false, error: "keys must be an array of selected file names" });
    }
    const dir = resolveMediaOutputDir(folder);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => {
      if (e && e.code === "ENOENT") return null;
      throw e;
    });
    if (!entries) return res.status(404).json({ ok: false, error: "folder not found" });
    // Resolve + containment-check explicit keys before the ffmpeg gate so bad
    // paths are rejected regardless of ffmpeg availability.
    let resolvedKeys = null;
    if (rawKeys !== null) {
      resolvedKeys = [];
      for (const raw of rawKeys) {
        const key = String(raw || "").replace(/\\/g, "/").trim();
        if (!key) continue;
        const norm = path.normalize(key);
        if (path.isAbsolute(norm)) return res.status(400).json({ ok: false, error: `invalid key: ${key}` });
        const full = path.join(dir, norm);
        const rel = path.relative(dir, full);
        if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
          return res.status(400).json({ ok: false, error: `invalid key: ${key}` });
        }
        resolvedKeys.push({ key, full });
      }
    }
    if (!ffmpegBin) {
      return res.status(503).json({ ok: false, error: "ffmpeg not installed" });
    }
    const names = entries.filter((en) => en.isFile()).map((en) => en.name);
    const planned = [];
    let skippedCount = 0;
    if (resolvedKeys !== null) {
      for (const { key, full } of resolvedKeys) {
        const st = await fs.stat(full).catch(() => null);
        if (!st || !st.isFile()) { skippedCount += 1; continue; }
        if (!isVideoFileName(path.basename(full))) { skippedCount += 1; continue; }
        let hasPoster = false;
        if (mode === "missing") {
          const stem = posterStemOf(path.basename(full)).toLowerCase();
          const siblings = await fs.readdir(path.dirname(full)).catch(() => []);
          hasPoster = siblings.some((n) => {
            const m = POSTER_SIBLING_RE.exec(n);
            return m && m[1].toLowerCase() === stem;
          });
          if (hasPoster) { skippedCount += 1; continue; }
        }
        planned.push({ key, full });
      }
    } else {
      const { targets, skipped } = selectPosterTargets(names, mode);
      skippedCount = skipped.length;
      for (const name of targets) planned.push({ key: name, full: path.join(dir, name) });
    }
    // Stream one NDJSON progress line per file, then a final done line, so the
    // popup can show live progress instead of an indeterminate wait.
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    let clientGone = false;
    const emit = (event) => {
      if (clientGone) return;
      try { res.write(JSON.stringify(event) + "\n"); }
      catch { clientGone = true; }
    };
    const total = planned.length;
    const failedKeys = [];
    let generatedCount = 0;
    let index = 0;
    for (const { key, full } of planned) {
      index += 1;
      const poster = await generatePosterForMedia(full, { overwrite: mode === "all" });
      if (poster) generatedCount += 1;
      else failedKeys.push({ key, message: "poster not produced (ffmpeg error or unsupported file)" });
      emit({ type: "progress", index, total, generated: generatedCount, skipped: skippedCount, failed: failedKeys.length, file: key });
    }
    emit({ type: "done", ok: true, folder, mode, total, generated: generatedCount, skipped: skippedCount, failed: failedKeys.length, errors: failedKeys.slice(0, 10) });
    try { res.end(); } catch { /* client already gone */ }
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
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

// Settings page schema (user-friendly labels/controls over .env keys).
// type: bool | number | duration (stored ms, shown in `unit`) | select | text | path | password
// live: applies without a restart. advanced: hidden behind "Show advanced".
function settingsSchema() {
  const home = process.env.HOME || process.env.USERPROFILE || require("os").homedir();
  const headlessDef = !process.env.DISPLAY ? "1" : "0";
  const autoContinueDef = !process.stdin.isTTY ? "1" : "0";
  return [
    { name: "Media library", icon: "bi-collection-play", vars: [
      { key: "ENCRYPT_NEW_MEDIA", label: "Encrypt new files automatically", type: "bool", def: "0", live: true, disabled: !isPanelProtected(), desc: isPanelProtected() ? "New downloads and uploads are saved encrypted. Needs encryption set up; works while it is locked." : "Set a panel password first." },
      { key: "KEYBOARD_HINTS", label: "Show keyboard shortcut hints", type: "bool", def: "1", live: true, desc: "Small key labels on buttons in the media library." },
      { key: "MEDIA_RANGE_SIZE", label: "Files per section on the scroll rail", type: "number", def: "100", min: 10, max: 5000, live: true, desc: "How many files each jump-to section on the right-hand rail covers." },
    ] },
    { name: "Browser", icon: "bi-window", vars: [
      { key: "HEADLESS", label: "Run the browser hidden", type: "bool", def: headlessDef, desc: "Hidden (headless) is faster; visible lets you watch it work over VNC." },
      { key: "API_HEADLESS", label: "Hidden browser for panel downloads", type: "select", def: "", options: [["", "Same as above"], ["1", "Hidden"], ["0", "Visible"]], desc: "Override just for downloads started from this panel." },
      { key: "AUTO_CONTINUE", label: "Continue without asking", type: "bool", def: autoContinueDef, desc: "Skip the \"press Enter to continue\" pauses." },
      { key: "AUTO_CONTINUE_WAIT_MS", label: "Pause before continuing", type: "duration", unit: "s", def: "0", desc: "Extra wait before an automatic continue." },
      { key: "INSTAGRAM_USER_AGENT", label: "Instagram browser identity", type: "text", def: "", placeholder: "iPhone Safari (default)", advanced: true, desc: "Custom user-agent string sent to Instagram." },
      { key: "BROWSER_USER_DATA_DIR", label: "Browser profile folder", type: "path", def: `${home}/.config/cloakbrowser-profile`, advanced: true, desc: "Where the browser keeps logins and cookies." },
      { key: "BROWSER_PROFILE_DIR", label: "Profile name", type: "text", def: "Default", advanced: true, desc: "Sub-profile inside the profile folder." },
      { key: "BROWSER_PATH", label: "Browser program", type: "path", def: "", placeholder: "automatic", advanced: true, desc: "Use a specific Chrome/Chromium binary." },
      { key: "CLOAKBROWSER_CACHE_DIR", label: "Browser download cache", type: "path", def: "/data/cloakbrowser", advanced: true, desc: "Where the stealth browser itself is stored." },
    ] },
    { name: "Downloads & timing", icon: "bi-stopwatch", vars: [
      { key: "AUTO_CAPTURE_TIMEOUT_MS", label: "Look for media for up to", type: "duration", unit: "s", def: "30000", desc: "How long a page is watched for video before giving up." },
      { key: "API_JOB_TIMEOUT_MS", label: "Give up on a download after", type: "duration", unit: "min", def: "1800000", desc: "Whole-job limit; the browser is recycled after a timeout." },
      { key: "DOWNLOAD_FETCH_TIMEOUT_MS", label: "File transfer timeout", type: "duration", unit: "min", def: "300000", desc: "Limit for fetching a single file." },
      { key: "FFMPEG_TIMEOUT_MS", label: "Video processing timeout", type: "duration", unit: "min", def: "900000", desc: "Limit for ffmpeg (stream joining, merging audio)." },
      { key: "MANUAL_BROWSER_TIMEOUT_MS", label: "Close a manually opened browser after", type: "duration", unit: "min", def: "900000", desc: "Auto-close for browsers opened from Profiles." },
      { key: "AUTO_CAPTURE_QUIET_MS", label: "Quiet time before finishing a page", type: "duration", unit: "s", def: "1800", advanced: true, desc: "No new media for this long = page is done." },
      { key: "AUTO_CAPTURE_POLL_MS", label: "Page check interval", type: "duration", unit: "ms", def: "250", minMs: 50, advanced: true, desc: "How often the page is re-checked for media." },
      { key: "FFPROBE_TIMEOUT_MS", label: "Video inspection timeout", type: "duration", unit: "min", def: "120000", advanced: true, desc: "Limit for ffprobe." },
    ] },
    { name: "Instagram & sync", icon: "bi-instagram", vars: [
      { key: "INSTAGRAM_429_COOLDOWN_MS", label: "Pause after Instagram rate-limits", type: "duration", unit: "min", def: "300000", desc: "Wait this long after a \"too many requests\" response." },
      { key: "SAVED_SYNC_RETRY_COUNT", label: "Sync retries", type: "number", def: "20", min: 0, max: 1000, desc: "How many times the saved-collection sync retries a failed call." },
      { key: "SAVED_SYNC_RETRY_DELAY_MS", label: "Wait between sync retries", type: "duration", unit: "s", def: "3000", desc: "" },
      { key: "API_BASE", label: "Sync daemon API address", type: "text", def: "http://localhost:3001", advanced: true, desc: "Where the background sync daemon reaches this server." },
      { key: "SAVED_SYNC_STATE_FILE", label: "Sync state file", type: "path", def: ".saved-sync-state.json", advanced: true, desc: "" },
      { key: "SAVED_SYNC_QUEUE_FILE", label: "Sync queue file", type: "path", def: ".download-queue.json", advanced: true, desc: "" },
      { key: "SNAPSHOT_DIR", label: "Debug snapshot folder", type: "path", def: "media/.debug-snapshots", advanced: true, desc: "Page snapshots saved when no media was found." },
    ] },
    { name: "Remote desktop (VNC)", icon: "bi-display", vars: [
      { key: "ENABLE_VNC", label: "Start remote desktop at boot", type: "bool", def: "0", desc: "Watch/drive the browser in your web browser (noVNC). The Dashboard toggle overrides this." },
      { key: "VNC_PORT", label: "VNC port", type: "number", def: "6777", min: 1, max: 65535, advanced: true, desc: "" },
      { key: "NOVNC_PORT", label: "Web VNC port", type: "number", def: "6778", min: 1, max: 65535, advanced: true, desc: "" },
      { key: "VNC_FLAG", label: "VNC on/off flag file", type: "path", def: "/data/browser/.vnc-enabled", advanced: true, desc: "" },
      { key: "DISPLAY", label: "X display", type: "text", def: ":99", advanced: true, desc: "" },
    ] },
    { name: "Server", icon: "bi-hdd-network", vars: [
      { key: "PORT", label: "Panel port", type: "number", def: "6767", min: 1, max: 65535, advanced: true, desc: "Port this panel listens on inside the container." },
    ] },
  ];
}
app.get("/api/config", (_req, res) => {
  const groups = settingsSchema().map((g) => ({
    ...g,
    vars: g.vars.map((v) => {
      const raw = process.env[v.key];
      const isPw = v.type === "password";
      return {
        ...v,
        def: v.def ?? "",
        value: isPw ? "" : raw == null ? "" : String(raw),
        hasValue: raw != null && String(raw) !== "",
        restart: !v.live,
        lockedByContainer: ENV_FROM_CONTAINER.has(v.key),
      };
    }),
  }));
  res.json({ ok: true, groups });
});
// Restart the server so restart-only settings apply (docker brings it back).
app.post("/api/restart", (req, res) => {
  const busy = Boolean(activeJob || scanActiveJob || queueActiveJob) || (lockJob && lockJob.status === "running") || activeUploads > 0;
  if (busy && !req.body?.force) return res.status(409).json({ ok: false, error: "A download, scan, lock job or upload is running — wait for it to finish (or force)." });
  res.json({ ok: true, restarting: true });
  console.log("[settings] restart requested from the panel");
  res.once("finish", () => setTimeout(() => { shuttingDown = true; process.exit(0); }, 250));
});
// .env value quoting: dotenv treats " #" / "#" as a comment and trims
// surrounding spaces, so such values are written quoted (single quotes are
// literal in dotenv; double quotes only when the value has a single quote).
function envQuote(v) {
  const s = String(v);
  if (!/[#'"`]|^\s|\s$/.test(s)) return s;
  // dotenv reads '...' and `...` literally; it can't unescape \" inside "...".
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes("`")) return "`" + s + "`";
  return `"${s.replace(/"/g, "'")}"`; // has ' " and ` : keep it readable, swap " for '
}
app.post("/api/config", async (req, res) => {
  const key = String(req.body?.key || "").trim();
  const value = req.body?.value == null ? "" : String(req.body.value);
  const allowed = new Set(settingsSchema().flatMap((g) => g.vars.map((v) => v.key)));
  if (!key || !allowed.has(key)) return res.status(400).json({ ok: false, error: `Key not allowed: ${key}` });
  if (/[\n\r]/.test(key) || /[\n\r]/.test(value)) return res.status(400).json({ ok: false, error: "Invalid characters" });
  // Type checks from the settings schema (empty = back to the default).
  const meta = settingsSchema().flatMap((g) => g.vars).find((v) => v.key === key);
  if (ENV_FROM_CONTAINER.has(key)) return res.status(409).json({ ok: false, error: `${meta ? meta.label : key} is set by the container (docker-compose.yml environment: or its startup script) — change it there and recreate the container` });
  if (meta && value !== "") {
    if (meta.type === "bool" && value !== "0" && value !== "1") return res.status(400).json({ ok: false, error: `${meta.label}: must be on or off` });
    if ((meta.type === "number" || meta.type === "duration") && !/^\d+$/.test(value)) return res.status(400).json({ ok: false, error: `${meta.label}: must be a whole number` });
    if (meta.type === "duration" && meta.minMs != null && Number(value) < meta.minMs) return res.status(400).json({ ok: false, error: `${meta.label}: must be at least ${meta.minMs} ms` });
    if (meta.type === "number" && ((meta.min != null && Number(value) < meta.min) || (meta.max != null && Number(value) > meta.max))) return res.status(400).json({ ok: false, error: `${meta.label}: must be between ${meta.min} and ${meta.max}` });
    if (meta.type === "select" && !meta.options.some(([v]) => v === value)) return res.status(400).json({ ok: false, error: `${meta.label}: not a valid choice` });
  }
  const envPath = path.join(rootDir, ".env");
  // Media encryption (plan 039): the setting needs a panel password, and a
  // password change re-wraps the vault key before .env is rewritten.
  try {
    if (key === "ENCRYPT_NEW_MEDIA") {
      if (value !== "0" && value !== "1" && value !== "") return res.status(400).json({ ok: false, error: "ENCRYPT_NEW_MEDIA must be 0 or 1" });
      if (value === "1") {
        if (!isPanelProtected()) return res.status(400).json({ ok: false, error: "Set a panel password first — encryption needs it" });
        await mediaVault.encryptKey(); // requires encryption to be set up (no auto-create)
      }
    }
  } catch (e) { return vaultHttpError(res, e); }
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
      if (k === key) { found = true; return `${key}=${envQuote(value)}`; }
      return line;
    });
    if (!found) {
      if (next.length && next[next.length - 1] !== "") next.push("");
      next[next.length - 1] === "" ? next[next.length - 1] = `${key}=${envQuote(value)}` : next.push(`${key}=${envQuote(value)}`);
      // ensure no double empty
      const cleaned = next.filter((l, i, a) => !(l === "" && a[i + 1] === ""));
      next.length = 0; next.push(...cleaned);
    }
    // trim trailing empty handling
    let out = next.join("\n");
    if (!out.endsWith("\n")) out += "\n";
    await fs.writeFile(envPath, out, "utf8");
    process.env[key] = value;
    res.json({ ok: true, key, value });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/update/status", async (_req, res) => {
  try {
    res.json(await getUpdateStatus());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/update", async (_req, res) => {
  if (updateRunning) return res.status(409).json({ ok: false, error: "An update is already running" });
  updateRunning = true;
  try {
    const result = await performUpdate();
    console.log(`[update] ${result.method} update -> ${result.commitShort || "?"} — restarting`);
    res.json({ ok: true, ...result, restarting: true });
    // Restart once the response is flushed: the process is PID 1's child, so
    // exiting makes docker bring the container back (restart: unless-stopped).
    res.once("finish", () => setTimeout(() => { shuttingDown = true; process.exit(0); }, 250));
  } catch (e) {
    updateRunning = false;
    const code = e.code || null;
    const httpStatus = code === "DIRTY" || code === "AHEAD" || code === "COLLIDE" || code === "NOGIT" || code === "NOREMOTE" ? 409 : 500;
    console.log(`[update] failed (${code || "ERROR"}): ${e.message}`);
    res.status(httpStatus).json({ ok: false, error: e.message, code, changes: e.changes || null, dirtyCount: e.dirtyCount ?? null });
  }
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
  headers["x-xdl-internal"] = INTERNAL_MEDIA_TOKEN; // loopback-only internal auth
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
      const byKey = {};
      for (const p of pend) { const f = String(p.folder || ""); const a = normalizeAccountName(p.account || "default"); const key = `${f}|||${a}`; (byKey[key] = byKey[key] || []).push(p.url); }
      for (const [key, us] of Object.entries(byKey)) { const [f, a] = key.split("|||"); await selfPost("/queue/add", { urls: us, folder: f, account: a }); }
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
    const account = normalizeAccountName(body.account || body.profile || "");
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
        queue.pending.push({ url: rawUrl, folder, account, addedAt: new Date().toISOString() });
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
  const account = normalizeAccountName(req.body?.account || req.query?.account);
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
  const downloadedPaths = [];
  const logToClientAndConsole = (message) => {
    const text = String(message == null ? "" : message);
    if (!text) return;

    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    for (const line of lines) {
      console.log(`[scan:${jobId}] ${line}`);
      const dl = /Downloaded media to:\s*(.+)/.exec(line);
      if (dl) downloadedPaths.push(dl[1].trim());
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
    // Encrypt whatever was written, also after a failure/timeout part-way.
    await autoEncryptDownloaded(downloadedPaths, logToClientAndConsole).catch(() => {});
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
          const firstPostUrl = resultUrls.find((u) => /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|tv)\//i.test(u) || /reddit\.com\/r\/[^/]+\/comments\//i.test(u)) || resultUrls[0] || "";
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
// The live-updates socket carries queue URLs, logs and file names, and
// accepts "queue:add" — so it needs the same login session as the rest of the
// panel (the browser sends the httpOnly session cookie on the upgrade), and
// cross-site pages may not open it.
wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ req }, done) => {
    try {
      const origin = String(req.headers.origin || "");
      if (origin) {
        let originHost = "";
        try { originHost = new URL(origin).host; } catch {}
        if (originHost !== String(req.headers.host || "")) return done(false, 403, "Forbidden");
      }
      if (!isPanelProtected()) return done(true);
      const cookies = parseCookies(req.headers.cookie);
      if (patternAuth.validSession(cookies.xdl_session) || patternAuth.validSession(req.headers["x-xdl-session"])) return done(true);
      return done(false, 401, "Unauthorized");
    } catch {
      return done(false, 401, "Unauthorized");
    }
  },
});
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
  // Remove temp files left by an interrupted encrypt/decrypt/upload (a
  // partial .xdec- file would be plaintext sitting next to the locked file).
  (async () => {
    let removed = 0;
    const stack = [mediaDir];
    while (stack.length) {
      const dir = stack.pop();
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const en of entries) {
        const full = path.join(dir, en.name);
        if (en.isDirectory() && !en.isSymbolicLink() && !en.name.startsWith(".")) stack.push(full);
        else if (en.isFile() && mediaCrypto.TEMP_RE.test(en.name)) { await fs.unlink(full).catch(() => {}); removed += 1; }
      }
    }
    if (removed) console.log(`[vault] removed ${removed} leftover temp file(s) from an interrupted job`);
  })().catch(() => {});
  mediaVault.init().then(() => {
    const st = mediaVault.status();
    if (st.exists) console.log(`[vault] media vault found (key ${st.keyId}, copies: ${st.copies.join(", ")}) — locked until a password/pattern login${st.error ? ` — WARNING: ${st.error}` : ""}`);
  }).catch((e) => console.error(`[vault] init failed: ${e.message}`));
  ensureDefaultStateFiles({ log: (msg) => console.log(`[state] ${msg}`) }).catch((error) => {
    console.error(`[state] failed to create default state files: ${error.message}`);
  });
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
        const firstPostUrl = urls.find((u) => /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|tv)\//i.test(u) || /reddit\.com\/r\/[^/]+\/comments\//i.test(u)) || urls[0] || "";
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

const STATE_READ_ATTEMPTS = 5;
const STATE_READ_RETRY_MS = 20;
const emptySyncState = () => ({ config: { accounts: [], savedLists: [] }, lists: {}, updatedAt: null });

async function readStateFile() {
  const filePath = getStateFilePath();
  for (let attempt = 1; ; attempt++) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return emptySyncState();
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
        return emptySyncState();
      }
      // A non-atomic writer can leave a half-written file behind; retry before failing.
      if (error instanceof SyntaxError && attempt < STATE_READ_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, STATE_READ_RETRY_MS));
        continue;
      }
      throw error;
    }
  }
}

let stateWriteSeq = 0;

async function writeStateFile(state) {
  const filePath = getStateFilePath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  // Write to a unique temp file and rename: readers never observe a partial file.
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${stateWriteSeq++}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
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
    const lastSeenNorm = normalizeSyncUrl(lastSeen);
    const lastSeenId = extractSyncPostId(lastSeen);
    const idx = urls.findIndex((u) => {
      if (normalizeSyncUrl(u) === lastSeenNorm) return true;
      // link format changed over time (/<user>/(p|reel|tv)/<code> vs /(p|reel|tv)/<code>)
      if (lastSeenId && extractSyncPostId(u) === lastSeenId) return true;
      return false;
    });
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
    // Scanned lists come back newest-first; queue oldest-first so downloads
    // follow the collection's sequence.
    for (const url of [...newUrls].reverse()) {
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

function extractSyncPostId(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    if (/(^|\.)reddit\.com$/i.test(parsed.hostname)) {
      const m = parsed.pathname.match(/\/comments\/([^/?#]+)\/?/i);
      return m ? String(m[1] || "").trim() : "";
    }
    const m = parsed.pathname.match(/^(?:\/[^/]+)?\/(?:reel|p|tv)\/([^/?#]+)\/?$/i);
    return m ? String(m[1] || "").trim() : "";
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
