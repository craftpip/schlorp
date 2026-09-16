const test = require("node:test");
const assert = require("node:assert/strict");
const { setEnv, restoreEnv, withTempDir } = require("../helpers/temp-state");

const {
  shouldRunHeadless,
  shouldAutoContinuePrompts,
  getInstagramUserAgent,
  normalizeUrl,
  resolveProfileConfig,
  loadAppConfig,
  resolveAccountConfig,
  normalizeAccountName,
  normalizeCdpUrl,
  isCdpUrl,
  getStateFilePath,
} = require("../../scan-videos/config");

const ENV_KEYS = [
  "HEADLESS",
  "DISPLAY",
  "AUTO_CONTINUE",
  "AUTO_CONTINUE_WAIT_MS",
  "INSTAGRAM_USER_AGENT",
  "BROWSER_USER_DATA_DIR",
  "BROWSER_PROFILE_DIR",
  "SAVED_SYNC_STATE_FILE",
];

test("shouldRunHeadless: defaults to true when HEADLESS unset and no DISPLAY", () => {
  setEnv({ HEADLESS: undefined, DISPLAY: undefined });
  try {
    assert.equal(shouldRunHeadless(), true);
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("shouldRunHeadless: defaults to false when DISPLAY is set", () => {
  setEnv({ HEADLESS: undefined, DISPLAY: ":0" });
  try {
    assert.equal(shouldRunHeadless(), false);
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("shouldRunHeadless: explicit truthy/falsy env wins over DISPLAY", () => {
  setEnv({ HEADLESS: "0", DISPLAY: undefined });
  try {
    assert.equal(shouldRunHeadless(), false);
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("shouldRunHeadless: unparseable value falls back to inferred default", () => {
  setEnv({ HEADLESS: "maybe", DISPLAY: undefined });
  try {
    assert.equal(shouldRunHeadless(), true);
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("shouldAutoContinuePrompts: AUTO_CONTINUE=1 forces auto-continue", () => {
  setEnv({ AUTO_CONTINUE: "1" });
  try {
    assert.equal(shouldAutoContinuePrompts(), true);
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("shouldAutoContinuePrompts: AUTO_CONTINUE=0 forces false even when not a TTY", () => {
  setEnv({ AUTO_CONTINUE: "0" });
  try {
    assert.equal(shouldAutoContinuePrompts(), false);
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("getInstagramUserAgent: returns custom UA when set", () => {
  setEnv({ INSTAGRAM_USER_AGENT: " Custom-UA " });
  try {
    assert.equal(getInstagramUserAgent(), "Custom-UA");
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("getInstagramUserAgent: returns default iPhone Safari UA when unset", () => {
  setEnv({ INSTAGRAM_USER_AGENT: undefined });
  try {
    const ua = getInstagramUserAgent();
    assert.match(ua, /^Mozilla\/5\.0 \(iPhone/);
    assert.match(ua, /AppleWebKit\/605\.1\.15/);
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("normalizeUrl: prepends nothing when scheme present, returns href", () => {
  assert.equal(normalizeUrl("https://example.com/a?x=1#h"), "https://example.com/a?x=1#h");
});

test("normalizeUrl: throws on missing protocol", () => {
  assert.throws(() => normalizeUrl("example.com/video"), /Invalid URL\. Include protocol/);
});

test("normalizeUrl: throws on garbage", () => {
  assert.throws(() => normalizeUrl("not a url"), /Invalid URL/);
});

test("resolveProfileConfig: uses env overrides", () => {
  setEnv({ BROWSER_USER_DATA_DIR: "/profiles/work", BROWSER_PROFILE_DIR: "Profile 2" });
  try {
    assert.deepEqual(resolveProfileConfig(), {
      userDataDir: "/profiles/work",
      profileDir: "Profile 2",
    });
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("resolveProfileConfig: falls back to home + Default", () => {
  setEnv({ BROWSER_USER_DATA_DIR: undefined, BROWSER_PROFILE_DIR: undefined });
  try {
    const cfg = resolveProfileConfig();
    assert.match(cfg.userDataDir, /cloakbrowser-profile$/);
    assert.equal(cfg.profileDir, "Default");
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("getStateFilePath: env override wins", () => {
  setEnv({ SAVED_SYNC_STATE_FILE: "/tmp/state.json" });
  try {
    assert.equal(getStateFilePath(), "/tmp/state.json");
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("loadAppConfig: reads config section from state file", async () => {
  await withTempDir(async (dir) => {
    const statePath = `${dir}/state.json`;
    await require("fs/promises").writeFile(
      statePath,
      JSON.stringify({
        config: {
          accounts: [{ name: "work", profileDir: "Profile 1" }],
          savedLists: [{ url: "https://instagram.com/me/saved", folder: "ig" }],
        },
        lists: {},
      })
    );
    setEnv({ SAVED_SYNC_STATE_FILE: statePath });
    try {
      const cfg = await loadAppConfig();
      assert.equal(cfg.accounts.length, 1);
      assert.equal(cfg.accounts[0].name, "work");
      assert.equal(cfg.savedLists[0].folder, "ig");
    } finally {
      restoreEnv(ENV_KEYS);
    }
  });
});

test("loadAppConfig: returns defaults on missing/unparseable file", async () => {
  await withTempDir(async (dir) => {
    setEnv({ SAVED_SYNC_STATE_FILE: `${dir}/missing.json` });
    try {
      assert.deepEqual(await loadAppConfig(), { accounts: [], savedLists: [] });
    } finally {
      restoreEnv(ENV_KEYS);
    }
  });
});

test("normalizeCdpUrl: passes ws/wss/http/https", () => {
  assert.equal(normalizeCdpUrl("ws://127.0.0.1:9222/devtools/browser/abc"), "ws://127.0.0.1:9222/devtools/browser/abc");
  assert.equal(normalizeCdpUrl("  http://localhost:9222  "), "http://localhost:9222");
});

test("normalizeCdpUrl: rejects ftp and garbage", () => {
  assert.throws(() => normalizeCdpUrl("ftp://x"), /must start with ws:\/\//);
  assert.throws(() => normalizeCdpUrl("::not-a-url"), /Invalid CDP URL/);
});

test("normalizeCdpUrl: trims to empty when blank, throws when too long", () => {
  assert.equal(normalizeCdpUrl("   "), "");
  assert.throws(() => normalizeCdpUrl(`ws://x/${"a".repeat(600)}`), /max 500/);
});

test("isCdpUrl: protocol whitelist + invalid input", () => {
  assert.equal(isCdpUrl("wss://a/b"), true);
  assert.equal(isCdpUrl("https://a/b"), true);
  assert.equal(isCdpUrl("   "), false);
  assert.equal(isCdpUrl("gopher://a"), false);
  assert.equal(isCdpUrl("nonsense"), false);
});

test("normalizeAccountName: trims and defaults to 'default'", () => {
  assert.equal(normalizeAccountName(" work "), "work");
  assert.equal(normalizeAccountName(""), "default");
  assert.equal(normalizeAccountName(undefined), "default");
});

test("resolveAccountConfig: default with no NAME env", () => {
  setEnv({ BROWSER_USER_DATA_DIR: "/profiles/default", BROWSER_PROFILE_DIR: "Default" });
  try {
    assert.deepEqual(resolveAccountConfig("missing", []), {
      userDataDir: "/profiles/default",
      profileDir: "Default",
      cdpUrl: "",
    });
  } finally {
    restoreEnv(ENV_KEYS);
  }
});

test("resolveAccountConfig: merges per-account values over defaults", () => {
  const cfg = resolveAccountConfig("work", [
    { name: "work", userDataDir: "/profiles/work", profileDir: "Profile 2", cdpUrl: "ws://x/y" },
  ]);
  assert.deepEqual(cfg, {
    userDataDir: "/profiles/work",
    profileDir: "Profile 2",
    cdpUrl: "ws://x/y",
  });
});