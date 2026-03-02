#!/usr/bin/env node
require("dotenv").config();
const puppeteer = require("puppeteer-core");
const chromeLauncher = require("chrome-launcher");
const readline = require("readline");
const fs = require("fs/promises");
const { createWriteStream } = require("fs");
const os = require("os");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const { promisify } = require("util");
const { execFile } = require("child_process");

const execFileAsync = promisify(execFile);

function parseBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;

  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function shouldRunHeadless() {
  const inferredDefault = !process.env.DISPLAY;
  return parseBooleanEnv("HEADLESS", inferredDefault);
}

function shouldAutoContinuePrompts() {
  const inferredDefault = !process.stdin.isTTY;
  return parseBooleanEnv("AUTO_CONTINUE", inferredDefault);
}

async function askUrlIfMissing(cliUrl) {
  if (cliUrl) return cliUrl;
  if (shouldAutoContinuePrompts()) {
    throw new Error("Missing URL argument in non-interactive mode.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const url = await new Promise((resolve) => {
    rl.question("Enter URL: ", (answer) => resolve(answer.trim()));
  });

  rl.close();
  return url;
}

async function waitForEnter(message, options = {}) {
  const forcePrompt = Boolean(options.forcePrompt);

  if (!forcePrompt && shouldAutoContinuePrompts()) {
    console.log(`${message} (auto-continue enabled)`);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise((resolve) => {
    rl.question(`${message}\nPress Enter to continue...`, () => resolve());
  });

  rl.close();
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    return u.href;
  } catch {
    throw new Error("Invalid URL. Include protocol, e.g. https://example.com");
  }
}

async function getChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const installs = chromeLauncher.Launcher.getInstallations();
  if (!installs || installs.length === 0) {
    throw new Error(
      "Chrome not found. Install Chrome or set CHROME_PATH to the executable."
    );
  }
  return installs[0];
}

function resolveProfileConfig() {
  const home = process.env.HOME || "/home/boniface";
  const userDataDir =
    process.env.CHROME_USER_DATA_DIR || `${home}/.config/google-chrome`;
  const profileDir = process.env.CHROME_PROFILE_DIR || "Default";

  return { userDataDir, profileDir };
}

async function cloneProfileDir(sourceDir, profileDir) {
  const cloneDir = path.join(os.tmpdir(), `chrome-profile-clone-${Date.now()}`);
  const sourceProfilePath = path.join(sourceDir, profileDir);
  const targetProfilePath = path.join(cloneDir, profileDir);

  await fs.mkdir(cloneDir, { recursive: true });

  await fs.cp(path.join(sourceDir, "Local State"), path.join(cloneDir, "Local State"), {
    force: true,
  }).catch(() => {});

  await fs.cp(path.join(sourceDir, "First Run"), path.join(cloneDir, "First Run"), {
    force: true,
  }).catch(() => {});

  await fs.cp(sourceProfilePath, targetProfilePath, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (name === "SingletonLock") return false;
      if (name === "SingletonCookie") return false;
      if (name === "SingletonSocket") return false;
      if (name === "Cache") return false;
      if (name === "Code Cache") return false;
      if (name === "GPUCache") return false;
      if (name === "Media Cache") return false;
      return true;
    },
  });

  return cloneDir;
}

async function launchBrowser(chromePath, userDataDir, profileDir, options = {}) {
  const headless =
    typeof options.headless === "boolean" ? options.headless : shouldRunHeadless();
  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    `--profile-directory=${profileDir}`,
  ];

  if (headless) launchArgs.push("--headless=new");

  try {
    return await puppeteer.launch({
      executablePath: chromePath,
      headless,
      defaultViewport: null,
      userDataDir,
      args: launchArgs,
    });
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    const lockError = message.includes("browser is already running");

    if (!lockError) throw err;

    console.log(
      "Primary profile is locked by a running Chrome instance. Using a cloned local profile snapshot..."
    );

    const clonedUserDataDir = await cloneProfileDir(userDataDir, profileDir);

    return puppeteer.launch({
      executablePath: chromePath,
      headless,
      defaultViewport: null,
      userDataDir: clonedUserDataDir,
      args: launchArgs,
    });
  }
}

