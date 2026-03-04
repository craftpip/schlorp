#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

const API_BASE = process.env.API_BASE || "http://localhost:3001";
const STATE_FILE = process.env.SAVED_SYNC_STATE_FILE || path.resolve(__dirname, ".saved-sync-state.json");
const MEDIA_ROOT_DIR = path.resolve(__dirname, "media");
const RETRY_DELAY_MS = Number(process.env.SAVED_SYNC_RETRY_DELAY_MS || 3000);
const RETRY_COUNT = Number(process.env.SAVED_SYNC_RETRY_COUNT || 20);
const DOWNLOAD_DELAY_MS = Number(process.env.SAVED_SYNC_DOWNLOAD_DELAY_MS || 20000);
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.SAVED_SYNC_429_COOLDOWN_MS || 300000);

// Edit this list only: one saved URL per target folder.
const SAVED_LISTS = [
  { url: "https://www.instagram.com/whatwhatwhaaaaaaaat/saved/cosplay/18108968914608682/", folder: "cosplay" },
  { url: "https://www.instagram.com/whatwhatwhaaaaaaaat/saved/k/18046180493635998/", folder: "k" },
  { url: "https://www.instagram.com/whatwhatwhaaaaaaaat/saved/sexy/18094103047620020/", folder: "sexy" },
  { url: "https://www.instagram.com/whatwhatwhaaaaaaaat/saved/pussy/18068979569102831/", folder: "pussy" },
  { url: "https://www.instagram.com/whatwhatwhaaaaaaaat/saved/ass/18139114003414587/", folder: "ass" },
  { url: "https://www.instagram.com/whatwhatwhaaaaaaaat/saved/boobs/18074138810302982/", folder: "boobs" },
  { url: "https://www.instagram.com/whatwhatwhaaaaaaaat/saved/nipp/17909657295053658/", folder: "nipp" },
];

class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status || 0;
    this.retryable = Boolean(options.retryable);
  }
}

async function main() {
  validateConfig();

  const state = await loadState(STATE_FILE);
  const apiBase = String(API_BASE).replace(/\/+$/, "");
  let hadErrors = false;
  let suspendRequested = false;
  let lastDownloadRequestAt = 0;

  for (let i = 0; i < SAVED_LISTS.length; i += 1) {
    if (suspendRequested) break;

    const item = SAVED_LISTS[i];
    const listState = state.lists[item.url] || {};
    const lastSeenUrl = String(listState.lastSeenUrl || "").trim();
    const endUrls = lastSeenUrl ? [lastSeenUrl] : [];

    console.log(`\n[${i + 1}/${SAVED_LISTS.length}] Scanning saved list`);
    console.log(`URL: ${item.url}`);
    console.log(`Folder: ${item.folder}`);
    if (lastSeenUrl) {
      console.log(`Last seen marker: ${lastSeenUrl}`);
    } else {
      console.log("Last seen marker: <none> (first full sync)");
    }

    let scanResult;
    try {
      scanResult = await withRetries(
        "scan-saved",
        () => postJson(`${apiBase}/scan-saved`, { url: item.url, endUrls }),
        RETRY_COUNT,
        RETRY_DELAY_MS
      );
    } catch (error) {
      hadErrors = true;
      console.error(`[error] scan failed for ${item.url}: ${error.message}`);
      if (isRateLimitError(error)) {
        await waitFor429Cooldown();
        suspendRequested = true;
      }
      continue;
    }

    const scannedUrls = Array.from(
      new Set((Array.isArray(scanResult.urls) ? scanResult.urls : []).map((x) => String(x || "").trim()).filter(Boolean))
    );

    const newUrls = getNewUrlsSinceMarker(scannedUrls, lastSeenUrl);
    if (!newUrls.length) {
      console.log("No new posts since last scan.");
      state.lists[item.url] = {
        ...listState,
        lastRunAt: new Date().toISOString(),
      };
      continue;
    }

    console.log(`Found ${newUrls.length} new post(s). Downloading...`);

    const downloadQueue = [...newUrls].reverse();
    let listFailed = false;
    let successfulDownloads = 0;
    const outputDir = resolveOutputDir(item.folder);

    for (let idx = 0; idx < downloadQueue.length; idx += 1) {
      if (suspendRequested) break;

      const postUrl = downloadQueue[idx];
      console.log(`\n[download ${idx + 1}/${downloadQueue.length}] ${postUrl}`);

      try {
        const postId = extractInstagramPostId(postUrl);
        if (postId && (await hasPostIdFileInFolder(outputDir, postId))) {
          console.log(`already found skipped: ${postUrl}`);
          successfulDownloads += 1;
          await checkpointListState(state, item, postUrl, successfulDownloads);
          continue;
        }

        if (DOWNLOAD_DELAY_MS > 0) {
          const elapsedMs = Date.now() - lastDownloadRequestAt;
          const waitMs = DOWNLOAD_DELAY_MS - elapsedMs;
          if (waitMs > 0) {
            console.log(`sync download throttle: waiting ${Math.ceil(waitMs / 1000)}s before next download request...`);
            await delay(waitMs);
          }
        }
        lastDownloadRequestAt = Date.now();

        await withRetries(
          "download",
          () => postDownload(`${apiBase}/download`, {
            link: postUrl,
            folder: item.folder,
            maxQuality: item.maxQuality,
          }),
          RETRY_COUNT,
          RETRY_DELAY_MS
        );
        successfulDownloads += 1;
        await checkpointListState(state, item, postUrl, successfulDownloads);
      } catch (error) {
        listFailed = true;
        hadErrors = true;
        console.error(`[error] download failed: ${error.message}`);
        if (isRateLimitError(error)) {
          await waitFor429Cooldown();
          suspendRequested = true;
          break;
        }
      }
    }

    if (suspendRequested) {
      continue;
    }

    if (listFailed) {
      console.error("One or more downloads failed. Kept per-post checkpoint progress for this list.");
      const currentState = state.lists[item.url] || listState;
      state.lists[item.url] = {
        ...currentState,
        lastRunAt: new Date().toISOString(),
      };
      continue;
    }

    state.lists[item.url] = {
      ...listState,
      lastSeenUrl: scannedUrls[0] || lastSeenUrl,
      lastRunAt: new Date().toISOString(),
      lastDownloadedCount: newUrls.length,
      folder: item.folder,
    };

    console.log(`Done: downloaded ${newUrls.length} post(s).`);
  }

  state.updatedAt = new Date().toISOString();
  await saveState(STATE_FILE, state);
  console.log(`\nState saved: ${STATE_FILE}`);

  if (hadErrors) {
    process.exitCode = 1;
    if (suspendRequested) {
      console.log("Run suspended after Instagram 429 cooldown; retry in a future run.");
    }
    console.log("Completed with errors.");
  } else {
    console.log("Completed successfully.");
  }
}

