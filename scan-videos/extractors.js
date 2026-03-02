const {
  stripByteRangeParams,
  metadataQualityScore,
  sanitizeFileToken,
} = require("./media-utils");
const { isReservedInstagramName } = require("./instagram-utils");

async function extractXhamsterMediaData(page) {
  const entries = await page.evaluate(() => {
    const maxNodes = 60_000;
    let scannedNodes = 0;
    const seenObjects = new WeakSet();
    const output = [];

    const normalize = (value) =>
      String(value || "")
        .replace(/\\u002F/gi, "/")
        .replace(/\\u0026/gi, "&")
        .replace(/\\\//g, "/")
        .trim();

    const toAbsolute = (value) => {
      const normalized = normalize(value);
      if (!normalized) return "";
      try {
        return new URL(normalized, location.href).href;
      } catch {
        return "";
      }
    };

    const pushCandidate = (value, meta = {}) => {
      const url = toAbsolute(value);
      if (!url) return;
      if (!/\.(mp4|webm|mov|mkv|avi|flv|m3u8|mpd)(\?|$)/i.test(url)) return;

      output.push({
        url,
        height: Number(meta.height || 0) || 0,
        width: Number(meta.width || 0) || 0,
        bitrate: Number(meta.bitrate || 0) || 0,
        fps: Number(meta.fps || 0) || 0,
        label: String(meta.label || ""),
        quality: String(meta.quality || ""),
        name: String(meta.name || ""),
        resolution: String(meta.resolution || ""),
      });
    };

    const scan = (node, depth = 0) => {
      if (scannedNodes > maxNodes) return;
      scannedNodes += 1;
      if (depth > 7 || node == null) return;

      if (typeof node === "string") {
        pushCandidate(node);
        return;
      }

      if (typeof node !== "object") return;
      if (seenObjects.has(node)) return;
      seenObjects.add(node);

      if (Array.isArray(node)) {
        for (const item of node) scan(item, depth + 1);
        return;
      }

      const meta = {
        height: node.height,
        width: node.width,
        bitrate: node.bitrate,
        fps: node.fps,
        label: node.label,
        quality: node.quality,
        name: node.name,
        resolution: node.resolution,
      };

      const urlFields = [
        "url",
        "src",
        "file",
        "videoUrl",
        "video_url",
        "hls",
        "hlsUrl",
        "hls_url",
        "dash",
        "dashUrl",
        "dash_url",
        "manifest",
        "playlist",
      ];

      for (const key of urlFields) {
        if (node[key]) pushCandidate(node[key], meta);
      }

      for (const value of Object.values(node)) {
        scan(value, depth + 1);
      }
    };

    if (window.initials) scan(window.initials);
    if (window.xplayerSettings) scan(window.xplayerSettings);
    if (window.playerConfig) scan(window.playerConfig);
    if (window.__INITIAL_STATE__) scan(window.__INITIAL_STATE__);

    const preloadLinks = Array.from(
      document.querySelectorAll('link[rel="preload"][as="fetch"][href]')
    );
    for (const link of preloadLinks) {
      pushCandidate(link.getAttribute("href"));
    }

    const scripts = Array.from(document.querySelectorAll("script"));
    const patterns = [
      /https?:\/\/[^\s"'<>]+\.(?:m3u8|mpd|mp4)(?:[^\s"'<>]*)/gi,
      /"(https?:\/\/[^"\\]+\.(?:m3u8|mpd|mp4)[^"\\]*)"/gi,
      /'((?:https?:)?\/\/[^'\\]+\.(?:m3u8|mpd|mp4)[^'\\]*)'/gi,
    ];

    for (const script of scripts) {
      const text = (script.textContent || "").replace(/\\\//g, "/");
      if (!text) continue;

      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text))) {
          pushCandidate(match[1] || match[0]);
        }
      }
    }

    return output;
  });

  const urls = [];
  const qualityByUrl = new Map();
  const seen = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const cleaned = stripByteRangeParams(entry && entry.url ? entry.url : "");
    if (!cleaned) continue;

    const score = metadataQualityScore(entry);
    const current = Number(qualityByUrl.get(cleaned) || 0);
    if (score > current) qualityByUrl.set(cleaned, score);

    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }

  return { urls, qualityByUrl };
}

