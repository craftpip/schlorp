// Panel login: password + optional pattern, sessions, attempt limits (plan 040 v2).
//
// - The panel password is never stored in plain text: only a slow salted
//   scrypt hash in <root>/.xdl-auth.json (next to the app, gitignored).
// - One pattern (5x5 grid, at least 8 dots) can log in instead of the password.
//   The same pattern also seals a slot in the media vault, so it must be strong
//   enough to face offline guessing — hence the 5x5 / 8-dot minimum.
// - Logins issue random session tokens held in memory only (gone on restart).
const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const PATTERN_SIZE = 5;
const MIN_DOTS = 8;
// Same cost as the vault slots, so the login hash is never the cheaper
// target for offline guessing (password 2^17, pattern 2^18).
const HASH = { N: 1 << 17, r: 8, p: 1 };
const HASH_PATTERN = { N: 1 << 18, r: 8, p: 1 };
const AUTO_LOCK_CHOICES = new Set([0, 5, 15, 30, 60, 120]);
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

// Validate + canonicalize a pattern: { size, dots } -> "5:a.b.c…"
function normalizePattern(input) {
  const size = Number(input && input.size);
  const dots = Array.isArray(input && input.dots) ? input.dots.map(Number) : null;
  if (size !== PATTERN_SIZE) throw httpError(400, `the pattern grid must be ${PATTERN_SIZE}×${PATTERN_SIZE}`, "BAD_PATTERN");
  if (!dots || dots.length < MIN_DOTS) throw httpError(400, `connect at least ${MIN_DOTS} dots`, "BAD_PATTERN");
  const seen = new Set();
  for (const d of dots) {
    if (!Number.isInteger(d) || d < 0 || d >= size * size || seen.has(d)) throw httpError(400, "invalid pattern", "BAD_PATTERN");
    seen.add(d);
  }
  return `${size}:${dots.join(".")}`;
}

function scryptAsync(secret, salt, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r + 16 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k)));
  });
}

async function hashSecret(secret, params = HASH) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(secret), salt, params);
  return { salt: salt.toString("base64"), hash: hash.toString("base64"), N: params.N, r: params.r, p: params.p };
}

