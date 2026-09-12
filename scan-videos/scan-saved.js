const {
  isRedditSavedUrl,
  extractRedditPostId,
} = require("./reddit-utils");

function normalizeComparableUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    parsed.hash = "";
    const href = parsed.href.replace(/\/+$/, "");
    return href;
  } catch {
    return "";
  }
}

function extractIdFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    // reddit
    if (/(^|\.)reddit\.com$/i.test(parsed.hostname)) {
      const m = parsed.pathname.match(/\/comments\/([^/?#]+)\/?/i);
      if (m) return String(m[1] || "").trim();
    }
    const match = parsed.pathname.match(/^\/(?:reel|p|tv)\/([^/?#]+)\/?/i);
    if (match) return String(match[1] || "").trim();

    const parts = parsed.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    if (!parts.length) return "";
    return parts[parts.length - 1];
  } catch {
    return "";
  }
}

function extractStopId(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";

  const fromUrl = extractIdFromUrl(value);
  if (fromUrl) return fromUrl;

  const parts = value
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) return "";
  return parts[parts.length - 1];
}

function toUniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readItemsOnPage(page) {
  return page.evaluate(() => {
    const isPostUrl = (href) => /^https:\/\/[^/]*instagram\.com\/(?:p|reel|tv)\/[^/?#]+/i.test(String(href || ""));
    const rootAnchors = document.querySelectorAll("._ac7v.x1ty9z65.xzboxd6 a[href]");
    const anchors = rootAnchors.length ? rootAnchors : document.querySelectorAll("a[href]");
    const urls = Array.from(anchors)
      .map((anchor) => (anchor && typeof anchor.href === "string" ? anchor.href.trim() : ""))
      .filter((href) => href && isPostUrl(href));

    return {
      urls,
      count: urls.length,
    };
  });
}

async function readRedditItemsOnPage(page) {
  return page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll("shreddit-post[permalink]").forEach((el) => {
      const perm = el.getAttribute("permalink");
      if (perm) {
        try {
          const full = new URL(perm, location.href).href;
          const u = new URL(full);
          // must have /comments/
          if (/\/r\/[^/]+\/comments\/[^/?#]+\/?/i.test(u.pathname) || /\/comments\/[^/?#]+\/?/i.test(u.pathname)) {
            u.search = "";
            u.hash = "";
            out.add(u.href.replace(/\/+$/, ""));
          }
        } catch {}
      }
    });
    // fallback anchors
    document.querySelectorAll("a[href]").forEach((a) => {
      try {
        const href = a.href;
        if (!href) return;
        const u = new URL(href, location.href);
        if (!/(^|\.)reddit\.com$/i.test(u.hostname)) return;
        if (!/\/r\/[^/]+\/comments\/[^/?#]+\/?/i.test(u.pathname) && !/\/comments\/[^/?#]+\/?/i.test(u.pathname)) return;
        u.search = "";
        u.hash = "";
        out.add(u.href.replace(/\/+$/, ""));
      } catch {}
    });
    const urls = Array.from(out);
    return { urls, count: urls.length };
  });
}

async function scrollToBottom(page) {
  return page.evaluate(() => {
    const isScrollable = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const overflowY = String(style.overflowY || "").toLowerCase();
      const allowsScroll = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
      return allowsScroll && el.scrollHeight > el.clientHeight + 20;
    };

    const scrollingElement = document.scrollingElement || document.documentElement || document.body;
    const candidates = [scrollingElement, ...Array.from(document.querySelectorAll("main, section, article, div"))];

    for (const node of candidates) {
      if (!isScrollable(node)) continue;
      node.scrollTop = node.scrollHeight;
    }

    window.scrollTo(0, Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0));
  });
}

async function scanInstagramSavedPage(options = {}) {
  const browser = options.browser;
  if (!browser) {
    throw new Error("Missing browser instance.");
  }

  const targetUrl = String(options.targetUrl || "").trim();
  if (!targetUrl) {
    throw new Error("Target URL is required.");
  }

  const log = typeof options.log === "function" ? options.log : () => {};
  const waitMs = Number.isFinite(Number(options.waitMs)) && Number(options.waitMs) > 0
    ? Math.floor(Number(options.waitMs))
    : 2000;
  const exitWaitMs = Number.isFinite(Number(options.exitWaitMs)) && Number(options.exitWaitMs) > 0
    ? Math.floor(Number(options.exitWaitMs))
    : 4500;
  const maxIterations = Number.isFinite(Number(options.maxIterations)) && Number(options.maxIterations) > 0
    ? Math.floor(Number(options.maxIterations))
    : 1200;
  const stopUrls = toUniqueStrings(Array.isArray(options.endUrls) ? options.endUrls : []);
  const stopIdSet = new Set(stopUrls.map((value) => extractStopId(value)).filter(Boolean));
  const stopUrlSet = new Set(stopUrls.map((url) => normalizeComparableUrl(url)).filter(Boolean));
  const collectedUrls = new Set();
  const matchedStopUrls = new Set();
  const matchedStopIds = new Set();
  const page = await browser.newPage();
  if (!(browser && browser.__isCdp)) {
    try { await page.bringToFront().catch(() => {}); } catch {}
  }

  let reason = "max_iterations";
  let iterations = 0;

  try {
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

    const isCdp = Boolean(browser && browser.__isCdp);
    let response = null;
    if (isCdp) {
      log(`CDP browser — using domcontentloaded for ${targetUrl}`);
      try {
        response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (e) {
        log(`domcontentloaded failed: ${e.message} — checking page state`);
        const curUrl = page.url();
        if (curUrl && curUrl !== "about:blank") {
          log(`proceeding despite goto timeout — page url is ${curUrl}`);
        } else {
          throw e;
        }
      }
    } else {
      try {
        response = await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });
      } catch (e) {
        const msg = String(e && e.message || e);
        const isTimeout = /timeout/i.test(msg) && /navigation/i.test(msg);
        if (isTimeout) {
          log(`page.goto networkidle2 timed out, trying domcontentloaded fallback: ${msg}`);
          try {
            response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          } catch (e2) {
            log(`domcontentloaded also failed: ${e2.message} — checking page state`);
            const curUrl = page.url();
            if (curUrl && curUrl !== "about:blank") {
              log(`proceeding despite goto timeout — page url is ${curUrl}`);
            } else {
              throw e2;
            }
          }
        } else {
          throw e;
        }
      }
    }
    if (!(browser && browser.__isCdp)) {
    try { await page.bringToFront().catch(() => {}); } catch {}
  }
    const status = response && typeof response.status === "function" ? response.status() : 0;
    if (status === 429) {
      log("Instagram saved-page scan got 429.");
      const error = new Error("Instagram responded with 429 during saved-page scan. Cancelling this job now.");
      error.status = 429;
      throw error;
    }

    const openedUrl = page.url();
    const targetLooksSaved = /\/saved\//i.test(targetUrl);
    const openedLooksSaved = /\/saved\//i.test(openedUrl);
    if (targetLooksSaved && !openedLooksSaved) {
      throw new Error(
        `Instagram redirected from saved page to ${openedUrl}. Make sure this browser profile is logged into the same account that owns the saved collection.`
      );
    }

    const noIncreaseTimeoutMs = 5000;
    const increaseDelayMs = 1000;
    let lastSeenCount = 0;
    let lastIncreaseAt = Date.now();

    for (let index = 0; index < maxIterations; index += 1) {
      iterations = index + 1;

      const pass = await readItemsOnPage(page);
      const beforeSize = collectedUrls.size;
      let newCount = 0;

      for (const url of pass.urls) {
        if (!collectedUrls.has(url)) {
          collectedUrls.add(url);
          newCount += 1;
        }

        const normalized = normalizeComparableUrl(url);
        if (normalized && stopUrlSet.has(normalized)) {
          matchedStopUrls.add(normalized);
        }

        const foundId = extractIdFromUrl(url);
        if (foundId && stopIdSet.has(foundId)) {
          matchedStopIds.add(foundId);
        }
      }

      if (matchedStopUrls.size > 0 || matchedStopIds.size > 0) {
        reason = "stop_url_found";
        log(`loop=${iterations} collected=${collectedUrls.size} visible=${pass.count} new=${newCount} matchedStop=1 → stop`);
        break;
      }

      const currentCollected = collectedUrls.size;
      let increased = false;
      if (currentCollected > lastSeenCount) {
        increased = true;
        lastSeenCount = currentCollected;
        lastIncreaseAt = Date.now();
      } else if (newCount > 0) {
        // fallback: new unique found even if visible count didn't grow (virtualized DOM)
        increased = true;
        lastIncreaseAt = Date.now();
      }

      const noIncreaseForMs = Date.now() - lastIncreaseAt;
      log(`loop=${iterations} collected=${currentCollected} visible=${pass.count} new=${newCount} noIncreaseMs=${noIncreaseForMs}`);

      if (noIncreaseForMs >= noIncreaseTimeoutMs) {
        reason = "end_reached";
        break;
      }

      if (increased) {
        await sleep(increaseDelayMs);
      }

      await scrollToBottom(page);
      await sleep(waitMs);
    }

    log(
      `scan complete: urls=${collectedUrls.size}, matchedStopUrls=${matchedStopUrls.size}, iterations=${iterations}, reason=${reason}`
    );

    await sleep(exitWaitMs);

    const finalUrls = await page.evaluate(() => {
      const isPostUrl = (href) => /^https:\/\/[^/]*instagram\.com\/(?:p|reel|tv)\//i.test(String(href || ""));
      const rootAnchors = document.querySelectorAll("._ac7v.x1ty9z65.xzboxd6 a[href]");
      const anchors = rootAnchors.length ? rootAnchors : document.querySelectorAll("a[href]");
      return Array.from(anchors)
        .map((anchor) => (anchor && typeof anchor.href === "string" ? anchor.href.trim() : ""))
        .filter((href) => href && isPostUrl(href));
    });

    for (const url of finalUrls) {
      collectedUrls.add(url);
    }

    const urls = Array.from(collectedUrls);
    const ids = toUniqueStrings(urls.map((url) => extractIdFromUrl(url)));

    return {
      targetUrl,
      endUrls: stopUrls,
      reason,
      iterations,
      totalUrls: urls.length,
      totalIds: ids.length,
      matchedStopUrls: Array.from(matchedStopUrls),
      matchedStopIds: Array.from(matchedStopIds),
      urls,
      ids,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scanRedditSavedPage(options = {}) {
  const browser = options.browser;
  if (!browser) {
    throw new Error("Missing browser instance.");
  }

  const targetUrl = String(options.targetUrl || "").trim();
  if (!targetUrl) {
    throw new Error("Target URL is required.");
  }

  const log = typeof options.log === "function" ? options.log : () => {};
  const waitMs = Number.isFinite(Number(options.waitMs)) && Number(options.waitMs) > 0
    ? Math.floor(Number(options.waitMs))
    : 2000;
  const exitWaitMs = Number.isFinite(Number(options.exitWaitMs)) && Number(options.exitWaitMs) > 0
    ? Math.floor(Number(options.exitWaitMs))
    : 3000;
  const maxIterations = Number.isFinite(Number(options.maxIterations)) && Number(options.maxIterations) > 0
    ? Math.floor(Number(options.maxIterations))
    : 1200;

  const stopUrls = toUniqueStrings(Array.isArray(options.endUrls) ? options.endUrls : []);
  // for reddit, ids are base36 after /comments/
  const stopIdSet = new Set(stopUrls.map((value) => extractStopId(value)).filter(Boolean));
  const stopUrlSet = new Set(stopUrls.map((url) => normalizeComparableUrl(url)).filter(Boolean));
  const collectedUrls = new Set();
  const matchedStopUrls = new Set();
  const matchedStopIds = new Set();
  const page = await browser.newPage();
  if (!(browser && browser.__isCdp)) {
    try { await page.bringToFront().catch(() => {}); } catch {}
  }

  let reason = "max_iterations";
  let iterations = 0;

  try {
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    const isCdp = Boolean(browser && browser.__isCdp);
    if (!isCdp) {
      await page.setViewport({ width: 1280, height: 900 });
    } else {
      log("CDP browser — keeping remote viewport (skipping setViewport).");
    }

    let response = null;
    if (isCdp) {
      log(`CDP browser — using domcontentloaded for ${targetUrl}`);
      try {
        response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (e) {
        log(`domcontentloaded failed: ${e.message} — checking page state`);
        const curUrl = page.url();
        if (curUrl && curUrl !== "about:blank") {
          log(`proceeding despite goto timeout — page url is ${curUrl}`);
        } else {
          throw e;
        }
      }
    } else {
      try {
        response = await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });
      } catch (e) {
        const msg = String(e && e.message || e);
        const isTimeout = /timeout/i.test(msg) && /navigation/i.test(msg);
        if (isTimeout) {
          log(`page.goto networkidle2 timed out, trying domcontentloaded fallback: ${msg}`);
          try {
            response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          } catch (e2) {
            log(`domcontentloaded also failed: ${e2.message} — checking page state`);
            const curUrl = page.url();
            if (curUrl && curUrl !== "about:blank") {
              log(`proceeding despite goto timeout — page url is ${curUrl}`);
            } else {
              throw e2;
            }
          }
        } else {
          throw e;
        }
      }
    }
    if (!(browser && browser.__isCdp)) {
    try { await page.bringToFront().catch(() => {}); } catch {}
  }
    const status = response && typeof response.status === "function" ? response.status() : 0;
    if (status === 429) {
      log("Reddit saved-page scan got 429.");
      const error = new Error("Reddit responded with 429 during saved-page scan. Cancelling this job now.");
      error.status = 429;
      throw error;
    }

    const openedUrl = page.url();
    const targetLooksSaved = /\/user\/[^/]+\/saved/i.test(targetUrl);
    const openedLooksSaved = /\/user\/[^/]+\/saved/i.test(openedUrl);
    if (targetLooksSaved && !openedLooksSaved) {
      throw new Error(
        `Reddit redirected from saved page to ${openedUrl}. Make sure this browser profile is logged into the same account that owns the saved collection.`
      );
    }

    const noIncreaseTimeoutMs = 7000;
    const increaseDelayMs = 800;
    let lastSeenCount = 0;
    let lastIncreaseAt = Date.now();

    for (let index = 0; index < maxIterations; index += 1) {
      iterations = index + 1;

      const pass = await readRedditItemsOnPage(page);
      let newCount = 0;

      for (const url of pass.urls) {
        if (!collectedUrls.has(url)) {
          collectedUrls.add(url);
          newCount += 1;
        }

        const normalized = normalizeComparableUrl(url);
        if (normalized && stopUrlSet.has(normalized)) {
          matchedStopUrls.add(normalized);
        }

        const foundId = extractRedditPostId(url) || extractIdFromUrl(url);
        if (foundId && stopIdSet.has(foundId)) {
          matchedStopIds.add(foundId);
        }
      }

      if (matchedStopUrls.size > 0 || matchedStopIds.size > 0) {
        reason = "stop_url_found";
        log(`loop=${iterations} collected=${collectedUrls.size} visible=${pass.count} new=${newCount} matchedStop=1 → stop`);
        break;
      }

      const currentCollected = collectedUrls.size;
      let increased = false;
      if (currentCollected > lastSeenCount) {
        increased = true;
        lastSeenCount = currentCollected;
        lastIncreaseAt = Date.now();
      } else if (newCount > 0) {
        increased = true;
        lastIncreaseAt = Date.now();
      }

      const noIncreaseForMs = Date.now() - lastIncreaseAt;
      log(`loop=${iterations} collected=${currentCollected} visible=${pass.count} new=${newCount} noIncreaseMs=${noIncreaseForMs}`);

      if (noIncreaseForMs >= noIncreaseTimeoutMs) {
        reason = "end_reached";
        break;
      }

      if (increased) {
        await sleep(increaseDelayMs);
      }

      await scrollToBottom(page);
      await sleep(waitMs);
    }

    log(
      `scan complete: urls=${collectedUrls.size}, matchedStopUrls=${matchedStopUrls.size}, iterations=${iterations}, reason=${reason}`
    );

    await sleep(exitWaitMs);

    const final = await readRedditItemsOnPage(page);
    for (const url of final.urls) {
      collectedUrls.add(url);
    }

    const urls = Array.from(collectedUrls);
    const ids = toUniqueStrings(urls.map((url) => extractRedditPostId(url) || extractIdFromUrl(url)));

    return {
      targetUrl,
      endUrls: stopUrls,
      reason,
      iterations,
      totalUrls: urls.length,
      totalIds: ids.length,
      matchedStopUrls: Array.from(matchedStopUrls),
      matchedStopIds: Array.from(matchedStopIds),
      urls,
      ids,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scanSavedPage(options = {}) {
  const targetUrl = String(options.targetUrl || "").trim();
  if (isRedditSavedUrl(targetUrl)) {
    return scanRedditSavedPage(options);
  }
  return scanInstagramSavedPage(options);
}

module.exports = {
  scanSavedPage,
  scanInstagramSavedPage,
  scanRedditSavedPage,
};
