#!/usr/bin/env node
require("dotenv").config({ quiet: true });

const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const { run } = require("./scan-videos/index");
const { buildBrowserFromLocalProfile } = require("./scan-videos/browser");
const { scanSavedPage } = require("./scan-videos/scan-saved");
const { loadAppConfig, normalizeAccountName, resolveAccountConfig, resolveProfileConfig, getStateFilePath } = require("./scan-videos/config");

const app = express();
const rootDir = __dirname;
const mediaDir = path.join(rootDir, "media");
const port = Number(process.env.PORT) || 3000;
const apiJobTimeoutMs = parsePositiveInt(process.env.API_JOB_TIMEOUT_MS, 1800000);

let shuttingDown = false;
let jobCounter = 0;
let activeJob = null;
let sharedBrowser = null;
let browserInitPromise = null;
const browsersByAccount = new Map();
const manualBrowsersByAccount = new Map();
const manualBrowserTimeoutMs = parsePositiveInt(process.env.MANUAL_BROWSER_TIMEOUT_MS, 900000);

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

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use("/media", express.static(mediaDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.get("/scan-saved", (_req, res) => {
  res.redirect("/#saved");
});

app.get("/api/media", async (req, res) => {
  try {
    const folder = String(req.query?.folder || "").trim();
    const resolved = resolveMediaOutputDir(folder);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const items = [];

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
        mtime: stat.mtime.toISOString(),
      });
    }

    items.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return res.json({ ok: true, folder, items });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    shuttingDown,
    busy: Boolean(activeJob),
    browserReady: Boolean(sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()),
    accountBrowsersReady: Array.from(browsersByAccount.values()).filter(
      (browser) => browser && browser.isConnected && browser.isConnected()
    ).length,
    manualBrowsers: Array.from(manualBrowsersByAccount.keys()),
  });
});

