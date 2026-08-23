#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");
const { normalizeAccountName } = require("./scan-videos/config");

const API_BASE = process.env.API_BASE || "http://localhost:3001";
const STATE_FILE = process.env.SAVED_SYNC_STATE_FILE || path.resolve(__dirname, ".saved-sync-state.json");
const QUEUE_FILE = process.env.SAVED_SYNC_QUEUE_FILE || path.resolve(__dirname, ".download-queue.json");
const RETRY_DELAY_MS = Number(process.env.SAVED_SYNC_RETRY_DELAY_MS || 3000);
const RETRY_COUNT = Number(process.env.SAVED_SYNC_RETRY_COUNT || 20);
const MAX_COMPLETED_TRIM = 200;

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------

async function loadQueue() {
  try {
    const raw = await fs.readFile(QUEUE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { pending: [], completed: [] };
    }
    if (!Array.isArray(parsed.pending)) parsed.pending = [];
    if (!Array.isArray(parsed.completed)) parsed.completed = [];
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { pending: [], completed: [] };
    }
    throw error;
  }
}

async function saveQueue(queue) {
  if (queue.completed.length > MAX_COMPLETED_TRIM) {
    queue.completed = queue.completed.slice(-MAX_COMPLETED_TRIM);
  }
  const dir = path.dirname(QUEUE_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
}

function enqueueUrls(queue, urls, folder, existingSeenUrls) {
  const seenSet = new Set(existingSeenUrls.map((u) => normalizeUrl(u)));
  let added = 0;
  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (!normalized || seenSet.has(normalized)) continue;
    const alreadyPending = queue.pending.some((item) => normalizeUrl(item.url) === normalized);
    const alreadyCompleted = queue.completed.some((item) => normalizeUrl(item.url) === normalized);
    if (alreadyPending || alreadyCompleted) continue;
    queue.pending.push({
      url,
      folder,
      addedAt: new Date().toISOString(),
    });
    seenSet.add(normalized);
    added += 1;
  }
  return added;
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    parsed.hash = "";
    return parsed.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// State management (backward compatible with existing format)
// ---------------------------------------------------------------------------

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { config: { accounts: [], savedLists: [] }, lists: {}, updatedAt: null };
    }
    if (!parsed.config || typeof parsed.config !== "object") {
      parsed.config = { accounts: [], savedLists: [] };
    }
    if (!Array.isArray(parsed.config.accounts)) parsed.config.accounts = [];
    if (!Array.isArray(parsed.config.savedLists)) parsed.config.savedLists = [];
    if (!parsed.lists || typeof parsed.lists !== "object") {
      parsed.lists = {};
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { config: { accounts: [], savedLists: [] }, lists: {}, updatedAt: null };
    }
    throw error;
  }
}

async function saveState(state) {
  const preserved = { ...state };
  preserved.updatedAt = new Date().toISOString();
  const dir = path.dirname(STATE_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(preserved, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status || 0;
    this.retryable = Boolean(options.retryable);
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const message = data && data.error ? data.error : `Request failed with status ${response.status}`;
    const isRateLimited = response.status === 429 || isRateLimitMessage(message);
    throw new ApiError(message, {
      status: isRateLimited ? 429 : response.status,
      retryable: isRateLimited || response.status === 503,
    });
  }

  return data;
}

async function postDownload(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const data = await response.json();
      if (data && data.error) message = data.error;
    } catch {
      const text = await response.text().catch(() => "");
      if (text) message = text;
    }

    const isRateLimited = response.status === 429 || isRateLimitMessage(message);
    throw new ApiError(message, {
      status: isRateLimited ? 429 : response.status,
      retryable: isRateLimited || response.status === 503,
    });
  }

  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    const apiFailure = extractApiProcessFailureMessage(text);
    if (apiFailure) {
      const isRateLimited = isRateLimitMessage(apiFailure);
      throw new ApiError(apiFailure, {
        status: isRateLimited ? 429 : 500,
        retryable: isRateLimited,
      });
    }
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) {
      output += chunk;
      process.stdout.write(chunk);
    }
  }
  const rest = decoder.decode();
  if (rest) {
    output += rest;
    process.stdout.write(rest);
  }

  const apiFailure = extractApiProcessFailureMessage(output);
  if (apiFailure) {
    const isRateLimited = isRateLimitMessage(apiFailure);
    throw new ApiError(apiFailure, {
      status: isRateLimited ? 429 : 500,
      retryable: isRateLimited,
    });
  }
}