async function verifySecret(stored, secret) {
  if (!stored) return false;
  const got = await scryptAsync(String(secret), Buffer.from(stored.salt, "base64"), stored);
  const want = Buffer.from(stored.hash, "base64");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Escalating lockout: 5 free tries, then 1 min, 2 min, 4 min, capped at 5
// min. The failure count fades after `decayMs` without failures, so a single
// stray attempt can't keep the owner locked out forever.
function createLimiter({ free = 5, baseMs = 60000, maxMs = 5 * 60000, decayMs = 15 * 60000, now = () => Date.now() } = {}) {
  let fails = 0;
  let lockedUntil = 0;
  let lastFail = 0;
  const decay = () => { if (fails && now() - lastFail > decayMs) { fails = 0; lockedUntil = 0; } };
  return {
    check() {
      decay();
      const wait = lockedUntil - now();
      if (wait > 0) throw httpError(429, `too many wrong attempts — try again in ${Math.ceil(wait / 1000)}s`, "LOCKED_OUT");
    },
    fail() {
      decay();
      fails += 1;
      lastFail = now();
      if (fails >= free) lockedUntil = now() + Math.min(maxMs, baseMs * 2 ** (fails - free));
      return Math.max(0, free - fails);
    },
    success() { fails = 0; lockedUntil = 0; },
    get idle() { decay(); return fails === 0; },
  };
}

function createPatternAuth({ rootDir, hashParams = HASH, patternHashParams = null }) {
  const patternParams = patternHashParams || (hashParams === HASH ? HASH_PATTERN : hashParams);
  const file = path.join(rootDir, ".xdl-auth.json");
  let cfg = { password: null, pattern: null, preferLogin: "password", autoLockMinutes: 0 };
  // Fail closed: if the auth file exists but can't be read or parsed, the
  // panel stays protected (every login fails) instead of opening up.
  let corrupt = null;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      cfg = { ...cfg, ...parsed };
      // Earlier format: loginPattern (any grid) — not valid any more.
      if (parsed.loginPattern && !parsed.pattern) cfg.pattern = null;
      delete cfg.loginPattern;
      delete cfg.unlockPattern;
      delete cfg.preferUnlock;
    }
  } catch (e) {
    if (!e || e.code !== "ENOENT") {
      corrupt = `cannot read ${path.basename(file)}: ${e && e.message}`;
      console.error(`[auth] ${corrupt} — the panel stays locked until this is fixed`);
    }
  }
  // Per-client limiters (keyed by IP; behind a NAT/bridge everyone may share
  // one) for login + vault unlock.
  const limiters = new Map();
  const limiterFor = (key) => {
    const k = String(key || "-");
    let l = limiters.get(k);
    if (!l) {
      if (limiters.size > 1000) for (const [kk, ll] of limiters) if (ll.idle) limiters.delete(kk);
      l = createLimiter();
      limiters.set(k, l);
    }
    return l;
  };
  // Secret checks run one at a time: parallel guesses can't slip past the
  // lockout, and floods can't tie up the libuv threadpool with scrypt.
  let checkChain = Promise.resolve();
  const sessions = new Map(); // token -> expiresAt

  async function save() {
    const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
  }

  function publicSettings() {
    return {
      hasPassword: !!cfg.password,
      pattern: cfg.pattern ? { size: PATTERN_SIZE } : null,
      preferLogin: cfg.preferLogin === "pattern" && cfg.pattern ? "pattern" : "password",
      autoLockMinutes: Number(cfg.autoLockMinutes) || 0,
      autoLockChoices: [...AUTO_LOCK_CHOICES],
      patternSize: PATTERN_SIZE,
      minDots: MIN_DOTS,
    };
  }

  // Rate-limited secret check. kind: "password" | "pattern". Returns the
  // canonical secret (pattern string or password) on success.
  function check(kind, input, clientKey) {
    const run = () => checkNow(kind, input, limiterFor(clientKey));
    const p = checkChain.then(run, run);
    checkChain = p.catch(() => {});
    return p;
  }
  async function checkNow(kind, input, limiter) {
    if (corrupt) throw httpError(503, `login is unavailable: ${corrupt}`, "AUTH_FILE");
    limiter.check();
    let secret = null;
    let ok = false;
    if (kind === "pattern") {
      if (!cfg.pattern) throw httpError(400, "no pattern is set", "NO_PATTERN");
      try { secret = normalizePattern(input); } catch { secret = null; }
      ok = !!secret && (await verifySecret(cfg.pattern, secret));
    } else {
      if (!cfg.password) throw httpError(400, "no password is set", "NO_PASSWORD");
      secret = String(input ?? "");
      ok = await verifySecret(cfg.password, secret);
    }
    if (!ok) {
      const left = limiter.fail();
      throw httpError(401, `wrong ${kind}${left ? ` — ${left} attempt${left === 1 ? "" : "s"} left` : " — locked for a while"}`, kind === "pattern" ? "BAD_PATTERN" : "BAD_PASSWORD");
    }
    limiter.success();
    return secret;
  }

  async function setPassword(newPassword) {
    const p = String(newPassword ?? "");
    if (!p) {
      cfg.password = null;
      cfg.pattern = null; // a pattern without a password would be the only gate
      cfg.preferLogin = "password";
    } else {
      cfg.password = await hashSecret(p, hashParams);
    }
    await save();
    return publicSettings();
  }

  // Returns the canonical pattern string (needed to seal the vault slot).
  async function setPattern(pattern) {
    if (pattern == null) {
      cfg.pattern = null;
      if (cfg.preferLogin === "pattern") cfg.preferLogin = "password";
      await save();
      return null;
    }
    const canonical = normalizePattern(pattern);
    cfg.pattern = await hashSecret(canonical, patternParams);
    await save();
    return canonical;
  }

  async function setPrefs({ preferLogin, autoLockMinutes }) {
    if (preferLogin !== undefined) {
      if (preferLogin !== "password" && preferLogin !== "pattern") throw httpError(400, "preferLogin must be password or pattern");
      cfg.preferLogin = preferLogin;
    }
    if (autoLockMinutes !== undefined) {
      const n = Number(autoLockMinutes);
      if (!AUTO_LOCK_CHOICES.has(n)) throw httpError(400, `autoLockMinutes must be one of ${[...AUTO_LOCK_CHOICES].join(", ")}`);
      cfg.autoLockMinutes = n;
    }
    await save();
    return publicSettings();
  }

  // One-time move of a plain-text password from .env into the hash store.
  async function migratePlainPassword(plain) {
    if (cfg.password || !String(plain || "")) return false;
    cfg.password = await hashSecret(String(plain), hashParams);
    await save();
    return true;
  }

  // Synchronous variant used at server start, before any request is served,
  // so the panel is never briefly unprotected during the migration.
  function migratePlainPasswordSync(plain) {
    if (corrupt || cfg.password || !String(plain || "")) return false;
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(plain), salt, 32, { N: hashParams.N, r: hashParams.r, p: hashParams.p, maxmem: 256 * hashParams.N * hashParams.r + 16 * 1024 * 1024 });
    cfg.password = { salt: salt.toString("base64"), hash: hash.toString("base64"), N: hashParams.N, r: hashParams.r, p: hashParams.p };
    const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
    fsSync.writeFileSync(tmp, JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600 });
    fsSync.renameSync(tmp, file);
    return true;
  }

  function newSession() {
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }
  function validSession(token) {
    if (!token) return false;
    const exp = sessions.get(String(token));
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(String(token)); return false; }
    return true;
  }
  function endSession(token) { if (token) sessions.delete(String(token)); }
  function endAllSessions() { sessions.clear(); }

  return {
    file,
    publicSettings,
    check,
    setPassword,
    setPattern,
    setPrefs,
    migratePlainPassword,
    migratePlainPasswordSync,
    newSession,
    validSession,
    endSession,
    endAllSessions,
    hasPassword: () => !!cfg.password || !!corrupt,
    hasPattern: () => !!cfg.pattern,
    autoLockMinutes: () => Number(cfg.autoLockMinutes) || 0,
  };
}

module.exports = { createPatternAuth, normalizePattern, hashSecret, verifySecret, createLimiter, MIN_DOTS, PATTERN_SIZE };