function validateConfig() {
  if (!Array.isArray(SAVED_LISTS) || SAVED_LISTS.length === 0) {
    throw new Error("SAVED_LISTS is empty. Add at least one { url, folder } item in this script.");
  }

  for (const [index, item] of SAVED_LISTS.entries()) {
    const url = String(item && item.url ? item.url : "").trim();
    const folder = String(item && item.folder ? item.folder : "").trim();

    if (!url) {
      throw new Error(`SAVED_LISTS[${index}] is missing 'url'.`);
    }
    if (!folder) {
      throw new Error(`SAVED_LISTS[${index}] is missing 'folder'.`);
    }

    try {
      new URL(url);
    } catch {
      throw new Error(`SAVED_LISTS[${index}].url must be an absolute URL: ${url}`);
    }
  }
}

function getNewUrlsSinceMarker(scannedUrls, markerUrl) {
  if (!markerUrl) return scannedUrls;
  const markerIndex = scannedUrls.indexOf(markerUrl);
  if (markerIndex === -1) return scannedUrls;
  return scannedUrls.slice(0, markerIndex);
}

function resolveOutputDir(folder) {
  const normalizedFolder = String(folder || "").replace(/\\/g, "/").trim();
  const resolved = path.resolve(MEDIA_ROOT_DIR, normalizedFolder);
  const relative = path.relative(MEDIA_ROOT_DIR, resolved);

  if (!relative || relative === ".") return MEDIA_ROOT_DIR;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid folder. Use a path inside media, e.g. 'hello' or 'hello/sub'.");
  }

  return resolved;
}

function extractInstagramPostId(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const match = parsed.pathname.match(/^\/(?:reel|p|tv)\/([^/?#]+)\/?/i);
    return match ? String(match[1] || "").trim().toLowerCase() : "";
  } catch {
    return "";
  }
}

async function hasPostIdFileInFolder(folderPath, postId) {
  if (!postId) return false;

  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry || !entry.isFile || !entry.isFile()) continue;
      const name = String(entry.name || "").toLowerCase();
      if (name.includes(`-${postId}.`) || name.includes(`-${postId}-`)) {
        return true;
      }
    }
    return false;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function checkpointListState(state, item, lastSeenUrl, downloadedCount) {
  state.lists[item.url] = {
    ...(state.lists[item.url] || {}),
    lastSeenUrl,
    lastRunAt: new Date().toISOString(),
    lastDownloadedCount: downloadedCount,
    folder: item.folder,
  };
  state.updatedAt = new Date().toISOString();
  await saveState(STATE_FILE, state);
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
      await delay(retryDelayMs);
    }
  }

  throw lastError || new Error(`${label} failed`);
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

async function loadState(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { lists: {}, updatedAt: null };
    }
    if (!parsed.lists || typeof parsed.lists !== "object") {
      parsed.lists = {};
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { lists: {}, updatedAt: null };
    }
    throw error;
  }
}

async function saveState(filePath, state) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitFor429Cooldown() {
  console.log("waiting for 429 cooldown.");
  await delay(RATE_LIMIT_COOLDOWN_MS);
}

main().catch((error) => {
  console.error(`[fatal] ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
