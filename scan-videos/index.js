const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { buildBrowserFromLocalProfile } = require("./browser");
const {
  getInstagramUserAgent,
  shouldAutoContinuePrompts,
  waitForEnter,
  normalizeUrl,
} = require("./config");
const {
  isLikelyVideoUrl,
  stripByteRangeParams,
  getInstagramAssetId,
  isInstagramAudioOnlyUrl,
  scoreDownloadCandidate,
  extractDownloadableVideoUrls,
  prioritizeInstagramCandidates,
  prioritizeXhamsterCandidates,
  prioritizeRedditCandidates,
  isRedgifsUrl,
  isGifUrl,
  isPhotoUrl,
  extractQualityHint,
  sanitizeFileToken,
} = require("./media-utils");
const {
  extractInstagramShortcode,
  extractInstagramUsernameFromJsonText,
  extractInstagramMediaHintsFromJsonText,
  extractInstagramImageHintsFromJsonText,
  dedupeInstagramPhotos,
  filterInstagramCandidatesForTarget,
} = require("./instagram-utils");
const {
  isRedditUrl,
  extractRedditPostId,
  extractRedditMediaHintsFromJsonText,
  extractRedditImageHintsFromJsonText,
  dedupeRedditPhotos,
} = require("./reddit-utils");
const {
  extractXhamsterMediaData,
  extractXvideosMediaUrls,
  extractPornhubMediaData,
  getInstagramUsername,
  getInstagramUsernameFromOembed,
  extractRedditMediaData,
  extractInstagramPhotoData,
  fetchRedgifsMediaUrls,
} = require("./extractors");
const {
  hasFfmpeg,
  muxVideoAndAudio,
  mediaHasAudio,
  downloadMedia,
} = require("./download");

const SNAPSHOT_DIR =
  String(process.env.SNAPSHOT_DIR || "").trim() || path.join(process.cwd(), "media", ".debug-snapshots");

// Reddit redgifs API helper (server-side, handles auth token)
async function fetchRedgifsDirectUrlsViaApi(redgifsId, log = () => {}) {
  if (!redgifsId) return [];
  try {
    const tokenRes = await fetch("https://api.redgifs.com/v2/auth/temporary");
    if (!tokenRes.ok) {
      log(`redgifs token fetch failed: ${tokenRes.status}`);
      return [];
    }
    const tokenJson = await tokenRes.json().catch(() => null);
    const token = tokenJson && tokenJson.token;
    if (!token) {
      log("redgifs token missing");
      return [];
    }
    const apiUrl = `https://api.redgifs.com/v2/gifs/${encodeURIComponent(redgifsId)}`;
    const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      log(`redgifs api ${redgifsId} status ${res.status} ${txt.slice(0, 200)}`);
      return [];
    }
    const data = await res.json().catch(() => null);
    if (!data) return [];
    const gif = data.gif || (data.gifs && data.gifs[0]) || data;
    const urls = [];
    const scan = (node, depth = 0) => {
      if (depth > 6 || node == null) return;
      if (typeof node === "string") {
        if (/\.(mp4|m3u8|mpd)(\?|$)/i.test(node) || /media\.redgifs\.com/i.test(node)) urls.push(node);
        return;
      }
      if (typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((x) => scan(x, depth + 1));
        return;
      }
      for (const v of Object.values(node)) scan(v, depth + 1);
    };
    scan(gif);
    if (gif && gif.urls) {
      if (gif.urls.hd) urls.push(gif.urls.hd);
      if (gif.urls.sd) urls.push(gif.urls.sd);
    }
    // dedupe and clean
    const cleaned = Array.from(new Set(urls.map((u) => stripByteRangeParams(u)).filter(Boolean)));
    if (cleaned.length) log(`redgifs api ${redgifsId} → ${cleaned.length} URL(s)`);
    return cleaned;
  } catch (e) {
    log(`redgifs api error ${redgifsId}: ${e.message}`);
    return [];
  }
}

const POPUP_CLOSE_SELECTORS = [
  // generic cookie banners
  'button[id*="accept"]', 'button[id*="cookie"]', '[id*="onetrust"] button', '[id*="cookie"] button',
  'button:has-text("Accept")', 'button:has-text("I agree")', 'button:has-text("Got it")',
  // xHamster / xVideos / Pornhub age gates
  'button[data-role="agree"]', 'button.xh-age-confirm', '#age-verify button',
  '[data-testid="age-verify"] button', '.age-verification button',
  'button:has-text("I am 18")', 'button:has-text("I am over 18")', 'button:has-text("Enter")',
  // Instagram login wall
  'button:has-text("Not Now")', 'button:has-text("Not now")', '[aria-label="Close"]',
  'div[role="dialog"] button', 'div[role="presentation"] button',
  // generic modals
  '.modal button.close', '.popup button.close', '[class*="popup"] [class*="close"]',
  'button.close', '[aria-label="Dismiss"]',
];

async function dismissPopups(page, log = () => {}) {
  for (const sel of POPUP_CLOSE_SELECTORS) {
    try {
      // page.evaluate to avoid puppeteer :has-text which is not native CSS — handle text via JS
      const clicked = await page.evaluate((selector) => {
        // handle :has-text pseudo by manual text search
        const hasTextMatch = selector.match(/:has-text\("([^"]+)"\)/);
        if (hasTextMatch) {
          const text = hasTextMatch[1].toLowerCase();
          const base = selector.replace(/:has-text\("([^"]+)"\)/, "");
          const candidates = base ? Array.from(document.querySelectorAll(base)) : Array.from(document.querySelectorAll("button, a, [role=button]"));
          for (const el of candidates) {
            const t = (el.textContent || "").trim().toLowerCase();
            if (t.includes(text) && el.offsetParent !== null) { el.click(); return true; }
          }
          return false;
        }
        const els = document.querySelectorAll(selector);
        for (const el of els) {
          if (el.offsetParent !== null) { el.click(); return true; }
        }
        return false;
      }, sel);
      if (clicked) {
        log(`Dismissed popup via: ${sel}`);
        await sleep(400);
      }
    } catch {}
  }
  // also try pressing Escape to close overlays
  try { await page.keyboard.press("Escape"); } catch {}
}

