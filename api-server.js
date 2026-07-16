#!/usr/bin/env node
require("dotenv").config({ quiet: true });

const express = require("express");
const path = require("path");
const { run } = require("./scan-videos/index");
const { buildBrowserFromLocalProfile } = require("./scan-videos/browser");
const { scanSavedPage } = require("./scan-videos/scan-saved");

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

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use("/media", express.static(mediaDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.get("/scan-saved", (_req, res) => {
  res.sendFile(path.join(rootDir, "scan-saved.html"));
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    shuttingDown,
    busy: Boolean(activeJob),
    browserReady: Boolean(sharedBrowser && sharedBrowser.isConnected && sharedBrowser.isConnected()),
  });
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

    await runWithJobTimeout(
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
      }
    );

    logToClientAndConsole(`\n[api] process finished (exit=0, signal=none)`);
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

  const endUrls = normalizeEndUrls(req.body?.endUrls ?? req.query?.endUrls);
  const jobId = ++jobCounter;
  activeJob = { id: jobId, type: "scan-saved", startedAt: Date.now() };

  try {
    const browser = await getSharedBrowser((message) => {
      const text = String(message == null ? "" : message).trim();
      if (!text) return;
      console.log(`[scan-saved:${jobId}] ${text}`);
    });

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

function setupShutdownHandlers(serverInstance) {
  const handleSignal = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down...`);

    await new Promise((resolve) => {
      serverInstance.close(() => resolve());
    });

    await closeSharedBrowser();
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

  let timer = null;
  let timedOut = false;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      timedOut = true;
      const message = `[api] ${jobType} job ${jobId} timed out after ${timeoutMs}ms. Recycling browser session.`;
      if (log) log(message);
      console.error(message);
      await closeSharedBrowser();
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
      await closeSharedBrowser();
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