app.get("/accounts", async (_req, res) => {
  try {
    const appConfig = await loadAppConfig();
    const defaults = resolveProfileConfig();

    const accounts = [{ name: "default", userDataDir: defaults.userDataDir, profileDir: defaults.profileDir }];
    for (const account of appConfig.accounts) {
      if (!account || !account.name) continue;
      if (account.name === "default") continue;
      accounts.push({
        name: account.name,
        userDataDir: account.userDataDir || defaults.userDataDir,
        profileDir: account.profileDir || defaults.profileDir,
      });
    }

    return res.json({
      ok: true,
      accounts: accounts.map((account) => {
        const manual = manualBrowsersByAccount.get(account.name);
        const accountBrowser = browsersByAccount.get(account.name);
        const isShared = account.name === "default" && sharedBrowser;
        return {
          ...account,
          manualOpen: browserIsAlive(manual && manual.browser),
          sharedOpen: Boolean(isShared && browserIsAlive(sharedBrowser)),
          accountBrowserOpen: browserIsAlive(accountBrowser),
          openedAt: manual ? manual.openedAt : null,
        };
      }),
    });
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
    accounts.push(account);
    state.config = state.config || {};
    state.config.accounts = accounts;
    state.updatedAt = new Date().toISOString();
    await writeStateFile(state);

    return res.status(201).json({ ok: true, account });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete("/accounts/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    const key = name.toLowerCase();
    if (key === "default") {
      return res.status(400).json({ ok: false, error: "The built-in \"default\" account cannot be deleted." });
    }

    await closeManualBrowser(name);
    await closeBrowserForAccount(name);

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

    return res.json({ ok: true, config: state.config });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/sync-queue/clear", async (_req, res) => {
  try {
    const queue = await readQueueFile();
    const cleared = Array.isArray(queue.completed) ? queue.completed.length : 0;
    queue.completed = [];
    await writeQueueFile(queue);
    return res.json({ ok: true, cleared });
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
    const [queue, state] = await Promise.all([readQueueFile(), readStateFile()]);

    const seenUrls = new Set();
    for (const item of queue.pending) {
      if (item && item.url) seenUrls.add(normalizeSyncUrl(item.url));
    }
    for (const item of queue.completed) {
      if (item && item.url) seenUrls.add(normalizeSyncUrl(item.url));
    }
    for (const key of Object.keys(state.lists || {})) {
      const lastSeenUrl = String((state.lists[key] || {}).lastSeenUrl || "").trim();
      if (lastSeenUrl) seenUrls.add(normalizeSyncUrl(lastSeenUrl));
    }

    let added = 0;
    let skipped = 0;
    for (const rawUrl of rawUrls) {
      const normalized = normalizeSyncUrl(rawUrl);
      if (!normalized || seenUrls.has(normalized)) {
        skipped += 1;
        continue;
      }
      queue.pending.push({ url: rawUrl, folder, addedAt: new Date().toISOString() });
      seenUrls.add(normalized);
      added += 1;
    }

    await writeQueueFile(queue);
    return res.json({ ok: true, added, skipped, pending: queue.pending.length });
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

  const existing = manualBrowsersByAccount.get(accountName);
  if (existing && existing.browser && existing.browser.isConnected && existing.browser.isConnected()) {
    return res.status(409).json({
      ok: false,
      error: `A manual browser is already open for account "${accountName}". Close it first.`,
    });
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
      }
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    logToClientAndConsole(
      "\n[open-browser] Browser is open and visible in the VNC session. It starts on a blank tab."
    );
    logToClientAndConsole(
      `[open-browser] Use http://${req.hostname.split(":")[0]}:7906 to control it.`
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
  try {
    const folder = String(req.body?.folder || req.query?.folder || "").trim();
    outputDir = resolveMediaOutputDir(folder);
    maxQuality = resolveMaxQuality(req.body?.maxQuality ?? req.query?.maxQuality);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
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
    const browser = await getSharedBrowser(logToClientAndConsole);
    logToClientAndConsole("[api] browser ready, starting scan...\n");

    const result = await runWithJobTimeout(
      run({
        urls: [link],
        linkOnly: false,
        outputDir,
        maxQuality,
        browser,
        autoContinuePrompts: true,
        waitForCompletionPrompt: false,
        log: logToClientAndConsole,
      }),
      {
        timeoutMs: apiJobTimeoutMs,
        jobId,
        jobType: "download",
        log: logToClientAndConsole,
        recycleBrowser: closeSharedBrowser,
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

    if (sharedBrowser && sharedBrowser.isConnected && !sharedBrowser.isConnected()) {
      await closeSharedBrowser();
    }
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

  if (activeJob) {
    return res.status(429).json({
      ok: false,
      error: `Another task is currently running (job ${activeJob.id}, type=${activeJob.type}). Try again when it finishes.`,
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

  const account = normalizeAccountName(req.body?.account || req.query?.account);
  const endUrls = normalizeEndUrls(req.body?.endUrls ?? req.query?.endUrls);
  const jobId = ++jobCounter;
  activeJob = { id: jobId, type: "scan-saved", startedAt: Date.now() };

  const manualForAccount = manualBrowsersByAccount.get(account);
  if (manualForAccount && manualForAccount.browser && manualForAccount.browser.isConnected && manualForAccount.browser.isConnected()) {
    activeJob = null;
    return res.status(409).json({
      ok: false,
      error: `A manual browser is open on account "${account}". Close it before scanning.`,
    });
  }

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
        endUrls,
        log: (message) => {
          const text = String(message == null ? "" : message).trim();
          if (!text) return;
          console.log(`[scan-saved:${jobId}] ${text}`);
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

    return res.json({ ok: true, ...result });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const statusCode = Number(error && error.status) === 429 || /429|too many requests/i.test(message) ? 429 : 500;
    console.error(`[scan-saved:${jobId}] failed: ${message}`);
    return res.status(statusCode).json({ ok: false, error: message });
  } finally {
    activeJob = null;
  }
});

const server = app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
  void getSharedBrowser((message) => {
    const text = String(message == null ? "" : message).trim();
    if (!text) return;
    console.log(`[browser] ${text}`);
  }).catch((error) => {
    console.error(`[browser] initial launch failed: ${error.message}`);
  });
});

setupShutdownHandlers(server);

async function getSharedBrowser(log) {
  if (sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }

  if (browserInitPromise) {
    return browserInitPromise;
  }

  const headless = parseBooleanInput(process.env.API_HEADLESS, parseBooleanInput(process.env.HEADLESS, true));

  browserInitPromise = buildBrowserFromLocalProfile({ headless, log })
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

async function closeSharedBrowser() {
  if (!sharedBrowser) return;

  const browser = sharedBrowser;
  sharedBrowser = null;
  try {
    await browser.close();
  } catch {
    // ignore
  }
}

async function closeBrowserForAccount(accountName, expectedBrowser) {
  const browser = browsersByAccount.get(accountName);
  if (!browser || (expectedBrowser && browser !== expectedBrowser)) return;

  browsersByAccount.delete(accountName);
  try {
    await browser.close();
  } catch {
    // ignore
  }
}

async function getBrowserForAccount(accountName, jobId) {
  const existing = browsersByAccount.get(accountName);
  if (existing && existing.isConnected && existing.isConnected()) {
    return existing;
  }

  const appConfig = await loadAppConfig();
  const config = resolveAccountConfig(accountName, appConfig.accounts);
  const headless = parseBooleanInput(process.env.API_HEADLESS, parseBooleanInput(process.env.HEADLESS, true));

  console.log(`[browser] launching browser for account "${accountName}" (${config.userDataDir}/${config.profileDir})`);
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
    await entry.browser.close();
  } catch {
    // ignore
  }
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
  const filePath = getQueueFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(queue, null, 2), "utf8");
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

    result.push({
      name,
      profileDir: String(raw.profileDir || "Default").trim() || "Default",
      userDataDir: String(raw.userDataDir || "").trim(),
    });
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

    result.push({
      url,
      folder: String(raw.folder || "").trim(),
      account: String(raw.account || "").trim() || "default",
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