async function captureFailureSnapshot(page, targetUrl, reason, log = () => {}) {
  try {
    await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
    const safeHost = (() => { try { return new URL(targetUrl).hostname.replace(/[^a-z0-9]/gi, "_"); } catch { return "unknown"; } })();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `${stamp}_${safeHost}_${sanitizeFileToken(reason || "no-video").slice(0, 30)}`;
    const pngPath = path.join(SNAPSHOT_DIR, `${base}.png`);
    const htmlPath = path.join(SNAPSHOT_DIR, `${base}.html`);
    await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => "");
    if (html) await fs.writeFile(htmlPath, html, "utf8").catch(() => {});
    log(`Snapshot saved for ${targetUrl} (${reason}): ${pngPath}`);
    // best-effort: also log overlay diagnostics
    const diag = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="presentation"], .modal, [class*="popup"], [class*="overlay"], [id*="cookie"], [id*="age"]'));
      return dialogs.slice(0, 5).map((el) => ({ tag: el.tagName, cls: el.className?.slice(0, 80) || "", id: el.id || "", text: (el.innerText || "").slice(0, 120).replace(/\s+/g, " ") }));
    }).catch(() => []);
    if (diag.length) log(`Visible overlays: ${JSON.stringify(diag)}`);
  } catch (e) {
    log(`Snapshot failed: ${e.message}`);
  }
}

async function countDomMediaSignals(page) {
  return page.evaluate(() => {
    const abs = (u) => {
      try {
        return new URL(u, location.href).href;
      } catch {
        return "";
      }
    };

    const urls = new Set();

    document.querySelectorAll("video").forEach((el) => {
      const currentSrc = abs(el.currentSrc || "");
      const src = abs(el.getAttribute("src") || el.src || "");
      if (currentSrc) urls.add(currentSrc);
      if (src) urls.add(src);
    });

    document.querySelectorAll("video source[src], source[src], a[href]").forEach((el) => {
      const attr = el.hasAttribute("href") ? "href" : "src";
      const raw = el.getAttribute(attr) || "";
      const resolved = abs(raw);
      if (!resolved) return;
      if (/(\.mp4|\.webm|\.m3u8|\.mpd|\.mov|\.mkv|\.avi|\.flv)(\?.*)?$/i.test(resolved)) {
        urls.add(resolved);
      }
    });

    const readyVideoCount = Array.from(document.querySelectorAll("video")).filter(
      (el) => el.readyState >= 2
    ).length;

    return {
      urlCount: urls.size,
      readyVideoCount,
      readyState: document.readyState,
    };
  });
}

async function waitForAutoCaptureWindow(page, getNetworkState, logLabel, log = console.log) {
  const timeoutRaw = Number(process.env.AUTO_CAPTURE_TIMEOUT_MS);
  const quietRaw = Number(process.env.AUTO_CAPTURE_QUIET_MS);
  const pollRaw = Number(process.env.AUTO_CAPTURE_POLL_MS);

  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 7000;
  const quietMs = Number.isFinite(quietRaw) && quietRaw > 0 ? quietRaw : 1800;
  const pollMs = Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : 250;
  const startedAt = Date.now();

  let lastPopupCheckAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const dom = await countDomMediaSignals(page).catch(() => ({
      urlCount: 0,
      readyVideoCount: 0,
      readyState: "loading",
    }));
    const net = getNetworkState();
    const signalCount = dom.urlCount + dom.readyVideoCount + net.mediaCount;

    const quietForMs = Date.now() - net.lastMediaSignalAt;
    const hasSignals = signalCount > 0;
    const domReady = dom.readyState === "complete" || dom.readyState === "interactive";

    if (hasSignals && quietForMs >= quietMs && domReady) {
      log(`${logLabel} (auto-proceed after media settled: signals=${signalCount}, quiet=${quietForMs}ms)`);
      return;
    }

    // periodically try to dismiss popups/overlays that block media loading
    if (Date.now() - lastPopupCheckAt > 2000) {
      lastPopupCheckAt = Date.now();
      await dismissPopups(page, log).catch(() => {});
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  log(`${logLabel} (auto-proceed after timeout)`);
}

function parseCliArgs(rawArgs) {
  let linkOnly = false;
  let maxQuality = null;
  let account = "";
  const args = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--link-only") {
      linkOnly = true;
      continue;
    }

    if (arg === "--max-quality") {
      const value = rawArgs[index + 1];
      if (!value) {
        throw new Error("--max-quality requires a value, e.g. --max-quality 720");
      }
      maxQuality = parseMaxQualityInput(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--max-quality=")) {
      maxQuality = parseMaxQualityInput(arg.slice("--max-quality=".length));
      continue;
    }

    if (arg === "--account") {
      account = String(rawArgs[index + 1] || "").trim();
      if (!account) {
        throw new Error("--account requires a value, e.g. --account work");
      }
      index += 1;
      continue;
    }

    if (arg.startsWith("--account=")) {
      account = arg.slice("--account=".length).trim();
      if (!account) {
        throw new Error("--account requires a value, e.g. --account work");
      }
      continue;
    }

    args.push(arg);
  }

  if (!args.length) {
    throw new Error(
      "Usage: node scan-videos.js [--link-only] [--max-quality <p>] [--account <name>] <url1> [url2 ...] OR node scan-videos.js open-browser [--account <name>]"
    );
  }

  const command = String(args[0] || "").toLowerCase();
  if (command === "open-browser") {
    return { command, account };
  }

  return {
    command: "scan",
    linkOnly,
    maxQuality,
    account,
    inputUrls: args.map((raw) => normalizeUrl(raw)),
  };
}

