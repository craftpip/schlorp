const fs = require("fs/promises");
const path = require("path");
const { createWriteStream } = require("fs");
const { pipeline } = require("stream/promises");
const { Readable, Transform } = require("stream");
const { promisify } = require("util");
const { execFile } = require("child_process");
const {
  stripByteRangeParams,
  isStreamingManifestUrl,
  extractQualityHint,
  sanitizeFileToken,
} = require("./media-utils");

const execFileAsync = promisify(execFile);

const DOWNLOAD_FETCH_TIMEOUT_MS = parsePositiveIntEnv("DOWNLOAD_FETCH_TIMEOUT_MS", 300000);
const FFMPEG_TIMEOUT_MS = parsePositiveIntEnv("FFMPEG_TIMEOUT_MS", 900000);
const FFPROBE_TIMEOUT_MS = parsePositiveIntEnv("FFPROBE_TIMEOUT_MS", 120000);

function parsePositiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// Extension chosen from what the server actually sent, not the URL:
// Reddit preview URLs end in `.gif` while returning MP4 bytes (and vice versa).
const VIDEO_EXTS = new Set([
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "3gp", "flv", "ts", "m2ts", "wmv", "ogv",
]);

function posterPathFor(videoPath) {
  return path.extname(videoPath)
    ? videoPath.replace(/\.[a-z0-9]+$/i, "-poster.jpg")
    : `${videoPath}-poster.jpg`;
}

const POSTER_SIBLING_RE = /^(.*)-poster\.(jpe?g|png|webp|avif|gif)$/i;

// Stem of a file name (extension stripped) — "<video>-poster.jpg" pair key.
function posterStemOf(name) {
  return String(name || "").replace(/\.[^.]+$/, "");
}

function isVideoFileName(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  return VIDEO_EXTS.has(ext);
}

// Decide which videos in a directory listing get a poster frame:
// - "missing": only videos whose stem has no `<stem>-poster.*` sibling.
// - "all": every video (existing posters are regenerated).
// Pure (no ffmpeg/fs) so it can be unit-tested. Returns { targets, skipped }.
function selectPosterTargets(names, mode) {
  const videos = (names || []).filter(isVideoFileName).sort();
  const posterStems = new Set();
  for (const n of names || []) {
    const m = POSTER_SIBLING_RE.exec(n);
    if (m) posterStems.add(m[1].toLowerCase());
  }
  const targets = [];
  const skipped = [];
  for (const name of videos) {
    if (mode === "missing" && posterStems.has(posterStemOf(name).toLowerCase())) skipped.push(name);
    else targets.push(name);
  }
  return { targets, skipped };
}

// Best-effort: extract a representative frame next to the video as
// `<stem>-poster.jpg`. Never throws — a failed thumbnail is not a failed download.
// `overwrite: true` re-extracts even when a poster already exists (ffmpeg `-y`).
async function generatePosterThumbnail(videoPath, { overwrite = false } = {}) {
  try {
    const ext = path.extname(videoPath).slice(1).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) return null;
    if (!(await hasFfmpeg())) return null;
    const posterPath = posterPathFor(videoPath);
    if (posterPath === videoPath) return null;
    try { await fs.access(posterPath); if (!overwrite) return posterPath; } catch {}

    // Thumbnail frame timestamp: the exact middle of the video (t = duration/2).
    const durationSeconds = await probeDurationSeconds(videoPath);
    const seekMs = Number.isFinite(durationSeconds) ? (durationSeconds * 1000) / 2 : 0;

    const args = ["-y"];
    if (seekMs > 0) args.push("-i", videoPath, "-ss", String(seekMs / 1000));
    else args.push("-i", videoPath);
    args.push("-vf", "scale=320:-2", "-frames:v", "1", "-q:v", "2", posterPath);
    await execFileAsync("ffmpeg", args, { timeout: 60000 });
    return posterPath;
  } catch {
    return null;
  }
}

async function probeDurationSeconds(filePath) {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      { timeout: FFPROBE_TIMEOUT_MS }
    );
    const duration = Number(String(stdout || "").trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

const CONTENT_TYPE_EXT = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/flac": "flac",
};

function extFromContentType(value) {
  const mime = String(value || "").split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE_EXT[mime] || "";
}

// Magic-byte sniff of the actual payload (content-type headers lie too).
function sniffMediaKind(buffer) {
  if (!buffer || buffer.length < 10) return "";
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("latin1") === "ftyp") return "mp4";
  const head6 = buffer.subarray(0, 6).toString("latin1");
  if (head6 === "GIF87a" || head6 === "GIF89a") return "gif";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e &&
    buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a &&
    buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return "png";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) return "webp";
  return "";
}

function gifDimensions(buffer) {
  try {
    if (!buffer || buffer.length < 10) return null;
    const head = buffer.subarray(0, 6).toString("latin1");
    if (head !== "GIF87a" && head !== "GIF89a") return null;
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  } catch {
    return null;
  }
}