async function withRetries(label, fn, retryCount, retryDelayMs) {
  let attempt = 0;
  let lastError;

  while (attempt < retryCount) {
    attempt += 1;
    try {
      if (attempt > 1) {
        console.log(`[retry] ${label} attempt ${attempt}/${retryCount}`);
      }
      return await fn();
    } catch (error) {
      lastError = error;
      if (isRateLimitError(error)) {
        throw error;
      }
      const retryable = Boolean(error && error.retryable);
      if (!retryable || attempt >= retryCount) {
        throw error;
      }
      console.log(`[retry] ${label} busy/unavailable. Waiting ${retryDelayMs}ms...`);
      await sleep(retryDelayMs);
    }
  }

  throw lastError || new Error(`${label} failed`);
}

function isRateLimitMessage(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("429") || text.includes("too many requests");
}

function isRateLimitError(error) {
  if (!error) return false;
  if (Number(error.status) === 429) return true;
  return isRateLimitMessage(error.message);
}

function extractApiProcessFailureMessage(output) {
  const text = String(output || "");
  const regex = /\[api\]\s*process failed:\s*([^\r\n]+)/gi;
  let match;
  let lastMessage = "";
  while ((match = regex.exec(text))) {
    lastMessage = String(match[1] || "").trim();
  }
  return lastMessage;
}

// ---------------------------------------------------------------------------
// Task: Scan a random list
// ---------------------------------------------------------------------------