function resolveLogger(log) {
  if (typeof log === "function") return log;
  return (message) => console.log(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseMaxQualityInput(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--max-quality must be a positive integer, e.g. 720 or 1080.");
  }
  return Math.floor(parsed);
}

function applyMaxQualityLimit(urls, maxQuality) {
  if (!Number.isFinite(maxQuality) || maxQuality <= 0) return urls;

  const candidates = urls.map((url) => ({ url, quality: extractQualityHint(url) }));
  const explicit = candidates.filter((entry) => entry.quality > 0);
  const cappedExplicit = explicit.filter((entry) => entry.quality <= maxQuality);

  if (cappedExplicit.length > 0) {
    return cappedExplicit.map((entry) => entry.url);
  }

  if (explicit.length === 0) {
    return urls;
  }

  return [];
}

function isInstagram429Error(err) {
  const message = String(err && err.message ? err.message : err || "").toLowerCase();
  return message.includes("429") || message.includes("too many requests");
}

function createInstagram429CooldownError(message) {
  const error = new Error(message);
  error.status = 429;
  return error;
}

async function waitForInstagram429Cooldown(log, cooldownMs) {
  log("waiting for 429 cooldown.");
  await sleep(cooldownMs);
}

async function gotoWithInstagram429Retry(page, targetUrl, isInstagramTarget, log, cooldownMs) {
  const isCdp = (() => {
    try {
      if (page.browser && typeof page.browser === "function") {
        const b = page.browser();
        if (b && b.__isCdp) return true;
      }
    } catch {}
    return false;
  })();
  if (!isCdp) {
    try { await page.bringToFront().catch(() => {}); } catch {}
  }
  let response;
  if (isCdp) {
    log(`CDP browser — using domcontentloaded for ${targetUrl}`);
    try {
      response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      const curUrl = page.url();
      if (curUrl && curUrl !== "about:blank") {
        log(`proceeding despite goto timeout — page url is ${curUrl}`);
        return null;
      }
      throw e;
    }
  } else {
    try {
      response = await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });
    } catch (e) {
      const msg = String(e && e.message || e);
      const isTimeout = /timeout/i.test(msg) && /navigation/i.test(msg);
      if (isTimeout) {
        log(`page.goto networkidle2 timed out, trying domcontentloaded fallback: ${msg}`);
        try {
          response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        } catch (e2) {
          const curUrl = page.url();
          if (curUrl && curUrl !== "about:blank") {
            log(`proceeding despite goto timeout — page url is ${curUrl}`);
            return null;
          }
          throw e2;
        }
      } else {
        throw e;
      }
    }
  }
  if (!isCdp) {
    try { await page.bringToFront().catch(() => {}); } catch {}
  }
  const status = response && typeof response.status === "function" ? response.status() : 0;

  if (isInstagramTarget && status === 429) {
    log(`Instagram responded with 429 for ${targetUrl}.`);
    await waitForInstagram429Cooldown(log, cooldownMs);
    throw createInstagram429CooldownError("Instagram responded with 429. Suspending this run; retry later.");
  }

  return response;
}

