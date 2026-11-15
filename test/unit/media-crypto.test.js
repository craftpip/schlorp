const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { Readable } = require("stream");

const mc = require("../../scan-videos/media-crypto");
const { withTempDir } = require("../helpers/temp-state");

const FAST = { N: 1 << 10, r: 8, p: 1 }; // fast scrypt params for tests
const CS = 1024; // small chunk so multi-chunk paths are cheap
const PASS = "copper lantern mosaic river";

async function collect(iter) {
  const parts = [];
  for await (const p of iter) parts.push(p);
  return Buffer.concat(parts);
}

let keys;
test.before(async () => {
  keys = await mc.createVault(PASS, FAST);
});

for (const size of [0, 1, CS - 1, CS, CS + 1, 5 * CS + 17]) {
  test(`round-trips ${size} bytes: encrypt with public key, decrypt with private key`, async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "clip.mp4");
      const data = crypto.randomBytes(size);
      await fs.writeFile(file, data);
      const old = new Date("2024-01-02T03:04:05Z");
      await fs.utimes(file, old, old);

      const { stat, createdMs } = await mc.encryptFileInPlace(file, keys.publicKey, { chunkSize: CS });
      assert.equal(stat.mtimeMs, old.getTime());
      const raw = await fs.readFile(file);
      assert.ok(raw.subarray(0, 8).equals(mc.MAGIC));
      if (size > 8) assert.equal(raw.indexOf(data.subarray(0, 8)), -1);

      const h = await mc.readFileHeader(file);
      assert.equal(h.plainSize, size);
      assert.equal(h.createdMs, Math.floor(createdMs));
      assert.equal(h.kid, keys.vault.kid);
      assert.deepEqual(await collect(mc.decryptRange(file, keys.privateKey)), data);

      await mc.decryptFileInPlace(file, keys.privateKey);
      assert.deepEqual(await fs.readFile(file), data);
      assert.equal((await fs.stat(file)).mtimeMs, old.getTime());
      assert.equal(await mc.readFileHeader(file), null);
      assert.deepEqual((await fs.readdir(dir)).sort(), ["clip.mp4"]);
    });
  });
}

test("range decrypt returns exact slices across chunk boundaries", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "a.bin");
    const data = crypto.randomBytes(7 * CS + 300);
    await fs.writeFile(file, data);
    await mc.encryptFileInPlace(file, keys.publicKey, { chunkSize: CS });
    for (const [s, e] of [[0, 0], [0, CS - 1], [CS - 1, CS], [CS + 5, 3 * CS + 9], [7 * CS, 7 * CS + 299], [100, 10 ** 9]]) {
      const got = await collect(mc.decryptRange(file, keys.privateKey, { start: s, end: e }));
      assert.deepEqual(got, data.subarray(s, Math.min(e, data.length - 1) + 1), `range ${s}-${e}`);
    }
  });
});

test("streaming encryption (uploads) decrypts", async () => {
  await withTempDir(async (dir) => {
    const data = crypto.randomBytes(3 * CS + 1);
    const file = path.join(dir, "up.jpg");
    const { plainSize } = await mc.encryptIterableToFile(Readable.from([data.subarray(0, 10), data.subarray(10, 2000), data.subarray(2000)]), file, keys.publicKey, { chunkSize: CS });
    assert.equal(plainSize, data.length);
    assert.equal((await mc.readFileHeader(file)).chunks, 4);
    assert.deepEqual(await collect(mc.decryptRange(file, keys.privateKey)), data);
  });
});

test("tampering, truncation and another vault's key are rejected", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "t.mp4");
    await fs.writeFile(file, crypto.randomBytes(3 * CS));
    await mc.encryptFileInPlace(file, keys.publicKey, { chunkSize: CS });
    const raw = await fs.readFile(file);

    const flipped = Buffer.from(raw);
    flipped[mc.HEADER_LEN + 5] ^= 1;
    await fs.writeFile(file, flipped);
    await assert.rejects(collect(mc.decryptRange(file, keys.privateKey)));

    const badWrap = Buffer.from(raw);
    badWrap[50] ^= 1; // inside the wrapped file key
    await fs.writeFile(file, badWrap);
    await assert.rejects(collect(mc.decryptRange(file, keys.privateKey)));

    await fs.writeFile(file, raw.subarray(0, raw.length - (CS + mc.TAG_LEN)));
    await assert.rejects(collect(mc.decryptRange(file, keys.privateKey)));

    await fs.writeFile(file, raw);
    const other = await mc.createVault("a different long passphrase", FAST);
    await assert.rejects(collect(mc.decryptRange(file, other.privateKey)), { code: "WRONG_VAULT" });
    assert.equal((await collect(mc.decryptRange(file, keys.privateKey))).length, 3 * CS);
  });
});

