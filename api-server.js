#!/usr/bin/env node
require("dotenv").config();

const express = require("express");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const SCAN_SCRIPT = path.join(__dirname, "scan-videos.js");

let queue = Promise.resolve();

function normalizeInputUrls(body) {
  const single = typeof body?.url === "string" ? [body.url] : [];
  const list = Array.isArray(body?.urls) ? body.urls : [];
  const merged = [...single, ...list]
    .map((u) => String(u || "").trim())
    .filter(Boolean);

  if (!merged.length) {
    throw new Error("Provide 'url' (string) or 'urls' (string array) in request body.");
  }

  return merged;
}

function parseRunOutput(stdout) {
  const downloadRegex = /Downloaded media to:\s*(.+)/g;
  const sourceRegex = /Source URL:\s*(.+)/g;
  const files = [];
  const sources = [];

  let match;
  while ((match = downloadRegex.exec(stdout))) files.push(match[1].trim());
  while ((match = sourceRegex.exec(stdout))) sources.push(match[1].trim());

  return files.map((filePath, index) => ({
    filePath,
    sourceUrl: sources[index] || null,
  }));
}

function runScan(urls) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCAN_SCRIPT, ...urls], {
      cwd: __dirname,
      env: {
        ...process.env,
        AUTO_CONTINUE: process.env.AUTO_CONTINUE || "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(`scan-videos exited with code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }

      return resolve({
        downloads: parseRunOutput(stdout),
        stdout,
      });
    });
  });
}

app.post("/download", (req, res) => {
  let urls;
  try {
    urls = normalizeInputUrls(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const task = () =>
    runScan(urls)
      .then((result) => {
        res.json({
          ok: true,
          requested: urls,
          downloads: result.downloads,
        });
      })
      .catch((err) => {
        res.status(500).json({
          ok: false,
          error: err.message,
          details: (err.stderr || err.stdout || "").trim().slice(0, 4000),
        });
      });

  queue = queue.then(task, task);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