async function extractXvideosMediaUrls(page) {
  const result = await page.evaluate(() => {
    const toAbsolute = (value) => {
      if (!value) return "";
      const normalized = String(value)
        .replace(/\\u002F/gi, "/")
        .replace(/\\u0026/gi, "&")
        .replace(/\\\//g, "/")
        .trim();
      if (!normalized) return "";
      try {
        return new URL(normalized, location.href).href;
      } catch {
        return "";
      }
    };

    const out = new Set();

    const pushIfMedia = (value) => {
      const url = toAbsolute(value);
      if (!url) return;
      if (/\.(mp4|webm|mov|mkv|avi|flv|m3u8|mpd)(\?|$)/i.test(url)) {
        out.add(url);
      }
    };

    const player = window.html5player;
    if (player && typeof player === "object") {
      pushIfMedia(player.url_high);
      pushIfMedia(player.url_low);
      pushIfMedia(player.hls);
      pushIfMedia(player.hlsurl);
      pushIfMedia(player.url_hls);
      pushIfMedia(player.url_dash);
    }

    const scripts = Array.from(document.querySelectorAll("script"));
    const patterns = [
      /setVideoUrlHigh\('([^']+)'\)/g,
      /setVideoUrlLow\('([^']+)'\)/g,
      /setVideoHLS\('([^']+)'\)/g,
      /setVideoDash\('([^']+)'\)/g,
      /"video(?:UrlHigh|UrlLow|HLS|Dash)"\s*:\s*"([^"]+)"/g,
      /"contentUrl"\s*:\s*"([^"]+)"/g,
    ];

    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text) continue;
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text))) {
          pushIfMedia(match[1]);
        }
      }
    }

    return Array.from(out);
  });

  return Array.isArray(result) ? result : [];
}

