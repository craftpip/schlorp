const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCliArgs } = require("../scan-videos/index");
const { normalizeAccountName, resolveAccountConfig } = require("../scan-videos/config");

test("unnamed downloads keep the default profile selection", () => {
  const parsed = parseCliArgs(["https://example.com/video"]);

  assert.equal(parsed.command, "scan");
  assert.equal(parsed.account, "");
  assert.equal(normalizeAccountName(parsed.account), "default");
});

test("named CLI scans select the requested account", () => {
  const parsed = parseCliArgs(["--account", "personal", "https://example.com/video"]);

  assert.equal(parsed.account, "personal");
  assert.equal(normalizeAccountName(parsed.account), "personal");
});

test("named accounts resolve to isolated persistent profile directories", () => {
  const previousUserDataDir = process.env.BROWSER_USER_DATA_DIR;
  const previousProfileDir = process.env.BROWSER_PROFILE_DIR;
  process.env.BROWSER_USER_DATA_DIR = "/profiles/default";
  process.env.BROWSER_PROFILE_DIR = "Default";

  try {
    const account = resolveAccountConfig("work", [
      { name: "personal", userDataDir: "/profiles/personal", profileDir: "Default" },
      { name: "work", userDataDir: "/profiles/work", profileDir: "Profile 2" },
    ]);
    const unknown = resolveAccountConfig("missing", []);

    assert.deepEqual(account, {
      userDataDir: "/profiles/work",
      profileDir: "Profile 2",
    });
    assert.deepEqual(unknown, {
      userDataDir: "/profiles/default",
      profileDir: "Default",
    });
  } finally {
    if (previousUserDataDir === undefined) delete process.env.BROWSER_USER_DATA_DIR;
    else process.env.BROWSER_USER_DATA_DIR = previousUserDataDir;
    if (previousProfileDir === undefined) delete process.env.BROWSER_PROFILE_DIR;
    else process.env.BROWSER_PROFILE_DIR = previousProfileDir;
  }
});
