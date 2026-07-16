const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { shouldRunHeadless, resolveProfileConfig } = require("./config");

async function getCloakBrowser() {
  return import("cloakbrowser/puppeteer");
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
  const { launchPersistentContext } = await getCloakBrowser();

  if (process.env.BROWSER_PATH) {
    process.env.CLOAKBROWSER_BINARY_PATH = process.env.BROWSER_PATH;
  }

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    `--profile-directory=${profileDir}`,
  ];

  const cbOptions = {
    headless,
    args,
    userDataDir,
  };

  try {
    return await launchPersistentContext(cbOptions);
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    const lockError =
      message.includes("browser is already running") ||
      message.includes("profile appears to be in use") ||
      message.includes("Chromium has locked the profile") ||
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
  const { userDataDir, profileDir } = resolveProfileConfig();
  return launchBrowser(userDataDir, profileDir, options);
}

module.exports = {
  buildBrowserFromLocalProfile,
};