async function getInstagramUsername(page) {
  try {
    const candidate = await page.evaluate(() => {
      const isReserved = (value) => {
        const name = String(value || "").toLowerCase();
        return [
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
        ].includes(name);
      };

      const normalize = (value) => {
        if (!value) return null;
        const cleaned = String(value).trim().replace(/^@+/, "");
        if (!cleaned) return null;
        if (!/^[a-z0-9._]+$/i.test(cleaned)) return null;
        return cleaned;
      };

      const fromPath = (() => {
        const m = location.pathname.match(/^\/([a-z0-9._]+)\/?$/i);
        return m ? normalize(m[1]) : null;
      })();
      if (fromPath) return fromPath;

      const fromCanonical = (() => {
        const link = document.querySelector('link[rel="canonical"]');
        if (!link) return null;
        const href = link.getAttribute("href") || "";
        try {
          const url = new URL(href, location.href);
          const m = url.pathname.match(/^\/([a-z0-9._]+)\/?$/i);
          return m ? normalize(m[1]) : null;
        } catch {
          return null;
        }
      })();
      if (fromCanonical) return fromCanonical;

      const fromProfileLink = (() => {
        const reelHeaderLink = (() => {
          const selectors = [
            "article header a[href^='/']",
            "main header a[href^='/']",
            "article a[href^='/'][role='link']",
          ];

          for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (!node) continue;
            const href = node.getAttribute("href") || "";
            const m = href.match(/^\/([a-z0-9._]+)\/?$/i);
            if (!m) continue;
            const username = normalize(m[1]);
            if (username && !isReserved(username)) return username;
          }

          return null;
        })();

        if (reelHeaderLink) return reelHeaderLink;

        const anchors = Array.from(document.querySelectorAll('a[href^="/"]'));
        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/^\/([a-z0-9._]+)\/?$/i);
          if (!m) continue;
          const username = normalize(m[1]);
          if (!username) continue;
          if (isReserved(username)) continue;
          return username;
        }
        return null;
      })();
      if (fromProfileLink) return fromProfileLink;

      const fromTitle = (() => {
        const title = document.title || "";
        const m = title.match(/^@?([a-z0-9._]+)\s+on\s+instagram/i);
        return m ? normalize(m[1]) : null;
      })();
      if (fromTitle) return fromTitle;

      const fromMeta = (() => {
        const selectors = [
          'meta[property="og:title"]',
          'meta[property="og:description"]',
          'meta[name="description"]',
        ];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          const content = el ? el.getAttribute("content") || "" : "";
          const m = content.match(/@?([a-z0-9._]+)\s+on\s+instagram/i);
          if (m) {
            const username = normalize(m[1]);
            if (username) return username;
          }
        }
        return null;
      })();
      if (fromMeta) return fromMeta;

      const fromLdJson = (() => {
        const scripts = Array.from(
          document.querySelectorAll('script[type="application/ld+json"]')
        );

        const extract = (node) => {
          if (!node || typeof node !== "object") return null;
          const author = node.author;
          const list = Array.isArray(author) ? author : [author];
          for (const entry of list) {
            if (!entry || typeof entry !== "object") continue;
            const alternateName = normalize(entry.alternateName || "");
            if (alternateName) return alternateName;
            const name = normalize(entry.name || "");
            if (name) return name;
          }
          return null;
        };

        for (const script of scripts) {
          const raw = script.textContent || "";
          if (!raw.trim()) continue;
          try {
            const parsed = JSON.parse(raw);
            const nodes = Array.isArray(parsed) ? parsed : [parsed];
            for (const node of nodes) {
              const username = extract(node);
              if (username) return username;
            }
          } catch {
            // ignore invalid JSON-LD
          }
        }

        return null;
      })();
      if (fromLdJson) return fromLdJson;

      return null;
    });

    const normalized = sanitizeFileToken(candidate);
    if (normalized && !isReservedInstagramName(normalized)) return normalized;

    const html = await page.content();
    const patterns = [
      /"xdt_shortcode_media"[\s\S]*?"owner"\s*:\s*\{[\s\S]*?"username"\s*:\s*"([a-zA-Z0-9._]+)"/,
      /"shortcode_media"[\s\S]*?"owner"\s*:\s*\{[\s\S]*?"username"\s*:\s*"([a-zA-Z0-9._]+)"/,
      /"owner"\s*:\s*\{[\s\S]*?"username"\s*:\s*"([a-zA-Z0-9._]+)"/,
      /"user"\s*:\s*\{[\s\S]*?"username"\s*:\s*"([a-zA-Z0-9._]+)"/,
      /"username"\s*:\s*"([a-zA-Z0-9._]+)"\s*,\s*"profile_pic_url"/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match) continue;
      const username = sanitizeFileToken(match[1]);
      if (!username || isReservedInstagramName(username)) continue;
      return username;
    }

    return "";
  } catch {
    return "";
  }
}

async function getInstagramUsernameFromOembed(page, targetUrl) {
  try {
    const candidate = await page.evaluate(async (url) => {
      const endpoints = [
        `/api/v1/oembed/?url=${encodeURIComponent(url)}`,
        `/oembed/?url=${encodeURIComponent(url)}`,
      ];

      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint, {
            method: "GET",
            credentials: "include",
          });
          if (!response.ok) continue;
          const payload = await response.json();
          const value =
            payload.author_name || payload.author || payload.username || "";
          if (value) return value;
        } catch {
          // ignore endpoint failures
        }
      }

      return "";
    }, targetUrl);

    const normalized = sanitizeFileToken(candidate);
    if (!normalized || isReservedInstagramName(normalized)) return "";
    return normalized;
  } catch {
    return "";
  }
}

module.exports = {
  extractXhamsterMediaData,
  extractXvideosMediaUrls,
  getInstagramUsername,
  getInstagramUsernameFromOembed,
};
