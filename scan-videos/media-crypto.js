// Media-at-rest encryption (plan 039; v3 vault: password or pattern slots).
//
// A random X25519 key pair is generated once and stored with the media (the
// vault file). Its private half is sealed by the user's secrets — the panel
// password and optionally the 5x5 pattern — which are never stored. The PUBLIC
// key is in the clear so the server can encrypt new files at any time; reading
// needs the private key, which only lives in server memory after unlock.
//
// Content = chunked AES-256-GCM so it decrypts at random offsets (HTTP Range
// / video seeking). The file name is hidden too: the file on disk gets a
// random code name (plan 041) and the real name is stored encrypted right
// after the header.
//
//   header (128 B):
//     "XDLENC03"(8) | ephPub(32) | wrappedFileKey(48) | salt(16)
//     | chunkSize u32 BE(4) | createdMs u64 BE(8) | kid(4) | reserved(8)
//   name block (286 B):
//     nonce(12) | AES-256-GCM(nameKey, AAD="xdl-name"|salt,
//                             u16 len | utf8 name | zero pad to 258) | tag(16)
//     nameKey = HKDF-SHA256(fileKey, salt, "xdl-name-v3")
//   body: N >= 1 chunks, each = ciphertext(<= chunkSize) + GCM tag(16)
//
//   fileKey  = 32 random bytes per file
//   shared   = X25519(ephPriv, vaultPub)  ==  X25519(vaultPriv, ephPub)
//   kek      = HKDF-SHA256(shared, ephPub|vaultPub, "xdl-wrap-v2")
//   wrapped  = AES-256-GCM(kek, nonce=0^12, AAD=magic|salt, fileKey)
//   chunk i  = AES-256-GCM(fileKey, nonce=0^8|u32 i, AAD=salt|u32 i|isLast)
//
// The plain size is derived from the file size, so encryption can stream
// (uploads) without knowing the length up front.
const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { Readable } = require("stream");

const MAGIC = Buffer.from("XDLENC03", "latin1");
const HEADER_LEN = 128;
const NAME_PLAIN_LEN = 258; // u16 length + up to 256 bytes of UTF-8
const NAME_BLOCK_LEN = 12 + NAME_PLAIN_LEN + 16;
const NAME_INFO = Buffer.from("xdl-name-v3", "latin1");
const NAME_AAD = Buffer.from("xdl-name", "latin1");
const TAG_LEN = 16;
const DEFAULT_CHUNK = 64 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
const WRAP_INFO = Buffer.from("xdl-wrap-v2", "latin1");
const VAULT_AAD = Buffer.from("xdl-vault-v2", "latin1");

// ---- X25519 helpers (raw 32-byte keys <-> KeyObjects) ----
function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function publicKeyFromRaw(raw) {
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64url(raw) }, format: "jwk" });
}
function privateKeyFromRaw(rawPriv, rawPub) {
  return crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: b64url(rawPub), d: b64url(rawPriv) }, format: "jwk" });
}
function rawPublic(keyObject) {
  return Buffer.from(keyObject.export({ format: "jwk" }).x, "base64url");
}
function rawPrivate(keyObject) {
  return Buffer.from(keyObject.export({ format: "jwk" }).d, "base64url");
}
function keyIdOf(rawPub) {
  return crypto.createHash("sha256").update(rawPub).digest().subarray(0, 4);
}
function wrapKek(shared, ephPubRaw, vaultPubRaw) {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([ephPubRaw, vaultPubRaw]), WRAP_INFO, 32));
}

// ---- header ----
function buildHeader({ ephPub, wrapped, salt, chunkSize, createdMs, kid }) {
  const h = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(h, 0);
  ephPub.copy(h, 8);
  wrapped.copy(h, 40);
  salt.copy(h, 88);
  h.writeUInt32BE(chunkSize, 104);
  h.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(Number(createdMs) || 0))), 108);
  kid.copy(h, 116);
  return h;
}