async function run(options = {}) {
  const log = resolveLogger(options.log);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  const hasProgrammaticOptions =
    Array.isArray(options.urls) ||
    typeof options.command === "string" ||
    typeof options.linkOnly === "boolean" ||
    Boolean(options.browser);

  const parsed = hasProgrammaticOptions
    ? {
        command: options.command || "scan",
        linkOnly: Boolean(options.linkOnly),
        maxQuality: parseMaxQualityInput(options.maxQuality),
        account: String(options.account || "").trim(),
        inputUrls: Array.isArray(options.urls)
          ? options.urls.map((raw) => normalizeUrl(String(raw || "").trim())).filter(Boolean)
          : [],
      }
    : parseCliArgs(
        process.argv
          .slice(2)
          .map((x) => String(x || "").trim())
          .filter(Boolean)
      );

  const autoContinuePrompts =
    typeof options.autoContinuePrompts === "boolean"
      ? options.autoContinuePrompts
      : shouldAutoContinuePrompts();
  const waitForCompletionPrompt =
    typeof options.waitForCompletionPrompt === "boolean"
      ? options.waitForCompletionPrompt
      : !hasProgrammaticOptions;
  const instagram429CooldownMs = parsePositiveInt(process.env.INSTAGRAM_429_COOLDOWN_MS, 300000);

  if (parsed.command === "open-browser") {
    const browserOptions = { headless: false, log };
    if (parsed.account) {
      browserOptions.account = parsed.account;
    }
    const browser = await buildBrowserFromLocalProfile(browserOptions);
    const page = await browser.newPage();
    try { await page.bringToFront().catch(() => {}); } catch {}
    await page.goto("https://www.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const accountMsg = parsed.account ? ` (account: ${parsed.account})` : "";
    const vncHint =
      process.env.ENABLE_VNC === "1"
        ? " Open http://localhost:6779/vnc.html to control the browser."
        : "";
    await waitForEnter(`Browser is open on google.com${accountMsg}. Use it to log in anywhere you want.${vncHint}`, {
      forcePrompt: true,
      log,
    });
    await browser.close();
    return;
  }

  if (!parsed.inputUrls.length) {
    throw new Error("At least one URL is required.");
  }

  const outputDir =
    typeof options.outputDir === "string" && options.outputDir.trim()
      ? options.outputDir.trim()
      : path.join(process.cwd(), "media");

  const hasExternalBrowser = Boolean(options.browser);
  const browser =
    options.browser ||
    (await buildBrowserFromLocalProfile({
      headless: typeof options.headless === "boolean" ? options.headless : undefined,
      account: parsed.account || undefined,
      log,
    }));

  const failedTargets = [];

  try {
    for (let index = 0; index < parsed.inputUrls.length; index += 1) {
      const targetUrl = parsed.inputUrls[index];
      const isInstagramTarget = (() => {
        try {
          const u = new URL(targetUrl);
          return /(^|\.)instagram\.com$/i.test(u.hostname);
        } catch {
          return false;
        }
      })();
      const isXhamsterTarget = (() => {
        try {
          const u = new URL(targetUrl);
          return /(^|\.)xhamster\.com$/i.test(u.hostname);
        } catch {
          return false;
        }
      })();
      const isPornhubTarget = (() => {
        try {
          const u = new URL(targetUrl);
          return /(^|\.)pornhub\.(com|org)$/i.test(u.hostname);
        } catch {
          return false;
        }
      })();
      const isRedditTarget = (() => {
        try {
          const u = new URL(targetUrl);
          return /(^|\.)reddit\.com$/i.test(u.hostname);
        } catch {
          return false;
        }
      })();

      const instagramShortcode = isInstagramTarget
        ? extractInstagramShortcode(targetUrl)
        : "";
      const redditPostId = isRedditTarget ? extractRedditPostId(targetUrl) : "";

      const page = await browser.newPage();
      if (!(browser && browser.__isCdp)) {
        try { await page.bringToFront().catch(() => {}); } catch {}
      }

      try {
        if (isInstagramTarget) {
          const instagramUA = getInstagramUserAgent();
          if (instagramUA) {
            await page.setUserAgent(instagramUA);
            await page.setExtraHTTPHeaders({
              "accept-language": "en-US,en;q=0.9",
            });
            if (!(browser && browser.__isCdp)) {
              await page.setViewport({
                width: 430,
                height: 932,
                isMobile: true,
                hasTouch: true,
                deviceScaleFactor: 3,
              });
            } else {
              log("CDP browser — keeping remote viewport (skipping setViewport).");
            }
            log("Using Instagram mobile browser agent profile.");
          }
        }

        const networkVideos = new Set();
        let lastMediaSignalAt = Date.now();
        let instagramUsernameFromApi = "";
        const instagramTargetHintUrls = new Set();
        const instagramTargetHintAssetIds = new Set();
        const instagramImageHintUrls = new Set();
        const redditHintUrls = new Set();
        const redditRedgifsIds = new Set();
        const redditImageHintUrls = new Set();
        let redditIsVideoPost = null; // null=unknown, true=video, false=photo-only

        page.on("response", async (response) => {
          try {
            const url = response.url();
            const headers = response.headers();
            const contentType = (headers["content-type"] || "").toLowerCase();

            if (
              contentType.startsWith("video/") ||
              isLikelyVideoUrl(url) ||
              /\.gif(\?|$)/i.test(url) ||
              /redgifs\.com\/(?:watch|ifr)\//i.test(url) ||
              /v\.redd\.it\//i.test(url)
            ) {
              if (!networkVideos.has(url)) lastMediaSignalAt = Date.now();
              networkVideos.add(url);
            }

            if (
              isInstagramTarget &&
              instagramShortcode &&
              (contentType.includes("application/json") || /graphql|api\/v1/i.test(url))
            ) {
              const bodyText = await response.text().catch(() => "");
              if (bodyText && bodyText.length <= 2_000_000) {
                if (!instagramUsernameFromApi) {
                  const username = extractInstagramUsernameFromJsonText(
                    bodyText,
                    instagramShortcode
                  );
                  if (username) instagramUsernameFromApi = username;
                }

                const mediaHints = extractInstagramMediaHintsFromJsonText(
                  bodyText,
                  instagramShortcode
                );
                for (const hintUrl of mediaHints.urls) {
                  instagramTargetHintUrls.add(stripByteRangeParams(hintUrl));
                }
                for (const hintAssetId of mediaHints.assetIds) {
                  const cleaned = String(hintAssetId || "").trim();
                  if (cleaned) instagramTargetHintAssetIds.add(cleaned);
                }
                const imageHints = extractInstagramImageHintsFromJsonText(
                  bodyText,
                  instagramShortcode
                );
                for (const hintUrl of imageHints.imageUrls) {
                  instagramImageHintUrls.add(stripByteRangeParams(hintUrl));
                }
              }
            }

            if (
              isRedditTarget &&
              redditPostId &&
              (contentType.includes("application/json") || /\.json(\?|$)/i.test(url) || /api\.redgifs\.com/i.test(url))
            ) {
              const bodyText = await response.text().catch(() => "");
              if (bodyText && bodyText.length <= 5_000_000) {
                // reddit post json
                if (/reddit\.com.*\.json/i.test(url) || url.includes("/comments/")) {
                  const hints = extractRedditMediaHintsFromJsonText(bodyText, redditPostId);
                  if (hints.isVideo === false) {
                    redditIsVideoPost = false;
                  } else if (hints.urls.length || hints.redgifsIds.length) {
                    redditIsVideoPost = true;
                  }
                  for (const hintUrl of hints.urls) {
                    redditHintUrls.add(stripByteRangeParams(hintUrl));
                  }
                  for (const rid of hints.redgifsIds) {
                    const cleaned = String(rid || "").trim();
                    if (cleaned) redditRedgifsIds.add(cleaned);
                  }
                }
                // redgifs api json
                if (/api\.redgifs\.com/i.test(url)) {
                  try {
                    const parsed = JSON.parse(bodyText);
                    const urls = [];
                    const scan = (node, depth = 0) => {
                      if (depth > 6 || node == null) return;
                      if (typeof node === "string") {
                        if (/\.(mp4|m3u8|mpd)(\?|$)/i.test(node) || /media\.redgifs\.com/i.test(node)) urls.push(node);
                        return;
                      }
                      if (typeof node !== "object") return;
                      for (const v of Object.values(node)) scan(v, depth + 1);
                    };
                    scan(parsed);
                    for (const u of urls) redditHintUrls.add(stripByteRangeParams(u));
                  } catch {}
                }
              }
            }
          } catch {
            // ignore individual response parse errors
          }
        });

        await gotoWithInstagram429Retry(
          page,
          targetUrl,
          isInstagramTarget,
          log,
          instagram429CooldownMs
        );
        // best-effort: clear any blocking popups before waiting for media
        await dismissPopups(page, log).catch(() => {});
        const pageReadyMessage = `Target page ${index + 1}/${parsed.inputUrls.length} is open. If needed, log in and ensure media is visible.`;
        if (autoContinuePrompts) {
          await waitForAutoCaptureWindow(
            page,
            () => ({ mediaCount: networkVideos.size, lastMediaSignalAt }),
            pageReadyMessage,
            log
          );
        } else {
          await waitForEnter(pageReadyMessage, { log });
        }
        // one more pass after capture window
        await dismissPopups(page, log).catch(() => {});

        if (!isInstagramTarget) {
          await page.evaluate(async () => {
            window.scrollTo(0, document.body.scrollHeight / 2);
            await new Promise((r) => setTimeout(r, 800));
            window.scrollTo(0, document.body.scrollHeight);
            await new Promise((r) => setTimeout(r, 800));
            window.scrollTo(0, 0);
          });
        }

        // For reddit, actively fetch .json to determine video vs photo and collect hints
        if (isRedditTarget && redditPostId) {
          try {
            const jsonText = await page.evaluate(async (postUrl) => {
              const jurl = postUrl.replace(/\/+$/, "") + ".json";
              try {
                const resp = await fetch(jurl, { credentials: "include" });
                if (!resp.ok) return "";
                const txt = await resp.text();
                return txt.slice(0, 5_000_000);
              } catch {
                return "";
              }
            }, targetUrl);
            if (jsonText) {
              const hints = extractRedditMediaHintsFromJsonText(jsonText, redditPostId);
              if (hints.isVideo === false) redditIsVideoPost = false;
              else if (hints.urls.length || hints.redgifsIds.length) redditIsVideoPost = true;
              for (const u of hints.urls) redditHintUrls.add(stripByteRangeParams(u));
              for (const id of hints.redgifsIds) redditRedgifsIds.add(id);
              const imgHints = extractRedditImageHintsFromJsonText(jsonText, redditPostId);
              for (const u of imgHints.imageUrls) redditImageHintUrls.add(stripByteRangeParams(u));
              if (hints.isVideo === false && !imgHints.imageUrls.length) log(`Reddit .json indicates photo-only for ${redditPostId}`);
              else log(`Reddit .json hints: ${hints.urls.length} url(s), ${hints.redgifsIds.length} redgifs, ${imgHints.imageUrls.length} photo(s)`);
            }
          } catch {}
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

        const instagramFocusedDomVideos = isInstagramTarget
          ? await page.evaluate(() => {
              const videos = Array.from(document.querySelectorAll("video"));
              const viewportWidth = window.innerWidth || 1;
              const viewportHeight = window.innerHeight || 1;
              const viewportArea = viewportWidth * viewportHeight;
              const centerX = viewportWidth / 2;
              const centerY = viewportHeight / 2;

              const abs = (u) => {
                try {
                  return new URL(u, location.href).href;
                } catch {
                  return "";
                }
              };

              const scored = [];

              for (const el of videos) {
                const rawUrl = el.currentSrc || el.src || el.getAttribute("src") || "";
                const url = abs(rawUrl);
                if (!url) continue;

                const rect = el.getBoundingClientRect();
                const width = Math.max(0, rect.width);
                const height = Math.max(0, rect.height);
                if (!width || !height) continue;

                const ix = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
                const iy = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
                const visibleArea = ix * iy;
                if (!visibleArea) continue;

                const elCenterX = rect.left + rect.width / 2;
                const elCenterY = rect.top + rect.height / 2;
                const dist = Math.hypot(elCenterX - centerX, elCenterY - centerY);

                const visibleRatio = visibleArea / Math.max(1, width * height);
                const viewportCoverage = visibleArea / Math.max(1, viewportArea);

                let score = visibleArea;
                score += visibleRatio * 2_000_000;
                score += viewportCoverage * 4_000_000;
                score -= dist * 500;
                if (!el.paused && !el.ended) score += 5_000_000;
                if (el.autoplay) score += 500_000;

                scored.push({ url, score });
              }

              scored.sort((a, b) => b.score - a.score);
              return Array.from(new Set(scored.map((entry) => entry.url))).slice(0, 3);
            })
          : [];

        if (isInstagramTarget) {
          for (const value of instagramFocusedDomVideos) {
            const cleaned = stripByteRangeParams(value);
            if (!cleaned) continue;
            instagramTargetHintUrls.add(cleaned);
            const assetId = getInstagramAssetId(cleaned);
            if (assetId) instagramTargetHintAssetIds.add(assetId);
          }

          log(
            `Instagram target hints: ${instagramTargetHintUrls.size} URL(s), ${instagramTargetHintAssetIds.size} asset id(s)`
          );
        }

        let xhamsterData = { urls: [], qualityByUrl: new Map() };
        if (isXhamsterTarget) {
          xhamsterData = await extractXhamsterMediaData(page);
        }

        let pornhubData = { urls: [], qualityByUrl: new Map() };
        if (isPornhubTarget) {
          pornhubData = await extractPornhubMediaData(page);
        }

        let extractedXvideosUrls = [];
        try {
          const current = new URL(targetUrl);
          if (/(^|\.)xvideos\.com$/i.test(current.hostname)) {
            extractedXvideosUrls = await extractXvideosMediaUrls(page);
          }
        } catch {
          extractedXvideosUrls = [];
        }

        // Reddit specific extraction (video/GIF + photos)
        let redditData = { urls: [], redgifsIds: [], imageUrls: [] };
        let redgifsResolvedUrls = [];
        let redditOrderedImages = [];
        let instagramOrderedImages = [];
        if (isRedditTarget) {
          try {
            redditData = await extractRedditMediaData(page);
            for (const id of redditData.redgifsIds || []) {
              if (redditRedgifsIds.has(id)) continue;
              redditRedgifsIds.add(id);
            }
            for (const u of redditData.imageUrls || []) {
              const cleaned = stripByteRangeParams(u);
              if (cleaned && !redditImageHintUrls.has(cleaned)) redditImageHintUrls.add(cleaned);
            }
          } catch {}
          // merge intercepted hints
          for (const u of redditHintUrls) redditData.urls.push(u);
          for (const id of redditRedgifsIds) if (!redditData.redgifsIds.includes(id)) redditData.redgifsIds.push(id);
          // resolve redgifs ids to direct mp4/m3u8 via API (server-side with token)
          for (const rid of redditData.redgifsIds.slice(0, 5)) {
            try {
              const resolved = await fetchRedgifsDirectUrlsViaApi(rid, log);
              for (const rurl of resolved) {
                const cleaned = stripByteRangeParams(rurl);
                if (cleaned && !redgifsResolvedUrls.includes(cleaned)) redgifsResolvedUrls.push(cleaned);
              }
              // fallback: also try page-evaluate method if API failed
              if (!resolved.length) {
                const fallback = await fetchRedgifsMediaUrls(page, rid).catch(() => []);
                for (const rurl of fallback) {
                  const cleaned = stripByteRangeParams(rurl);
                  if (cleaned && !redgifsResolvedUrls.includes(cleaned)) redgifsResolvedUrls.push(cleaned);
                }
              }
            } catch {}
          }
          // ordered photos: JSON gallery order first (insertion order of redditImageHintUrls),
          // deduped by basename (i.redd.it direct wins over preview.redd.it variant)
          redditOrderedImages = dedupeRedditPhotos(
            Array.from(redditImageHintUrls).filter((u) => isPhotoUrl(u))
          );
          log(`Reddit hints: ${redditData.urls.length} URL(s), ${redditData.redgifsIds.length} redgifs id(s), ${redgifsResolvedUrls.length} resolved, ${redditOrderedImages.length} photo(s)`);
        }

        // Instagram photos: JSON hints (display_url, sidecar order) win when present;
        // otherwise meta cover + DOM fallback (deduped, cover first)
        if (isInstagramTarget) {
          let metaPhotos = [];
          let domPhotos = [];
          try {
            const photoData = await extractInstagramPhotoData(page);
            metaPhotos = (photoData.metaImages || []).filter((u) => isPhotoUrl(u));
            domPhotos = (photoData.imageUrls || []).filter((u) => isPhotoUrl(u));
          } catch {}
          const jsonPhotos = dedupeInstagramPhotos(Array.from(instagramImageHintUrls).filter((u) => isPhotoUrl(u)));
          if (jsonPhotos.length) {
            instagramOrderedImages = jsonPhotos;
          } else {
            instagramOrderedImages = dedupeInstagramPhotos(
              [...metaPhotos, ...domPhotos].map((u) => stripByteRangeParams(u)).filter(Boolean)
            );
          }
          log(`Instagram hints: ${instagramTargetHintUrls.size} video URL(s), ${instagramOrderedImages.length} photo(s)`);
        }

        const allVideos = Array.from(
          new Set([
            ...domVideos,
            ...networkVideos,
            ...extractedXvideosUrls,
            ...xhamsterData.urls,
            ...pornhubData.urls,
            ...(isRedditTarget ? redditData.urls : []),
            ...(isRedditTarget ? redgifsResolvedUrls : []),
          ])
        );
        // Reddit: only skip when neither video/GIF nor photos found
        if (isRedditTarget && redditIsVideoPost === false && !redditOrderedImages.length) {
          log("No media found — photo-only with no downloadable images, skipped.");
          failedTargets.push({ url: targetUrl, reason: "No media found — photo-only with no downloadable images, skipped." });
          continue;
        }
        log(`\n=== Video/Media URLs found for ${targetUrl} ===`);
        if (!allVideos.length && !redditOrderedImages.length && !instagramOrderedImages.length) {
          log("No video media URLs detected.");
          await captureFailureSnapshot(page, targetUrl, "no-video-urls", log);
          failedTargets.push({ url: targetUrl, reason: "No video media URLs detected." });
          continue;
        }
        allVideos.forEach((u, i) => log(`${i + 1}. ${u}`));
        if (redditOrderedImages.length) {
          log(`--- Photos (${redditOrderedImages.length}) ---`);
          redditOrderedImages.forEach((u, i) => log(`p${i + 1}. ${u}`));
        }
        if (instagramOrderedImages.length) {
          log(`--- Instagram photos (${instagramOrderedImages.length}) ---`);
          instagramOrderedImages.forEach((u, i) => log(`ig${i + 1}. ${u}`));
        }

        // For reddit, allow .gif via forceInclude (video/GIF only, photos skipped)
        let forceIncludeForReddit = null;
        if (isRedditTarget) {
          const gifSet = new Set();
          for (const u of allVideos) {
            if (isGifUrl(u) || /preview\.redd\.it.*format=mp4/i.test(u)) {
              gifSet.add(stripByteRangeParams(u));
            }
          }
          forceIncludeForReddit = gifSet;
        }

        const downloadableUrls = extractDownloadableVideoUrls(allVideos, {
          qualityByUrl: new Map([
            ...xhamsterData.qualityByUrl,
            ...pornhubData.qualityByUrl,
          ]),
          ...(forceIncludeForReddit ? { forceIncludeUrls: forceIncludeForReddit } : {}),
        });
        // For reddit, filter to video/gif only (photos handled separately below)
        let filteredDownloadable = downloadableUrls;
        if (isRedditTarget) {
          filteredDownloadable = downloadableUrls.filter(
            (u) => isLikelyVideoUrl(u) || isGifUrl(u) || /preview\.redd\.it.*format=mp4/i.test(u)
          );
          if (filteredDownloadable.length !== downloadableUrls.length) {
            log(`Reddit video/GIF filter: ${filteredDownloadable.length}/${downloadableUrls.length} kept`);
          }
        }
        if (!filteredDownloadable.length && !(isRedditTarget && redditOrderedImages.length) && !(isInstagramTarget && instagramOrderedImages.length)) {
          log("\nNo downloadable direct or stream URL found.");
          await captureFailureSnapshot(page, targetUrl, "no-downloadable-url", log);
          failedTargets.push({ url: targetUrl, reason: "No downloadable direct or stream URL found." });
          continue;
        }
        // replace downloadableUrls with filtered for reddit
        const downloadableUrlsForFlow = isRedditTarget ? filteredDownloadable : downloadableUrls;

        const maxQuality = Number(parsed.maxQuality || 0);
        const qualityCappedUrls = !isInstagramTarget
          ? applyMaxQualityLimit(downloadableUrlsForFlow, maxQuality)
          : downloadableUrlsForFlow;

        if (!qualityCappedUrls.length && !(isRedditTarget && redditOrderedImages.length) && !(isInstagramTarget && instagramOrderedImages.length)) {
          log(`\nNo downloadable media URL found at or below ${maxQuality}p.`);
          await captureFailureSnapshot(page, targetUrl, `no-url-below-${maxQuality}p`, log);
          failedTargets.push({
            url: targetUrl,
            reason: `No downloadable media URL at or below ${maxQuality}p.`,
          });
          continue;
        }

        if (!isInstagramTarget && maxQuality > 0 && qualityCappedUrls.length !== downloadableUrlsForFlow.length) {
          log(
            `Applying non-Instagram max quality cap: ${maxQuality}p (${qualityCappedUrls.length}/${downloadableUrlsForFlow.length} candidate URLs kept)`
          );
        }

        if (parsed.linkOnly) {
          log(`\n=== Downloadable media links for ${targetUrl} ===`);
          qualityCappedUrls.forEach((u, i) => log(`${i + 1}. ${u}`));
          if (isRedditTarget && redditOrderedImages.length) {
            log(`--- Photo links (${redditOrderedImages.length}) ---`);
            redditOrderedImages.forEach((u, i) => log(`p${i + 1}. ${u}`));
          }
          if (isInstagramTarget && instagramOrderedImages.length) {
            log(`--- Instagram photo links (${instagramOrderedImages.length}) ---`);
            instagramOrderedImages.forEach((u, i) => log(`ig${i + 1}. ${u}`));
          }
          continue;
        }

        const userAgent = await page.evaluate(() => navigator.userAgent);
        const requestOrigin = (() => {
          try {
            return new URL(targetUrl).origin;
          } catch {
            return "";
          }
        })();
        const buildDownloadHeaders = async (candidateUrl) => {
          const [pageCookies, candidateCookies] = await Promise.all([
            page.cookies().catch(() => []),
            page.cookies(candidateUrl).catch(() => []),
          ]);

          const cookieByName = new Map();
          for (const cookie of pageCookies) {
            if (!cookie || !cookie.name) continue;
            cookieByName.set(cookie.name, cookie.value);
          }
          for (const cookie of candidateCookies) {
            if (!cookie || !cookie.name) continue;
            cookieByName.set(cookie.name, cookie.value);
          }

          // For redgifs, reddit referer causes 403 — use redgifs origin
          const isRedgifsCandidate = /redgifs\.com/i.test(String(candidateUrl || ""));
          const headers = {
            "user-agent": userAgent,
            referer: isRedgifsCandidate ? "https://www.redgifs.com/" : targetUrl,
          };
          if (isRedgifsCandidate) {
            headers.origin = "https://www.redgifs.com";
          } else if (requestOrigin) {
            headers.origin = requestOrigin;
          }

          const cookieHeader = Array.from(cookieByName.entries())
            .map(([name, value]) => `${name}=${value}`)
            .join("; ");
          if (cookieHeader) headers.cookie = cookieHeader;

          return headers;
        };

        let filePrefix = "media";
        if (!isInstagramTarget && !isRedditTarget) {
          const title = await page.evaluate(() => document.title || "");
          const normalized = sanitizeFileToken(title) || "media";
          filePrefix = normalized;
        }
        if (isInstagramTarget) {
          const username =
            instagramUsernameFromApi ||
            (await getInstagramUsernameFromOembed(page, targetUrl)) ||
            (await getInstagramUsername(page));
          const postId = instagramShortcode || "post";
          filePrefix = username ? `${username}-${postId}` : `instagram-${postId}`;
        }
        if (isRedditTarget) {
          const title = await page.evaluate(() => document.title || "");
          let subreddit = "";
          try {
            const u = new URL(targetUrl);
            const m = u.pathname.match(/\/r\/([^/]+)\//i);
            if (m) subreddit = sanitizeFileToken(m[1]);
          } catch {}
          const postIdPart = redditPostId || "post";
          const titleToken = sanitizeFileToken(title).slice(0, 30);
          if (subreddit) filePrefix = `${subreddit}-${postIdPart}`;
          else if (titleToken) filePrefix = `${titleToken}-${postIdPart}`;
          else filePrefix = `reddit-${postIdPart}`;
        }

        let result = null;
        let lastError = null;
        let selectedCandidate = "";
        let selectedAssetId = "";

        const primaryCandidates = isInstagramTarget
          ? prioritizeInstagramCandidates(
              filterInstagramCandidatesForTarget(
                qualityCappedUrls.filter((u) => !isInstagramAudioOnlyUrl(u)),
                instagramTargetHintUrls,
                instagramTargetHintAssetIds
              ),
              domVideos
            )
          : isXhamsterTarget
            ? prioritizeXhamsterCandidates(qualityCappedUrls, xhamsterData.qualityByUrl)
            : isRedditTarget
              ? prioritizeRedditCandidates(qualityCappedUrls)
              : qualityCappedUrls;

        let candidatesToTry = primaryCandidates.length ? primaryCandidates : qualityCappedUrls;

        if (isInstagramTarget && primaryCandidates.length) {
          const audioCandidates = qualityCappedUrls.filter((u) => isInstagramAudioOnlyUrl(u));
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

        const downloadedFiles = [];
        // Photo post with no target-scoped video hints: video candidates are
        // unscoped page chrome (clips rail) — skip video, download photos only.
        // A centered playing DOM video still counts as the post itself.
        if (
          isInstagramTarget &&
          instagramOrderedImages.length &&
          !instagramTargetHintUrls.size &&
          !instagramFocusedDomVideos.length
        ) {
          log("Instagram photo post — skipping unscoped video candidates.");
          candidatesToTry = [];
        }
        if (candidatesToTry.length) {
          for (const candidate of candidatesToTry) {
            try {
              const headers = await buildDownloadHeaders(candidate);

              try {
                result = await downloadMedia(
                  candidate,
                  outputDir,
                  headers,
                  filePrefix,
                  {
                    includeTimestamp: !isInstagramTarget && !isRedditTarget,
                    onProgress: (p) => onProgress({ ...p, stage: p.stage || "downloading", candidate }),
                  }
                );
              } catch (err) {
                if (isInstagramTarget && isInstagram429Error(err)) {
                  log(`Instagram media request hit 429 for candidate ${candidate}.`);
                  await waitForInstagram429Cooldown(log, instagram429CooldownMs);
                  throw createInstagram429CooldownError("Instagram responded with 429. Suspending this run; retry later.");
                }
                throw err;
              }

              selectedCandidate = candidate;
              selectedAssetId = getInstagramAssetId(candidate);
              break;
            } catch (err) {
              lastError = err;
            }
          }
        }

        // Reddit photos: download each as filePrefix-001, -002, ... (gallery order)
        let photoResults = [];
        if (isRedditTarget && redditOrderedImages.length) {
          log(`\nDownloading ${redditOrderedImages.length} photo(s) as ${filePrefix}-001...`);
          for (let pi = 0; pi < redditOrderedImages.length; pi += 1) {
            const photoUrl = redditOrderedImages[pi];
            const numberedPrefix = `${filePrefix}-${String(pi + 1).padStart(3, "0")}`;
            try {
              const headers = await buildDownloadHeaders(photoUrl);
              const photoResult = await downloadMedia(
                photoUrl,
                outputDir,
                headers,
                numberedPrefix,
                {
                  includeTimestamp: false,
                  onProgress: (p) => onProgress({ ...p, stage: p.stage || "downloading", candidate: photoUrl }),
                }
              );
              photoResults.push(photoResult);
              log(`\nDownloaded media to: ${photoResult.filePath}`);
              log(`Source URL: ${photoResult.url}`);
            } catch (err) {
              lastError = err;
              log(`Photo ${pi + 1}/${redditOrderedImages.length} failed: ${err.message}`);
            }
          }
          if (photoResults.length) {
            for (const pr of photoResults) downloadedFiles.push(pr);
            // result points at last photo so single-result consumers still work;
            // all files are logged individually above
            if (!result) {
              result = photoResults[photoResults.length - 1];
              selectedCandidate = "";
            }
          }
        }

        // Instagram photos: download each as filePrefix-001, -002, ... (sidecar order)
        if (isInstagramTarget && instagramOrderedImages.length) {
          log(`\nDownloading ${instagramOrderedImages.length} Instagram photo(s) as ${filePrefix}-001...`);
          for (let pi = 0; pi < instagramOrderedImages.length; pi += 1) {
            const photoUrl = instagramOrderedImages[pi];
            const numberedPrefix = `${filePrefix}-${String(pi + 1).padStart(3, "0")}`;
            try {
              const headers = await buildDownloadHeaders(photoUrl);
              const photoResult = await downloadMedia(
                photoUrl,
                outputDir,
                headers,
                numberedPrefix,
                {
                  includeTimestamp: false,
                  onProgress: (p) => onProgress({ ...p, stage: p.stage || "downloading", candidate: photoUrl }),
                }
              );
              photoResults.push(photoResult);
              log(`\nDownloaded media to: ${photoResult.filePath}`);
              log(`Source URL: ${photoResult.url}`);
            } catch (err) {
              lastError = err;
              log(`Instagram photo ${pi + 1}/${instagramOrderedImages.length} failed: ${err.message}`);
            }
          }
          if (photoResults.length) {
            for (const pr of photoResults) {
              if (!downloadedFiles.includes(pr)) downloadedFiles.push(pr);
            }
            if (!result) {
              result = photoResults[photoResults.length - 1];
              selectedCandidate = "";
            }
          }
        }

        if (!result) {
          await captureFailureSnapshot(page, targetUrl, "download-failed", log);
          throw new Error(
            `Failed to download from ${qualityCappedUrls.length} candidate URLs${redditOrderedImages.length ? ` + ${redditOrderedImages.length} photo(s)` : ""}${instagramOrderedImages.length ? ` + ${instagramOrderedImages.length} Instagram photo(s)` : ""}. Last error: ${
              lastError ? lastError.message : "unknown"
            }`
          );
        }

        if (isInstagramTarget) {
          const audioCandidates = qualityCappedUrls.filter((u) => isInstagramAudioOnlyUrl(u));
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
                  const headers = await buildDownloadHeaders(candidate);
                  audioResult = await downloadMedia(candidate, tempDir, headers, "audio");
                  break;
                } catch (err) {
                  if (isInstagram429Error(err)) {
                    log("Instagram media request hit 429 while fetching companion audio.");
                    await waitForInstagram429Cooldown(log, instagram429CooldownMs);
                    throw createInstagram429CooldownError(
                      "Instagram responded with 429. Suspending this run; retry later."
                    );
                  }
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
              log("\nffmpeg not found; downloaded video-only stream.");
            }
          }
        }

        const resultWasPhotoLogged = Boolean(
          photoResults.length && result && photoResults.some((pr) => pr.filePath === result.filePath)
        );
        if ((isRedditTarget || isInstagramTarget) && photoResults.length && result && !resultWasPhotoLogged) {
          // video + photos: video result not logged yet
          log(`\nDownloaded media to: ${result.filePath}`);
          log(`Source URL: ${result.url}`);
          log(`Downloaded ${photoResults.length} photo(s) as ${filePrefix}-001... (logged individually above)`);
        } else if (!resultWasPhotoLogged) {
          log(`\nDownloaded media to: ${result.filePath}`);
          log(`Source URL: ${result.url}`);
        } else if (photoResults.length > 1) {
          log(`Downloaded ${photoResults.length} photo(s) for ${targetUrl}`);
        }
      } finally {
        await page.close().catch(() => {});
      }
    }

    if (waitForCompletionPrompt) {
      await waitForEnter("Run complete.", { log });
    } else {
      log("Run complete.");
    }
  } finally {
    if (!hasExternalBrowser) {
      await browser.close().catch(() => {});
    }
  }

  return { urls: parsed.inputUrls, failedTargets };
}

module.exports = {
  parseCliArgs,
  run,
};
