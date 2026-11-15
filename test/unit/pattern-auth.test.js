const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");

const { createPatternAuth, normalizePattern, createLimiter } = require("../../scan-videos/pattern-auth");
const { withTempDir } = require("../helpers/temp-state");

const FAST = { N: 1 << 10, r: 8, p: 1 };
const P = { size: 5, dots: [0, 6, 12, 18, 24, 23, 22, 21] };

test("patterns must be 5x5 with at least 8 dots", () => {
  assert.equal(normalizePattern(P), "5:0.6.12.18.24.23.22.21");
  for (const bad of [{ size: 3, dots: [0, 1, 2, 5, 8, 7, 6, 3] }, { size: 5, dots: [0, 1, 2, 3, 4, 9, 14] }, { size: 5, dots: [0, 1, 1, 2, 3, 4, 9, 14] }, { size: 5, dots: [0, 1, 2, 3, 4, 9, 14, 25] }, null]) {
    assert.throws(() => normalizePattern(bad), { code: "BAD_PATTERN" });
  }
});

test("password is stored only as a hash and checked with a limiter", async () => {
  await withTempDir(async (dir) => {
    const pa = createPatternAuth({ rootDir: dir, hashParams: FAST });
    assert.equal(pa.hasPassword(), false);
    assert.equal(await pa.migratePlainPassword("old plain pw"), true);
    assert.equal(await pa.migratePlainPassword("ignored"), false);
    const raw = await fs.readFile(path.join(dir, ".xdl-auth.json"), "utf8");
    assert.ok(!raw.includes("old plain pw"));
    assert.equal(await pa.check("password", "old plain pw"), "old plain pw");
    for (let i = 0; i < 5; i++) await assert.rejects(pa.check("password", "nope"), { code: "BAD_PASSWORD" });
    await assert.rejects(pa.check("password", "old plain pw"), { code: "LOCKED_OUT" });
  });
});

test("pattern: hashed, returns canonical form, removed with the password", async () => {
  await withTempDir(async (dir) => {
    const pa = createPatternAuth({ rootDir: dir, hashParams: FAST });
    await pa.setPassword("some password");
    assert.equal(await pa.setPattern(P), "5:0.6.12.18.24.23.22.21");
    const raw = await fs.readFile(path.join(dir, ".xdl-auth.json"), "utf8");
    assert.ok(!raw.includes("0.6.12"));
    assert.equal(await pa.check("pattern", P), "5:0.6.12.18.24.23.22.21");
    await assert.rejects(pa.check("pattern", { size: 5, dots: [24, 23, 22, 21, 20, 15, 10, 5] }), { code: "BAD_PATTERN" });
    await pa.setPrefs({ preferLogin: "pattern", autoLockMinutes: 30 });
    assert.equal(pa.publicSettings().preferLogin, "pattern");
    await pa.setPassword("");
    assert.equal(pa.hasPattern(), false);
    assert.equal(pa.publicSettings().preferLogin, "password");
  });
});

test("sessions are random, revocable and not persisted", async () => {
  await withTempDir(async (dir) => {
    const pa = createPatternAuth({ rootDir: dir, hashParams: FAST });
    const t = pa.newSession();
    assert.ok(pa.validSession(t));
    assert.ok(!pa.validSession("nope"));
    pa.endSession(t);
    assert.ok(!pa.validSession(t));
    const t2 = pa.newSession();
    assert.ok(!createPatternAuth({ rootDir: dir, hashParams: FAST }).validSession(t2));
  });
});

test("limiter escalates and resets on success", () => {
  const lim = createLimiter({ free: 2, baseMs: 1000 });
  lim.check(); lim.fail(); lim.check();
  lim.fail();
  assert.throws(() => lim.check(), { code: "LOCKED_OUT" });
  lim.success();
  lim.check();
});