async function readHead(filePath, length) {
  let handle = null;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function createAbortControllerWithTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    controller,
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function fetchWithTimeout(url, options, timeoutMs, operationLabel) {
  const { signal, clear } = createAbortControllerWithTimeout(timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal,
    });
    return { response, signal, clear };
  } catch (error) {
    const isAbortError = error && (error.name === "AbortError" || error.code === "ABORT_ERR");
    if (isAbortError) {
      throw new Error(`${operationLabel} timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
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
  try {
    await execFileAsync(
      "ffmpeg",
      [
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
      ],
      { timeout: FFMPEG_TIMEOUT_MS }
    );
  } catch (error) {
    if (error && error.killed && error.signal === "SIGTERM") {
      throw new Error(`ffmpeg mux timed out after ${FFMPEG_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

function buildOutputFilePath(outDir, filePrefix, ext, options = {}) {
  const includeTimestamp =
    typeof options.includeTimestamp === "boolean" ? options.includeTimestamp : true;
  const safePrefix = sanitizeFileToken(filePrefix) || "media";
  const filename = includeTimestamp ? `${safePrefix}-${Date.now()}.${ext}` : `${safePrefix}.${ext}`;
  return path.join(outDir, filename);
}

async function downloadStreamingManifest(url, outDir, headers = {}, filePrefix = "media", options = {}) {
  if (!(await hasFfmpeg())) {
    throw new Error("ffmpeg is required to download HLS/DASH streams (.m3u8/.mpd)");
  }

  const finalInputUrl = await (async () => {
    if (!/\.m3u8(\?|$)/i.test(url)) return url;

    try {
      const { response, clear } = await fetchWithTimeout(
        url,
        {
          method: "GET",
          redirect: "follow",
          headers,
        },
        DOWNLOAD_FETCH_TIMEOUT_MS,
        "Manifest request"
      );

      try {
        if (!response.ok) return url;
        const manifestText = await response.text();
        if (!manifestText.includes("#EXTM3U")) return url;

        const lines = manifestText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);

        let bestUrl = "";
        let bestScore = -1;

        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

          const attrsText = line.slice("#EXT-X-STREAM-INF:".length);
          const attrs = {};
          const attrRegex = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/g;
          let match;
          while ((match = attrRegex.exec(attrsText))) {
            attrs[match[1]] = String(match[2] || "").replace(/^"|"$/g, "");
          }

          let candidate = "";
          for (let j = i + 1; j < lines.length; j += 1) {
            if (!lines[j].startsWith("#")) {
              candidate = lines[j];
              break;
            }
          }
          if (!candidate) continue;

          let candidateUrl = "";
          try {
            candidateUrl = new URL(candidate, response.url || url).href;
          } catch {
            candidateUrl = "";
          }
          if (!candidateUrl) continue;

          const bandwidth = Number(attrs.BANDWIDTH || 0);
          const averageBandwidth = Number(attrs["AVERAGE-BANDWIDTH"] || 0);
          const effectiveBandwidth = Math.max(bandwidth, averageBandwidth);

          let pixels = 0;
          if (attrs.RESOLUTION) {
            const resMatch = attrs.RESOLUTION.match(/(\d+)x(\d+)/i);
            if (resMatch) {
              pixels = Number(resMatch[1]) * Number(resMatch[2]);
            }
          }

          const qualityHint = extractQualityHint(candidateUrl);
          const score = effectiveBandwidth + pixels + qualityHint * 1_000_000;
          if (score > bestScore) {
            bestScore = score;
            bestUrl = candidateUrl;
          }
        }

        return bestUrl || url;
      } finally {
        clear();
      }
    } catch {
      return url;
    }
  })();

  await fs.mkdir(outDir, { recursive: true });
  const filePath = buildOutputFilePath(outDir, filePrefix, "mp4", options);
  if (typeof options.onProgress === "function") {
    try { options.onProgress({ stage: "downloading", filePath }); } catch {}
  }

  const args = ["-y"];

  if (headers["user-agent"]) {
    args.push("-user_agent", String(headers["user-agent"]));
  }

  if (headers.referer) {
    args.push("-referer", String(headers.referer));
  }

  const passthroughHeaders = ["cookie", "origin"]
    .filter((key) => headers[key])
    .map((key) => `${key}: ${headers[key]}`)
    .join("\r\n");

  if (passthroughHeaders) {
    args.push("-headers", `${passthroughHeaders}\r\n`);
  }

  args.push("-i", finalInputUrl, "-c", "copy", "-movflags", "+faststart", filePath);
  try {
    await execFileAsync("ffmpeg", args, { timeout: FFMPEG_TIMEOUT_MS });
  } catch (error) {
    if (error && error.killed && error.signal === "SIGTERM") {
      throw new Error(`ffmpeg download timed out after ${FFMPEG_TIMEOUT_MS}ms`);
    }
    throw error;
  }

  await generatePosterThumbnail(filePath);

  return { filePath, url: finalInputUrl };
}

function parseM3u8Attributes(attrsText) {
  const attrs = {};
  const attrRegex = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/g;
  let match;
  while ((match = attrRegex.exec(String(attrsText || "")))) {
    attrs[match[1]] = String(match[2] || "").replace(/^"|"$/g, "");
  }
  return attrs;
}

// Pure m3u8 parse: master → best variant URL; media → { segments, keyUri, mapUri }.
// Returns { variantUrl } for master playlists, { segments, keyUri, mapUri } for media.
function parseM3u8Playlist(manifestText, baseUrl) {
  const lines = String(manifestText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || lines[0] !== "#EXTM3U") return { notPlaylist: true };

  const resolve = (candidate) => {
    try {
      return new URL(candidate, baseUrl).href;
    } catch {
      return "";
    }
  };

  // master playlist: pick best EXT-X-STREAM-INF variant
  let bestUrl = "";
  let bestScore = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    let candidate = "";
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].startsWith("#")) {
        candidate = lines[j];
        break;
      }
    }
    if (!candidate) continue;
    const candidateUrl = resolve(candidate);
    if (!candidateUrl) continue;
    const attrs = parseM3u8Attributes(line.slice("#EXT-X-STREAM-INF:".length));
    const bandwidth = Number(attrs.BANDWIDTH || 0);
    const averageBandwidth = Number(attrs["AVERAGE-BANDWIDTH"] || 0);
    let pixels = 0;
    if (attrs.RESOLUTION) {
      const resMatch = attrs.RESOLUTION.match(/(\d+)x(\d+)/i);
      if (resMatch) pixels = Number(resMatch[1]) * Number(resMatch[2]);
    }
    const score = Math.max(bandwidth, averageBandwidth) + pixels + extractQualityHint(candidateUrl) * 1_000_000;
    if (score > bestScore) {
      bestScore = score;
      bestUrl = candidateUrl;
    }
  }
  if (bestUrl) return { variantUrl: bestUrl };

  // media playlist
  const segments = [];
  let keyUri = "";
  let keyMethod = "";
  let mapUri = "";
  let pendingDuration = 0;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseM3u8Attributes(line.slice("#EXT-X-KEY:".length));
      keyMethod = String(attrs.METHOD || "").toUpperCase();
      if (keyMethod && keyMethod !== "NONE" && attrs.URI) {
        keyUri = resolve(attrs.URI);
      } else if (keyMethod === "NONE") {
        keyUri = "";
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseM3u8Attributes(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) mapUri = resolve(attrs.URI);
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number(line.slice("#EXTINF:".length).split(",")[0]) || 0;
      continue;
    }
    if (line.startsWith("#")) continue;
    const segUrl = resolve(line);
    if (segUrl) segments.push({ url: segUrl, duration: pendingDuration });
    pendingDuration = 0;
  }
  return { segments, keyUri, keyMethod, mapUri };
}

