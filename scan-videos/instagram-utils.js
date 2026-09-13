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
    const match = u.pathname.match(/^(?:\/[^/]+)?\/(?:p|reel|tv)\/([^/?#]+)\/?/i);
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

function decodeInstagramHtmlUrl(value) {
  return String(value || "").replace(/&amp;/g, "&").trim();
}

function isInstagramPostImageUrl(value) {
  const cleaned = decodeInstagramHtmlUrl(value);
  if (!cleaned) return false;
  try {
    const u = new URL(cleaned);
    if (!/cdninstagram\.com$/i.test(u.hostname) && !/\.cdninstagram\.com$/i.test(u.hostname)) {
      return false;
    }
  } catch {
    return false;
  }
  return /\.(jpe?g|png|webp|avif|bmp)(\?|$)/i.test(cleaned);
}

// Largest src from a display_resources-style list [{src, config_width, ...}]
function pickLargestDisplayResource(resources) {
  if (!Array.isArray(resources) || !resources.length) return "";
  let best = "";
  let bestWidth = -1;
  for (const entry of resources) {
    if (!entry || typeof entry !== "object") continue;
    const src = decodeInstagramHtmlUrl(entry.src);
    if (!src) continue;
    const width = Number(entry.config_width || 0);
    if (width > bestWidth) {
      bestWidth = width;
      best = src;
    }
  }
  return best;
}

// Collect post images from one shortcode-media-like node, in display order.
// Only touches post-image keys (display_url / display_resources / sidecar
// children) so owner profile pics and other chrome never leak in.
// Video nodes are skipped: a reel/video's display_url / og:image is just its
// cover thumbnail, not a photo to download.
function isInstagramVideoNode(node) {
  if (!node || typeof node !== "object") return false;
  if (node.is_video === true) return true;
  if (Number(node.media_type) === 2) return true;
  const typename = String(node.__typename || "").toLowerCase();
  if (typename.includes("video")) return true;
  const productType = String(node.product_type || "").toLowerCase();
  if (productType === "clips" || productType === "igtv") return true;
  return false;
}

function isInstagramReelTargetUrl(url) {
  try {
    return /\/(reel|tv)\//i.test(new URL(String(url || "")).pathname);
  } catch {
    return false;
  }
}

function instagramEfgTag(value) {
  try {
    const u = new URL(String(value || "").trim());
    const raw = u.searchParams.get("efg");
    if (!raw) return "";
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return String((parsed && (parsed.vencode_tag || parsed.efg_tag)) || "");
  } catch {
    return "";
  }
}

// Profile avatars (header chrome) ship as cdninstagram jpegs too — they must
// never be treated as post photos. efg vencode_tag "profile_pic_*" is the
// primary signal; tiny s100/s150 crops are the secondary one.
function isInstagramAvatarUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (instagramEfgTag(raw).toLowerCase().includes("profil")) return true;
  try {
    const stp = new URL(raw).searchParams.get("stp") || "";
    if (/s(100|150)x\1/i.test(stp)) return true;
  } catch {
    // ignore URL parse errors
  }
  return false;
}

function collectPostImagesFromMediaNode(node, out) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if (isInstagramVideoNode(node)) return;

  const edges =
    node.edge_sidecar_to_children &&
    typeof node.edge_sidecar_to_children === "object" &&
    Array.isArray(node.edge_sidecar_to_children.edges)
      ? node.edge_sidecar_to_children.edges
      : [];

  if (edges.length) {
    for (const edge of edges) {
      const child = edge && typeof edge === "object" && edge.node ? edge.node : null;
      if (!child || typeof child !== "object") continue;
      if (isInstagramVideoNode(child)) continue;
      const direct = decodeInstagramHtmlUrl(child.display_url);
      if (isInstagramPostImageUrl(direct)) out.push(stripByteRangeParams(direct));
      const largest = pickLargestDisplayResource(child.display_resources);
      if (isInstagramPostImageUrl(largest)) {
        const cleaned = stripByteRangeParams(largest);
        if (!out.includes(cleaned)) out.push(cleaned);
      }
    }
    return;
  }

  const direct = decodeInstagramHtmlUrl(node.display_url);
  if (isInstagramPostImageUrl(direct)) out.push(stripByteRangeParams(direct));
  const largest = pickLargestDisplayResource(node.display_resources);
  if (isInstagramPostImageUrl(largest)) {
    const cleaned = stripByteRangeParams(largest);
    if (!out.includes(cleaned)) out.push(cleaned);
  }
}

function extractInstagramImageHintsFromJsonText(rawText, shortcode) {
  if (!rawText || !shortcode) return { imageUrls: [] };

  const parsed = parseJsonWithInstagramPrefix(rawText);
  if (!parsed || typeof parsed !== "object") return { imageUrls: [] };

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
  if (!targetNodes.length) return { imageUrls: [] };

  const ordered = [];
  for (const node of targetNodes) collectPostImagesFromMediaNode(node, ordered);

  const seen = new Set();
  const imageUrls = [];
  for (const url of ordered) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    imageUrls.push(url);
  }

  return { imageUrls };
}

function instagramPhotoIdentity(value) {
  // Same photo is served from multiple CDN origins (scontent vs fbcdn) with
  // identical pathnames — identity on pathname merges those duplicates.
  try {
    const u = new URL(String(value || "").trim());
    return u.pathname.toLowerCase();
  } catch {
    return String(value || "").toLowerCase().split("?")[0];
  }
}

function instagramPhotoSizeRank(value) {
  // same photo ships as full-size (dst-jpg, no s-size) and crops (s640x640);
  // rank full-size first. Stable sort keeps post order across photos.
  let stp = "";
  try {
    stp = new URL(String(value || "")).searchParams.get("stp") || "";
  } catch {
    stp = "";
  }
  return /s\d+x\d+/i.test(stp) ? 1 : 0;
}

function dedupeInstagramPhotos(urls) {
  const groups = new Map();
  for (const raw of Array.isArray(urls) ? urls : []) {
    const url = String(raw || "").trim();
    if (!url) continue;
    if (isInstagramAvatarUrl(url)) continue;
    const key = instagramPhotoIdentity(url);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(url);
  }
  const out = [];
  for (const items of groups.values()) {
    items.sort((a, b) => instagramPhotoSizeRank(a) - instagramPhotoSizeRank(b));
    out.push(items[0]);
  }
  return out;
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
  isInstagramReelTargetUrl,
  isInstagramAvatarUrl,
  extractInstagramUsernameFromJsonText,
  extractInstagramMediaHintsFromJsonText,
  extractInstagramImageHintsFromJsonText,
  dedupeInstagramPhotos,
  filterInstagramCandidatesForTarget,
};
