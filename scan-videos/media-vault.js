// Server-side media vault state (plan 039, v3: password or pattern slots).
//
// - A random key pair is generated once at setup and stored with the media
//   (`.xdl-vault.json`), its private half sealed by the panel password and,
//   optionally, the 5x5 pattern. Neither secret is ever stored.
// - The private key lives in memory only between unlock (login or the unlock
//   bar) and lock/idle auto-lock/restart.
// - The public key is read from the vault file, so new files are encrypted
//   while the vault is locked.
// - A copy of the vault file sits at the root of every drive mounted inside
//   media/, so each drive is recoverable alone (drive + password or pattern).
// - A vault is only ever created by an explicit setup.
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
const mc = require("./media-crypto");

const VAULT_NAME = ".xdl-vault.json";

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function createMediaVault({ mediaDir, rootDir, isProtected, scryptParams = null }) {
  const vaultFile = path.join(mediaDir, VAULT_NAME);
  const createdFile = path.join(rootDir, ".xdl-created.json");
  let vault = null;
  let publicKey = null;
  let privateKey = null;
  let error = null;
  let initPromise = null;
  const copies = new Set();
  // Vault files that exist but can't be read/parsed — never overwrite them.
  let unreadable = []; // [{ dir, error }]
  // Other readable copies of the current vault (tried on unlock as fallbacks).
  let foundCopies = []; // [{ dir, vault }]
  // Serialises slot changes so concurrent edits can't undo each other.
  let slotChain = Promise.resolve();
  const checkedDevs = new Set();
  const infoCache = new Map();
  // Real names of hidden-name files (plan 041), cached per unlock: bumping
  // the generation on lock makes every cached name unreachable.
  let nameGen = 0;

  let created = {};
  try {
    const parsed = JSON.parse(fsSync.readFileSync(createdFile, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.entries) created = parsed.entries;
  } catch {}
  let createdChain = Promise.resolve();
  const saveCreated = () => {
    const task = () => fs.writeFile(createdFile, JSON.stringify({ updatedAt: new Date().toISOString(), entries: created }), "utf8").catch(() => {});
    createdChain = createdChain.then(task, task);
    return createdChain;
  };

  async function discover() {
    const found = [];
    const tryDir = async (dir) => {
      let v = null;
      try {
        v = await mc.readVaultFile(path.join(dir, VAULT_NAME));
      } catch (e) {
        unreadable.push({ dir, error: e.message });
        return;
      }
      if (v && v.v === 3 && v.pub) found.push({ dir, vault: v });
      // Any other format is never overwritten — treated like an unreadable key.
      else if (v) unreadable.push({ dir, error: "unsupported key file format" });
    };
    unreadable = [];
    await tryDir(mediaDir);
    const entries = await fs.readdir(mediaDir, { withFileTypes: true }).catch(() => []);
    for (const en of entries) if (en.isDirectory() && !en.name.startsWith(".")) await tryDir(path.join(mediaDir, en.name));
    return found;
  }

  async function load() {
    error = null;
    const found = await discover();
    copies.clear();
    vault = null;
    publicKey = null;
    if (!found.length) { privateKey = null; return; }
    const kids = new Set(found.map((f) => f.vault.kid));
    if (kids.size > 1) error = `found ${kids.size} different media vaults (${[...kids].join(", ")}) — drives were set up separately`;
    // Prefer the media-root copy, then the most recently updated one.
    found.sort((a, b) => (a.dir === mediaDir ? -1 : b.dir === mediaDir ? 1 : String(b.vault.updatedAt).localeCompare(String(a.vault.updatedAt))));
    vault = found[0].vault;
    publicKey = mc.vaultPublicKey(vault);
    for (const f of found) if (f.vault.kid === vault.kid) copies.add(f.dir);
    foundCopies = found.filter((f) => f.vault.kid === vault.kid);
    if (privateKey) {
      try {
        const mine = Buffer.from(nodeCrypto.createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
        if (!mine.equals(Buffer.from(vault.pub, "base64"))) privateKey = null;
      } catch { privateKey = null; }
    }
  }

  function init() {
    if (!initPromise) initPromise = load().catch((e) => { error = `vault unreadable: ${e.message}`; });
    return initPromise;
  }

  // May `dir` receive a copy of `v`? Only if it has no vault file yet, or a
  // readable copy of the SAME key pair. A different key, an older format or an
  // unreadable file is never overwritten — that could destroy the only key
  // for the files on that drive.
  async function canWriteCopy(dir, v) {
    let existing;
    try {
      existing = await mc.readVaultFile(path.join(dir, VAULT_NAME));
    } catch (e) {
      return `unreadable key file in ${path.relative(mediaDir, dir) || "media"} (${e.message}) — left untouched`;
    }
    if (!existing) return null;
    if (existing.pub !== v.pub) return `a different key file exists in ${path.relative(mediaDir, dir) || "media"} (key ${existing.kid || "?"}) — left untouched`;
    return null;
  }

  // Root copy must succeed (throws); other copies are best effort — a copy
  // that fails is reported and dropped, never left half-done silently.
  async function writeEverywhere(v) {
    const rootProblem = await canWriteCopy(mediaDir, v);
    if (rootProblem) throw httpError(409, rootProblem, "VAULT_CONFLICT");
    await mc.writeVaultFile(vaultFile, v);
    copies.add(mediaDir);
    for (const dir of [...copies]) {
      if (dir === mediaDir) continue;
      try {
        const problem = await canWriteCopy(dir, v);
        if (problem) { console.error(`[vault] ${problem}`); copies.delete(dir); error = problem; continue; }
        await mc.writeVaultFile(path.join(dir, VAULT_NAME), v);
      } catch (e) {
        console.error(`[vault] could not update the key copy in ${dir}: ${e.message}`);
        copies.delete(dir);
      }
    }
  }

  async function ensureCopyAt(dir, dev) {
    if (!vault) return;
    if (!copies.has(dir)) {
      try {
        const problem = await canWriteCopy(dir, vault);
        if (problem) { console.error(`[vault] ${problem}`); error = problem; return; }
        await mc.writeVaultFile(path.join(dir, VAULT_NAME), vault);
        copies.add(dir);
      } catch (e) {
        console.error(`[vault] could not write copy to ${dir}: ${e.message}`);
        return;
      }
    }
    if (dev != null) checkedDevs.add(dev);
  }

  // Any already-encrypted media file? (Setup must not create a new key while
  // files locked with an existing key are present — e.g. drive not mounted.)
  async function anyEncryptedFile() {
    const stack = [mediaDir];
    let seen = 0;
    while (stack.length && seen < 200000) {
      const dir = stack.pop();
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const en of entries) {
        if (en.name.startsWith(".") || en.isSymbolicLink()) continue;
        const full = path.join(dir, en.name);
        if (en.isDirectory()) { stack.push(full); continue; }
        if (!en.isFile()) continue;
        seen += 1;
        const h = await mc.readFileHeader(full).catch(() => null);
        if (h) return path.relative(mediaDir, full);
      }
    }
    return null;
  }

  async function copyToDriveRoots() {
    if (!vault) return;
    const rootDev = (await fs.stat(mediaDir)).dev;
    const entries = await fs.readdir(mediaDir, { withFileTypes: true }).catch(() => []);
    for (const en of entries) {
      if (!en.isDirectory() || en.name.startsWith(".")) continue;
      const dir = path.join(mediaDir, en.name);
      const st = await fs.stat(dir).catch(() => null);
      if (st && st.dev !== rootDev) await ensureCopyAt(dir, st.dev);
    }
  }

  // Before encrypting `fullPath`, make sure its drive carries a vault copy at
  // the drive's mount root (walk up until the device changes).
  async function ensureCopyFor(fullPath) {
    if (!vault) return;
    try {
      let cur = path.dirname(fullPath);
      let st = await fs.stat(cur);
      if (checkedDevs.has(st.dev)) return;
      const rootDev = (await fs.stat(mediaDir)).dev;
      if (st.dev === rootDev) { checkedDevs.add(st.dev); return; }
      while (cur !== mediaDir && cur.startsWith(mediaDir)) {
        const parent = path.dirname(cur);
        const pst = await fs.stat(parent);
        if (pst.dev !== st.dev) break;
        cur = parent;
        st = pst;
      }
      await ensureCopyAt(cur, st.dev);
    } catch {}
  }

  function encryptNewEnabled() {
    // On by default once encryption is set up; ENCRYPT_NEW_MEDIA=0 turns it off.
    return String(process.env.ENCRYPT_NEW_MEDIA || "1") !== "0" && isProtected() && !!vault;
  }

  function status() {
    return {
      available: isProtected(),
      exists: !!vault,
      unlocked: !!privateKey,
      patternSlot: !!(vault && vault.slots && vault.slots.pattern),
      unreadable: unreadable.map((u) => path.relative(mediaDir, u.dir) || "."),
      error: !vault && unreadable.length ? `A key file exists but can't be read (${unreadable.map((u) => `${path.relative(mediaDir, u.dir) || "media"}: ${u.error}`).join("; ")}) — restore it from a backup or another drive; setup is blocked so it isn't replaced`
        : error,
      encryptNew: encryptNewEnabled(),
      keyId: vault ? vault.kid : null,
      createdAt: vault ? vault.createdAt || null : null,
      copies: [...copies].map((d) => path.relative(mediaDir, d) || "."),
      minPassword: mc.MIN_PASSWORD,
    };
  }

  // Slow part of sealing a slot, done ahead of time (at login) so encryption
  // can later be switched on with only a confirmation (plan 042).
  function deriveSlotKey(slotName, secret) {
    return mc.deriveSlotKey(secret, scryptParams || (slotName === "pattern" ? mc.SCRYPT_PATTERN : mc.SCRYPT));
  }

  // `secret` = the panel password (already verified against the login hash)
  // or { passwordKey, patternKey } derived from it at login.
  async function setup(secret) {
    await init();
    if (!isProtected()) throw httpError(400, "Set a panel password first", "NO_PASSWORD");
    await load(); // a drive may have been mounted since startup
    if (vault) throw httpError(409, "Encryption is already set up", "VAULT_EXISTS");
    // Never create a new key over an old one: files locked with it would be lost.
    if (unreadable.length) throw httpError(409, "A key file exists but can't be read — fix or restore it first; a new key would make existing locked files unreadable", "VAULT_UNREADABLE");
    const already = await anyEncryptedFile();
    if (already) throw httpError(409, `Encrypted files already exist (e.g. ${already}) but their key file wasn't found — is the right drive mounted? Setup is blocked so they aren't stranded.`, "ORPHAN_FILES");
    let made;
    try {
      made = typeof secret === "string"
        ? await mc.createVault(secret, scryptParams || undefined)
        : mc.createVaultWithKeys(secret && secret.passwordKey, secret && secret.patternKey);
    } catch (e) {
      throw httpError(e.status || 400, e.message, e.code);
    }
    await fs.mkdir(mediaDir, { recursive: true });
    await mc.writeVaultFile(vaultFile, made.vault);
    vault = made.vault;
    publicKey = made.publicKey;
    privateKey = made.privateKey;
    copies.add(mediaDir);
    await copyToDriveRoots();
  }

  // Open the vault with the password or the canonical pattern string.
  async function unlock(slotName, secret) {
    await init();
    if (!vault) await load();
    if (!vault) throw httpError(404, "Encryption is not set up (or the media drive is not mounted)", "NO_VAULT");
    if (privateKey) return;
    // Try the current copy first, then other copies of the same key, and the
    // previous password slot kept during a password change (crash safety).
    const candidates = [vault, ...foundCopies.map((f) => f.vault).filter((v) => v !== vault)];
    const slotNames = slotName === "password" ? ["password", "passwordPrev"] : [slotName];
    let lastErr = null;
    for (const v of candidates) {
      for (const sn of slotNames) {
        if (!v.slots || !v.slots[sn]) continue;
        try {
          privateKey = await mc.openVault(v, secret, sn);
          break;
        } catch (e) { lastErr = e; }
      }
      if (privateKey) break;
    }
    if (!privateKey) {
      const e = lastErr || Object.assign(new Error(`wrong ${slotName}`), { status: 401 });
      throw httpError(e.status || 401, slotName === "pattern" ? "wrong pattern" : "wrong password", slotName === "pattern" ? "BAD_PATTERN" : "BAD_PASSWORD");
    }
    await copyToDriveRoots();
  }

  function lockNow() {
    privateKey = null;
    nameGen += 1;
    for (const e of infoCache.values()) { e.realName = undefined; e.nameGenOf = -1; }
  }

  // Re-seal a slot (password change, pattern set/removed). Needs the private
  // key: from memory, or opened with the current password.
  function setSlot(slotName, secret, opts = {}) {
    const run = () => setSlotNow(slotName, secret, opts);
    const p = slotChain.then(run, run);
    slotChain = p.catch(() => {});
    return p;
  }
  // keepPrevious: during a password change the old password slot is kept as
  // "passwordPrev" until the login hash is saved too (dropPrevious), so a
  // crash in between can never leave files unopenable.
  async function setSlotNow(slotName, secret, { currentPassword, keepPrevious = false } = {}) {
    await init();
    if (!vault) return false;
    let key = privateKey;
    if (!key) {
      if (!currentPassword) throw httpError(423, "Unlock encryption first", "VAULT_LOCKED");
      key = await mc.openVault(vault, currentPassword, "password").catch((e) => { throw httpError(e.status || 401, e.message, e.code); });
    }
    let next;
    try {
      next = await mc.setVaultSlot(vault, key, slotName, secret, scryptParams || undefined);
    } catch (e) {
      throw httpError(e.status || 400, e.message, e.code);
    }
    if (slotName === "password" && keepPrevious && vault.slots && vault.slots.password) next.slots.passwordPrev = vault.slots.password;
    await writeEverywhere(next); // throws before `vault` changes if the root copy fails
    vault = next;
    foundCopies = foundCopies.map((f) => ({ ...f, vault: next }));
    return true;
  }

  function dropPrevious() {
    const run = async () => {
      if (!vault || !vault.slots || !vault.slots.passwordPrev) return;
      const next = { ...vault, slots: { ...vault.slots }, updatedAt: new Date().toISOString() };
      delete next.slots.passwordPrev;
      await writeEverywhere(next);
      vault = next;
    };
    const p = slotChain.then(run, run);
    slotChain = p.catch(() => {});
    return p;
  }

  async function encryptKey() {
    await init();
    if (!vault) await load();
    if (!isProtected()) throw httpError(400, "Set a panel password first", "NO_PASSWORD");
    if (!vault) throw httpError(400, "Set up encryption first (Settings → Encryption)", "NO_VAULT");
    return publicKey;
  }

  async function decryptKey() {
    await init();
    return privateKey;
  }

  async function fileInfo(fullPath, hint) {
    let size, mtimeMs;
    if (hint && Number.isFinite(hint.size) && Number.isFinite(hint.mtimeMs)) {
      ({ size, mtimeMs } = hint);
    } else {
      const st = await fs.stat(fullPath).catch(() => null);
      if (!st || !st.isFile()) return null;
      size = st.size;
      mtimeMs = st.mtimeMs;
    }
    const hit = infoCache.get(fullPath);
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit;
    const header = size >= mc.HEADER_LEN + mc.TAG_LEN ? await mc.readFileHeader(fullPath) : null;
    const entry = { size, mtimeMs, header, locked: !!header };
    if (infoCache.size > 50000) infoCache.clear();
    infoCache.set(fullPath, entry);
    return entry;
  }

  function forget(fullPath) {
    infoCache.delete(fullPath);
  }

  // The real name stored in an encrypted file. null when the vault is
  // locked, the file isn't encrypted or the stored name is unusable.
  async function fileName(fullPath, hint) {
    const info = await fileInfo(fullPath, hint);
    if (!info || !info.locked || !info.header) return null;
    if (!privateKey) return null;
    if (info.nameGenOf === nameGen) return info.realName;
    let name = null;
    try {
      name = safeStoredName(mc.decryptFileName(info.header, privateKey));
    } catch {
      name = null;
    }
    info.realName = name;
    info.nameGenOf = nameGen;
    return name;
  }

  function createdOverride(stat) {
    if (!stat || !stat.ino) return null;
    const e = created[`${stat.dev}:${stat.ino}`];
    if (!e || e.size !== stat.size || Math.abs(e.mtimeMs - stat.mtimeMs) > 1) return null;
    return e.createdMs;
  }

  async function setCreatedOverride(stat, createdMs) {
    if (!stat || !stat.ino || !(createdMs > 0)) return;
    created[`${stat.dev}:${stat.ino}`] = { createdMs, size: stat.size, mtimeMs: stat.mtimeMs };
    await saveCreated();
  }

  return {
    vaultFile,
    VAULT_NAME,
    init,
    reload: load,
    status,
    setup,
    deriveSlotKey,
    unlock,
    lockNow,
    setSlot,
    dropPrevious,
    encryptKey,
    decryptKey,
    ensureCopyFor,
    fileInfo,
    fileName,
    forget,
    createdOverride,
    setCreatedOverride,
    encryptNewEnabled,
    exists: () => !!vault,
  };
}

// A stored name is only used if it's a plain, safe file name (it comes out of
// a file anyone with the drive could have swapped in).
function safeStoredName(name) {
  const n = String(name || "");
  if (!n || n.length > 255 || n === "." || n === ".." || n.startsWith(".")) return null;
  if (/[\/\\\0-\x1f]/.test(n)) return null;
  return n;
}

module.exports = { createMediaVault, httpError, VAULT_NAME, safeStoredName };