test("refuses to double-encrypt and to decrypt plain files", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "x.png");
    await fs.writeFile(file, "hello");
    await assert.rejects(mc.decryptFileInPlace(file, keys.privateKey), { code: "NOT_LOCKED" });
    await mc.encryptFileInPlace(file, keys.publicKey);
    await assert.rejects(mc.encryptFileInPlace(file, keys.publicKey), { code: "ALREADY_LOCKED" });
  });
});

test("vault: no usable secret on disk; password and pattern slots open the same key", async () => {
  const { vault, privateKey } = keys;
  const json = JSON.stringify(vault);
  const privRaw = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  assert.ok(!json.includes(privRaw.toString("base64")) && !json.includes(privRaw.toString("base64url")));
  assert.ok(!json.includes(PASS));
  assert.deepEqual(Object.keys(vault.slots), ["password"]);

  await withTempDir(async (dir) => {
    const file = path.join(dir, "f.bin");
    await fs.writeFile(file, "secret bytes");
    // Public key alone (as read from the vault file) can encrypt...
    await mc.encryptFileInPlace(file, mc.vaultPublicKey(vault));
    // ...reading needs a slot secret.
    await assert.rejects(mc.openVault(vault, "wrong password!!"), { code: "BAD_PASSWORD" });
    await assert.rejects(mc.openVault(vault, "5:0.1.2", "pattern"), { code: "NO_SLOT" });

    const withPattern = await mc.setVaultSlot(vault, privateKey, "pattern", "5:0.6.12.18.24.23.22.21", FAST);
    assert.ok(!JSON.stringify(withPattern).includes("0.6.12"));
    await assert.rejects(mc.openVault(withPattern, "5:0.1.2.3.4.9.14.19", "pattern"), { code: "BAD_PATTERN" });
    const viaPattern = await mc.openVault(withPattern, "5:0.6.12.18.24.23.22.21", "pattern");
    const viaPassword = await mc.openVault(withPattern, PASS);
    for (const k of [viaPattern, viaPassword]) assert.equal((await collect(mc.decryptRange(file, k))).toString(), "secret bytes");

    // Changing the password keeps every file readable; the old one stops working.
    const changed = await mc.setVaultSlot(withPattern, viaPassword, "password", "a brand new password", FAST);
    assert.equal(changed.kid, vault.kid);
    await assert.rejects(mc.openVault(changed, PASS), { code: "BAD_PASSWORD" });
    assert.equal((await collect(mc.decryptRange(file, await mc.openVault(changed, "a brand new password")))).toString(), "secret bytes");

    // Removing the pattern slot; the password slot can't be removed.
    const noPattern = await mc.setVaultSlot(changed, viaPassword, "pattern", null);
    assert.deepEqual(Object.keys(noPattern.slots), ["password"]);
    await assert.rejects(mc.setVaultSlot(changed, viaPassword, "password", null));
  });
});

test("short passwords are refused for encryption", async () => {
  await assert.rejects(mc.createVault("short", FAST), { code: "WEAK_PASSWORD" });
  await assert.rejects(mc.setVaultSlot(keys.vault, keys.privateKey, "password", "tiny", FAST), { code: "WEAK_PASSWORD" });
});

test("lockable names skip dotfiles, stacks and partials", () => {
  for (const n of ["a.mp4", "b-poster.jpg", "notes.txt"]) assert.equal(mc.isLockableName(n), true, n);
  for (const n of [".xdl-vault.json", "s.xdlstack", "v.mp4.part", ".a.mp4.xenc-1234", ""]) assert.equal(mc.isLockableName(n), false, n);
});
