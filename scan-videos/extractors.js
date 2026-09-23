const {
  stripByteRangeParams,
  metadataQualityScore,
  sanitizeFileToken,
} = require("./media-utils");
const { isReservedInstagramName, isInstagramAvatarUrl } = require("./instagram-utils");

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
      // current player uses sUrl* aliases (xVideos + XNXX share this player)
      pushIfMedia(player.sUrlHigh);
      pushIfMedia(player.sUrlLow);
      pushIfMedia(player.sUrlHls);
      pushIfMedia(player.sUrlDash);
      pushIfMedia(player.sVideoUrl);
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

async function extractKvsMediaData(page) {
  // Kernel Video Sharing (KVS) player — used by PornTrex, Txxx and many
  // clones. The page embeds `var flashvars = { video_url: "...",
  // video_alt_url: "...", ... }` plus a `kt_player` div. Live-verified on
  // porntrex.com 2026-09-23 (video_url at ~351k, kt_player present).
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

    const out = [];
    const seen = new Set();
    const push = (value, quality = "") => {
      const url = toAbsolute(value);
      if (!url) return;
      if (!/\.(mp4|webm|mov|mkv|avi|flv|m3u8|mpd)(\?|$)/i.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ url, quality: String(quality || "") });
    };

    // flashvars may live on window or only inside script text
    try {
      const fv = window.flashvars;
      if (fv && typeof fv === "object") {
        push(fv.video_url, fv.video_url_text || fv.quality || "");
        push(fv.video_alt_url, fv.video_alt_url_text || "");
        push(fv.video_alt_url2, fv.video_alt_url2_text || "");
        push(fv.hls_url || fv.hlsUrl, "hls");
        if (Array.isArray(fv.video_versions)) {
          for (const v of fv.video_versions) {
            if (v && typeof v === "object") push(v.url, v.label || v.quality || "");
          }
        }
      }
    } catch {}

    const scripts = Array.from(document.querySelectorAll("script"));
    const patterns = [
      /["']video_url["']\s*:\s*["']([^"']+)["']/g,
      /["']video_alt_url\d*["']\s*:\s*["']([^"']+)["']/g,
      /["']hls_url["']\s*:\s*["']([^"']+)["']/g,
      /https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mpd)(?:[^\s"'<>]*)/gi,
    ];

    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text) continue;
      if (!/video_url|flashvars|kt_player|\.mp4|\.m3u8/i.test(text)) continue;
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text))) {
          push(match[1] || match[0]);
        }
      }
    }

    // <video><source> fallback (some KVS skins render sources directly)
    document.querySelectorAll("video source[src], video[src]").forEach((el) => {
      push(el.getAttribute("src") || el.src || "");
    });

    return out;
  });

  const urls = [];
  const qualityByUrl = new Map();
  const seen = new Set();
  for (const entry of Array.isArray(result) ? result : []) {
    const cleaned = stripByteRangeParams(entry && entry.url ? entry.url : "");
    if (!cleaned) continue;
    const score = metadataQualityScore({ quality: entry.quality });
    const current = Number(qualityByUrl.get(cleaned) || 0);
    if (score > current) qualityByUrl.set(cleaned, score);
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return { urls, qualityByUrl };
}

