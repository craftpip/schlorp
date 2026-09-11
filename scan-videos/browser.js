const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { shouldRunHeadless, resolveProfileConfig, resolveAccountConfig, normalizeCdpUrl } = require("./config");

async function getCloakBrowser() {
  return import("cloakbrowser/puppeteer");
}

async function getPuppeteerCore() {
  return import("puppeteer-core");
}

async function resolveCdpWsEndpoint(cdpUrl) {
  const raw = String(cdpUrl || "").trim();
  if (!raw) throw new Error("CDP URL is empty");
  const normalized = normalizeCdpUrl(raw);
  const u = new URL(normalized);
  const proto = u.protocol.toLowerCase();
  if (proto === "ws:" || proto === "wss:") {
    return normalized;
  }
  // http(s) -> fetch /json/version
  const origin = `${u.protocol}//${u.host}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${origin}/json/version`, { signal: controller.signal });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      if (j && j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    }
    // fallback: /json
    const res2 = await fetch(`${origin}/json`, { signal: controller.signal });
    if (res2.ok) {
      const arr = await res2.json().catch(() => null);
      if (Array.isArray(arr) && arr.length) {
        const found = arr.find((x) => x && x.webSocketDebuggerUrl);
        if (found) return found.webSocketDebuggerUrl;
      }
    }
    throw new Error(`CDP probe failed at ${origin}/json/version (status ${res.status})`);
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`CDP probe timed out for ${origin}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function checkCdpStatus(cdpUrl) {
  const start = Date.now();
  try {
    const raw = String(cdpUrl || "").trim();
    const normalized = normalizeCdpUrl(raw);
    const u = new URL(normalized);
    const proto = u.protocol.toLowerCase();
    if (proto === "ws:" || proto === "wss:") {
      // probe http counterpart to verify the browser is actually listening
      const httpProto = proto === "wss:" ? "https:" : "http:";
      const origin = `${httpProto}//${u.host}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(`${origin}/json/version`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.json().catch(() => ({}));
        clearTimeout(timer);
        return { ok: true, wsEndpoint: normalized, latencyMs: Date.now() - start };
      } catch (e) {
        clearTimeout(timer);
        if (e.name === "AbortError") return { ok: false, error: `CDP probe timed out for ${origin}`, latencyMs: Date.now() - start };
        // try direct WS connect as fallback before declaring down
        try {
          const WebSocket = require("ws");
          const ws = new WebSocket(normalized, { handshakeTimeout: 3000 });
          const result = await new Promise((resolve, reject) => {
            const t = setTimeout(() => { try { ws.terminate(); } catch {} ; reject(new Error(`WS connect timed out for ${normalized}`)); }, 3000);
            ws.on("open", () => { clearTimeout(t); try { ws.terminate(); } catch {} ; resolve(true); });
            ws.on("error", (err) => { clearTimeout(t); reject(err); });
          });
          if (result) return { ok: true, wsEndpoint: normalized, latencyMs: Date.now() - start };
        } catch (wsErr) {
          return { ok: false, error: wsErr.message || String(wsErr) || (e.message || String(e)), latencyMs: Date.now() - start };
        }
        return { ok: false, error: e.message || String(e), latencyMs: Date.now() - start };
      }
    }
    const wsEndpoint = await resolveCdpWsEndpoint(cdpUrl);
    return { ok: true, wsEndpoint, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.message || String(e), latencyMs: Date.now() - start };
  }
}

async function connectToCdp(cdpUrl, { log } = {}) {
  const wsEndpoint = await resolveCdpWsEndpoint(cdpUrl);
  let browser;
  // prefer cloakbrowser if it exposes connect, else puppeteer-core
  try {
    const cb = await getCloakBrowser();
    if (cb && typeof cb.connect === "function") {
      browser = await cb.connect({ browserWSEndpoint: wsEndpoint });
    } else if (cb && cb.default && typeof cb.default.connect === "function") {
      browser = await cb.default.connect({ browserWSEndpoint: wsEndpoint });
    }
  } catch {}
  if (!browser) {
    const pc = await getPuppeteerCore();
    const connectFn = pc.connect || (pc.default && pc.default.connect);
    if (!connectFn) throw new Error("puppeteer-core connect not available");
    browser = await connectFn({ browserWSEndpoint: wsEndpoint });
  }
  browser.__isCdp = true;
  browser.__cdpUrl = String(cdpUrl).trim();
  browser.__wsEndpoint = wsEndpoint;
  if (log) log(`Connected via CDP ${wsEndpoint}`);
  return browser;
}