async function scanRandomList(state, queue, apiBase) {
  const savedLists = Array.isArray(state.config.savedLists) ? state.config.savedLists : [];
  if (!savedLists.length) {
    console.log("[scan] No saved lists configured in config.savedLists. Add entries to .saved-sync-state.json");
    return { scanned: false, list: "<none>" };
  }

  const scannedUrls = [];
  for (const item of savedLists) {
    const listState = state.lists[item.url] || {};
    const lastSeenUrl = String(listState.lastSeenUrl || "").trim();
    if (lastSeenUrl) scannedUrls.push(lastSeenUrl);
  }

  const unscannedLists = savedLists.filter((item) => {
    const listState = state.lists[item.url] || {};
    const lastSeenUrl = String(listState.lastSeenUrl || "").trim();
    return !lastSeenUrl;
  });

  let target;
  if (unscannedLists.length > 0) {
    target = randomChoice(unscannedLists);
  } else {
    target = randomChoice(savedLists);
  }

  const listState = state.lists[target.url] || {};
  const lastSeenUrl = String(listState.lastSeenUrl || "").trim();
  const endUrls = lastSeenUrl ? [lastSeenUrl] : [];
  const account = normalizeAccountName(target.account);

  console.log(`\n[scan] ${target.folder} (account: ${account}) | stop: ${lastSeenUrl || "<none>"}`);

  let scanResult;
  try {
    scanResult = await withRetries(
      "scan-saved",
      () => postJson(`${apiBase}/scan-saved`, { url: target.url, endUrls, account }),
      RETRY_COUNT,
      RETRY_DELAY_MS
    );
  } catch (error) {
    console.error(`[scan] failed: ${error.message}`);
    if (isRateLimitError(error)) {
      console.log("[scan] 429 detected. Waiting 30 min before next task...");
      await sleep(30 * 60 * 1000);
    }
    return { scanned: false, list: target.folder };
  }

  const scannedPageUrls = Array.from(
    new Set((Array.isArray(scanResult.urls) ? scanResult.urls : []).map((x) => String(x || "").trim()).filter(Boolean))
  );

  const firstPostUrl = scannedPageUrls.find((u) => /instagram\.com\/(?:p|reel|tv)\//i.test(u)) || "";
  const added = enqueueUrls(queue, scannedPageUrls, target.folder, scannedUrls);

  state.lists[target.url] = {
    ...listState,
    lastSeenUrl: firstPostUrl || lastSeenUrl,
    lastRunAt: new Date().toISOString(),
    lastScannedCount: scannedPageUrls.length,
    folder: target.folder,
  };

  console.log(`[scan] ${target.folder}: ${scannedPageUrls.length} urls, ${added} new queued`);
  return { scanned: true, list: target.folder, added };
}

// ---------------------------------------------------------------------------
// Task: Download a random URL from queue
// ---------------------------------------------------------------------------

async function downloadRandomUrl(queue, apiBase) {
  if (queue.pending.length === 0) return { downloaded: false };

  const idx = randomBetween(0, queue.pending.length - 1);
  const item = queue.pending[idx];

  console.log(`\n[download] ${item.folder} | ${item.url}`);

  try {
    await withRetries(
      "download",
      () => postDownload(`${apiBase}/download`, {
        link: item.url,
        folder: item.folder,
      }),
      RETRY_COUNT,
      RETRY_DELAY_MS
    );

    queue.pending.splice(idx, 1);
    queue.completed.push({
      url: item.url,
      folder: item.folder,
      downloadedAt: new Date().toISOString(),
    });

    console.log(`[download] done. Queue: ${queue.pending.length} pending`);
    return { downloaded: true };
  } catch (error) {
    console.error(`[download] failed: ${error.message}`);
    if (isRateLimitError(error)) {
      console.log("[download] 429 detected. Waiting 30 min before next task...");
      await sleep(30 * 60 * 1000);
    }
    return { downloaded: false };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTargetDownloadsPerHour(queue) {
  if (queue.pending.length >= 50) return { min: 8, max: 12 };
  if (queue.pending.length >= 20) return { min: 6, max: 10 };
  if (queue.pending.length >= 5) return { min: 4, max: 8 };
  return { min: 2, max: 5 };
}

function getTargetScansPerHour(queue) {
  if (queue.pending.length < 5) return { min: 25, max: 45 };
  if (queue.pending.length < 20) return { min: 30, max: 50 };
  return { min: 40, max: 70 };
}

// ---------------------------------------------------------------------------
// Main daemon loop
// ---------------------------------------------------------------------------

let shutdownRequested = false;

process.on("SIGTERM", () => {
  console.log("\n[shutdown] SIGTERM received. Finishing current task...");
  shutdownRequested = true;
});

process.on("SIGINT", () => {
  console.log("\n[shutdown] SIGINT received. Finishing current task...");
  shutdownRequested = true;
});

async function main() {
  console.log("Starting randomized sync daemon...");
  console.log(`API: ${API_BASE}`);
  console.log(`State: ${STATE_FILE}`);
  console.log(`Queue: ${QUEUE_FILE}`);

  const startupJitterMs = randomBetween(0, 5 * 60 * 1000);
  console.log(`Startup jitter: ${Math.round(startupJitterMs / 1000)}s`);
  await sleep(startupJitterMs);

  const state = await loadState();
  const queue = await loadQueue();
  const apiBase = String(API_BASE).replace(/\/+$/, "");

  const savedLists = Array.isArray(state.config.savedLists) ? state.config.savedLists : [];
  console.log(`Saved lists: ${savedLists.length}`);
  console.log(`Queue: ${queue.pending.length} pending, ${queue.completed.length} completed`);

  let lastBreakAt = Date.now();
  let tasksSinceBreak = 0;

  while (!shutdownRequested) {
    const isDownloadQueueLow = queue.pending.length < 5;
    const scanChance = isDownloadQueueLow ? 0.7 : 0.3;
    const pickScan = Math.random() < scanChance;

    const hoursSinceBreak = (Date.now() - lastBreakAt) / (1000 * 60 * 60);
    if (hoursSinceBreak > 8 && tasksSinceBreak > 15 && Math.random() < 0.3) {
      const breakMinutes = randomBetween(60, 90);
      console.log(`\n[break] Taking a ${breakMinutes} min break...`);
      await sleep(breakMinutes * 60 * 1000);
      if (shutdownRequested) break;
      lastBreakAt = Date.now();
      tasksSinceBreak = 0;
    }

    try {
      if (pickScan) {
        await scanRandomList(state, queue, apiBase);
        await saveState(state);
        await saveQueue(queue);
        tasksSinceBreak += 1;

        const scanGap = getTargetScansPerHour(queue);
        const waitMs = randomBetween(scanGap.min, scanGap.max) * 60 * 1000;
        console.log(`[wait] Next task in ${Math.round(waitMs / 1000 / 60)} min (queue: ${queue.pending.length})`);
        await sleep(waitMs);
      } else if (queue.pending.length > 0) {
        const result = await downloadRandomUrl(queue, apiBase);
        await saveQueue(queue);
        if (result.downloaded) {
          await saveState(state);
          tasksSinceBreak += 1;
        }

        const dlGap = getTargetDownloadsPerHour(queue);
        const waitMs = randomBetween(dlGap.min, dlGap.max) * 60 * 1000;
        console.log(`[wait] Next task in ${Math.round(waitMs / 1000 / 60)} min (queue: ${queue.pending.length})`);
        await sleep(waitMs);
      } else {
        console.log("[idle] Queue empty. Scanning in 5 min...");
        await sleep(5 * 60 * 1000);
      }
    } catch (error) {
      console.error(`[error] ${error.message}`);
      await sleep(5 * 60 * 1000);
    }
  }

  console.log("[shutdown] Saving final state...");
  await saveState(state);
  await saveQueue(queue);
  console.log("[shutdown] Done.");
}

main().catch((error) => {
  console.error(`[fatal] ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