async function buildBrowserFromLocalProfile(options = {}) {
  const chromePath = await getChromePath();
  const { userDataDir, profileDir } = resolveProfileConfig();
  return launchBrowser(chromePath, userDataDir, profileDir, options);
}

function isLikelyVideoUrl(url) {
  return /\.(mp4|webm|m3u8|mpd|mov|mkv|avi|flv)(\?.*)?$/i.test(url);
}

function stripByteRangeParams(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete("bytestart");
    u.searchParams.delete("byteend");
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function decodeBase64Url(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseInstagramEfg(url) {
  try {
    const parsedUrl = new URL(url);
    const rawEfg = parsedUrl.searchParams.get("efg");
    if (!rawEfg) return null;
    return JSON.parse(decodeBase64Url(rawEfg));
  } catch {
    return null;
  }
}

function isInstagramAudioOnlyUrl(url) {
  const efg = parseInstagramEfg(url);
  if (!efg || typeof efg !== "object") return false;

  const tag = String(efg.vencode_tag || "").toLowerCase();
  if (!tag) return false;
  return (
    tag.includes("audio") ||
    tag.includes("lna_heaac") ||
    tag.includes("dash_lna")
  );
}

function getInstagramAssetId(url) {
  const efg = parseInstagramEfg(url);
  if (!efg || typeof efg !== "object") return "";
  const id = efg.xpv_asset_id;
  return id == null ? "" : String(id);
}

function scoreDownloadCandidate(url) {
  let score = 0;
  const efg = parseInstagramEfg(url);

  if (efg && typeof efg === "object") {
    const tag = String(efg.vencode_tag || "").toLowerCase();
    const bitrate = Number(efg.bitrate || 0);

    if (tag.includes("dash_baseline")) score += 2_000;
    if (tag.includes("clips")) score += 300;
    if (tag.includes("audio") || tag.includes("lna_heaac") || tag.includes("dash_lna")) {
      score -= 20_000;
    }
    if (Number.isFinite(bitrate) && bitrate > 0) score += Math.min(bitrate, 5_000_000);
  }

  return score;
}

function extractDownloadableVideoUrls(videoUrls) {
  const seen = new Set();
  const output = [];

  for (const url of videoUrls) {
    if (!url || url.startsWith("blob:")) continue;
    if (!/\.mp4(\?|$)/i.test(url)) continue;

    const cleaned = stripByteRangeParams(url);
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    output.push(cleaned);
  }

  return output.sort((a, b) => scoreDownloadCandidate(b) - scoreDownloadCandidate(a));
}

async function hasFfmpeg() {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function muxVideoAndAudio(videoPath, audioPath, outPath) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c",
    "copy",
    "-shortest",
    outPath,
  ]);
}

async function mediaHasAudio(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      filePath,
    ]);
    return String(stdout || "").toLowerCase().includes("audio");
  } catch {
    return false;
  }
}

function sanitizeFileToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function isReservedInstagramName(value) {
  const name = String(value || "").toLowerCase();
  if (!name) return true;
  return new Set([
    "reel",
    "reels",
    "p",
    "tv",
    "explore",
    "accounts",
    "stories",
    "about",
    "developer",
    "developers",
    "graphql",
    "api",
    "challenge",
    "legal",
    "privacy",
    "direct",
    "login",
    "logout",
  ]).has(name);
}

