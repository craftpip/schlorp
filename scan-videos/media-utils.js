function isLikelyVideoUrl(url) {
  return /\.(mp4|webm|m3u8|mpd|mov|mkv|avi|flv)(\?.*)?$/i.test(url);
}

function isRedgifsUrl(url) {
  const v = String(url || "");
  if (v.includes("/static/")) return false;
  if (v.includes(".css") || v.includes(".js")) return false;
  return /redgifs\.com\/(?:watch|ifr)\/[a-zA-Z0-9]+/i.test(v);
}

function extractRedgifsId(url) {
  try {
    const m = String(url || "").match(/redgifs\.com\/(?:watch|ifr)\/([^/?#&]+)/i);
    return m ? String(m[1] || "").trim() : "";
  } catch {
    return "";
  }
}

function isRedditMediaUrl(url) {
  const value = String(url || "");
  return (
    /\/v\.redd\.it\//i.test(value) ||
    /i\.redd\.it\//i.test(value) ||
    /preview\.redd\.it\//i.test(value) ||
    isRedgifsUrl(value) ||
    /external-preview\.redd\.it\//i.test(value)
  );
}

function isGifUrl(url) {
  return /\.gif(\?|$)/i.test(String(url || ""));
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

function isStreamingManifestUrl(url) {
  return /\.(m3u8|mpd)(\?|$)/i.test(url);
}

function isDirectFileUrl(url) {
  return /\.(mp4|webm|mov|mkv|avi|flv)(\?|$)/i.test(url);
}

function extractQualityHint(url) {
  const value = String(url || "");
  const knownResolutions = [240, 360, 480, 540, 576, 720, 1080, 1440, 2160, 4320];

  const explicitP = value.match(/(?:^|[^0-9])([0-9]{3,4})p(?:[^0-9]|$)/i);
  if (explicitP) return Number(explicitP[1]);

  for (const resolution of knownResolutions) {
    const pattern = new RegExp(`(?:^|[\\/_-])${resolution}(?:[\\/_.-]|$)`, "i");
    if (pattern.test(value)) return resolution;
  }

  return 0;
}

function metadataQualityScore(meta) {
  if (!meta || typeof meta !== "object") return 0;

  const height = Number(meta.height || 0);
  const width = Number(meta.width || 0);
  const bitrate = Number(meta.bitrate || 0);
  const fps = Number(meta.fps || 0);
  const labelQuality = extractQualityHint(
    [meta.label, meta.quality, meta.name, meta.resolution].filter(Boolean).join(" ")
  );

  let score = 0;
  if (Number.isFinite(height) && height > 0) score += height * 1_000_000;
  if (Number.isFinite(width) && width > 0) score += width * 100_000;
  if (Number.isFinite(labelQuality) && labelQuality > 0) score += labelQuality * 1_000_000;
  if (Number.isFinite(bitrate) && bitrate > 0) score += Math.min(bitrate, 100_000_000);
  if (Number.isFinite(fps) && fps > 0) score += fps * 10_000;
  return score;
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

function scoreDownloadCandidate(url, metadataBonus = 0) {
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

  if (isDirectFileUrl(url)) score += 200_000;
  if (/\.mp4(\?|$)/i.test(url)) score += 250_000;
  if (isStreamingManifestUrl(url)) score += 150_000;

  score += extractQualityHint(url) * 1_000;
  score += Number(metadataBonus || 0);

  return score;
}

function prioritizeInstagramCandidates(urls, domUrls = []) {
  const domUrlSet = new Set();
  const domAssetIds = new Set();

  for (const value of domUrls) {
    const cleaned = stripByteRangeParams(value);
    if (!cleaned) continue;
    domUrlSet.add(cleaned);

    const assetId = getInstagramAssetId(cleaned);
    if (assetId) domAssetIds.add(assetId);
  }

  const withPriority = (url) => {
    let bonus = 0;
    const cleaned = stripByteRangeParams(url);

    if (domUrlSet.has(cleaned)) {
      bonus += 50_000_000;
    }

    const assetId = getInstagramAssetId(cleaned);
    if (assetId && domAssetIds.has(assetId)) {
      bonus += 40_000_000;
    }

    return scoreDownloadCandidate(cleaned) + bonus;
  };

  return [...urls].sort((a, b) => withPriority(b) - withPriority(a));
}

function extractDownloadableVideoUrls(videoUrls, options = {}) {
  const qualityByUrl = options.qualityByUrl instanceof Map ? options.qualityByUrl : new Map();
  const forceIncludeUrls = options.forceIncludeUrls instanceof Set ? options.forceIncludeUrls : new Set();
  const seen = new Set();
  const output = [];

  for (const url of videoUrls) {
    if (!url || url.startsWith("blob:")) continue;

    const cleaned = stripByteRangeParams(url);
    const forceIncluded = forceIncludeUrls.has(cleaned);
    if (!forceIncluded && !isDirectFileUrl(cleaned) && !isStreamingManifestUrl(cleaned)) continue;

    const metadataScore = Number(qualityByUrl.get(cleaned) || 0);

    if (seen.has(cleaned)) continue;
    seen.add(cleaned);

    if (metadataScore > 0) qualityByUrl.set(cleaned, metadataScore);
    output.push(cleaned);
  }

  return output.sort(
    (a, b) =>
      scoreDownloadCandidate(b, qualityByUrl.get(b)) -
      scoreDownloadCandidate(a, qualityByUrl.get(a))
  );
}

function prioritizeXhamsterCandidates(urls, qualityByUrl = new Map()) {
  const manifestUrls = [];
  const directUrls = [];

  for (const url of urls) {
    if (isStreamingManifestUrl(url)) {
      manifestUrls.push(url);
      continue;
    }
    directUrls.push(url);
  }

  manifestUrls.sort(
    (a, b) =>
      scoreDownloadCandidate(b, qualityByUrl.get(b)) -
      scoreDownloadCandidate(a, qualityByUrl.get(a))
  );

  let maxDirectQualityHint = 0;
  for (const url of directUrls) {
    maxDirectQualityHint = Math.max(maxDirectQualityHint, extractQualityHint(url));
  }

  const highQualityDirectUrls = [];
  const remainingDirectUrls = [];

  for (const url of directUrls) {
    const hint = extractQualityHint(url);
    if (maxDirectQualityHint > 0 && hint === maxDirectQualityHint) {
      highQualityDirectUrls.push(url);
    } else {
      remainingDirectUrls.push(url);
    }
  }

  highQualityDirectUrls.sort(
    (a, b) =>
      scoreDownloadCandidate(b, qualityByUrl.get(b)) -
      scoreDownloadCandidate(a, qualityByUrl.get(a))
  );

  remainingDirectUrls.sort(
    (a, b) =>
      scoreDownloadCandidate(b, qualityByUrl.get(b)) -
      scoreDownloadCandidate(a, qualityByUrl.get(a))
  );

  return [...manifestUrls, ...highQualityDirectUrls, ...remainingDirectUrls];
}

function sanitizeFileToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function prioritizeRedditCandidates(urls, qualityByUrl = new Map()) {
  // Prefer: v.redd.it fallback mp4 > i.redd.it gif mp4 > preview mp4 > redgifs mp4 > redgifs m3u8
  const scored = (url) => {
    let bonus = 0;
    const lower = String(url || "").toLowerCase();
    if (/v\.redd\.it.*\.mp4/i.test(lower)) bonus += 500_000;
    if (/preview\.redd\.it.*format=mp4/i.test(lower)) bonus += 400_000;
    if (/i\.redd\.it.*\.gif/i.test(lower) && /mp4/i.test(lower)) bonus += 300_000;
    if (/i\.redd\.it.*\.gif/i.test(lower)) bonus += 200_000;
    if (/redgifs\.com.*\.mp4/i.test(lower)) bonus += 450_000;
    if (/redgifs\.com.*\.m3u8/i.test(lower)) bonus += 350_000;
    if (/redgifs\.com/i.test(lower)) bonus += 300_000;
    return scoreDownloadCandidate(url, qualityByUrl.get(url)) + bonus;
  };
  return [...urls].sort((a, b) => scored(b) - scored(a));
}

module.exports = {
  isLikelyVideoUrl,
  isRedgifsUrl,
  extractRedgifsId,
  isRedditMediaUrl,
  isGifUrl,
  stripByteRangeParams,
  isStreamingManifestUrl,
  isDirectFileUrl,
  extractQualityHint,
  metadataQualityScore,
  isInstagramAudioOnlyUrl,
  getInstagramAssetId,
  scoreDownloadCandidate,
  prioritizeInstagramCandidates,
  prioritizeRedditCandidates,
  extractDownloadableVideoUrls,
  prioritizeXhamsterCandidates,
  sanitizeFileToken,
};
