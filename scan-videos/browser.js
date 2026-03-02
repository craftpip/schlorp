const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");
const chromeLauncher = require("chrome-launcher");
const { shouldRunHeadless, resolveProfileConfig } = require("./config");

async function getChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const installs = chromeLauncher.Launcher.getInstallations();
  if (!installs || installs.length === 0) {
    throw new Error(
      "Chrome not found. Install Chrome or set CHROME_PATH to the executable."
    );
  }
  return installs[0];
}

async function cloneProfileDir(sourceDir, profileDir) {
  const cloneDir = path.join(os.tmpdir(), `chrome-profile-clone-${Date.now()}`);
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

async function launchBrowser(chromePath, userDataDir, profileDir, options = {}) {
  const headless =
    typeof options.headless === "boolean" ? options.headless : shouldRunHeadless();
  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    `--profile-directory=${profileDir}`,
  ];

  if (headless) launchArgs.push("--headless=new");

  try {
    return await puppeteer.launch({
      executablePath: chromePath,
      headless,
      defaultViewport: null,
      userDataDir,
      args: launchArgs,
    });
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    const lockError =
      message.includes("browser is already running") ||
      message.includes("profile appears to be in use") ||
      message.includes("Chromium has locked the profile") ||
      message.includes("Failed to launch the browser process:  Code: 21");
    if (!lockError) throw err;

    console.log("Profile lock detected. Trying to clear stale lock files and retry...");
    await removeStaleLockArtifacts(userDataDir, profileDir);

    try {
      return await puppeteer.launch({
        executablePath: chromePath,
        headless,
        defaultViewport: null,
        userDataDir,
        args: launchArgs,
      });
    } catch (retryErr) {
      const retryMessage = String(retryErr && retryErr.message ? retryErr.message : retryErr);
      const retryStillLocked =
        retryMessage.includes("browser is already running") ||
        retryMessage.includes("profile appears to be in use") ||
        retryMessage.includes("Chromium has locked the profile") ||
        retryMessage.includes("Failed to launch the browser process:  Code: 21");
      if (!retryStillLocked) throw retryErr;
    }

    console.log(
      "Primary profile is locked by a running Chrome instance. Using a cloned local profile snapshot..."
    );

    const clonedUserDataDir = await cloneProfileDir(userDataDir, profileDir);

    return puppeteer.launch({
      executablePath: chromePath,
      headless,
      defaultViewport: null,
      userDataDir: clonedUserDataDir,
      args: launchArgs,
    });
  }
}

async function buildBrowserFromLocalProfile(options = {}) {
  const chromePath = await getChromePath();
  const { userDataDir, profileDir } = resolveProfileConfig();
  return launchBrowser(chromePath, userDataDir, profileDir, options);
}

module.exports = {
  buildBrowserFromLocalProfile,
};
