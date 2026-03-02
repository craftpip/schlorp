#!/usr/bin/env node
require("dotenv").config({ quiet: true });

const express = require("express");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const rootDir = __dirname;
const mediaDir = path.join(rootDir, "media");
const port = Number(process.env.PORT) || 3000;

let shuttingDown = false;
let jobCounter = 0;
const runningChildren = new Set();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use("/media", express.static(mediaDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/download", (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ ok: false, error: "Server is shutting down." });
  }

  const link = String(req.body?.link || req.query?.link || "").trim();
  if (!link) {
    return res.status(400).json({ ok: false, error: "Field 'link' is required." });
  }

  const jobId = ++jobCounter;
  const args = ["scan-videos.js", link];

  console.log(`[scan:${jobId}] starting: node ${args.join(" ")}`);

  const child = spawn("node", args, {
    cwd: rootDir,
    env: {
      ...process.env,
      AUTO_CONTINUE: process.env.AUTO_CONTINUE || "1",
      HEADLESS: process.env.API_HEADLESS || process.env.HEADLESS || "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  runningChildren.add(child);

  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const writeStreamChunk = (streamName, chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      console.log(`[scan:${jobId}][${streamName}] ${line}`);
    }

    if (!res.writableEnded) {
      res.write(text);
    }
  };

  child.stdout.on("data", (chunk) => writeStreamChunk("stdout", chunk));
  child.stderr.on("data", (chunk) => writeStreamChunk("stderr", chunk));

  child.on("error", (error) => {
    runningChildren.delete(child);
    console.error(`[scan:${jobId}] failed to start: ${error.message}`);

    if (!res.writableEnded) {
      res.write(`\n[api] failed to start process: ${error.message}\n`);
      res.end();
    }
  });

  child.on("close", (code, signal) => {
    runningChildren.delete(child);
    console.log(`[scan:${jobId}] finished: exit=${code} signal=${signal || "none"}`);

    if (!res.writableEnded) {
      res.write(`\n[api] process finished (exit=${code}, signal=${signal || "none"})\n`);
      res.end();
    }
  });

  req.on("aborted", () => {
    if (child.exitCode == null && child.signalCode == null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  });

  res.on("close", () => {
    if (!res.writableEnded && child.exitCode == null && child.signalCode == null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  });
});

const server = app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});

setupShutdownHandlers(server);

function setupShutdownHandlers(serverInstance) {
  const handleSignal = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down...`);

    await new Promise((resolve) => {
      serverInstance.close(() => resolve());
    });

    const children = Array.from(runningChildren);
    if (children.length) {
      console.log(`[api] stopping ${children.length} running process(es)...`);
    }

    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));

    for (const child of Array.from(runningChildren)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });

  process.on("SIGINT", () => {
    void handleSignal("SIGINT");
  });
}
