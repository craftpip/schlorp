const fs = require("fs/promises");
const path = require("path");
const readline = require("readline");

function parseBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;

  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function shouldRunHeadless() {
  const inferredDefault = !process.env.DISPLAY;
  return parseBooleanEnv("HEADLESS", inferredDefault);
}

function shouldAutoContinuePrompts() {
  const inferredDefault = !process.stdin.isTTY;
  return parseBooleanEnv("AUTO_CONTINUE", inferredDefault);
}

function getInstagramUserAgent() {
  if (process.env.INSTAGRAM_USER_AGENT) {
    return String(process.env.INSTAGRAM_USER_AGENT).trim();
  }

  return [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
    "AppleWebKit/605.1.15 (KHTML, like Gecko)",
    "Version/17.5 Mobile/15E148 Safari/604.1",
  ].join(" ");
}

async function waitForEnter(message, options = {}) {
  const forcePrompt = Boolean(options.forcePrompt);
  const log = typeof options.log === "function" ? options.log : console.log;

  if (!forcePrompt && shouldAutoContinuePrompts()) {
    const rawDelay = process.env.AUTO_CONTINUE_WAIT_MS;
    const parsedDelay = Number(rawDelay);
    const delayMs = Number.isFinite(parsedDelay) && parsedDelay > 0 ? Math.floor(parsedDelay) : 0;

    if (delayMs > 0) {
      log(`${message} (auto-continue in ${delayMs}ms)`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return;
    }

    log(`${message} (auto-continue enabled)`);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise((resolve) => {
    rl.question(`${message}\nPress Enter to continue...`, () => resolve());
  });

  rl.close();
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    return u.href;
  } catch {
    throw new Error("Invalid URL. Include protocol, e.g. https://example.com");
  }
}

function resolveProfileConfig() {
  const home = process.env.HOME || process.env.USERPROFILE || require("os").homedir();
  const userDataDir =
    process.env.BROWSER_USER_DATA_DIR || `${home}/.config/cloakbrowser-profile`;
  const profileDir = process.env.BROWSER_PROFILE_DIR || "Default";

  return { userDataDir, profileDir };
}

function getStateFilePath() {
  return (
    process.env.SAVED_SYNC_STATE_FILE ||
    path.resolve(__dirname, "..", ".saved-sync-state.json")
  );
}

async function loadAppConfig() {
  const statePath = getStateFilePath();
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.config === "object" && parsed.config) {
      return {
        accounts: Array.isArray(parsed.config.accounts) ? parsed.config.accounts : [],
        savedLists: Array.isArray(parsed.config.savedLists) ? parsed.config.savedLists : [],
      };
    }
  } catch {
    // file missing or unparseable
  }
  return { accounts: [], savedLists: [] };
}

function normalizeCdpUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.length > 500) throw new Error("CDP URL too long (max 500 chars)");
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("Invalid CDP URL. Use ws://, wss://, http:// or https://");
  }
  const proto = u.protocol.toLowerCase();
  if (!["ws:", "wss:", "http:", "https:"].includes(proto)) {
    throw new Error("CDP URL must start with ws://, wss://, http:// or https://");
  }
  return s;
}

function isCdpUrl(value) {
  try {
    const s = String(value || "").trim();
    if (!s) return false;
    const u = new URL(s);
    return ["ws:", "wss:", "http:", "https:"].includes(u.protocol.toLowerCase());
  } catch {
    return false;
  }
}

function resolveAccountConfig(accountName, accounts) {
  const match = Array.isArray(accounts)
    ? accounts.find((a) => a && a.name === accountName)
    : null;
  const defaults = resolveProfileConfig();
  let cdpUrl = "";
  try {
    cdpUrl = match && match.cdpUrl ? normalizeCdpUrl(match.cdpUrl) : "";
  } catch {
    cdpUrl = String(match.cdpUrl || "").trim();
  }
  return {
    userDataDir: (match && match.userDataDir) || defaults.userDataDir,
    profileDir: (match && match.profileDir) || defaults.profileDir,
    cdpUrl,
  };
}

function normalizeAccountName(value) {
  return String(value || "").trim() || "default";
}

module.exports = {
  shouldRunHeadless,
  shouldAutoContinuePrompts,
  getInstagramUserAgent,
  waitForEnter,
  normalizeUrl,
  resolveProfileConfig,
  loadAppConfig,
  resolveAccountConfig,
  normalizeAccountName,
  normalizeCdpUrl,
  isCdpUrl,
  getStateFilePath,
};