async function cloneProfileDir(sourceDir, profileDir) {
  const cloneDir = path.join(os.tmpdir(), `browser-profile-clone-${Date.now()}`);
  const sourceProfilePath = path.join(sourceDir, profileDir);
  const targetProfilePath = path.join(cloneDir, profileDir);

  await fs.mkdir(cloneDir, { recursive: true });

  await fs.cp(path.join(sourceDir, "Local State"), path.join(cloneDir, "Local State"), {
    force: true,
  }).catch(() => {});

  await fs.cp(path.join(sourceDir, "First Run"), path.join(cloneDir, "First Run"), {
    force: true,
  }).catch(() => {});

  await fs.cp(sourceProfilePath, targetProfilePath, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (name === "SingletonLock") return false;
      if (name === "SingletonCookie") return false;
      if (name === "SingletonSocket") return false;
      if (name === "Cache") return false;
      if (name === "Code Cache") return false;
      if (name === "GPUCache") return false;
      if (name === "Media Cache") return false;
      return true;
    },
  });

  return cloneDir;
}

async function removeStaleLockArtifacts(userDataDir, profileDir) {
  const lockNames = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  const targets = [userDataDir, path.join(userDataDir, profileDir)];

  for (const dir of targets) {
    for (const name of lockNames) {
      const lockPath = path.join(dir, name);
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  }
}

async function launchBrowser(userDataDir, profileDir, options = {}) {
  const headless =
    typeof options.headless === "boolean" ? options.headless : shouldRunHeadless();
  const log = typeof options.log === "function" ? options.log : console.log;

  if (!headless && !process.env.DISPLAY && process.env.ENABLE_VNC === "1") {
    process.env.DISPLAY = ":99";
  }

  const { launchPersistentContext } = await getCloakBrowser();

  if (process.env.BROWSER_PATH && !process.env.CLOAKBROWSER_BINARY_PATH) {
    log("BROWSER_PATH is deprecated; use CLOAKBROWSER_BINARY_PATH instead.");
    process.env.CLOAKBROWSER_BINARY_PATH = process.env.BROWSER_PATH;
  }

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    `--profile-directory=${profileDir}`,
    "--start-maximized",
  ];

  const cbOptions = {
    headless,
    args,
    userDataDir,
    defaultViewport: null,
  };

  try {
    return await launchPersistentContext(cbOptions);
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    const lockError =
      message.includes("browser is already running") ||
      message.includes("profile appears to be in use") ||
      message.includes("Chromium has locked the profile") ||
      message.includes("Opening in existing browser session") ||
      message.includes("Failed to launch the browser process:  Code: 21");
    if (!lockError) throw err;

    log("Profile lock detected. Trying to clear stale lock files and retry...");
    await removeStaleLockArtifacts(userDataDir, profileDir);

    try {
      return await launchPersistentContext(cbOptions);
    } catch (retryErr) {
      const retryMessage = String(retryErr && retryErr.message ? retryErr.message : retryErr);
      const retryStillLocked =
        retryMessage.includes("browser is already running") ||
        retryMessage.includes("profile appears to be in use") ||
        retryMessage.includes("Chromium has locked the profile") ||
        retryMessage.includes("Opening in existing browser session") ||
        retryMessage.includes("Failed to launch the browser process:  Code: 21");
      if (!retryStillLocked) throw retryErr;
    }

    log(
      "Primary profile is locked by a running browser instance. Using a cloned local profile snapshot..."
    );

    const clonedUserDataDir = await cloneProfileDir(userDataDir, profileDir);

    return launchPersistentContext({
      ...cbOptions,
      userDataDir: clonedUserDataDir,
    });
  }
}

async function buildBrowserFromLocalProfile(options = {}) {
  const log = typeof options.log === "function" ? options.log : console.log;

  // direct cdpUrl override (for tests / explicit callers)
  if (options.cdpUrl) {
    const cdp = normalizeCdpUrl(options.cdpUrl);
    log(`Using CDP ${cdp}`);
    return connectToCdp(cdp, { log });
  }

  if (options.account) {
    const appConfig = await resolveAppConfigWithRetry(log);
    const config = resolveAccountConfig(options.account, appConfig.accounts);
    if (config.cdpUrl) {
      log(`Using account "${options.account}" -> CDP ${config.cdpUrl}`);
      try {
        return await connectToCdp(config.cdpUrl, { log });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        const err = new Error(`CDP unreachable for "${options.account}" (${config.cdpUrl}): ${msg}`);
        err.cause = e;
        throw err;
      }
    }
    log(`Using account "${options.account}" -> ${config.userDataDir}/${config.profileDir}`);
    return launchBrowser(config.userDataDir, config.profileDir, options);
  }

  const { userDataDir, profileDir } = resolveProfileConfig();
  return launchBrowser(userDataDir, profileDir, options);
}

async function resolveAppConfigWithRetry(log) {
  try {
    const { loadAppConfig } = require("./config");
    return await loadAppConfig();
  } catch (err) {
    log(`Warning: could not load account config: ${err.message}`);
    return { accounts: [], savedLists: [] };
  }
}

module.exports = {
  buildBrowserFromLocalProfile,
  resolveCdpWsEndpoint,
  checkCdpStatus,
  connectToCdp,
};
