#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

const API_BASE = process.env.API_BASE || "http://localhost:3001";
const STATE_FILE = process.env.SAVED_SYNC_STATE_FILE || path.resolve(__dirname, ".saved-sync-state.json");
const RETRY_DELAY_MS = Number(process.env.SAVED_SYNC_RETRY_DELAY_MS || 3000);
const RETRY_COUNT = Number(process.env.SAVED_SYNC_RETRY_COUNT || 20);

// Edit this list only: one saved URL per target folder.
const SAVED_LISTS = [
  { url: "https://www.instagram.com/whatwhatwhaaaaaaaat/saved/cosplay/18108968914608682/", folder: "cosplay" },
  // { url: "https://www.instagram.com/<user>/saved/<collection>/<id>/", folder: "collection-b/sub" },
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

  for (let i = 0; i < SAVED_LISTS.length; i += 1) {
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

    for (let idx = 0; idx < downloadQueue.length; idx += 1) {
      const postUrl = downloadQueue[idx];
      console.log(`\n[download ${idx + 1}/${downloadQueue.length}] ${postUrl}`);

      try {
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
      } catch (error) {
        listFailed = true;
        hadErrors = true;
        console.error(`[error] download failed: ${error.message}`);
      }
    }

    if (listFailed) {
      console.error("One or more downloads failed. State marker was not advanced for this list.");
      state.lists[item.url] = {
        ...listState,
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
    throw new ApiError(message, {
      status: response.status,
      retryable: response.status === 429 || response.status === 503,
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

    throw new ApiError(message, {
      status: response.status,
      retryable: response.status === 429 || response.status === 503,
    });
  }

  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) process.stdout.write(chunk);
  }
  const rest = decoder.decode();
  if (rest) process.stdout.write(rest);
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

main().catch((error) => {
  console.error(`[fatal] ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
