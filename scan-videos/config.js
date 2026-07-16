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
  const home = process.env.HOME || "/home/boniface";
  const userDataDir =
    process.env.CHROME_USER_DATA_DIR || `${home}/.config/google-chrome`;
  const profileDir = process.env.CHROME_PROFILE_DIR || "Default";

  return { userDataDir, profileDir };
}

module.exports = {
  shouldRunHeadless,
  shouldAutoContinuePrompts,
  getInstagramUserAgent,
  waitForEnter,
  normalizeUrl,
  resolveProfileConfig,
};
