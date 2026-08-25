const {
  stripByteRangeParams,
  isDirectFileUrl,
  isStreamingManifestUrl,
} = require("./media-utils");

function isRedditUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    return /(^|\.)reddit\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function isRedditSavedUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    if (!/(^|\.)reddit\.com$/i.test(u.hostname)) return false;
    return /\/user\/[^/]+\/saved\/?/i.test(u.pathname);
  } catch {
    return false;
  }
}

function normalizeRedditPostUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    // only reddit post urls
    if (!/(^|\.)reddit\.com$/i.test(u.hostname)) return "";
    // must have /comments/
    if (!/\/comments\//i.test(u.pathname)) return "";
    // strip query, hash, keep origin + pathname
    u.search = "";
    u.hash = "";
    let href = u.href.replace(/\/+$/, "");
    // ensure https
    return href;
  } catch {
    return "";
  }
}

function extractRedditPostId(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    const m = u.pathname.match(/\/comments\/([^/?#]+)\/?/i);
    return m ? String(m[1] || "").trim() : "";
  } catch {
    return "";
  }
}

function isRedditVideoPost(post) {
  if (!post || typeof post !== "object") return false;
  const domain = String(post.domain || "").toLowerCase();
  const hint = String(post.post_hint || "").toLowerCase();
  const uod = String(post.url_overridden_by_dest || "").toLowerCase();
  // GIF wanted even if image hint but gif extension
  const isGifUod = /\.gif(\?|$)/i.test(uod);
  const hasPreviewMp4 =
    post.preview &&
    (() => {
      try {
        return JSON.stringify(post.preview).includes("format=mp4");
      } catch {
        return false;
      }
    })();
  if (isGifUod && hasPreviewMp4) return true;
  if (isGifUod) return true;
  if (domain.includes("redgifs.com")) return true;
  if (uod.includes("redgifs.com")) return true;
  if (domain.includes("v.redd.it")) return true;
  if (uod.includes("v.redd.it")) return true;
  if (post.is_video === true) return true;
  if (hint === "hosted:video") return true;
  if (hint === "rich:video" && domain.includes("redgifs.com")) return true;
  if (post.media && post.media.reddit_video) return true;
  if (post.secure_media && post.secure_media.reddit_video) return true;
  // also check crosspost parent?
  if (Array.isArray(post.crosspost_parent_list)) {
    for (const parent of post.crosspost_parent_list) {
      if (isRedditVideoPost(parent)) return true;
    }
  }
  return false;
}

function parseJsonWithPrefix(rawText) {
  if (!rawText) return null;
  let text = String(rawText).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findPostNode(parsed, postId) {
  if (!parsed) return null;
  // reddit .json is array of listings
  const listings = Array.isArray(parsed) ? parsed : [parsed];
  for (const listing of listings) {
    const children = listing && listing.data && Array.isArray(listing.data.children) ? listing.data.children : [];
    for (const child of children) {
      if (!child || child.kind !== "t3") continue;
      const data = child.data;
      if (!data) continue;
      if (postId && (data.id === postId || data.name === `t3_${postId}`)) return data;
      // fallback: if postId not provided, return first t3
      if (!postId) return data;
    }
  }
  // fallback scan any t3 deeper
  const seen = new WeakSet();
  let found = null;
  const scan = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) scan(item);
      return;
    }
    if (node.kind === "t3" && node.data && typeof node.data === "object") {
      const data = node.data;
      if (!postId || data.id === postId || data.name === `t3_${postId}`) {
        found = data;
        return;
      }
    }
    for (const v of Object.values(node)) scan(v);
  };
  scan(parsed);
  return found;
}

