const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");

const { createMediaVault } = require("../../scan-videos/media-vault");
const mc = require("../../scan-videos/media-crypto");
const { createPatternAuth } = require("../../scan-videos/pattern-auth");
const { withTempDir } = require("../helpers/temp-state");

const FAST = { N: 1 << 10, r: 8, p: 1 };
const mk = (root) => createMediaVault({ mediaDir: path.join(root, "media"), rootDir: root, isProtected: () => true, scryptParams: FAST });

test("never overwrites a key file of a DIFFERENT key in a subfolder/drive", async () => {
  await withTempDir(async (root) => {
    const media = path.join(root, "media");
    await fs.mkdir(path.join(media, "drive"), { recursive: true });
    const other = await mc.createVault("drive password long", FAST);
    await mc.writeVaultFile(path.join(media, "drive", ".xdl-vault.json"), other.vault);
    // A root vault with a different key is set up later (e.g. drive mounted after setup).
    const made = await mc.createVault("main password long", FAST);
    await mc.writeVaultFile(path.join(media, ".xdl-vault.json"), made.vault);
    const v = mk(root);
    await v.init();
    await v.unlock("password", "main password long");
    await v.ensureCopyFor(path.join(media, "drive", "x.mp4"));
    await v.setSlot("pattern", "5:0.1.2.3.4.9.14.19");
    const after = await mc.readVaultFile(path.join(media, "drive", ".xdl-vault.json"));
    assert.equal(after.kid, other.vault.kid, "drive key file must be left untouched");
    assert.match(String(v.status().error), /different (key file|media vaults)/);
  });
});

test("an unreadable key file blocks setup instead of being replaced", async () => {
  await withTempDir(async (root) => {
    const media = path.join(root, "media");
    await fs.mkdir(media, { recursive: true });
    await fs.writeFile(path.join(media, ".xdl-vault.json"), '{"v":3,"pub":"tor');
    const v = mk(root);
    await v.init();
    assert.equal(v.status().exists, false);
    assert.match(String(v.status().error), /can't be read/);
    await assert.rejects(v.setup("a long enough password"), { code: "VAULT_UNREADABLE" });
    assert.equal(await fs.readFile(path.join(media, ".xdl-vault.json"), "utf8"), '{"v":3,"pub":"tor');
  });
});

test("encrypted files without a key file block setup (drive not mounted)", async () => {
  await withTempDir(async (root) => {
    const media = path.join(root, "media");
    await fs.mkdir(path.join(media, "a"), { recursive: true });
    const other = await mc.createVault("some old password", FAST);
    // Encrypted files always sit under a 16-char code name.
    await fs.writeFile(path.join(media, "a", "k7q2m9x4c8v2b3n6"), "secret");
    await mc.encryptFileInPlace(path.join(media, "a", "k7q2m9x4c8v2b3n6"), other.publicKey);
    await assert.rejects(mk(root).setup("a long enough password"), { code: "ORPHAN_FILES" });
  });
});

test("setup check opens only code-named files and walks a looped folder once", async () => {
  await withTempDir(async (root) => {
    const media = path.join(root, "media");
    await fs.mkdir(path.join(media, "a"), { recursive: true });
    for (let i = 0; i < 5; i++) await fs.writeFile(path.join(media, "a", `clip${i}.mp4`), "plain");
    // A folder that loops back into media/ (like a bind mount of the parent).
    await fs.symlink(media, path.join(media, "a", "loop")).catch(() => {});
    const v = mk(root);
    const seen = [];
    const orig = mc.readFileHeader;
    mc.readFileHeader = async (f) => { seen.push(f); return orig(f); };
    try { await v.setup("a long enough password"); } finally { mc.readFileHeader = orig; }
    assert.deepEqual(seen, []);
    assert.equal(v.status().exists, true);
    assert.equal(v.status().setupCheck, null);
  });
});

test("clicking turn on twice runs one setup", async () => {
  await withTempDir(async (root) => {
    const v = mk(root);
    const [a, b] = await Promise.allSettled([v.setup("a long enough password"), v.setup("a long enough password")]);
    assert.equal(a.status, "fulfilled");
    assert.equal(b.status, "fulfilled");
    assert.equal(v.status().exists, true);
  });
});

test("password change keeps the old slot until committed; either password opens meanwhile", async () => {
  await withTempDir(async (root) => {
    const v = mk(root);
    await v.setup("old password long");
    await v.setSlot("password", "new password long", { keepPrevious: true });
    // Simulate a crash before the login hash was saved: restart.
    const v2 = mk(root);
    await v2.init();
    await v2.unlock("password", "old password long");
    assert.equal(v2.status().unlocked, true);
    v2.lockNow();
    await v2.unlock("password", "new password long");
    await v2.dropPrevious();
    const v3 = mk(root);
    await v3.init();
    await assert.rejects(v3.unlock("password", "old password long"), { code: "BAD_PASSWORD" });
    await v3.unlock("password", "new password long");
  });
});

test("parallel wrong guesses can't slip past the lockout", async () => {
  await withTempDir(async (root) => {
    const pa = createPatternAuth({ rootDir: root, hashParams: FAST });
    await pa.setPassword("the right password");
    const tries = Array.from({ length: 20 }, (_, i) => (i === 12 ? "the right password" : `wrong ${i}`));
    const results = await Promise.allSettled(tries.map((t) => pa.check("password", t, "1.2.3.4")));
    const codes = results.map((r) => (r.status === "fulfilled" ? "OK" : r.reason.code));
    assert.equal(codes.filter((c) => c === "BAD_PASSWORD").length, 5, codes.join(","));
    assert.equal(codes[12], "LOCKED_OUT", "the right password must not get through once locked");
    // Another client is not locked out by this one.
    assert.equal(await pa.check("password", "the right password", "5.6.7.8"), "the right password");
  });
});

test("fileName gives the real name only while unlocked, and rejects unsafe stored names", async () => {
  await withTempDir(async (root) => {
    const v = mk(root);
    await v.setup("a long enough password");
    const media = path.join(root, "media");
    const put = async (diskName, realName) => {
      const f = path.join(media, diskName);
      await fs.writeFile(f, "data");
      const r = await mc.encryptToTemp(f, await v.encryptKey(), { name: realName });
      await fs.rename(r.tmp, f);
      return f;
    };
    const good = await put(mc.codeName(), "Secret trip.mp4");
    const evil = await put(mc.codeName(), "../../etc/passwd");
    assert.equal(await v.fileName(good), "Secret trip.mp4");
    assert.equal(await v.fileName(evil), null);
    v.lockNow();
    assert.equal(await v.fileName(good), null, "no names while the vault is locked");
    await v.unlock("password", "a long enough password");
    assert.equal(await v.fileName(good), "Secret trip.mp4");
  });
});

test("setup from keys derived at login: no password needed later, and both slots open it", async () => {
  await withTempDir(async (root) => {
    const v = mk(root);
    await v.init();
    const passwordKey = await v.deriveSlotKey("password", "pw");
    const patternKey = await v.deriveSlotKey("pattern", "5:0.1.2.3.4.9.14.19");
    await v.setup({ passwordKey, patternKey });
    assert.equal(v.status().unlocked, true);
    assert.equal(v.status().patternSlot, true);
    const v2 = mk(root);
    await v2.init();
    await v2.unlock("pattern", "5:0.1.2.3.4.9.14.19");
    v2.lockNow();
    await v2.unlock("password", "pw");
    await assert.rejects(mk(root).setup({ passwordKey: null }), { code: "VAULT_EXISTS" });
  });
});
