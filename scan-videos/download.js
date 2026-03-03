const fs = require("fs/promises");
const path = require("path");
const { createWriteStream } = require("fs");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const { promisify } = require("util");
const { execFile } = require("child_process");
const {
  stripByteRangeParams,
  isStreamingManifestUrl,
  extractQualityHint,
  sanitizeFileToken,
} = require("./media-utils");

const execFileAsync = promisify(execFile);

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
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers,
      });

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
    } catch {
      return url;
    }
  })();

  await fs.mkdir(outDir, { recursive: true });
  const filePath = buildOutputFilePath(outDir, filePrefix, "mp4", options);

  const args = ["-y"];

  if (headers["user-agent"]) {
    args.push("-user_agent", String(headers["user-agent"]));
  }

  const passthroughHeaders = ["referer", "cookie", "origin"]
    .filter((key) => headers[key])
    .map((key) => `${key}: ${headers[key]}`)
    .join("\r\n");

  if (passthroughHeaders) {
    args.push("-headers", `${passthroughHeaders}\r\n`);
  }

  args.push("-i", finalInputUrl, "-c", "copy", "-movflags", "+faststart", filePath);
  await execFileAsync("ffmpeg", args);

  return { filePath, url: finalInputUrl };
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

async function downloadMedia(url, outDir, headers = {}, filePrefix = "media", options = {}) {
  const targetUrl = stripByteRangeParams(url);
  if (isStreamingManifestUrl(targetUrl)) {
    return downloadStreamingManifest(targetUrl, outDir, headers, filePrefix, options);
  }

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
  const filePath = buildOutputFilePath(outDir, filePrefix, ext, options);

  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
  return { filePath, url: targetUrl };
}

module.exports = {
  hasFfmpeg,
  muxVideoAndAudio,
  mediaHasAudio,
  downloadMedia,
};
