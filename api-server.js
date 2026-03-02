#!/usr/bin/env node
require("dotenv").config({ quiet: true });

const express = require("express");
const path = require("path");
const { run } = require("./scan-videos/index");
const { buildBrowserFromLocalProfile } = require("./scan-videos/browser");

const app = express();
const rootDir = __dirname;
const mediaDir = path.join(rootDir, "media");
const port = Number(process.env.PORT) || 3000;

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
      error: `Another download is currently running (job ${activeJob.id}). Try again when it finishes.`,
    });
  }

  const link = String(req.body?.link || req.query?.link || "").trim();
  if (!link) {
    return res.status(400).json({ ok: false, error: "Field 'link' is required." });
  }

  let outputDir = mediaDir;
  try {
    const folder = String(req.body?.folder || req.query?.folder || "").trim();
    outputDir = resolveMediaOutputDir(folder);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  const jobId = ++jobCounter;
  activeJob = { id: jobId, startedAt: Date.now() };

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

    await run({
      urls: [link],
      linkOnly: false,
      outputDir,
      browser,
      autoContinuePrompts: true,
      waitForCompletionPrompt: false,
      log: logToClientAndConsole,
    });

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
