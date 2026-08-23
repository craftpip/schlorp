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

async function scanSavedPage(options = {}) {
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

  let reason = "max_iterations";
  let iterations = 0;

  try {
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

    const response = await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 60000 });
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

module.exports = {
  scanSavedPage,
};
