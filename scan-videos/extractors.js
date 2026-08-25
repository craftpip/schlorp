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

async function extractPornhubMediaData(page) {
  const entries = await page.evaluate(() => {
    const maxNodes = 80_000;
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

      const looksLikeMedia =
        /\.(mp4|webm|mov|mkv|avi|flv|m3u8|mpd)(\?|$)/i.test(url) ||
        /\/video\/get_media\b/i.test(url) ||
        /\/hls\//i.test(url) ||
        /[?&](?:quality|download|format|mime)=/i.test(url);

      if (!looksLikeMedia) return;

      output.push({
        url,
        quality: String(meta.quality || ""),
        label: String(meta.label || ""),
        name: String(meta.name || ""),
      });
    };

    const scan = (node, depth = 0) => {
      if (scannedNodes > maxNodes) return;
      scannedNodes += 1;
      if (depth > 8 || node == null) return;

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
        quality: node.quality,
        label: node.label,
        name: node.name,
      };

      const urlFields = [
        "videoUrl",
        "video_url",
        "url",
        "src",
        "file",
        "hls",
        "hlsUrl",
        "hls_url",
        "dash",
        "dashUrl",
        "dash_url",
        "manifest",
      ];

      for (const key of urlFields) {
        if (node[key]) pushCandidate(node[key], meta);
      }

      for (const value of Object.values(node)) {
        scan(value, depth + 1);
      }
    };

    for (const [key, value] of Object.entries(window)) {
      if (
        /^flashvars_/i.test(key) ||
        /^mediadefinitions/i.test(key) ||
        /^playerobj/i.test(key) ||
        /^qualityitems/i.test(key)
      ) {
        scan(value);
      }
    }

    if (window.MDL_FLASHVARS) scan(window.MDL_FLASHVARS);
    if (window.flashvars) scan(window.flashvars);

    const scripts = Array.from(document.querySelectorAll("script"));
    const patterns = [
      /https?:\/\/[^\s"'<>]+(?:\.m3u8|\.mpd|\.mp4)(?:[^\s"'<>]*)/gi,
      /https?:\/\/[^\s"'<>]*\/video\/get_media[^\s"'<>]*/gi,
      /"videoUrl"\s*:\s*"([^"\\]+)"/gi,
      /"quality"\s*:\s*"?(\d{3,4})p?"?\s*,\s*"videoUrl"\s*:\s*"([^"\\]+)"/gi,
    ];

    for (const script of scripts) {
      const text = (script.textContent || "").replace(/\\\//g, "/");
      if (!text) continue;

      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text))) {
          if (match[2]) {
            pushCandidate(match[2], { quality: match[1] });
          } else {
            pushCandidate(match[1] || match[0]);
          }
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

async function extractRedditMediaData(page) {
  const entries = await page.evaluate(() => {
    const out = new Set();
    const toAbs = (value) => {
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
    const pushIfVideo = (value) => {
      const url = toAbs(value);
      if (!url) return;
      // video/GIF only: mp4/webm/m3u8/mpd/gif + redgifs/v.redd/preview mp4
      if (
        /\.(mp4|webm|mov|mkv|avi|flv|m3u8|mpd|gif)(\?|$)/i.test(url) ||
        /v\.redd\.it\//i.test(url) ||
        /redgifs\.com\/(?:watch|ifr)\//i.test(url) ||
        /preview\.redd\.it.*format=mp4/i.test(url)
      ) {
        out.add(url);
      }
    };

    // shreddit-post content-href
    document.querySelectorAll("shreddit-post[content-href]").forEach((el) => {
      const href = el.getAttribute("content-href");
      if (href) pushIfVideo(href);
      // also permalink not needed
    });

    // videos and sources
    document.querySelectorAll("video, video source, source[src]").forEach((el) => {
      pushIfVideo(el.src || el.currentSrc || el.getAttribute("src"));
    });
    document.querySelectorAll('a[href*="redgifs"], a[href*="redd.it"], a[href*="v.redd"] ').forEach((el) => {
      const href = el.getAttribute("href") || el.href;
      pushIfVideo(href);
    });
    document.querySelectorAll('img[src*="preview.redd.it"]').forEach((el) => {
      const src = el.getAttribute("src") || el.src;
      if (src && /format=mp4/i.test(src)) pushIfVideo(src);
    });

    // scripts regex
    const scripts = Array.from(document.querySelectorAll("script"));
    const patterns = [
      /https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mpd|gif)(?:[^\s"'<>]*)/gi,
      /https?:\/\/v\.redd\.it\/[^\s"'<>]+/gi,
      /https?:\/\/(?:www\.)?redgifs\.com\/(?:watch|ifr)\/[^\s"'<>]+/gi,
      /https?:\/\/preview\.redd\.it\/[^\s"'<>]*format=mp4[^\s"'<>]*/gi,
    ];
    for (const script of scripts) {
      const text = (script.textContent || "").replace(/\\\//g, "/");
      if (!text) continue;
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text))) {
          pushIfVideo(match[0]);
        }
      }
    }

    // deep scan window objects if any reddit state leaked
    try {
      const seen = new WeakSet();
      const scan = (node, depth = 0) => {
        if (depth > 6 || node == null) return;
        if (typeof node === "string") {
          pushIfVideo(node);
          return;
        }
        if (typeof node !== "object") return;
        if (seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
          for (const item of node) scan(item, depth + 1);
          return;
        }
        for (const v of Object.values(node)) scan(v, depth + 1);
      };
      if (window.___r) scan(window.___r);
      if (window.__PRELOADED_STATE__) scan(window.__PRELOADED_STATE__);
    } catch {}

    return Array.from(out);
  });

  const urls = [];
  const seen = new Set();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const cleaned = stripByteRangeParams(String(raw || "").trim());
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  // extract redgifs ids
  const redgifsIds = [];
  const seenIds = new Set();
  for (const url of urls) {
    const m = String(url).match(/redgifs\.com\/(?:watch|ifr)\/([^/?#&]+)/i);
    if (m && m[1] && !seenIds.has(m[1])) {
      seenIds.add(m[1]);
      redgifsIds.push(m[1]);
    }
  }
  // also scan all urls again for watch ids in page content via separate evaluate already covered, but keep
  return { urls, redgifsIds };
}

async function fetchRedgifsMediaUrls(page, redgifsId) {
  if (!redgifsId) return [];
  try {
    const result = await page.evaluate(async (id) => {
      const urls = new Set();
      const add = (u) => {
        if (!u) return;
        try {
          const abs = new URL(u, location.href).href;
          if (
            /\.(mp4|m3u8|mpd|webm)(\?|$)/i.test(abs) ||
            /redgifs\.com/i.test(abs) ||
            /media\.redgifs\.com/i.test(abs)
          ) {
            urls.add(abs);
          }
        } catch {}
      };
      // try api.redgifs.com/v2/gifs/<id>
      try {
        const apiUrl = `https://api.redgifs.com/v2/gifs/${encodeURIComponent(id)}`;
        const resp = await fetch(apiUrl, { method: "GET" });
        if (resp.ok) {
          const json = await resp.json().catch(() => null);
          const gif = json && (json.gif || (json.gifs && json.gifs[0]) || json);
          const deepScan = (node, depth = 0) => {
            if (depth > 6 || node == null) return;
            if (typeof node === "string") {
              add(node);
              return;
            }
            if (typeof node !== "object") return;
            if (Array.isArray(node)) {
              node.forEach((x) => deepScan(x, depth + 1));
              return;
            }
            for (const v of Object.values(node)) deepScan(v, depth + 1);
          };
          if (gif) deepScan(gif);
          // also try direct fields
          if (gif && gif.urls) {
            if (gif.urls.hd) add(gif.urls.hd);
            if (gif.urls.sd) add(gif.urls.sd);
            if (gif.urls.vthumbnail) add(gif.urls.vthumbnail);
          }
          if (gif && gif.files) {
            for (const f of Object.values(gif.files)) deepScan(f);
          }
        }
      } catch {}
      // fallback: fetch watch page html
      try {
        const watchUrl = `https://www.redgifs.com/watch/${encodeURIComponent(id)}`;
        const resp2 = await fetch(watchUrl, { method: "GET" });
        if (resp2.ok) {
          const html = await resp2.text();
          const patterns = [
            /https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/media\.redgifs\.com\/[^\s"'<>]+/gi,
          ];
          for (const pat of patterns) {
            pat.lastIndex = 0;
            let m;
            while ((m = pat.exec(html))) add(m[0]);
          }
        }
      } catch {}
      return Array.from(urls);
    }, redgifsId);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

module.exports = {
  extractXhamsterMediaData,
  extractXvideosMediaUrls,
  extractPornhubMediaData,
  getInstagramUsername,
  getInstagramUsernameFromOembed,
  extractRedditMediaData,
  fetchRedgifsMediaUrls,
};