function extractRedditMediaHintsFromJsonText(rawText, postId) {
  if (!rawText || !postId) return { urls: [], redgifsIds: [], isVideo: false };
  const parsed = parseJsonWithPrefix(rawText);
  if (!parsed) return { urls: [], redgifsIds: [], isVideo: false };
  const post = findPostNode(parsed, postId);
  if (!post) return { urls: [], redgifsIds: [], isVideo: false };
  const isVideo = isRedditVideoPost(post);
  // if not video (photo-only), return empty for downloader skip (but still report isVideo false)
  if (!isVideo) return { urls: [], redgifsIds: [], isVideo: false };

  const urls = new Set();
  const redgifsIds = new Set();

  const addUrl = (value) => {
    if (typeof value !== "string") return;
    const cleaned = stripByteRangeParams(value);
    if (!cleaned) return;
    // allow video/gif/hls/mpd and redgifs watch
    if (
      isDirectFileUrl(cleaned) ||
      isStreamingManifestUrl(cleaned) ||
      /\.gif(\?|$)/i.test(cleaned) ||
      /redgifs\.com\/(watch|ifr)\//i.test(cleaned) ||
      /preview\.redd\.it.*format=mp4/i.test(cleaned) ||
      /v\.redd\.it/i.test(cleaned)
    ) {
      urls.add(cleaned);
    }
  };

  const addRedgifsId = (value) => {
    if (typeof value !== "string") return;
    const m = String(value).match(/redgifs\.com\/(?:watch|ifr)\/([^/?#&]+)/i);
    if (m && m[1]) redgifsIds.add(m[1].trim());
  };

  // url_overridden_by_dest
  if (post.url_overridden_by_dest) {
    addUrl(post.url_overridden_by_dest);
    addRedgifsId(post.url_overridden_by_dest);
  }
  if (post.url) {
    addUrl(post.url);
    addRedgifsId(post.url);
  }

  // preview images variants mp4/gif
  if (post.preview && post.preview.images && Array.isArray(post.preview.images)) {
    for (const img of post.preview.images) {
      if (!img) continue;
      if (img.source && img.source.url) addUrl(img.source.url.replace(/&amp;/g, "&"));
      if (img.variants) {
        if (img.variants.mp4 && img.variants.mp4.source && img.variants.mp4.source.url) {
          addUrl(img.variants.mp4.source.url.replace(/&amp;/g, "&"));
        }
        if (img.variants.gif && img.variants.gif.source && img.variants.gif.source.url) {
          addUrl(img.variants.gif.source.url.replace(/&amp;/g, "&"));
        }
      }
    }
  }

  // media.reddit_video
  const redditVideoCandidates = [];
  if (post.media && post.media.reddit_video) redditVideoCandidates.push(post.media.reddit_video);
  if (post.secure_media && post.secure_media.reddit_video) redditVideoCandidates.push(post.secure_media.reddit_video);
  for (const rv of redditVideoCandidates) {
    if (rv.fallback_url) addUrl(rv.fallback_url);
    if (rv.hls_url) addUrl(rv.hls_url);
    if (rv.dash_url) addUrl(rv.dash_url);
    if (rv.scrubber_media_url) addUrl(rv.scrubber_media_url);
  }

  // reddit_video_preview for redgifs posts fallback v.redd.it
  if (post.preview && post.preview.reddit_video_preview) {
    const rv = post.preview.reddit_video_preview;
    if (rv.fallback_url) addUrl(rv.fallback_url);
    if (rv.hls_url) addUrl(rv.hls_url);
    if (rv.dash_url) addUrl(rv.dash_url);
  }

  // media_embed iframe
  if (post.media_embed && post.media_embed.content) {
    const content = String(post.media_embed.content);
    const iframeMatch = content.match(/src=["']([^"']+)["']/i);
    if (iframeMatch) {
      addUrl(iframeMatch[1]);
      addRedgifsId(iframeMatch[1]);
    }
  }
  if (post.secure_media_embed && post.secure_media_embed.content) {
    const content = String(post.secure_media_embed.content);
    const iframeMatch = content.match(/src=["']([^"']+)["']/i);
    if (iframeMatch) {
      addUrl(iframeMatch[1]);
      addRedgifsId(iframeMatch[1]);
    }
  }
  // secure_media oembed html
  if (post.secure_media && post.secure_media.oembed && post.secure_media.oembed.html) {
    const html = String(post.secure_media.oembed.html);
    const iframeMatch = html.match(/src=["']([^"']+)["']/i);
    if (iframeMatch) {
      addUrl(iframeMatch[1]);
      addRedgifsId(iframeMatch[1]);
    }
  }
  if (post.media && post.media.oembed && post.media.oembed.html) {
    const html = String(post.media.oembed.html);
    const iframeMatch = html.match(/src=["']([^"']+)["']/i);
    if (iframeMatch) {
      addUrl(iframeMatch[1]);
      addRedgifsId(iframeMatch[1]);
    }
  }

  // crosspost parents
  if (Array.isArray(post.crosspost_parent_list)) {
    for (const parent of post.crosspost_parent_list) {
      if (!parent) continue;
      if (parent.url_overridden_by_dest) {
        addUrl(parent.url_overridden_by_dest);
        addRedgifsId(parent.url_overridden_by_dest);
      }
      if (parent.media && parent.media.reddit_video) {
        const rv = parent.media.reddit_video;
        if (rv.fallback_url) addUrl(rv.fallback_url);
        if (rv.hls_url) addUrl(rv.hls_url);
        if (rv.dash_url) addUrl(rv.dash_url);
      }
      if (parent.secure_media && parent.secure_media.reddit_video) {
        const rv = parent.secure_media.reddit_video;
        if (rv.fallback_url) addUrl(rv.fallback_url);
        if (rv.hls_url) addUrl(rv.hls_url);
        if (rv.dash_url) addUrl(rv.dash_url);
      }
    }
  }

  // also scan raw text for redgifs/watch ids via regex (fallback)
  const redgifsRegex = /https?:\/\/(?:www\.)?redgifs\.com\/(?:watch|ifr)\/([a-z0-9]+)/gi;
  let match;
  while ((match = redgifsRegex.exec(rawText))) {
    if (match[1]) redgifsIds.add(match[1].trim());
  }

  return {
    urls: Array.from(urls),
    redgifsIds: Array.from(redgifsIds),
    isVideo,
  };
}

module.exports = {
  isRedditUrl,
  isRedditSavedUrl,
  normalizeRedditPostUrl,
  extractRedditPostId,
  isRedditVideoPost,
  extractRedditMediaHintsFromJsonText,
};