function extractInstagramShortcode(url) {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/^\/(?:reel|p|tv)\/([^/?#]+)\/?/i);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function extractUsernameFromNode(node) {
  if (!node || typeof node !== "object") return "";
  const owner = node.owner && typeof node.owner === "object" ? node.owner : null;
  const user = node.user && typeof node.user === "object" ? node.user : null;
  const username =
    (owner && owner.username) ||
    (user && user.username) ||
    node.username ||
    "";
  const normalized = sanitizeFileToken(username);
  if (!normalized || isReservedInstagramName(normalized)) return "";
  return normalized;
}

function findInstagramUsernameInJson(node, shortcode) {
  if (!node || typeof node !== "object") return "";

  if (node.xdt_shortcode_media && typeof node.xdt_shortcode_media === "object") {
    const nested = extractUsernameFromNode(node.xdt_shortcode_media);
    if (nested) return nested;
  }

  if (node.shortcode === shortcode || node.code === shortcode) {
    const direct = extractUsernameFromNode(node);
    if (direct) return direct;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findInstagramUsernameInJson(item, shortcode);
      if (found) return found;
    }
    return "";
  }

  for (const value of Object.values(node)) {
    const found = findInstagramUsernameInJson(value, shortcode);
    if (found) return found;
  }

  return "";
}

function extractInstagramUsernameFromJsonText(rawText, shortcode) {
  if (!rawText || !shortcode) return "";

  let text = rawText.trim();
  if (!text) return "";
  if (text.startsWith("for (;;);")) {
    text = text.slice("for (;;);".length).trim();
  }

  try {
    const parsed = JSON.parse(text);
    return findInstagramUsernameInJson(parsed, shortcode);
  } catch {
    return "";
  }
}

async function getInstagramUsername(page) {
  try {
    const candidate = await page.evaluate(() => {
      const isReserved = (value) => {
        const name = String(value || "").toLowerCase();
        return [
          "reel",
          "reels",
          "p",
          "tv",
          "explore",
          "accounts",
          "stories",
          "about",
          "developer",
          "developers",
          "graphql",
          "api",
          "challenge",
          "legal",
          "privacy",
          "direct",
          "login",
          "logout",
        ].includes(name);
      };

      const normalize = (value) => {
        if (!value) return null;
        const cleaned = String(value).trim().replace(/^@+/, "");
        if (!cleaned) return null;
        if (!/^[a-z0-9._]+$/i.test(cleaned)) return null;
        return cleaned;
      };

      const fromPath = (() => {
        const m = location.pathname.match(/^\/([a-z0-9._]+)\/?$/i);
        return m ? normalize(m[1]) : null;
      })();
      if (fromPath) return fromPath;

      const fromCanonical = (() => {
        const link = document.querySelector('link[rel="canonical"]');
        if (!link) return null;
        const href = link.getAttribute("href") || "";
        try {
          const url = new URL(href, location.href);
          const m = url.pathname.match(/^\/([a-z0-9._]+)\/?$/i);
          return m ? normalize(m[1]) : null;
        } catch {
          return null;
        }
      })();
      if (fromCanonical) return fromCanonical;

      const fromProfileLink = (() => {
        const reelHeaderLink = (() => {
          const selectors = [
            "article header a[href^='/']",
            "main header a[href^='/']",
            "article a[href^='/'][role='link']",
          ];

          for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (!node) continue;
            const href = node.getAttribute("href") || "";
            const m = href.match(/^\/([a-z0-9._]+)\/?$/i);
            if (!m) continue;
            const username = normalize(m[1]);
            if (username && !isReserved(username)) return username;
          }

          return null;
        })();

        if (reelHeaderLink) return reelHeaderLink;

        const anchors = Array.from(document.querySelectorAll('a[href^="/"]'));
        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/^\/([a-z0-9._]+)\/?$/i);
          if (!m) continue;
          const username = normalize(m[1]);
          if (!username) continue;
            if (isReserved(username)) {
              continue;
            }
            return username;
        }
        return null;
      })();
      if (fromProfileLink) return fromProfileLink;

      const fromTitle = (() => {
        const title = document.title || "";
        const m = title.match(/^@?([a-z0-9._]+)\s+on\s+instagram/i);
        return m ? normalize(m[1]) : null;
      })();
      if (fromTitle) return fromTitle;

      const fromMeta = (() => {
        const selectors = [
          'meta[property="og:title"]',
          'meta[property="og:description"]',
          'meta[name="description"]',
        ];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          const content = el ? el.getAttribute("content") || "" : "";
          const m = content.match(/@?([a-z0-9._]+)\s+on\s+instagram/i);
          if (m) {
            const username = normalize(m[1]);
            if (username) return username;
          }
        }
        return null;
      })();
      if (fromMeta) return fromMeta;

      const fromLdJson = (() => {
        const scripts = Array.from(
          document.querySelectorAll('script[type="application/ld+json"]')
        );

        const extract = (node) => {
          if (!node || typeof node !== "object") return null;
          const author = node.author;
          const list = Array.isArray(author) ? author : [author];
          for (const entry of list) {
            if (!entry || typeof entry !== "object") continue;
            const alternateName = normalize(entry.alternateName || "");
            if (alternateName) return alternateName;
            const name = normalize(entry.name || "");
            if (name) return name;
          }
          return null;
        };

        for (const script of scripts) {
          const raw = script.textContent || "";
          if (!raw.trim()) continue;
          try {
            const parsed = JSON.parse(raw);
            const nodes = Array.isArray(parsed) ? parsed : [parsed];
            for (const node of nodes) {
              const username = extract(node);
              if (username) return username;
            }
          } catch {
            // ignore invalid JSON-LD
          }
        }

        return null;
      })();
      if (fromLdJson) return fromLdJson;

      return null;
    });

    const normalized = sanitizeFileToken(candidate);
    if (normalized && !isReservedInstagramName(normalized)) return normalized;

    const html = await page.content();
    const patterns = [
      /"xdt_shortcode_media"[\s\S]*?"owner"\s*:\s*\{[\s\S]*?"username"\s*:\s*"([a-zA-Z0-9._]+)"/,
      /"shortcode_media"[\s\S]*?"owner"\s*:\s*\{[\s\S]*?"username"\s*:\s*"([a-zA-Z0-9._]+)"/,
      /"owner"\s*:\s*\{[\s\S]*?"username"\s*:\s*"([a-zA-Z0-9._]+)"/,
      /"user"\s*:\s*\{[\s\S]*?"username"\s*:\s*"([a-zA-Z0-9._]+)"/,
      /"username"\s*:\s*"([a-zA-Z0-9._]+)"\s*,\s*"profile_pic_url"/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match) continue;
      const username = sanitizeFileToken(match[1]);
      if (!username || isReservedInstagramName(username)) continue;
      return username;
    }

    return "";
  } catch {
    return "";
  }
}

async function getInstagramUsernameFromOembed(page, targetUrl) {
  try {
    const candidate = await page.evaluate(async (url) => {
      const endpoints = [
        `/api/v1/oembed/?url=${encodeURIComponent(url)}`,
        `/oembed/?url=${encodeURIComponent(url)}`,
      ];

      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint, {
            method: "GET",
            credentials: "include",
          });
          if (!response.ok) continue;
          const payload = await response.json();
          const value =
            payload.author_name || payload.author || payload.username || "";
          if (value) return value;
        } catch {
          // ignore endpoint failures
        }
      }

      return "";
    }, targetUrl);

    const normalized = sanitizeFileToken(candidate);
    if (!normalized || isReservedInstagramName(normalized)) return "";
    return normalized;
  } catch {
    return "";
  }
}