// `buf` holds the header plus the name block (null if not an encrypted file).
function parseHeader(buf) {
  if (!buf || buf.length < HEADER_LEN + NAME_BLOCK_LEN) return null;
  if (!buf.subarray(0, 8).equals(MAGIC)) return null;
  const chunkSize = buf.readUInt32BE(104);
  if (!chunkSize || chunkSize > MAX_CHUNK) return null;
  return {
    bodyOffset: HEADER_LEN + NAME_BLOCK_LEN,
    nameBlock: Buffer.from(buf.subarray(HEADER_LEN, HEADER_LEN + NAME_BLOCK_LEN)),
    ephPub: Buffer.from(buf.subarray(8, 40)),
    wrapped: Buffer.from(buf.subarray(40, 88)),
    salt: Buffer.from(buf.subarray(88, 104)),
    chunkSize,
    createdMs: Number(buf.readBigUInt64BE(108)),
    kid: Buffer.from(buf.subarray(116, 120)).toString("hex"),
  };
}

// Chunk geometry for an encrypted file of `fileSize` bytes. null = malformed.
function cipherLayout(fileSize, chunkSize, bodyOffset = HEADER_LEN + NAME_BLOCK_LEN) {
  const body = fileSize - bodyOffset;
  if (body < TAG_LEN) return null;
  const full = chunkSize + TAG_LEN;
  const chunks = Math.ceil(body / full);
  const lastLen = body - (chunks - 1) * full;
  if (lastLen < TAG_LEN) return null;
  return { chunks, plainSize: body - chunks * TAG_LEN, lastLen };
}

function chunkNonce(i) {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(i, 8);
  return n;
}

function chunkAad(salt, i, isLast) {
  const a = Buffer.alloc(21);
  salt.copy(a, 0);
  a.writeUInt32BE(i, 16);
  a[20] = isLast ? 1 : 0;
  return a;
}

function encryptChunk(fileKey, salt, i, isLast, plain) {
  const c = crypto.createCipheriv("aes-256-gcm", fileKey, chunkNonce(i));
  c.setAAD(chunkAad(salt, i, isLast));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

function decryptChunk(fileKey, salt, i, isLast, data) {
  if (data.length < TAG_LEN) throw new Error("encrypted chunk truncated");
  const d = crypto.createDecipheriv("aes-256-gcm", fileKey, chunkNonce(i));
  d.setAAD(chunkAad(salt, i, isLast));
  d.setAuthTag(data.subarray(data.length - TAG_LEN));
  return Buffer.concat([d.update(data.subarray(0, data.length - TAG_LEN)), d.final()]);
}

// New per-file key, wrapped to the vault's public key (no passphrase needed).
function wrapNewFileKey(vaultPublicKey) {
  const vaultPubRaw = rawPublic(vaultPublicKey);
  const eph = crypto.generateKeyPairSync("x25519");
  const ephPubRaw = rawPublic(eph.publicKey);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: vaultPublicKey });
  const kek = wrapKek(shared, ephPubRaw, vaultPubRaw);
  const fileKey = crypto.randomBytes(32);
  const salt = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-256-gcm", kek, Buffer.alloc(12));
  c.setAAD(Buffer.concat([MAGIC, salt]));
  const wrapped = Buffer.concat([c.update(fileKey), c.final(), c.getAuthTag()]);
  return { fileKey, salt, ephPub: ephPubRaw, wrapped, kid: keyIdOf(vaultPubRaw) };
}

// Recover a file's key with the vault private key.
function unwrapFileKey(header, vaultPrivateKey) {
  const vaultPubRaw = rawPublic(crypto.createPublicKey(vaultPrivateKey));
  if (keyIdOf(vaultPubRaw).toString("hex") !== header.kid) {
    throw Object.assign(new Error("file was encrypted with a different vault key"), { code: "WRONG_VAULT" });
  }
  const shared = crypto.diffieHellman({ privateKey: vaultPrivateKey, publicKey: publicKeyFromRaw(header.ephPub) });
  const kek = wrapKek(shared, header.ephPub, vaultPubRaw);
  const d = crypto.createDecipheriv("aes-256-gcm", kek, Buffer.alloc(12));
  d.setAAD(Buffer.concat([MAGIC, header.salt]));
  d.setAuthTag(header.wrapped.subarray(32));
  return Buffer.concat([d.update(header.wrapped.subarray(0, 32)), d.final()]);
}