async function fetchTextViaBrowser(page, url) {
  return fetchTextViaContext(page, url);
}

// ctx is any puppeteer execution context: a Page or a WebWorker (both expose
// .evaluate). Worker fetches carry the same browser TLS/clearance as page
// fetches, which matters for bot-guarded CDNs.
async function fetchTextViaContext(ctx, url) {
  return ctx.evaluate(async (targetUrl) => {
    // credentials: omit — sending page-domain cookies cross-origin to the
    // CDN (e.g. missav.ws cookies to surrit.com) gets the request dropped.
    const resp = await fetch(targetUrl, { credentials: "omit" });
    if (!resp.ok) {
      throw new Error(`Browser fetch failed with status ${resp.status} for ${targetUrl}`);
    }
    return { text: await resp.text(), finalUrl: resp.url || targetUrl };
  }, url);
}

async function fetchBytesViaBrowser(page, urls, concurrency = 6) {
  return fetchBytesViaContext(page, urls, concurrency);
}

async function fetchBytesViaContext(ctx, urls, concurrency = 6) {
  return ctx.evaluate(async (targets, parallel) => {
    const out = new Array(targets.length);
    const fetchOne = async (targetUrl) => {
      try {
        // credentials: omit — see fetchTextViaBrowser.
        const resp = await fetch(targetUrl, { credentials: "omit" });
        if (!resp.ok) return { ok: false, status: resp.status };
        const buffer = await resp.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        // eslint-disable-next-line no-undef
        return { ok: true, b64: btoa(binary) };
      } catch (e) {
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      }
    };
    const workers = Math.max(1, Math.min(parallel || 6, targets.length));
    let next = 0;
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (next < targets.length) {
          const index = next;
          next += 1;
          out[index] = await fetchOne(targets[index]);
        }
      })
    );
    return out;
  }, urls, concurrency);
}

// Bot-guarded HLS (e.g. Cloudflare on surrit.com for MissAV): curl/ffmpeg get
// 403 while the real browser passes. Relay the playlist + segments through
// the page (browser TLS + clearance) and mux locally — ffmpeg never touches
// the network. Works with CloakBrowser and CDP user browsers alike.
const RELAY_BATCH_SIZE = 12;
const RELAY_CONCURRENCY = 8;
const RELAY_BATCH_TIMEOUT_MS = 240000;

function isImageSegmentUrl(url) {
  return /\.(jpe?g|png|webp|avif|bmp|gif)(\?|$)/i.test(String(url || ""));
}

function isManifestUrl(url) {
  const u = String(url || "");
  return /\.(m3u8|mpd)(\?|$)/i.test(u) || /\/(master|playlist|manifest|do2|hls)(\?|$|\/)/i.test(u);
}