async function extractEpornerMediaData(page) {
  // Eporner serves sources via an in-page `/xhr/video/<id>?hash=...` JSON
  // endpoint (live-verified 2026-09-23). Fetch it in page context (carries
  // cookies) and deep-scan the JSON for mp4/m3u8/mpd URLs.
  let entries = [];
  try {
    entries = await page.evaluate(async () => {
      const out = [];
      const seen = new Set();
      const push = (value) => {
        if (typeof value !== "string" || !value) return;
        const normalized = value.replace(/\\\//g, "/").trim();
        if (!/\.(mp4|m3u8|mpd)(\?|$)/i.test(normalized)) return;
        try {
          const abs = new URL(normalized, location.href).href;
          if (seen.has(abs)) return;
          seen.add(abs);
          out.push(abs);
        } catch {}
      };
      const scan = (node, depth = 0) => {
        if (depth > 6 || node == null) return;
        if (typeof node === "string") {
          push(node);
          return;
        }
        if (typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const item of node) scan(item, depth + 1);
          return;
        }
        for (const v of Object.values(node)) scan(v, depth + 1);
      };

      // find the xhr endpoint: performance resources first, else page HTML
      let xhrUrl = "";
      try {
        const resources = performance.getEntriesByType("resource").map((r) => r.name);
        xhrUrl = resources.find((u) => /\/xhr\/video\//i.test(u)) || "";
      } catch {}
      if (!xhrUrl) {
        try {
          const m = document.documentElement.innerHTML.match(/(\/xhr\/video\/[^"'\s<>]+)/i);
          if (m) xhrUrl = new URL(m[1], location.href).href;
        } catch {}
      }
      if (!xhrUrl) return out;
      try {
        const resp = await fetch(xhrUrl, { credentials: "include" });
        if (!resp.ok) return out;
        const json = await resp.json().catch(() => null);
        scan(json);
      } catch {}
      return out;
    });
  } catch {
    entries = [];
  }

  const urls = [];
  const qualityByUrl = new Map();
  const seen = new Set();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const cleaned = stripByteRangeParams(String(raw || "").trim());
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return { urls, qualityByUrl };
}

async function extractBeegMediaData(page) {
  // Beeg serves video data via `store.externulls.com/facts/file/<fileId>`
  // (no tag param needed). `file.fallback` is a signed direct-mp4 path and
  // `file.hls_resources.fl_cdn_multi` a multi-bitrate HLS template (`_TPL_`
  // resolves to e.g. 720p). Both live under `https://video.beeg.com/`.
  // Live-verified 2026-09-23 (m3u8 200s on video.beeg.com).
  let entries = [];
  try {
    entries = await page.evaluate(async () => {
      const out = [];
      const m = String(location.href).match(/(\d{12,})/);
      const fileId = m ? m[1] : "";
      if (!fileId) return out;
      const push = (value) => {
        if (!value) return;
        try {
          const abs = new URL(String(value), "https://video.beeg.com/").href;
          if (/\.(mp4|m3u8|mpd)(\?|$)/i.test(abs)) out.push(abs);
        } catch {}
      };
      try {
        const resp = await fetch(
          `https://store.externulls.com/facts/file/${encodeURIComponent(fileId)}`,
          { credentials: "omit" }
        );
        if (!resp.ok) return out;
        const json = await resp.json().catch(() => null);
        const file = json && json.file ? json.file : null;
        if (!file) return out;
        if (file.fallback) push(`https://video.beeg.com/${String(file.fallback).replace(/^\/+/, "")}`);
        const multi =
          (file.hls_resources && file.hls_resources.fl_cdn_multi) ||
          (file.hls_resources_tmp && file.hls_resources_tmp.fl_cdn_multi) ||
          "";
        if (multi) {
          const clean = String(multi).replace(/^\/+/, "");
          // _TPL_ template → concrete ladder entries the downloader can fetch
          for (const q of ["720p", "480p"]) {
            push(`https://video.beeg.com/${clean.replace("_TPL_", q)}`);
          }
        }
      } catch {}
      return out;
    });
  } catch {
    entries = [];
  }

  const urls = [];
  const qualityByUrl = new Map();
  const seen = new Set();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const cleaned = stripByteRangeParams(String(raw || "").trim());
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return { urls, qualityByUrl };
}

async function extractSpankbangMediaData(page) {
  // SpankBang exposes `window.stream_data`: a quality-keyed map
  // ({"240p": [mp4...], "1080p": [mp4...], "m3u8": [...], ...}) on
  // sb-cd.com CDNs. Live-verified 2026-09-23.
  const entries = await page.evaluate(() => {
    const out = [];

    const toAbsolute = (value) => {
      if (!value) return "";
      const normalized = String(value).trim();
      if (!normalized) return "";
      try {
        return new URL(normalized, location.href).href;
      } catch {
        return "";
      }
    };

    const push = (value, quality = "") => {
      const url = toAbsolute(value);
      if (!url) return;
      if (!/\.(mp4|webm|mov|mkv|avi|flv|m3u8|mpd)(\?|$)/i.test(url)) return;
      out.push({ url, quality: String(quality || "") });
    };

    try {
      const sd = window.stream_data;
      if (sd && typeof sd === "object") {
        for (const [quality, list] of Object.entries(sd)) {
          const urls = Array.isArray(list) ? list : [list];
          for (const u of urls) push(u, quality);
        }
      }
    } catch {}

    document.querySelectorAll("video source[src], video[src]").forEach((el) => {
      push(el.getAttribute("src") || el.src || "");
    });

    return out;
  });

  const urls = [];
  const qualityByUrl = new Map();
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const cleaned = stripByteRangeParams(entry && entry.url ? entry.url : "");
    if (!cleaned) continue;
    const score = metadataQualityScore({ quality: entry.quality });
    const current = Number(qualityByUrl.get(cleaned) || 0);
    if (score > current) qualityByUrl.set(cleaned, score);
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return { urls, qualityByUrl };
}

async function extractJavMediaData(page) {
  // Shared extractor for JAV tubes (plan 036 §9). Two player families:
  // A) Direct/self-hosted (MissAV surrit HLS, JAVtiful fast-stream source,
  //    BestJavPorn data-mediabook mp4s) — collected from DOM + scripts.
  // B) Click-to-load hoster buttons (SupJav server tabs, JavGuru
  //    wp-btn-iframe, JAVMost select_part, BestJavPorn play-button,
  //    SexTB V.I.P) — clicked so the embed (and its HLS/mp4) loads and the
  //    engine's network interception captures the stream. Hoster embeds
  //    themselves (dood/filemoon/voe/...) resolve via generic capture.
  // Live-verified per-site 2026-09-23 (see plan 036 §3).
  const found = await page.evaluate(async () => {
    const out = [];
    const seen = new Set();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const toAbsolute = (value) => {
      if (!value) return "";
      const normalized = String(value).replace(/\\\//g, "/").trim();
      if (!normalized || normalized.startsWith("javascript:") || normalized.startsWith("data:")) return "";
      try {
        return new URL(normalized, location.href).href;
      } catch {
        return "";
      }
    };

    const push = (value) => {
      const url = toAbsolute(value);
      if (!url || seen.has(url)) return;
      // media by extension, or known extensionless JAV CDNs (jav.si /p/)
      const mediaLike =
        /\.(mp4|webm|mov|mkv|avi|flv|m3u8|mpd)(\?|$)/i.test(url) ||
        /jav\.si\/p\//i.test(url);
      if (!mediaLike) return;
      seen.add(url);
      out.push(url);
    };

    // page video code (e.g. ksbj-379, mida-180) — used to keep only the
    // target's data-mediabook mp4s, never related videos' previews
    const pageCode = (() => {
      const m = location.pathname.match(/([a-z]+-?\d+[a-z]*)/i);
      return m ? m[1].replace(/-/g, "").toLowerCase() : "";
    })();

    // A) direct sources already in DOM
    document.querySelectorAll("video source[src], video[src]").forEach((el) => {
      push(el.getAttribute("src") || el.src || "");
    });
    document.querySelectorAll("[data-mediabook]").forEach((el) => {
      const raw = el.getAttribute("data-mediabook") || "";
      if (!pageCode) return;
      const norm = raw.replace(/-/g, "").toLowerCase();
      if (norm.includes(pageCode)) push(raw);
    });

    // A) script regex (surrit/tsyndicate/jav.si/mp4/m3u8)
    const scripts = Array.from(document.querySelectorAll("script"));
    const patterns = [
      /https?:\/\/[^\s"'<>]*surrit\.com[^\s"'<>]*\.(?:m3u8|mp4)[^\s"'<>]*/gi,
      /https?:\/\/[^\s"'<>]*jav\.si\/p\/[^\s"'<>]*/gi,
      /https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mpd)(?:[^\s"'<>]*)/gi,
    ];
    for (const script of scripts) {
      const text = (script.textContent || "").replace(/\\\//g, "/");
      if (!text) continue;
      if (!/surrit|jav\.si|\.mp4|\.m3u8|pornfhd|1024cdn/i.test(text)) continue;
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        let guard = 0;
        while ((match = pattern.exec(text)) && guard++ < 50) {
          const url = match[0];
          // skip ad/tracker creatives
          if (/twinrdengine|diffusedpassion|myavlive|fluxtrck|whitetrafsa|mayzaent|mnaspm|eix304|adtng|trafficjunky/i.test(url)) continue;
          push(url);
        }
      }
    }

    // B) click-to-load hoster buttons so embeds (and their streams) load
    const clickables = [];
    document.querySelectorAll("a, button").forEach((el) => {
      const text = (el.textContent || "").trim();
      const cls = String(el.className || "");
      if (
        /wp-btn-iframe__shortcode/i.test(cls) ||
        /play-button/i.test(cls) ||
        /^(server\s*\d*|part\s*\d+|stream\s*\w*|watch\s*\w*)$/i.test(text) ||
        /^(tv|fst|st|voe|dood|filemoon|streamtape|mixdrop)$/i.test(text)
      ) {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) clickables.push(el);
        } catch {}
      }
    });
    for (const el of clickables.slice(0, 5)) {
      try {
        el.click();
        await sleep(1200);
        document.querySelectorAll("video source[src], video[src]").forEach((node) => {
          push(node.getAttribute("src") || node.src || "");
        });
      } catch {}
    }

    return out;
  });

  const urls = [];
  const qualityByUrl = new Map();
  const seen = new Set();
  for (const raw of Array.isArray(found) ? found : []) {
    const cleaned = stripByteRangeParams(String(raw || "").trim());
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return { urls, qualityByUrl };
}

async function extractPornhubMediaData(page) {
  // Pornhub player (flashvars/mediaDefinitions/get_media). RedTube/YouPorn
  // have moved to a lazy player without flashvars — those rely on generic
  // DOM + network auto-capture instead of this extractor.
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

async function extractInstagramPhotoData(page) {
  let domImages = [];
  try {
    domImages = await page.evaluate(async () => {
      const out = [];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const toAbs = (value) => {
        if (!value) return "";
        const normalized = String(value).replace(/&amp;/g, "&").trim();
        if (!normalized) return "";
        try {
          return new URL(normalized, location.href).href;
        } catch {
          return "";
        }
      };
      const isPostHost = (url) => {
        let host = "";
        try {
          host = new URL(url).hostname.toLowerCase();
        } catch {
          return false;
        }
        return /cdninstagram\.com$/i.test(host) || /fbcdn\.net$/i.test(host);
      };
      const isStill = (url) => /\.(jpe?g|png|webp|avif|bmp)(\?|$)/i.test(url);
      // "url1 640w, url2 1080w" or "url1 1x, url2 2x" -> largest
      const largestFromSrcset = (srcset) => {
        let best = "";
        let bestScore = -1;
        for (const part of String(srcset || "").split(",")) {
          const tokens = part.trim().split(/\s+/).filter(Boolean);
          if (!tokens.length) continue;
          let score = 0;
          const desc = tokens[1] || "";
          const m = desc.match(/^([\d.]+)(w|x)$/i);
          if (m) score = Number(m[1]) * (m[2].toLowerCase() === "x" ? 1000 : 1);
          if (score >= bestScore) {
            bestScore = score;
            best = tokens[0];
          }
        }
        return best;
      };
      const isVisible = (el) => {
        try {
          const rect = el.getBoundingClientRect();
          return rect && rect.width >= 0 && rect.height >= 0;
        } catch {
          return true;
        }
      };
      const collect = () => {
        document.querySelectorAll("img[src], img[srcset]").forEach((el) => {
          // skip tiny chrome (avatars/icons): keep only post-sized renders
          try {
            const rect = el.getBoundingClientRect();
            if (rect && rect.width > 0 && rect.width < 150) return;
          } catch {}
          if (el.naturalWidth > 0 && el.naturalWidth < 150) return;
          const fromSrcset = largestFromSrcset(el.getAttribute("srcset"));
          if (fromSrcset) {
            const abs = toAbs(fromSrcset);
            if (abs && isPostHost(abs) && isStill(abs)) out.push(abs);
          } else {
            const abs = toAbs(el.getAttribute("src") || el.src || "");
            if (abs && isPostHost(abs) && isStill(abs)) out.push(abs);
          }
        });
      };
      collect();
      // Carousel walk: later slides only load when advanced. Prefer the
      // post article's Next button, else scroll the horizontal overflow
      // container. Bounded so a stuck carousel can't hang the download.
      for (let step = 0; step < 10; step += 1) {
        const before = out.length;
        let advanced = false;
        const nextBtn =
          document.querySelector("article button[aria-label=\"Next\"]") ||
          document.querySelector("main button[aria-label=\"Next\"]");
        if (nextBtn && isVisible(nextBtn)) {
          try {
            nextBtn.click();
            advanced = true;
          } catch {}
        } else {
          const scroller = Array.from(document.querySelectorAll("article div, main div")).find(
            (el) => el.scrollWidth > el.clientWidth + 10 && el.querySelector("img[src]")
          );
          if (scroller && scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 5) {
            try {
              scroller.scrollBy({ left: scroller.clientWidth, behavior: "instant" });
              advanced = true;
            } catch {}
          }
        }
        if (!advanced) break;
        await sleep(900);
        collect();
        if (out.length === before) {
          // one more beat for lazy images, then stop if still nothing new
          await sleep(900);
          collect();
          if (out.length === before) break;
        }
      }
      return out;
    });
  } catch {
    domImages = [];
  }

  // og:image / twitter:image carry the post cover in static HTML,
  // even on the logged-out/app-gated view.
  let metaImages = [];
  try {
    const html = await page.content().catch(() => "");
    if (html) {
      const patterns = [
        /<meta[^>]+property=["']og:image["'][^>]*>/gi,
        /<meta[^>]+name=["']twitter:image["'][^>]*>/gi,
      ];
      for (const pattern of patterns) {
        let m;
        while ((m = pattern.exec(html))) {
          const cm = m[0].match(/content=["']([^"']+)/i);
          if (cm && cm[1]) metaImages.push(cm[1].replace(/&amp;/g, "&").trim());
        }
      }
    }
  } catch {
    metaImages = [];
  }

  const clean = (list) => {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
      const cleaned = stripByteRangeParams(String(raw || "").trim());
      if (!cleaned) continue;
      if (!/\.(jpe?g|png|webp|avif|bmp)(\?|$)/i.test(cleaned)) continue;
      if (isInstagramAvatarUrl(cleaned)) continue;
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
    return out;
  };

  return { imageUrls: clean(domImages), metaImages: clean(metaImages) };
}

async function extractRedditMediaData(page, postId) {
  const entries = await page.evaluate((targetPostId) => {
    const out = new Set();
    const imageOut = new Set();
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

    // General avatar/profile-pic guard (no hardcoded URLs): author avatars,
    // comment avatars and community icons are never the post's media.
    const isAvatarImg = (el) => {
      if (!el) return false;
      try {
        if (
          typeof el.closest === "function" &&
          el.closest(
            'faceplate-avatar,[data-testid*="avatar" i],.avatar,[class*="avatar" i],[id*="avatar" i]'
          )
        )
          return true;
      } catch {}
      try {
        const alt =
          String(el.alt || "") ||
          String((el.getAttribute && el.getAttribute("alt")) || "");
        if (/avatar|profile\s*pic|user\s*pic|snoo/i.test(alt)) return true;
      } catch {}
      try {
        const r =
          typeof el.getBoundingClientRect === "function"
            ? el.getBoundingClientRect()
            : null;
        // Avatars render tiny (16-48px); post media renders far larger.
        if (r && r.width > 0 && r.width < 64 && r.height > 0 && r.height < 64)
          return true;
      } catch {}
      return false;
    };

    const toAbsImg = (value) => toAbs(value);
    // In page-wide fallback mode there is no post scoping, so be strict:
    // preview.redd.it sidebar/ad thumbnails carry tiny width params
    // (width=320 and below) — never the post's own media. Skipping them
    // beats downloading ads when the targeted .json lookup came up empty.
    const isTinyPreviewThumb = (url) => {
      try {
        const u = new URL(url);
        if (!/preview\.redd\.it$/i.test(u.hostname)) return false;
        const w = Number(u.searchParams.get("width") || 0);
        return w > 0 && w <= 320;
      } catch {
        return false;
      }
    };
    const pushIfImage = (value, el, strict) => {
      const url = toAbsImg(value);
      if (!url) return;
      if (/\.gif(\?|$)/i.test(url)) return; // gif via video flow
      if (strict && isTinyPreviewThumb(url)) return;
      if (/\.(jpe?g|png|webp|avif|bmp)(\?|$)/i.test(url)) {
        if (el && isAvatarImg(el)) return;
        imageOut.add(url);
      }
    };

    // Scope DOM scraping to the target post element. Page-wide scans pick up
    // sidebar/related-post/comment content (avatars, other posts' media).
    let scope = null;
    try {
      const wanted = String(targetPostId || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      if (wanted) {
        const posts = Array.from(
          document.querySelectorAll("shreddit-post[permalink]") || []
        );
        const re = new RegExp("/comments/" + wanted + "([/?#]|$)");
        for (const p of posts) {
          const pl = String(
            (p.getAttribute && p.getAttribute("permalink")) || ""
          ).toLowerCase();
          if (pl && re.test(pl)) {
            scope = p;
            break;
          }
        }
      }
    } catch {}
    const scoped = !!scope;
    const qsa = (root, sel) => {
      try {
        return Array.from((root || document).querySelectorAll(sel) || []);
      } catch {
        return [];
      }
    };

    const collectDom = (root, strict) => {
      // the scope element's own content-href (descendant query misses self)
      try {
        if (
          root &&
          root !== document &&
          root.getAttribute &&
          root.getAttribute("content-href")
        ) {
          const href = root.getAttribute("content-href");
          pushIfVideo(href);
          pushIfImage(href, null, strict);
        }
      } catch {}
      // shreddit-post content-href
      qsa(root, "shreddit-post[content-href]").forEach((el) => {
        let href = null;
        try {
          href = el.getAttribute("content-href");
        } catch {}
        if (href) {
          pushIfVideo(href);
          pushIfImage(href, null, strict);
        }
      });

      // videos and sources
      qsa(root, "video, video source, source[src]").forEach((el) => {
        let src = "";
        try {
          src = el.src || el.currentSrc || el.getAttribute("src") || "";
        } catch {}
        pushIfVideo(src);
      });
      qsa(root, 'a[href*="redgifs"], a[href*="redd.it"], a[href*="v.redd"] ').forEach((el) => {
        let href = "";
        try {
          href = el.getAttribute("href") || el.href || "";
        } catch {}
        pushIfVideo(href);
        pushIfImage(href, el, strict);
      });
      qsa(root, 'img[src*="preview.redd.it"]').forEach((el) => {
        let src = "";
        try {
          src = el.getAttribute("src") || el.src || "";
        } catch {}
        if (src && /format=mp4/i.test(src)) pushIfVideo(src);
      });
      // still images (gallery / single): i.redd.it, preview.redd.it, external-preview
      qsa(root, "img[src]").forEach((el) => {
        let src = "";
        try {
          src = el.getAttribute("src") || el.src || "";
        } catch {}
        if (!src) return;
        if (/i\.redd\.it\//i.test(src) || /preview\.redd\.it\//i.test(src) || /external-preview\.redd\.it\//i.test(src)) {
          pushIfImage(src, el, strict);
        }
      });
    };

    collectDom(scope || document, !scope);
    // Scoped element found but yielded no media (unusual layout): fall back to
    // page-wide so we never do worse than the old unscoped behavior.
    const scopedOk = !scoped || out.size > 0 || imageOut.size > 0;
    if (!scopedOk) collectDom(document, true);

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

    // deep scan window objects if any reddit state leaked.
    // Page-global state is unscoped, so apply the strict tiny-thumb filter
    // whenever the DOM pass wasn't post-scoped.
    const stateStrict = !scopedOk;
    try {
      const seen = new WeakSet();
      const scan = (node, depth = 0) => {
        if (depth > 6 || node == null) return;
        if (typeof node === "string") {
          pushIfVideo(node);
          pushIfImage(node, null, stateStrict);
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

    return { videos: Array.from(out), images: Array.from(imageOut), scoped: scopedOk && scoped };
  }, postId);

  const rawVideos = Array.isArray(entries?.videos) ? entries.videos : Array.isArray(entries) ? entries : [];
  const rawImages = Array.isArray(entries?.images) ? entries.images : [];
  const urls = [];
  const seen = new Set();
  for (const raw of rawVideos) {
    const cleaned = stripByteRangeParams(String(raw || "").trim());
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  const imageUrls = [];
  const seenImg = new Set();
  for (const raw of rawImages) {
    const cleaned = stripByteRangeParams(String(raw || "").trim());
    if (!cleaned) continue;
    if (/\.gif(\?|$)/i.test(cleaned)) continue;
    if (!/\.(jpe?g|png|webp|avif|bmp)(\?|$)/i.test(cleaned)) continue;
    if (seenImg.has(cleaned)) continue;
    seenImg.add(cleaned);
    imageUrls.push(cleaned);
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
  return { urls, redgifsIds, imageUrls, scoped: entries?.scoped === true };
}

// Pornhub's flashvars mediaDefinitions carry one extensionless
// `/video/get_media` entry (format "mp4") alongside the HLS variants.
// Fetched with the page's cookies it resolves to the target video's direct
// mp4 URLs — the correct mp4 fallback when HLS fails. Without this the only
// mp4 candidates on the page are ad creatives.
async function expandPornhubGetMediaUrls(page, urls) {
  const targets = Array.isArray(urls) ? urls.filter((u) => /\/video\/get_media\b/i.test(String(u || ""))).slice(0, 3) : [];
  if (!targets.length) return { urls: [], qualityByUrl: new Map() };

  let entries = [];
  try {
    entries = await page.evaluate(async (getMediaUrls) => {
      const out = [];
      for (const getMediaUrl of getMediaUrls) {
        try {
          const response = await fetch(getMediaUrl, { method: "GET", credentials: "include" });
          if (!response.ok) continue;
          const payload = await response.json().catch(() => null);
          const list = Array.isArray(payload) ? payload : payload && Array.isArray(payload.mediaDefinitions) ? payload.mediaDefinitions : [];
          for (const item of list) {
            if (!item || typeof item !== "object") continue;
            const videoUrl = item.videoUrl || item.url || item.src || item.file || "";
            if (!videoUrl) continue;
            out.push({
              url: String(videoUrl),
              height: Number(item.height || 0) || 0,
              width: Number(item.width || 0) || 0,
              quality: String(item.quality || ""),
              label: String(item.label || ""),
            });
          }
        } catch {
          // ignore per-URL failures; HLS candidates still stand
        }
      }
      return out;
    }, targets);
  } catch {
    entries = [];
  }

  const resultUrls = [];
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
    resultUrls.push(cleaned);
  }

  return { urls: resultUrls, qualityByUrl };
}

async function fetchRedgifsMediaUrls(page, redgifsId) {  if (!redgifsId) return [];
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
  extractKvsMediaData,
  extractEpornerMediaData,
  extractBeegMediaData,
  extractSpankbangMediaData,
  extractJavMediaData,
  extractPornhubMediaData,
  expandPornhubGetMediaUrls,
  getInstagramUsername,
  getInstagramUsernameFromOembed,
  extractInstagramPhotoData,
  extractRedditMediaData,
  fetchRedgifsMediaUrls,
};