function nameKeyOf(fileKey, salt) {
  return Buffer.from(crypto.hkdfSync("sha256", fileKey, salt, NAME_INFO, 32));
}
function sealName(fileKey, salt, name) {
  const utf8 = Buffer.from(String(name || ""), "utf8");
  if (utf8.length > NAME_PLAIN_LEN - 2) throw Object.assign(new Error("file name too long to encrypt"), { code: "NAME_TOO_LONG", status: 400 });
  const plain = Buffer.alloc(NAME_PLAIN_LEN);
  plain.writeUInt16BE(utf8.length, 0);
  utf8.copy(plain, 2);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", nameKeyOf(fileKey, salt), nonce);
  c.setAAD(Buffer.concat([NAME_AAD, salt]));
  return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]);
}
function openName(fileKey, salt, block) {
  const d = crypto.createDecipheriv("aes-256-gcm", nameKeyOf(fileKey, salt), block.subarray(0, 12));
  d.setAAD(Buffer.concat([NAME_AAD, salt]));
  d.setAuthTag(block.subarray(12 + NAME_PLAIN_LEN));
  const plain = Buffer.concat([d.update(block.subarray(12, 12 + NAME_PLAIN_LEN)), d.final()]);
  const len = plain.readUInt16BE(0);
  if (len > NAME_PLAIN_LEN - 2) throw new Error("bad name block");
  return plain.subarray(2, 2 + len).toString("utf8");
}
// The real file name stored in the header. Needs the vault PRIVATE key.
function decryptFileName(header, vaultPrivateKey) {
  if (!header || !header.nameBlock) return null;
  return openName(unwrapFileKey(header, vaultPrivateKey), header.salt, header.nameBlock);
}

async function readFully(fh, buf, position) {
  let off = 0;
  while (off < buf.length) {
    const { bytesRead } = await fh.read(buf, off, buf.length - off, position + off);
    if (!bytesRead) break;
    off += bytesRead;
  }
  return off;
}

async function writeFully(fh, buf) {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    off += bytesWritten;
  }
}