// Some players (MissAV/tsyndicate) expose storyboard playlists whose
// "segments" are JPEG strips — downloading those yields a thumbnail
// slideshow, not the video. The real stream is fetched by blob workers;
// discover its manifest (or raw segment URLs) by hooking worker fetch,
// then play/seek so the player requests across the timeline.
async function discoverWorkerManifest(page, log, excludeUrls = []) {
  const excluded = new Set(
    (Array.isArray(excludeUrls) ? excludeUrls : []).map((u) => stripByteRangeParams(String(u || "")))
  );

  const hook = `(${(() => {
    try {
      if (self.__xdlHooked) return "already";
      self.__xdlHooked = true;
      self.__xdlUrls = [];
      const origFetch = self.fetch.bind(self);
      self.fetch = async (...args) => {
        try {
          const u = args[0];
          self.__xdlUrls.push(String((u && u.url) || u || "").slice(0, 300));
          if (self.__xdlUrls.length > 2000) self.__xdlUrls.splice(0, 1000);
        } catch {}
        return origFetch(...args);
      };
      const OrigXHR = self.XMLHttpRequest;
      if (OrigXHR) {
        self.XMLHttpRequest = function (...args) {
          const xhr = new OrigXHR(...args);
          const origOpen = xhr.open.bind(xhr);
          xhr.open = (method, url, ...rest) => {
            try {
              self.__xdlUrls.push(`XHR:${String(url || "").slice(0, 290)}`);
              if (self.__xdlUrls.length > 2000) self.__xdlUrls.splice(0, 1000);
            } catch {}
            return origOpen(method, url, ...rest);
          };
          return xhr;
        };
      }
      return "hooked";
    } catch (e) {
      return `hook-failed: ${String((e && e.message) || e)}`;
    }
  }).toString()})()`;
  const hookTargets = [];
  const hookedWorkers = new Set();
  const hookWorker = async (worker) => {
    if (!worker || hookedWorkers.has(worker)) return;
    hookedWorkers.add(worker);
    try {
      await worker.evaluate(hook);
      hookTargets.push(worker);
    } catch {}
  };
  const collectWorkers = async () => {
    try {
      const current = typeof page.workers === "function" ? page.workers() : [];
      for (const worker of current) await hookWorker(worker);
    } catch {}
  };
  try {
    if (typeof page.evaluate === "function") {
      await page.evaluate(
        `(${((hookBody) => {
          try {
            if (window.__xdlHooked) return "already";
            window.__xdlHooked = true;
            window.__xdlUrls = [];
            const origFetch = window.fetch.bind(window);
            window.fetch = async (...args) => {
              try {
                const u = args[0];
                window.__xdlUrls.push(String((u && u.url) || u || "").slice(0, 300));
              } catch {}
              return origFetch(...args);
            };
            return "hooked";
          } catch (e) {
            return "hook-failed";
          }
        }).toString()})()`
      );
      hookTargets.push(page);
    }
  } catch {}
  await collectWorkers();
  log(`Browser relay: hooked ${hookTargets.length} context(s)`);
  if (!hookTargets.length) return { manifestUrl: "", segmentUrls: [] };

  // force the player to request across the timeline (manifest + segments)
  try {
    const playInfo = await page.evaluate(() => {
      const vids = Array.from(document.querySelectorAll("video"));
      vids.sort((a, b) => (b.videoWidth || 0) - (a.videoWidth || 0));
      const main = vids[0];
      if (!main) return "no-video";
      try { main.muted = true; } catch {}
      try {
        const playPromise = main.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
      } catch {}
      const duration = Number(main.duration);
      if (Number.isFinite(duration) && duration > 60) {
        const fractions = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.93];
        fractions.forEach((fraction, i) => {
          setTimeout(() => {
            try { main.currentTime = duration * fraction; } catch {}
          }, 3000 * (i + 1));
        });
        return `seeking ${duration}s`;
      }
      return `playing w=${main.videoWidth} d=${Number(main.duration)} paused=${main.paused}`;
    });
    log(`Browser relay: player state → ${playInfo}`);
  } catch (err) {
    log(`Browser relay: play attempt failed: ${String((err && err.message) || err).slice(0, 120)}`);
  }

  const readHookUrls = async () => {
    const all = [];
    for (const target of hookTargets) {
      try {
        const urls = await target.evaluate(
          `((Array.isArray(self.__xdlUrls) ? self.__xdlUrls : (Array.isArray(window.__xdlUrls) ? window.__xdlUrls : [])).slice(-2000))`
        );
        if (Array.isArray(urls)) all.push(...urls);
      } catch {}
    }
    return all;
  };

  const deadline = Date.now() + 60000;
  const seenManifests = new Set();
  let bestManifest = "";
  let bestDuration = 0;
  const segmentSamples = new Map(); // template -> Set(sample urls)
  // seed from the engine's CDP network tap (init-time page+worker traffic)
  let tapSeeded = false;
  const templateOf = (url) => {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname.replace(/\d+/g, "#")}`;
    } catch {
      return "";
    }
  };
  const isVideoSegment = (url) =>
    !isImageSegmentUrl(url) && !/\.(js|css|woff2?|ttf|svg|json|xml|txt|html)(\?|$)/i.test(url);

  const scoreManifest = async (cleaned) => {
    try {
      const probe = await fetchTextViaBrowser(page, cleaned);
      const check = parseM3u8Playlist(probe.text, probe.finalUrl || cleaned);
      if (check.variantUrl) {
        // score the VARIANT (media playlist), never the master itself —
        // re-downloading a master loops back to storyboards
        const nested = await fetchTextViaBrowser(page, check.variantUrl);
        const nestedCheck = parseM3u8Playlist(nested.text, nested.finalUrl || check.variantUrl);
        const segs = Array.isArray(nestedCheck.segments) ? nestedCheck.segments : [];
        if (!segs.length) return;
        const imageCount = segs.filter((s) => isImageSegmentUrl(s.url)).length;
        if (imageCount / segs.length > 0.5) {
          log(`Browser relay: skipping storyboard variant ${check.variantUrl.slice(0, 80)}`);
          return;
        }
        const total = segs.reduce((sum, s) => sum + Number(s.duration || 0), 0);
        if (total > bestDuration) {
          bestDuration = total;
          bestManifest = check.variantUrl;
          log(`Browser relay: worker manifest candidate ${check.variantUrl.slice(0, 80)} (~${Math.round(total)}s)`);
        }
        return;
      }
      const segs = Array.isArray(check.segments) ? check.segments : [];
      if (!segs.length) return;
      const imageCount = segs.filter((s) => isImageSegmentUrl(s.url)).length;
      if (segs.length && imageCount / segs.length > 0.5) {
        log(`Browser relay: skipping storyboard playlist ${cleaned.slice(0, 80)}`);
        return;
      }
      const total = segs.reduce((sum, s) => sum + Number(s.duration || 0), 0);
      if (total > bestDuration) {
        bestDuration = total;
        bestManifest = cleaned;
        log(`Browser relay: worker manifest candidate ${cleaned.slice(0, 80)} (~${Math.round(total)}s)`);
      }
    } catch {}
  };

  const noteSegment = (cleaned) => {
    if (!isVideoSegment(cleaned)) return;
    const template = templateOf(cleaned);
    if (!template) return;
    if (!segmentSamples.has(template)) segmentSamples.set(template, new Set());
    segmentSamples.get(template).add(cleaned);
  };

  const pendingManifests = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    // players often spawn streaming workers lazily on play — hook newcomers
    await collectWorkers();
    if (!tapSeeded) {
      tapSeeded = true;
      try {
        const tap = Array.isArray(page.__xdlNetUrls) ? page.__xdlNetUrls : [];
        if (tap.length) log(`Browser relay: network tap has ${tap.length} media URL(s)`);
        if (tap.length) log(`Browser relay: tap sample: ${tap.slice(0, 10).map((u) => String(u).slice(0, 100)).join(" | ")}`);
        try {
          const statusMap = page.__xdlNetStatus || {};
          const withStatus = tap.slice(0, 10).map((u) => {
            const key = String(u);
            const entry = statusMap[key];
            return `${key.slice(0, 60)}→${entry ? entry.status : "?"}`;
          });
          if (withStatus.length) log(`Browser relay: tap status: ${withStatus.join(" | ")}`);
        } catch {}
        for (const raw of tap) {
          const cleaned = stripByteRangeParams(String(raw || ""));
          if (!/^https?:/i.test(cleaned) || excluded.has(cleaned)) continue;
          if (isManifestUrl(cleaned)) {
            if (seenManifests.has(cleaned)) continue;
            seenManifests.add(cleaned);
            pendingManifests.push(cleaned);
          } else {
            noteSegment(cleaned);
          }
        }
      } catch {}
    }
    const urls = await readHookUrls();
      for (const raw of urls) {
        const cleaned = stripByteRangeParams(String(raw || "").replace(/^XHR:/, ""));
        if (!/^https?:/i.test(cleaned)) continue;
        if (excluded.has(cleaned)) continue;
        if (isManifestUrl(cleaned)) {
        if (seenManifests.has(cleaned)) continue;
        seenManifests.add(cleaned);
        pendingManifests.push(cleaned);
        continue;
      }
      noteSegment(cleaned);
    }
    while (pendingManifests.length) {
      await scoreManifest(pendingManifests.shift());
      if (bestDuration > 120) break;
    }
    if (bestDuration > 120) break;
  }

  // raw segment URLs observed (no manifest seen): infer enumerable template
  let segmentTemplate = "";
  let segmentCount = 0;
  for (const [template, samples] of segmentSamples) {
    if (template.includes("#") && samples.size >= 3) {
      if (samples.size > segmentCount) {
        segmentCount = samples.size;
        segmentTemplate = template;
      }
    }
  }
  try {
    const debugUrls = await readHookUrls();
    const byExt = {};
    for (const raw of debugUrls) {
      const cleaned = String(raw || "").replace(/^XHR:/, "");
      let ext = "other";
      try {
        const pathPart = new URL(cleaned).pathname;
        const m = pathPart.match(/\.([a-z0-9]+)$/i);
        ext = m ? m[1].toLowerCase() : "noext";
      } catch {}
      byExt[ext] = (byExt[ext] || 0) + 1;
    }
    log(`Browser relay: hook traffic sample ${debugUrls.length} urls ${JSON.stringify(byExt).slice(0, 300)}`);
    try {
      const mp4s = [...new Set(debugUrls.map((r) => String(r || "").replace(/^XHR:/, "")).filter((u) => /\.mp4(\?|$)/i.test(u)))].slice(0, 5);
      const m3u8s = [...new Set(debugUrls.map((r) => String(r || "").replace(/^XHR:/, "")).filter((u) => /\.m3u8(\?|$)/i.test(u)))].slice(0, 8);
      if (mp4s.length) log(`Browser relay: hook mp4 sample: ${mp4s.map((u) => u.slice(0, 110)).join(" | ")}`);
      if (m3u8s.length) log(`Browser relay: hook m3u8 sample: ${m3u8s.map((u) => u.slice(0, 110)).join(" | ")}`);
    } catch {}
  } catch {}
  if (bestManifest) log(`Browser relay: worker manifest → ${bestManifest.slice(0, 100)}`);
  else if (segmentTemplate) log(`Browser relay: segment template ← ${segmentTemplate.slice(0, 100)} (${segmentCount} samples)`);
  // player handshake (e.g. tsyndicate /do2/master) requested but never
  // answered = server egress blocked; only a browser on another network
  // (e.g. the user's real Chrome via a CDP-wired account) can proceed
  let handshakeDead = false;
  try {
    const tap = Array.isArray(page.__xdlNetUrls) ? page.__xdlNetUrls : [];
    const statusMap = page.__xdlNetStatus || {};
    handshakeDead = tap.some((u) => {
      const key = String(u);
      if (!/\/(master|do2)(\?|$|\/)/i.test(key)) return false;
      const entry = statusMap[key];
      return entry && Number(entry.status || 0) === 0;
    });
  } catch {}
  return { manifestUrl: bestManifest, segmentTemplate, handshakeDead };
}

// Raw enumerable worker segments (no manifest): expand the observed numeric
// template 0,1,2… until consecutive misses. Bounded and tolerant.
async function downloadSegmentsByTemplate(page, template, outDir, filePrefix, options, log, onProgress) {
  const widthOf = (sample) => {
    const m = String(sample || "").match(/(\d+)(?!.*\d)/);
    return m ? m[1].length : 0;
  };
  // learn padding from a live sample: fetch template@0 shape via page probe
  const pad = (n, w) => String(n).padStart(w, "0");
  const fill = (tpl, n, w) => tpl.replace(/#/g, () => pad(n, w));

  // discover padding width from the first fetchable index
  let width = 0;
  for (const probeIndex of [0, 1, 2]) {
    const probe = fill(template, probeIndex, 0);
    try {
      const results = await withEvaluateTimeout(
        fetchBytesViaBrowser(page, [probe]),
        RELAY_BATCH_TIMEOUT_MS,
        "Browser relay template probe"
      );
      if (results && results[0] && results[0].ok) {
        width = widthOf(probe) || 0;
        break;
      }
    } catch {}
  }

  const tmpDir = await fs.mkdtemp(path.join(osTmpdir(), "xdl-relay-"));
  const segFiles = [];
  try {
    await fs.mkdir(outDir, { recursive: true });
    let consecutiveMisses = 0;
    let index = 0;
    const MAX_SEGMENTS = 10000;
    const MAX_MISSES = 8;
    while (index < MAX_SEGMENTS && consecutiveMisses < MAX_MISSES) {
      const batchUrls = [];
      for (let k = 0; k < RELAY_BATCH_SIZE && index + k < MAX_SEGMENTS; k += 1) {
        batchUrls.push(fill(template, index + k, width));
      }
      const results = await withEvaluateTimeout(
        fetchBytesViaBrowser(page, batchUrls, RELAY_CONCURRENCY),
        RELAY_BATCH_TIMEOUT_MS,
        `Browser relay template batch @${index}`
      );
      for (let k = 0; k < batchUrls.length; k += 1) {
        const entry = results && results[k];
        if (!entry || !entry.ok || !entry.b64) {
          consecutiveMisses += 1;
          index += 1;
          if (consecutiveMisses >= MAX_MISSES) break;
          continue;
        }
        consecutiveMisses = 0;
        const segFile = path.join(tmpDir, `seg-${String(index).padStart(5, "0")}.ts`);
        await fs.writeFile(segFile, Buffer.from(entry.b64, "base64"));
        segFiles.push({ file: segFile, duration: 4 });
        index += 1;
      }
      if (onProgress) {
        onProgress({ stage: "downloading", detail: `relay template ${segFiles.length} segments via browser` });
      }
      log(`Browser relay: template ${segFiles.length} segments (misses ${consecutiveMisses})`);
    }
    if (!segFiles.length) throw new Error("Browser relay: template enumeration found no segments");

    const localLines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:10", "#EXT-X-MEDIA-SEQUENCE:0"];
    for (const seg of segFiles) {
      localLines.push("#EXTINF:4.000,", path.basename(seg.file));
    }
    localLines.push("#EXT-X-ENDLIST");
    await fs.writeFile(path.join(tmpDir, "local.m3u8"), localLines.join("\n"));

    const filePath = buildOutputFilePath(outDir, filePrefix, "mp4", options);
    await execFileAsync(
      "ffmpeg",
      ["-y", "-protocol_allowlist", "file,pipe", "-i", path.join(tmpDir, "local.m3u8"), "-c", "copy", "-movflags", "+faststart", filePath],
      { timeout: FFMPEG_TIMEOUT_MS }
    );
    await generatePosterThumbnail(filePath);
    return { filePath, url: template, relayed: true };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function downloadStreamingManifestViaBrowser(page, url, outDir, filePrefix = "media", options = {}) {
  if (!page || typeof page.evaluate !== "function") {
    throw new Error("Browser relay requires a live page");
  }
  if (!(await hasFfmpeg())) {
    throw new Error("ffmpeg is required to mux relayed HLS segments (.m3u8)");
  }
  const log = typeof options.log === "function" ? options.log : () => {};
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  const first = await fetchTextViaBrowser(page, stripByteRangeParams(url));
  let mediaBase = first.finalUrl || url;
  let parsed = parseM3u8Playlist(first.text, mediaBase);
  if (parsed.notPlaylist) throw new Error("Browser relay: URL did not return an m3u8 playlist");
  if (parsed.variantUrl) {
    log(`Browser relay: master playlist → ${parsed.variantUrl}`);
    const media = await fetchTextViaBrowser(page, parsed.variantUrl);
    mediaBase = media.finalUrl || parsed.variantUrl;
    parsed = parseM3u8Playlist(media.text, mediaBase);
    if (parsed.notPlaylist || parsed.variantUrl) throw new Error("Browser relay: nested variant not supported");
  }
  const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
  if (!segments.length) throw new Error("Browser relay: playlist has no segments");
  const storyboardCount = segments.filter((s) => isImageSegmentUrl(s.url)).length;
  let activeParsed = parsed;
  let activeBase = mediaBase;
  if (segments.length && storyboardCount / segments.length > 0.5) {
    // storyboard playlist (thumbnail strips, not video) — find the real
    // stream manifest (or raw segment URLs) via the player's blob workers
    log(`Browser relay: storyboard playlist detected (${storyboardCount}/${segments.length} images), discovering worker manifest`);
    const discovered = await discoverWorkerManifest(page, log, [url, mediaBase, activeBase]);
    if (!discovered || (!discovered.manifestUrl && !discovered.segmentTemplate)) {
      if (discovered && discovered.handshakeDead) {
        throw new Error("Browser relay: player handshake got no response from the server network (exit-blocked). Retry this download with an account wired to your real Chrome via CDP (Profiles → cdpUrl, then Downloads → Account).");
      }
      throw new Error("Browser relay: storyboard-only playlist and no worker manifest found");
    }
    if (discovered.segmentTemplate && !discovered.manifestUrl) {
      // raw enumerable segments observed in worker traffic — download by
      // template until consecutive misses (S3-style opaque names can't be
      // guessed, but observed templates enumerate cleanly)
      return downloadSegmentsByTemplate(page, discovered.segmentTemplate, outDir, filePrefix, options, log, onProgress);
    }
    const fetched = await fetchTextViaBrowser(page, discovered.manifestUrl);
    activeBase = fetched.finalUrl || discovered.manifestUrl;
    activeParsed = parseM3u8Playlist(fetched.text, activeBase);
    if (activeParsed.notPlaylist) throw new Error("Browser relay: discovered manifest is not a playlist");
    if (activeParsed.variantUrl) {
      const nested = await fetchTextViaBrowser(page, activeParsed.variantUrl);
      activeBase = nested.finalUrl || activeParsed.variantUrl;
      activeParsed = parseM3u8Playlist(nested.text, activeBase);
    }
  }
  const finalSegments = Array.isArray(activeParsed.segments) ? activeParsed.segments : [];
  if (!finalSegments.length) throw new Error("Browser relay: playlist has no segments");
  log(`Browser relay: ${finalSegments.length} segment(s) via page`);

  const tmpDir = await fs.mkdtemp(path.join(osTmpdir(), "xdl-relay-"));
  const segFiles = [];
  try {
    await fs.mkdir(outDir, { recursive: true });

    const fetchOne = async (targetUrl, label) => {
      const results = await withEvaluateTimeout(
        fetchBytesViaBrowser(page, [targetUrl]),
        RELAY_BATCH_TIMEOUT_MS,
        `Browser relay fetch ${label}`
      );
      const entry = results && results[0];
      if (!entry || !entry.ok || !entry.b64) {
        throw new Error(`Browser relay: segment fetch failed (${label}, status ${entry ? entry.status : "?"})`);
      }
      return Buffer.from(entry.b64, "base64");
    };

    let mapFile = "";
    if (activeParsed.mapUri) {
      const mapBytes = await fetchOne(activeParsed.mapUri, "init");
      mapFile = path.join(tmpDir, "init.mp4");
      await fs.writeFile(mapFile, mapBytes);
    }
    let keyFile = "";
    if (activeParsed.keyUri && String(activeParsed.keyMethod || "").toUpperCase() === "AES-128") {
      const keyBytes = await fetchOne(activeParsed.keyUri, "key");
      if (keyBytes.length !== 16) throw new Error("Browser relay: AES-128 key is not 16 bytes");
      keyFile = path.join(tmpDir, "key.bin");
      await fs.writeFile(keyFile, keyBytes);
    }

    let maxDuration = 0;
    for (let i = 0; i < finalSegments.length; i += RELAY_BATCH_SIZE) {
      const batch = finalSegments.slice(i, i + RELAY_BATCH_SIZE);
      const results = await withEvaluateTimeout(
        fetchBytesViaBrowser(page, batch.map((s) => s.url), RELAY_CONCURRENCY),
        RELAY_BATCH_TIMEOUT_MS,
        `Browser relay batch ${i / RELAY_BATCH_SIZE + 1}`
      );
      for (let k = 0; k < batch.length; k += 1) {
        const entry = results && results[k];
        if (!entry || !entry.ok || !entry.b64) {
          throw new Error(`Browser relay: segment ${i + k + 1}/${finalSegments.length} failed (status ${entry ? entry.status : "?"})`);
        }
        const segFile = path.join(tmpDir, `seg-${String(i + k).padStart(5, "0")}.ts`);
        await fs.writeFile(segFile, Buffer.from(entry.b64, "base64"));
        segFiles.push({ file: segFile, duration: batch[k].duration });
        maxDuration = Math.max(maxDuration, Number(batch[k].duration || 0));
      }
      if (onProgress) {
        const done = Math.min(i + RELAY_BATCH_SIZE, finalSegments.length);
        onProgress({ stage: "downloading", pct: Math.round((done / finalSegments.length) * 100), detail: `relay ${done}/${finalSegments.length} segments via browser` });
      }
      log(`Browser relay: ${Math.min(i + RELAY_BATCH_SIZE, finalSegments.length)}/${finalSegments.length} segments`);
    }

    const localLines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration) || 10}`, "#EXT-X-MEDIA-SEQUENCE:0"];
    if (keyFile) localLines.push(`#EXT-X-KEY:METHOD=AES-128,URI="key.bin"`);
    if (mapFile) localLines.push(`#EXT-X-MAP:URI="init.mp4"`);
    for (const seg of segFiles) {
      localLines.push(`#EXTINF:${Number(seg.duration || 0).toFixed(3)},`, path.basename(seg.file));
    }
    localLines.push("#EXT-X-ENDLIST");
    await fs.writeFile(path.join(tmpDir, "local.m3u8"), localLines.join("\n"));

    const filePath = buildOutputFilePath(outDir, filePrefix, "mp4", options);
    if (onProgress) {
      try { onProgress({ stage: "downloading", filePath }); } catch {}
    }
    // protocol_allowlist: local playlist references local key/init/segments
    await execFileAsync(
      "ffmpeg",
      ["-y", "-protocol_allowlist", "file,pipe", "-i", path.join(tmpDir, "local.m3u8"), "-c", "copy", "-movflags", "+faststart", filePath],
      { timeout: FFMPEG_TIMEOUT_MS }
    );
    await generatePosterThumbnail(filePath);
    return { filePath, url, relayed: true };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function withEvaluateTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function osTmpdir() {
  try {
    return require("os").tmpdir();
  } catch {
    return "/tmp";
  }
}

