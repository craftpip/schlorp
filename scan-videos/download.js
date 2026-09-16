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

// Best-effort: extract a representative frame next to the video as
// `<stem>-poster.jpg`. Never throws — a failed thumbnail is not a failed download.
async function generatePosterThumbnail(videoPath) {
  try {
    const ext = path.extname(videoPath).slice(1).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) return null;
    if (!(await hasFfmpeg())) return null;
    const posterPath = posterPathFor(videoPath);
    if (posterPath === videoPath) return null;
    try { await fs.access(posterPath); return posterPath; } catch {}

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
};
