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
  extractQualityHint,
  sanitizeFileToken,
} = require("./media-utils");
const {
  extractInstagramShortcode,
  extractInstagramUsernameFromJsonText,
  extractInstagramMediaHintsFromJsonText,
  filterInstagramCandidatesForTarget,
} = require("./instagram-utils");
const {
  extractXhamsterMediaData,
  extractXvideosMediaUrls,
  extractPornhubMediaData,
  getInstagramUsername,
  getInstagramUsernameFromOembed,
} = require("./extractors");
const {
  hasFfmpeg,
  muxVideoAndAudio,
  mediaHasAudio,
  downloadMedia,
} = require("./download");

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

  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 30000;
  const quietMs = Number.isFinite(quietRaw) && quietRaw > 0 ? quietRaw : 1800;
  const pollMs = Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : 250;
  const startedAt = Date.now();

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
  const response = await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 60000 });
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
    await page.goto("https://www.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const accountMsg = parsed.account ? ` (account: ${parsed.account})` : "";
    const vncHint =
      process.env.ENABLE_VNC === "1"
        ? " Open http://localhost:7901/vnc.html to control the browser."
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

      const instagramShortcode = isInstagramTarget
        ? extractInstagramShortcode(targetUrl)
        : "";

      const page = await browser.newPage();

      try {
        if (isInstagramTarget) {
          const instagramUA = getInstagramUserAgent();
          if (instagramUA) {
            await page.setUserAgent(instagramUA);
            await page.setExtraHTTPHeaders({
              "accept-language": "en-US,en;q=0.9",
            });
            await page.setViewport({
              width: 430,
              height: 932,
              isMobile: true,
              hasTouch: true,
              deviceScaleFactor: 3,
            });
            log("Using Instagram mobile browser agent profile.");
          }
        }

        const networkVideos = new Set();
        let lastMediaSignalAt = Date.now();
        let instagramUsernameFromApi = "";
        const instagramTargetHintUrls = new Set();
        const instagramTargetHintAssetIds = new Set();

        page.on("response", async (response) => {
          try {
            const url = response.url();
            const headers = response.headers();
            const contentType = (headers["content-type"] || "").toLowerCase();

            if (contentType.startsWith("video/") || isLikelyVideoUrl(url)) {
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

        const allVideos = Array.from(
          new Set([
            ...domVideos,
            ...networkVideos,
            ...extractedXvideosUrls,
            ...xhamsterData.urls,
            ...pornhubData.urls,
          ])
        );
        log(`\n=== Video/Media URLs found for ${targetUrl} ===`);
        if (!allVideos.length) {
          log("No video media URLs detected.");
          failedTargets.push({ url: targetUrl, reason: "No video media URLs detected." });
          continue;
        }
        allVideos.forEach((u, i) => log(`${i + 1}. ${u}`));

        const downloadableUrls = extractDownloadableVideoUrls(allVideos, {
          qualityByUrl: new Map([
            ...xhamsterData.qualityByUrl,
            ...pornhubData.qualityByUrl,
          ]),
        });
        if (!downloadableUrls.length) {
          log("\nNo downloadable direct or stream URL found.");
          failedTargets.push({ url: targetUrl, reason: "No downloadable direct or stream URL found." });
          continue;
        }

        const maxQuality = Number(parsed.maxQuality || 0);
        const qualityCappedUrls = !isInstagramTarget
          ? applyMaxQualityLimit(downloadableUrls, maxQuality)
          : downloadableUrls;

        if (!qualityCappedUrls.length) {
          log(`\nNo downloadable media URL found at or below ${maxQuality}p.`);
          failedTargets.push({
            url: targetUrl,
            reason: `No downloadable media URL at or below ${maxQuality}p.`,
          });
          continue;
        }

        if (!isInstagramTarget && maxQuality > 0 && qualityCappedUrls.length !== downloadableUrls.length) {
          log(
            `Applying non-Instagram max quality cap: ${maxQuality}p (${qualityCappedUrls.length}/${downloadableUrls.length} candidate URLs kept)`
          );
        }

        if (parsed.linkOnly) {
          log(`\n=== Downloadable media links for ${targetUrl} ===`);
          qualityCappedUrls.forEach((u, i) => log(`${i + 1}. ${u}`));
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

          const headers = {
            "user-agent": userAgent,
            referer: targetUrl,
          };
          if (requestOrigin) headers.origin = requestOrigin;

          const cookieHeader = Array.from(cookieByName.entries())
            .map(([name, value]) => `${name}=${value}`)
            .join("; ");
          if (cookieHeader) headers.cookie = cookieHeader;

          return headers;
        };

        let filePrefix = "media";
        if (!isInstagramTarget) {
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

        for (const candidate of candidatesToTry) {
          try {
            const headers = await buildDownloadHeaders(candidate);

            try {
              result = await downloadMedia(
                candidate,
                outputDir,
                headers,
                filePrefix,
                { includeTimestamp: !isInstagramTarget }
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

        if (!result) {
          throw new Error(
            `Failed to download from ${qualityCappedUrls.length} candidate URLs. Last error: ${
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

        log(`\nDownloaded media to: ${result.filePath}`);
        log(`Source URL: ${result.url}`);
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
