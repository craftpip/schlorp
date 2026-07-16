const {
  stripByteRangeParams,
  isDirectFileUrl,
  isStreamingManifestUrl,
  getInstagramAssetId,
  sanitizeFileToken,
} = require("./media-utils");

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

function parseJsonWithInstagramPrefix(rawText) {
  if (!rawText) return null;
  let text = String(rawText).trim();
  if (!text) return null;
  if (text.startsWith("for (;;);")) {
    text = text.slice("for (;;);".length).trim();
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractInstagramMediaHintsFromJsonText(rawText, shortcode) {
  if (!rawText || !shortcode) return { urls: [], assetIds: [] };

  const parsed = parseJsonWithInstagramPrefix(rawText);
  if (!parsed || typeof parsed !== "object") return { urls: [], assetIds: [] };

  const targetNodes = [];
  const seenNodes = new WeakSet();
  const maxScan = 80_000;
  let scanned = 0;

  const findTargetNodes = (node) => {
    if (scanned >= maxScan) return;
    scanned += 1;

    if (!node || typeof node !== "object") return;
    if (seenNodes.has(node)) return;
    seenNodes.add(node);

    if (Array.isArray(node)) {
      for (const item of node) findTargetNodes(item);
      return;
    }

    if (node.shortcode === shortcode || node.code === shortcode) {
      targetNodes.push(node);
    }

    if (node.xdt_shortcode_media && typeof node.xdt_shortcode_media === "object") {
      const nested = node.xdt_shortcode_media;
      if (nested.shortcode === shortcode || nested.code === shortcode) {
        targetNodes.push(nested);
      }
    }

    for (const value of Object.values(node)) {
      findTargetNodes(value);
    }
  };

  findTargetNodes(parsed);
  if (!targetNodes.length) return { urls: [], assetIds: [] };

  const urls = new Set();
  const assetIds = new Set();
  const mediaSeen = new WeakSet();
  const maxMediaScan = 120_000;
  let mediaScanned = 0;

  const addCandidate = (value) => {
    if (typeof value !== "string") return;
    const cleaned = stripByteRangeParams(value);
    if (!cleaned) return;
    if (!isDirectFileUrl(cleaned) && !isStreamingManifestUrl(cleaned)) return;
    urls.add(cleaned);

    const assetId = getInstagramAssetId(cleaned);
    if (assetId) assetIds.add(assetId);
  };

  const scanMedia = (node) => {
    if (mediaScanned >= maxMediaScan) return;
    mediaScanned += 1;

    if (node == null) return;
    if (typeof node === "string") {
      addCandidate(node);
      return;
    }

    if (typeof node !== "object") return;
    if (mediaSeen.has(node)) return;
    mediaSeen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) scanMedia(item);
      return;
    }

    if (node.xpv_asset_id != null) {
      const rawId = String(node.xpv_asset_id || "").trim();
      if (rawId) assetIds.add(rawId);
    }

    for (const key of [
      "video_url",
      "videoUrl",
      "url",
      "src",
      "playback_url",
      "playbackUrl",
      "dash_url",
      "hls_url",
      "manifest_url",
      "content_url",
    ]) {
      addCandidate(node[key]);
    }

    for (const value of Object.values(node)) {
      scanMedia(value);
    }
  };

  for (const node of targetNodes) scanMedia(node);

  return {
    urls: Array.from(urls),
    assetIds: Array.from(assetIds),
  };
}

function filterInstagramCandidatesForTarget(
  urls,
  targetHintUrls = new Set(),
  targetAssetIds = new Set()
) {
  const hasUrlHints = targetHintUrls instanceof Set && targetHintUrls.size > 0;
  const hasAssetHints = targetAssetIds instanceof Set && targetAssetIds.size > 0;
  if (!hasUrlHints && !hasAssetHints) return urls;

  const byUrl = urls.filter((url) => targetHintUrls.has(stripByteRangeParams(url)));
  if (byUrl.length) return byUrl;

  if (hasAssetHints) {
    const byAssetId = urls.filter((url) => {
      const assetId = getInstagramAssetId(url);
      return assetId && targetAssetIds.has(assetId);
    });
    if (byAssetId.length) return byAssetId;
  }

  return urls;
}

module.exports = {
  isReservedInstagramName,
  extractInstagramShortcode,
  extractInstagramUsernameFromJsonText,
  extractInstagramMediaHintsFromJsonText,
  filterInstagramCandidatesForTarget,
};