async function downloadMedia(url, outDir, headers = {}, filePrefix = "media") {
  const targetUrl = stripByteRangeParams(url);
  await fs.mkdir(outDir, { recursive: true });

  const response = await fetch(targetUrl, {
    method: "GET",
    redirect: "follow",
    headers,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const extMatch = new URL(targetUrl).pathname.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1] : "bin";
  const safePrefix = sanitizeFileToken(filePrefix) || "media";
  const filePath = path.join(outDir, `${safePrefix}-${Date.now()}.${ext}`);

  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));

  return { filePath, url: targetUrl };
}

(async () => {
  const args = process.argv.slice(2).map((x) => String(x || "").trim()).filter(Boolean);

  if (!args.length) {
    throw new Error(
      "Usage: node scan-videos.js <url1> [url2 ...] OR node scan-videos.js open-browser"
    );
  }

  const command = args[0].toLowerCase();
  if (command === "open-browser") {
    const browser = await buildBrowserFromLocalProfile({ headless: false });
    const page = await browser.newPage();
    await page.goto("https://www.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await waitForEnter("Browser is open on google.com. Use it to log in anywhere you want.", {
      forcePrompt: true,
    });
    await browser.close();
    return;
  }

  const inputUrls = args.map((raw) => normalizeUrl(raw));
  const browser = await buildBrowserFromLocalProfile();

  for (let index = 0; index < inputUrls.length; index += 1) {
    const targetUrl = inputUrls[index];
    const isInstagramTarget = (() => {
      try {
        const u = new URL(targetUrl);
        return /(^|\.)instagram\.com$/i.test(u.hostname);
      } catch {
        return false;
      }
    })();


    const instagramShortcode = isInstagramTarget ? extractInstagramShortcode(targetUrl) : "";

    const page = await browser.newPage();

    try {
      const networkVideos = new Set();
      let instagramUsernameFromApi = "";

      page.on("response", async (response) => {
        try {
          const url = response.url();
          const headers = response.headers();
          const contentType = (headers["content-type"] || "").toLowerCase();

          if (contentType.startsWith("video/") || isLikelyVideoUrl(url)) {
            networkVideos.add(url);
          }

          if (
            isInstagramTarget &&
            instagramShortcode &&
            !instagramUsernameFromApi &&
            (contentType.includes("application/json") || /graphql|api\/v1/i.test(url))
          ) {
            const bodyText = await response.text().catch(() => "");
            if (bodyText && bodyText.length <= 2_000_000) {
              const username = extractInstagramUsernameFromJsonText(
                bodyText,
                instagramShortcode
              );
              if (username) instagramUsernameFromApi = username;
            }
          }
        } catch {
          // ignore individual response parse errors
        }
      });

      await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 60000 });
      await waitForEnter(
        `Target page ${index + 1}/${inputUrls.length} is open. If needed, log in and ensure media is visible.`
      );

      if (!isInstagramTarget) {
        await page.evaluate(async () => {
          window.scrollTo(0, document.body.scrollHeight / 2);
          await new Promise((r) => setTimeout(r, 800));
          window.scrollTo(0, document.body.scrollHeight);
          await new Promise((r) => setTimeout(r, 800));
          window.scrollTo(0, 0);
        });
      }

      const domVideos = await page.evaluate(() => {
        const out = new Set();

        const abs = (u) => {
          try {
            return new URL(u, location.href).href;
          } catch {
            return null;
          }
        };

        document.querySelectorAll("video[src]").forEach((el) => {
          const u = abs(el.getAttribute("src"));
          if (u) out.add(u);
        });

        document.querySelectorAll("video source[src]").forEach((el) => {
          const u = abs(el.getAttribute("src"));
          if (u) out.add(u);
        });

        document.querySelectorAll("a[href], source[src]").forEach((el) => {
          const attr = el.hasAttribute("href") ? "href" : "src";
          const raw = el.getAttribute(attr);
          if (!raw) return;
          const u = abs(raw);
          if (!u) return;
          if (/\.(mp4|webm|m3u8|mpd|mov|mkv|avi|flv)(\?.*)?$/i.test(u)) out.add(u);
        });

        return Array.from(out);
      });

      const allVideos = Array.from(new Set([...domVideos, ...networkVideos]));
      console.log(`\n=== Video/Media URLs found for ${targetUrl} ===`);
      if (!allVideos.length) {
        console.log("No video media URLs detected.");
        continue;
      }
      allVideos.forEach((u, i) => console.log(`${i + 1}. ${u}`));

      const downloadableUrls = extractDownloadableVideoUrls(allVideos);
      if (!downloadableUrls.length) {
        console.log("\nNo downloadable HTTP MP4 URL found.");
        continue;
      }

      const userAgent = await page.evaluate(() => navigator.userAgent);
      let filePrefix = "media";
      if (isInstagramTarget) {
        const username =
          instagramUsernameFromApi ||
          (await getInstagramUsernameFromOembed(page, targetUrl)) ||
          (await getInstagramUsername(page));
        if (username) filePrefix = username;
      }

      let result = null;
      let lastError = null;
      let selectedCandidate = "";
      let selectedAssetId = "";

      const primaryCandidates = isInstagramTarget
        ? downloadableUrls.filter((u) => !isInstagramAudioOnlyUrl(u))
        : downloadableUrls;

      let candidatesToTry = primaryCandidates.length
        ? primaryCandidates
        : downloadableUrls;

      if (isInstagramTarget && primaryCandidates.length) {
        const audioCandidates = downloadableUrls.filter((u) => isInstagramAudioOnlyUrl(u));
        const assetStats = new Map();

        for (const candidate of primaryCandidates) {
          const assetId = getInstagramAssetId(candidate);
          if (!assetId) continue;
          const current = assetStats.get(assetId) || { bestVideo: -Infinity, hasAudio: false };
          current.bestVideo = Math.max(current.bestVideo, scoreDownloadCandidate(candidate));
          assetStats.set(assetId, current);
        }

        for (const candidate of audioCandidates) {
          const assetId = getInstagramAssetId(candidate);
          if (!assetId) continue;
          const current = assetStats.get(assetId) || { bestVideo: -Infinity, hasAudio: false };
          current.hasAudio = true;
          assetStats.set(assetId, current);
        }

        let preferredAssetId = "";
        let preferredAssetScore = -Infinity;
        for (const [assetId, stat] of assetStats.entries()) {
          const score = stat.bestVideo + (stat.hasAudio ? 10_000_000 : 0);
          if (score > preferredAssetScore) {
            preferredAssetScore = score;
            preferredAssetId = assetId;
          }
        }

        if (preferredAssetId) {
          const preferredVideos = primaryCandidates.filter(
            (u) => getInstagramAssetId(u) === preferredAssetId
          );
          if (preferredVideos.length) candidatesToTry = preferredVideos;
        }
      }

      for (const candidate of candidatesToTry) {
        try {
          const cookies = await page.cookies(candidate);
          const cookieHeader = cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; ");

          const headers = {
            "user-agent": userAgent,
            referer: targetUrl,
          };

          if (cookieHeader) headers.cookie = cookieHeader;

          result = await downloadMedia(
            candidate,
            path.join(process.cwd(), "media"),
            headers,
            filePrefix
          );
          selectedCandidate = candidate;
          selectedAssetId = getInstagramAssetId(candidate);
          break;
        } catch (err) {
          lastError = err;
        }
      }

      if (!result) {
        throw new Error(
          `Failed to download from ${downloadableUrls.length} candidate URLs. Last error: ${
            lastError ? lastError.message : "unknown"
          }`
        );
      }

      if (isInstagramTarget) {
        const audioCandidates = downloadableUrls.filter((u) => isInstagramAudioOnlyUrl(u));
        const primaryLooksVideo = selectedCandidate && !isInstagramAudioOnlyUrl(selectedCandidate);
        const matchingAudioCandidates = selectedAssetId
          ? audioCandidates.filter((u) => getInstagramAssetId(u) === selectedAssetId)
          : audioCandidates;

        if (
          primaryLooksVideo &&
          matchingAudioCandidates.length &&
          !(await mediaHasAudio(result.filePath))
        ) {
          if (await hasFfmpeg()) {
            const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ig-audio-"));
            let audioResult = null;

            for (const candidate of matchingAudioCandidates) {
              try {
                const cookies = await page.cookies(candidate);
                const cookieHeader = cookies
                  .map((cookie) => `${cookie.name}=${cookie.value}`)
                  .join("; ");

                const headers = {
                  "user-agent": userAgent,
                  referer: targetUrl,
                };

                if (cookieHeader) headers.cookie = cookieHeader;

                audioResult = await downloadMedia(candidate, tempDir, headers, "audio");
                break;
              } catch {
                // keep trying other audio candidates
              }
            }

            if (audioResult) {
              const mergedPath = `${result.filePath}.merged.mp4`;
              try {
                await muxVideoAndAudio(result.filePath, audioResult.filePath, mergedPath);
                await fs.rename(mergedPath, result.filePath);
              } finally {
                await fs.rm(audioResult.filePath, { force: true }).catch(() => {});
                await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
              }
            }
          } else {
            console.log("\nffmpeg not found; downloaded video-only stream.");
          }
        }
      }

      console.log(`\nDownloaded media to: ${result.filePath}`);
      console.log(`Source URL: ${result.url}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  await waitForEnter("Run complete.");
  await browser.close();
})().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