// Read the header of a file on disk. Returns parsed header (+ layout), or
// null when the file is readable and NOT encrypted. I/O errors (EMFILE, EIO,
// EACCES…) are thrown — never reported as "plain", which could lead to
// double encryption or ffmpeg being fed ciphertext.
async function readFileHeader(filePath) {
  let fh = null;
  try {
    fh = await fs.open(filePath, "r");
    const st = await fh.stat();
    if (!st.isFile() || st.size < HEADER_LEN + NAME_BLOCK_LEN + TAG_LEN) return null;
    const buf = Buffer.alloc(Math.min(st.size, HEADER_LEN + NAME_BLOCK_LEN));
    const got = await readFully(fh, buf, 0);
    if (got < HEADER_LEN) return null;
    const h = parseHeader(buf.subarray(0, got));
    if (!h) return null;
    const layout = cipherLayout(st.size, h.chunkSize, h.bodyOffset);
    if (!layout) return null;
    return { ...h, ...layout, size: st.size, mtimeMs: st.mtimeMs };
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// Incremental encryptor: feed plaintext with push(), finish with end().
// Needs only the vault PUBLIC key.
// `name` = the real file name, stored encrypted in the header.
function createChunkEncryptor(vaultPublicKey, { chunkSize = DEFAULT_CHUNK, createdMs = Date.now(), name = "" } = {}) {
  const w = wrapNewFileKey(vaultPublicKey);
  const header = Buffer.concat([
    buildHeader({ ephPub: w.ephPub, wrapped: w.wrapped, salt: w.salt, chunkSize, createdMs, kid: w.kid }),
    sealName(w.fileKey, w.salt, name),
  ]);
  let pending = [];
  let pendingLen = 0;
  let index = 0;
  let plainSize = 0;
  const take = (n) => {
    const all = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    pending = rest.length ? [rest] : [];
    pendingLen = rest.length;
    return out;
  };
  return {
    header,
    // A full chunk is only released once more data follows it, because the
    // final chunk is flagged isLast.
    push(buf) {
      if (!buf || !buf.length) return [];
      pending.push(buf);
      pendingLen += buf.length;
      plainSize += buf.length;
      const out = [];
      while (pendingLen > chunkSize) out.push(encryptChunk(w.fileKey, w.salt, index++, false, take(chunkSize)));
      return out;
    },
    end() {
      return [encryptChunk(w.fileKey, w.salt, index++, true, take(pendingLen))];
    },
    get plainSize() { return plainSize; },
  };
}

function tempSiblingPath(filePath, tag) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${tag}-${crypto.randomBytes(4).toString("hex")}`);
}

// Stream plaintext (async iterable of Buffers) into a new encrypted file.
async function encryptIterableToFile(iterable, destPath, vaultPublicKey, opts = {}) {
  const enc = createChunkEncryptor(vaultPublicKey, opts);
  const fh = await fs.open(destPath, "wx", 0o600);
  try {
    await writeFully(fh, enc.header);
    for await (const piece of iterable) {
      const b = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      for (const c of enc.push(b)) await writeFully(fh, c);
    }
    for (const c of enc.end()) await writeFully(fh, c);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await fs.unlink(destPath).catch(() => {});
    throw e;
  }
  await fh.close();
  return { plainSize: enc.plainSize };
}

function fileBirthMs(st) {
  return st.birthtimeMs && st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs || st.mtimeMs;
}

// Encrypt a plain file in place (temp file + atomic rename). Keeps mtime/atime;
// the original creation time is stored in the header. Public key only.
// Encrypt a plain file into a hidden temp file next to it (same folder, so it
// can be committed with link/rename). Keeps mode/mtime/atime; the original
// creation time and `name` (default: the current name) go into the header.
// The caller commits `tmp` and removes the source. Public key only.
async function encryptToTemp(filePath, vaultPublicKey, { chunkSize = DEFAULT_CHUNK, createdMs, name } = {}) {
  const st = await fs.stat(filePath);
  if (!st.isFile()) throw new Error("not a file");
  if (await readFileHeader(filePath)) throw Object.assign(new Error("already encrypted"), { code: "ALREADY_LOCKED" });
  const born = Number.isFinite(createdMs) && createdMs > 0 ? createdMs : fileBirthMs(st);
  const tmp = tempSiblingPath(filePath, "xenc");
  const realName = name == null ? path.basename(filePath) : String(name);
  await encryptIterableToFile(fsSync.createReadStream(filePath, { highWaterMark: chunkSize }), tmp, vaultPublicKey, { chunkSize, createdMs: born, name: realName });
  try {
    // The source may have changed while we read it (e.g. still downloading).
    const now = await fs.stat(filePath);
    if (now.size !== st.size || now.mtimeMs !== st.mtimeMs) throw Object.assign(new Error("file changed while encrypting"), { code: "CHANGED" });
    await fs.chmod(tmp, st.mode & 0o7777).catch(() => {});
    await fs.utimes(tmp, st.atime, st.mtime);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  return { tmp, createdMs: born, before: st };
}

// Encrypt a plain file in place (temp file + atomic rename, name unchanged).
async function encryptFileInPlace(filePath, vaultPublicKey, opts = {}) {
  const r = await encryptToTemp(filePath, vaultPublicKey, opts);
  try {
    await fs.rename(r.tmp, filePath);
  } catch (e) {
    await fs.unlink(r.tmp).catch(() => {});
    throw e;
  }
  return { stat: await fs.stat(filePath), createdMs: r.createdMs, before: r.before };
}

// Async generator of plaintext for bytes [start, end] (inclusive) of an
// encrypted file. Needs the vault PRIVATE key. Validates every chunk touched.
async function* decryptRange(filePath, vaultPrivateKey, { start = 0, end = Infinity, header = null } = {}) {
  const h = header || (await readFileHeader(filePath));
  if (!h) throw Object.assign(new Error("not an encrypted file"), { code: "NOT_LOCKED" });
  const fileKey = unwrapFileKey(h, vaultPrivateKey);
  if (h.plainSize === 0) return;
  const last = Math.min(end, h.plainSize - 1);
  if (start > last) return;
  const fh = await fs.open(filePath, "r");
  try {
    const cs = h.chunkSize;
    const full = cs + TAG_LEN;
    const first = Math.floor(start / cs);
    const lastChunk = Math.floor(last / cs);
    for (let i = first; i <= lastChunk; i++) {
      const isLast = i === h.chunks - 1;
      const len = isLast ? h.lastLen : full;
      const buf = Buffer.alloc(len);
      if ((await readFully(fh, buf, h.bodyOffset + i * full)) < len) throw new Error("encrypted file truncated");
      const plain = decryptChunk(fileKey, h.salt, i, isLast, buf);
      const chunkStart = i * cs;
      yield plain.subarray(Math.max(0, start - chunkStart), Math.min(plain.length, last - chunkStart + 1));
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

function createDecryptStream(filePath, vaultPrivateKey, opts = {}) {
  return Readable.from(decryptRange(filePath, vaultPrivateKey, opts), { objectMode: false });
}

// Decrypt in place (temp + rename). Keeps mtime/atime. Private key.
// Permissions for a decrypted file: the encrypted file's, plus the normal
// read/write bits for new files (0666 minus the umask, usually 0644).
function plainFileMode(encryptedMode) {
  let umask = 0o022;
  try { umask = process.umask(); } catch {}
  return ((encryptedMode & 0o7777) | (0o666 & ~umask)) & 0o7777;
}

// Decrypt into a hidden temp file next to the source (keeps mode/mtime/atime).
// Returns the temp path, the stored creation time and the stored real name
// The caller commits `tmp`. Private key.
async function decryptToTemp(filePath, vaultPrivateKey) {
  const st = await fs.stat(filePath);
  const h = await readFileHeader(filePath);
  if (!h) throw Object.assign(new Error("not encrypted"), { code: "NOT_LOCKED" });
  unwrapFileKey(h, vaultPrivateKey); // fail fast before creating the temp file
  const name = decryptFileName(h, vaultPrivateKey);
  const tmp = tempSiblingPath(filePath, "xdec");
  const out = await fs.open(tmp, "wx", 0o600);
  try {
    for await (const piece of decryptRange(filePath, vaultPrivateKey, { header: h })) await writeFully(out, piece);
    await out.sync();
    await out.close();
    // Unlocked files are ordinary media again: readable like any other file
    // (encrypted uploads are written owner-only, and the app may run as root).
    await fs.chmod(tmp, plainFileMode(st.mode)).catch(() => {});
    await fs.utimes(tmp, st.atime, st.mtime);
  } catch (e) {
    await out.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  return { tmp, createdMs: h.createdMs, name, header: h, before: st };
}

// Decrypt in place (temp + rename, name on disk unchanged). Private key.
async function decryptFileInPlace(filePath, vaultPrivateKey) {
  const r = await decryptToTemp(filePath, vaultPrivateKey);
  try {
    await fs.rename(r.tmp, filePath);
  } catch (e) {
    await fs.unlink(r.tmp).catch(() => {});
    throw e;
  }
  return { stat: await fs.stat(filePath), createdMs: r.createdMs, name: r.name, before: r.before };
}

// Random on-disk name for a locked file: 16 characters (80 bits), no
// extension — the type is read from the real name stored inside the file.
const CODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function codeName() {
  const bytes = crypto.randomBytes(16);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b & 31];
  return code;
}
const CODE_RE = /^[a-km-z2-9]{16}$/;
function isCodeName(name) {
  return CODE_RE.test(String(name || ""));
}

// ---- Vault (v3): X25519 key pair; the private half is sealed in "slots" ----
// One slot per unlock secret: the panel password and (optionally) the 5x5
// pattern. The vault file holds NO usable secret: the public key (encrypt-
// only) and the private key encrypted with scrypt(secret) per slot. A copy of
// the vault lives on every drive, so drive + password (or pattern) recovers it.
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
// Patterns have far fewer combinations than a password, so their slot uses
// a 2x more expensive scrypt to slow offline guessing a little more.
const SCRYPT_PATTERN = { N: 1 << 18, r: 8, p: 1 };
const MIN_PASSWORD = 1; // no length rule: the panel shows how long a password would take to crack
const SLOTS = new Set(["password", "pattern"]);

function scryptAsync(secret, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(secret), salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 32 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function checkPassword(password) {
  const p = String(password || "");
  if (p.length < MIN_PASSWORD) throw Object.assign(new Error("a password is required"), { code: "WEAK_PASSWORD", status: 400 });
  return p;
}

// scrypt(secret) with a fresh salt — the slow part of sealing a slot. Done
// at login (plan 042) so encryption can be switched on later with just a
// confirmation; only this derived key is kept in memory, never the secret.
async function deriveSlotKey(secret, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const kek = await scryptAsync(secret, salt, params);
  return { kek, salt, params: { N: params.N, r: params.r, p: params.p } };
}

async function sealSlot(privateKey, secret, params) {
  return sealSlotWithKey(privateKey, await deriveSlotKey(secret, params));
}

// Seal the private key with an already-derived key (one use per derived key).
function sealSlotWithKey(privateKey, derived) {
  const { kek, salt, params } = derived;
  const iv = crypto.randomBytes(12);
  const pubRaw = rawPublic(crypto.createPublicKey(privateKey));
  const c = crypto.createCipheriv("aes-256-gcm", kek, iv);
  c.setAAD(Buffer.concat([VAULT_AAD, pubRaw]));
  const ct = Buffer.concat([c.update(rawPrivate(privateKey)), c.final()]);
  return { kdf: "scrypt", N: params.N, r: params.r, p: params.p, salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64"), updatedAt: new Date().toISOString() };
}

function vaultPublicKey(vault) {
  if (!vault || vault.v !== 3 || !vault.pub) throw new Error("unsupported vault format");
  return publicKeyFromRaw(Buffer.from(vault.pub, "base64"));
}

// Open a sealed private key (one vault slot).
async function openSealed(slot, pubB64, secret, label) {
  const pubRaw = Buffer.from(pubB64, "base64");
  const kek = await scryptAsync(secret, Buffer.from(slot.salt, "base64"), slot);
  let privRaw;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", kek, Buffer.from(slot.iv, "base64"));
    d.setAAD(Buffer.concat([VAULT_AAD, pubRaw]));
    d.setAuthTag(Buffer.from(slot.tag, "base64"));
    privRaw = Buffer.concat([d.update(Buffer.from(slot.ct, "base64")), d.final()]);
  } catch {
    throw Object.assign(new Error(`wrong ${label}`), { code: `BAD_${label.toUpperCase()}`, status: 401 });
  }
  const priv = privateKeyFromRaw(privRaw, pubRaw);
  if (!rawPublic(crypto.createPublicKey(priv)).equals(pubRaw)) throw new Error("vault key pair mismatch");
  return priv;
}

// Open one slot with its secret -> private KeyObject.
async function openVault(vault, secret, slotName = "password") {
  if (!vault || vault.v !== 3) throw new Error("unsupported vault format");
  const slot = vault.slots && vault.slots[slotName];
  if (!slot) throw Object.assign(new Error(`no ${slotName} slot in this vault`), { code: "NO_SLOT", status: 400 });
  return openSealed(slot, vault.pub, secret, slotName);
}

async function createVault(password, params = SCRYPT) {
  checkPassword(password);
  return createVaultWithKeys(await deriveSlotKey(password, params));
}

// New vault from derived slot keys (password required; pattern optional).
function createVaultWithKeys(passwordKey, patternKey = null) {
  if (!passwordKey || !passwordKey.kek) throw Object.assign(new Error("password key required"), { code: "NEEDS_PASSWORD", status: 400 });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const pubRaw = rawPublic(publicKey);
  const now = new Date().toISOString();
  const slots = { password: sealSlotWithKey(privateKey, passwordKey) };
  if (patternKey && patternKey.kek) slots.pattern = sealSlotWithKey(privateKey, patternKey);
  const vault = { v: 3, pub: pubRaw.toString("base64"), kid: keyIdOf(pubRaw).toString("hex"), createdAt: now, updatedAt: now, slots };
  return { vault, privateKey, publicKey };
}

// Returns a NEW vault object with `slotName` sealed to `secret` (or removed
// when secret is null). Needs the private key (from any slot).
async function setVaultSlot(vault, privateKey, slotName, secret, params) {
  if (!SLOTS.has(slotName)) throw new Error("unknown slot");
  const next = { ...vault, slots: { ...(vault.slots || {}) }, updatedAt: new Date().toISOString() };
  if (secret == null) {
    if (slotName === "password") throw new Error("the password slot cannot be removed");
    delete next.slots[slotName];
  } else {
    if (slotName === "password") checkPassword(secret);
    next.slots[slotName] = await sealSlot(privateKey, secret, params || (slotName === "pattern" ? SCRYPT_PATTERN : SCRYPT));
  }
  return next;
}

async function readVaultFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

// Durable write: data is fsynced before the rename (USB drives / power loss
// must never leave a torn or empty vault file).
async function writeVaultFile(file, vault) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  const fh = await fs.open(tmp, "wx", 0o600);
  try {
    await writeFully(fh, Buffer.from(JSON.stringify(vault, null, 2), "utf8"));
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  await fh.close();
  await fs.rename(tmp, file);
  try { const d = await fs.open(path.dirname(file), "r"); await d.sync().catch(() => {}); await d.close(); } catch {}
}

// Matches the temp files written next to media while encrypting/decrypting/uploading.
const TEMP_RE = /^\..+\.(xenc|xdec|xupl)-[0-9a-f]{8}$/;

// Files the lock job must never touch: dotfiles (vault, temp files), stack
// metadata, and partial downloads.
function isLockableName(name) {
  const n = String(name || "");
  if (!n || n.startsWith(".")) return false;
  if (/\.(xdlstack|part|tmp|ytdl|crdownload)$/i.test(n)) return false;
  return true;
}

module.exports = {
  MAGIC,
  HEADER_LEN,
  NAME_BLOCK_LEN,
  decryptFileName,
  encryptToTemp,
  decryptToTemp,
  codeName,
  isCodeName,
  TAG_LEN,
  DEFAULT_CHUNK,
  SCRYPT,
  MIN_PASSWORD,
  parseHeader,
  cipherLayout,
  readFileHeader,
  wrapNewFileKey,
  unwrapFileKey,
  createChunkEncryptor,
  encryptIterableToFile,
  encryptFileInPlace,
  decryptFileInPlace,
  decryptRange,
  createDecryptStream,
  createVault,
  createVaultWithKeys,
  deriveSlotKey,
  openVault,
  setVaultSlot,
  vaultPublicKey,
  checkPassword,
  SCRYPT_PATTERN,
  readVaultFile,
  writeVaultFile,
  isLockableName,
  tempSiblingPath,
  TEMP_RE,
};