async function mediaHasAudio(filePath) {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        filePath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS }
    );
    return String(stdout || "").toLowerCase().includes("audio");
  } catch {
    return false;
  }
}

async function downloadMedia(url, outDir, headers = {}, filePrefix = "media", options = {}) {
  const targetUrl = stripByteRangeParams(url);
  if (isStreamingManifestUrl(targetUrl)) {
    if (typeof options.onProgress === "function") options.onProgress({ stage: "downloading", detail: "HLS · ffmpeg (streaming)" });
    return downloadStreamingManifest(targetUrl, outDir, headers, filePrefix, options);
  }

  await fs.mkdir(outDir, { recursive: true });

  const { response, signal, clear } = await fetchWithTimeout(
    targetUrl,
    {
      method: "GET",
      redirect: "follow",
      headers,
    },
    DOWNLOAD_FETCH_TIMEOUT_MS,
    "Media download request"
  );

  try {
    if (!response.ok || !response.body) {
      throw new Error(`Download failed with status ${response.status}`);
    }

    const urlExtMatch = new URL(targetUrl).pathname.match(/\.([a-z0-9]+)$/i);
    const urlExt = urlExtMatch ? urlExtMatch[1].toLowerCase() : "";
    // Content-type first (preview.redd.it/*.gif often returns video/mp4),
    // URL extension as fallback.
    const ext = extFromContentType(response.headers.get("content-type")) || urlExt || "bin";
    const filePath = buildOutputFilePath(outDir, filePrefix, ext, options);
    if (typeof options.onProgress === "function") {
      try { options.onProgress({ stage: "downloading", filePath }); } catch {}
    }

    const total = Number(response.headers.get("content-length") || 0);
    let received = 0;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

    const nodeStream = Readable.fromWeb(response.body);
    const progressTransform = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (onProgress) {
          if (total) {
            const pct = Math.round((received / total) * 100);
            onProgress({ stage: "downloading", pct, received, total, detail: `${(received / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB` });
          } else {
            onProgress({ stage: "downloading", pct: 0, received, total: 0, detail: `${(received / 1024 / 1024).toFixed(1)} MB downloaded` });
          }
        }
        cb(null, chunk);
      },
    });

    await pipeline(nodeStream, progressTransform, createWriteStream(filePath), { signal });

    // Verify the bytes match the extension; fix it when the URL lied
    // (e.g. MP4 payload saved as .gif). Returns the final path.
    let finalPath = filePath;
    try {
      const head = await readHead(filePath, 12);
      const realKind = sniffMediaKind(head);
      if (realKind && realKind !== ext.toLowerCase()) {
        const corrected = /\.[a-z0-9]+$/i.test(filePath)
          ? filePath.replace(/\.[a-z0-9]+$/i, `.${realKind}`)
          : `${filePath}.${realKind}`;
        await fs.rename(filePath, corrected);
        finalPath = corrected;
      }
      // Reject Reddit 1px placeholder GIFs (e.g. 35-byte GIF87a 1x1) so the
      // caller falls through to the next candidate instead of keeping junk.
      if (/\.(gif)$/i.test(finalPath)) {
        const dims = gifDimensions(await readHead(finalPath, 10));
        if (dims && dims.width <= 2 && dims.height <= 2) {
          await fs.unlink(finalPath).catch(() => {});
          throw new Error(
            `Downloaded GIF is a ${dims.width}x${dims.height} placeholder; trying next candidate`
          );
        }
      }
    } catch (error) {
      // Placeholder rejection must propagate (caller tries next candidate);
      // anything else here is best-effort verification — keep the file.
      if (/placeholder; trying next candidate/i.test(error && error.message)) throw error;
    }

    await generatePosterThumbnail(finalPath);

    return { filePath: finalPath, url: targetUrl };
  } catch (error) {
    // Don't leave partial/failed payloads behind as fake successes.
    try { await fs.unlink(filePath).catch(() => {}); } catch {}
    const isAbortError = error && (error.name === "AbortError" || error.code === "ABORT_ERR");
    if (isAbortError) {
      throw new Error(`Media download request timed out after ${DOWNLOAD_FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clear();
  }
}

module.exports = {
  hasFfmpeg,
  muxVideoAndAudio,
  mediaHasAudio,
  downloadMedia,
  downloadStreamingManifestViaBrowser,
  parseM3u8Playlist,
  parseM3u8Attributes,
  isImageSegmentUrl,
  generatePosterThumbnail,
  posterPathFor,
  posterStemOf,
  isVideoFileName,
  selectPosterTargets,
  POSTER_SIBLING_RE,
};
