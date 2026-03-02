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

async function waitForAutoCaptureWindow(page, getNetworkState, logLabel) {
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
      console.log(
        `${logLabel} (auto-proceed after media settled: signals=${signalCount}, quiet=${quietForMs}ms)`
      );
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  console.log(`${logLabel} (auto-proceed after timeout)`);
}

async function run() {
  const rawArgs = process.argv
    .slice(2)
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const linkOnly = rawArgs.includes("--link-only");
  const args = rawArgs.filter((arg) => arg !== "--link-only");

  if (!args.length) {
    throw new Error(
      "Usage: node scan-videos.js [--link-only] <url1> [url2 ...] OR node scan-videos.js open-browser"
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
    const vncHint =
      process.env.ENABLE_VNC === "1"
        ? " Open http://localhost:7901/vnc.html to control the browser."
        : "";
    await waitForEnter(`Browser is open on google.com. Use it to log in anywhere you want.${vncHint}`, {
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
          console.log("Using Instagram mobile browser agent profile.");
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

      await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 60000 });
      const pageReadyMessage = `Target page ${index + 1}/${inputUrls.length} is open. If needed, log in and ensure media is visible.`;
      if (shouldAutoContinuePrompts()) {
        await waitForAutoCaptureWindow(
          page,
          () => ({ mediaCount: networkVideos.size, lastMediaSignalAt }),
          pageReadyMessage
        );
      } else {
        await waitForEnter(pageReadyMessage);
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

        console.log(
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
      console.log(`\n=== Video/Media URLs found for ${targetUrl} ===`);
      if (!allVideos.length) {
        console.log("No video media URLs detected.");
        continue;
      }
      allVideos.forEach((u, i) => console.log(`${i + 1}. ${u}`));

      const downloadableUrls = extractDownloadableVideoUrls(allVideos, {
        qualityByUrl: new Map([
          ...xhamsterData.qualityByUrl,
          ...pornhubData.qualityByUrl,
        ]),
      });
      if (!downloadableUrls.length) {
        console.log("\nNo downloadable direct or stream URL found.");
        continue;
      }

      if (linkOnly) {
        console.log(`\n=== Downloadable media links for ${targetUrl} ===`);
        downloadableUrls.forEach((u, i) => console.log(`${i + 1}. ${u}`));
        continue;
      }

      const userAgent = await page.evaluate(() => navigator.userAgent);
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
        if (username) filePrefix = username;
      }

      let result = null;
      let lastError = null;
      let selectedCandidate = "";
      let selectedAssetId = "";

      const primaryCandidates = isInstagramTarget
        ? prioritizeInstagramCandidates(
            filterInstagramCandidatesForTarget(
              downloadableUrls.filter((u) => !isInstagramAudioOnlyUrl(u)),
              instagramTargetHintUrls,
              instagramTargetHintAssetIds
            ),
            domVideos
          )
        : isXhamsterTarget
          ? prioritizeXhamsterCandidates(downloadableUrls, xhamsterData.qualityByUrl)
          : downloadableUrls;

      let candidatesToTry = primaryCandidates.length ? primaryCandidates : downloadableUrls;

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
}

module.exports = {
  run,
};
