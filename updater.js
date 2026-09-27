"use strict";
// In-place project updater.
//
// Two strategies, in this order:
//   1. git  — when a `git` binary is available: `git pull`
//   2. zip  — otherwise: download the GitHub branch zip and extract it with
//             Node's built-in zlib (the container image ships no `unzip` and
//             no `git`), then replace the tracked files in place.
//
// Refuses to run when the work would be lost: local edits to tracked files
// (code "DIRTY", detected via `git status -uno`, by hashing every file in
// `.git/index`, or against the baseline manifest below) and local commits that
// upstream does not have (code "AHEAD", detected via the GitHub compare API).
//
// A zip update cannot move git's HEAD (there is no git in the image), so every
// applied tree is recorded in BASELINE_FILE: { sha, files: { path: blobSha } }.
// That manifest then replaces `.git/index` as the source of truth for "what is
// deployed" and "what is dirty", which is what lets a checkout be updated more
// than once. A successful `git pull` deletes it again, since git is then the
// authority.
//
// Three more rules, all of them about not destroying the running app:
//   - "locked" paths (.env, .git, node_modules/, media/, the manifest, this
//     file) are never written and never removed — upstream history tracks
//     .env, and an update must not clobber the user's own.
//   - "keep" paths (web/dist/) may be written but never removed: a remote that
//     does not track the built UI must not leave the app with no front end.
//   - an untracked file whose path the incoming tree also contains is a
//     collision (code "COLLIDE") and aborts the update instead of overwriting
//     work git cannot see.

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFile } = require("child_process");

const ROOT = __dirname;
const USER_AGENT = "schlorp-updater";
const REQUEST_TIMEOUT_MS = 60000;
const GIT_TIMEOUT_MS = 300000;
const MAX_ZIP_BYTES = 512 * 1024 * 1024;
const MAX_DIRTY_REPORTED = 100;
const BASELINE_FILE = ".xdl-update-baseline.json";

// Never written, never removed.
const LOCKED_PATHS = [".env", ".git", "node_modules", "media", BASELINE_FILE, "updater.js"];
// Writable, but never removed.
const KEEP_PATHS = [...LOCKED_PATHS, "web/dist"];

function normPath(rel) {
  return String(rel).split(path.sep).join("/").replace(/^\.\//, "");
}

// "locked" = off limits for both writing and removal, "keep" = writable but not
// removable, null = ordinary project file.
function pathClass(rel) {
  const p = normPath(rel);
  const hit = (list) => list.some((x) => p === x || p.startsWith(`${x}/`));
  if (hit(LOCKED_PATHS)) return "locked";
  if (hit(KEEP_PATHS)) return "keep";
  return null;
}

function readGitDirPath() {
  const dotGit = path.join(ROOT, ".git");
  let st;
  try { st = fs.statSync(dotGit); } catch { return null; }
  if (st.isDirectory()) return dotGit;
  if (st.isFile()) {
    // worktree/submodule: ".git" holds "gitdir: <path>"
    const txt = fs.readFileSync(dotGit, "utf8");
    const m = txt.match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const p = m[1].trim();
    return path.isAbsolute(p) ? p : path.join(ROOT, p);
  }
  return null;
}

function readGitDirInfo(gitDir) {
  const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  let branch = "";
  let ref = "";
  let sha = null;
  if (head.startsWith("ref:")) {
    ref = head.slice(4).trim();
    branch = ref.replace(/^refs\/heads\//, "");
  } else {
    sha = head || null;
  }
  if (ref && !sha) {
    try { sha = fs.readFileSync(path.join(gitDir, ...ref.split("/")), "utf8").trim() || null; } catch { sha = null; }
    if (!sha) sha = lookupPackedRef(gitDir, ref);
  }
  return { branch: branch || "(detached)", sha, remote: readRemoteUrl(gitDir) };
}

function lookupPackedRef(gitDir, ref) {
  let txt;
  try { txt = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8"); } catch { return null; }
  for (const line of txt.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const sp = line.indexOf(" ");
    if (sp === -1) continue;
    if (line.slice(sp + 1).trim() === ref) return line.slice(0, sp).trim() || null;
  }
  return null;
}

function readRemoteUrl(gitDir) {
  let txt;
  try { txt = fs.readFileSync(path.join(gitDir, "config"), "utf8"); } catch { return null; }
  let inOrigin = false;
  for (const raw of txt.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) { inOrigin = /^\[remote\s+"origin"\]$/i.test(line); continue; }
    if (!inOrigin) continue;
    const m = line.match(/^url\s*=\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

function parseGitHubSlug(remote) {
  if (!remote) return null;
  const m = String(remote).match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

let gitBinCache;
function gitBin() {
  if (gitBinCache !== undefined) return Promise.resolve(gitBinCache);
  gitBinCache = new Promise((resolve) => {
    execFile("git", ["--version"], { timeout: 5000 }, (err) => resolve(err ? null : "git"));
  });
  return gitBinCache;
}

function runGit(args, timeout = GIT_TIMEOUT_MS) {
  const bin = "git";
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-c", `safe.directory=${ROOT}`, ...args],
      { cwd: ROOT, timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(String(stderr || "").trim() || err.message || "git failed");
          e.code = err.code;
          reject(e);
        } else resolve(String(stdout));
      }
    );
  });
}

function readIndexEntries(gitDir) {
  const buf = fs.readFileSync(path.join(gitDir, "index"));
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "DIRC") throw new Error("unrecognized .git/index");
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported .git/index version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    if (pos + 62 > buf.length) throw new Error("truncated .git/index");
    const mode = buf.readUInt32BE(pos + 24);
    const flags = buf.readUInt16BE(pos + 60);
    const nameLen = flags & 0xfff;
    if (flags & 0x4000) throw new Error("unsupported .git/index entry (extended flags)");
    if (nameLen === 0xfff) throw new Error("unsupported .git/index entry (long name)");
    if (pos + 62 + nameLen > buf.length) throw new Error("truncated .git/index");
    const name = buf.toString("utf8", pos + 62, pos + 62 + nameLen);
    entries.push({ name, mode, sha: buf.subarray(pos + 40, pos + 60).toString("hex") });
    pos += (62 + nameLen + 8) & ~7; // git's align_flex_name()
  }
  return entries;
}

function hashBlob(data) {
  const h = crypto.createHash("sha1");
  h.update(`blob ${data.length}\0`);
  h.update(data);
  return h.digest("hex");
}

// Tracked files whose worktree content differs from .git/index (or is gone).
// Protected paths are skipped: a modified .env or a rebuilt web/dist is the
// app's own state, not local work that an update would destroy.
function indexWorktreeChanges(gitDir, entries) {
  const changed = [];
  for (const e of entries) {
    if ((e.mode & 0xf000) === 0xe000) continue; // gitlink (submodule)
    if (pathClass(e.name)) continue;
    const abs = path.join(ROOT, e.name);
    let st;
    try { st = fs.statSync(abs); } catch { changed.push({ path: e.name, status: "deleted" }); continue; }
    if (!st.isFile()) { changed.push({ path: e.name, status: "modified" }); continue; }
    let sha;
    try { sha = hashBlob(fs.readFileSync(abs)); } catch { continue; }
    if (sha !== e.sha) changed.push({ path: e.name, status: "modified" });
  }
  return changed;
}

// ---- baseline manifest (stands in for git's HEAD/index after a zip update) ----

function baselineFile() {
  return path.join(ROOT, BASELINE_FILE);
}

function readBaseline() {
  try {
    const j = JSON.parse(fs.readFileSync(baselineFile(), "utf8"));
    if (!j || typeof j.sha !== "string" || !j.files || typeof j.files !== "object") return null;
    return j;
  } catch {
    return null;
  }
}

// Records the tree that was just applied, so the next status call knows what is
// deployed without git. Protected paths are left out: they are neither
// dirty-checked nor stale-removed.
function writeBaseline(sha, treeDir) {
  const files = {};
  for (const rel of walkFiles(treeDir).map(normPath)) {
    if (pathClass(rel)) continue;
    try { files[rel] = hashBlob(fs.readFileSync(path.join(treeDir, rel))); } catch { /* skip */ }
  }
  const tmp = `${baselineFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sha, writtenAt: new Date().toISOString(), files }));
  fs.renameSync(tmp, baselineFile());
}

function clearBaseline() {
  try { fs.unlinkSync(baselineFile()); } catch { /* nothing to clear */ }
}

function baselineWorktreeChanges(baseline) {
  const changed = [];
  for (const [rel, sha] of Object.entries(baseline.files)) {
    if (pathClass(rel)) continue;
    const abs = path.join(ROOT, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch { changed.push({ path: rel, status: "deleted" }); continue; }
    if (!st.isFile()) { changed.push({ path: rel, status: "modified" }); continue; }
    let now;
    try { now = hashBlob(fs.readFileSync(abs)); } catch { continue; }
    if (now !== sha) changed.push({ path: rel, status: "modified" });
  }
  return changed;
}

// Files git does not track but the incoming tree would overwrite. Untracked work
// is invisible to the dirty check by design, so this is the only thing standing
// between an update and a user's unsaved file.
function findUntrackedCollisions(treeDir, managed) {
  const collisions = [];
  for (const rel of walkFiles(treeDir).map(normPath)) {
    if (pathClass(rel) || managed.has(rel)) continue;
    const dest = path.join(ROOT, rel);
    let st;
    try { st = fs.lstatSync(dest); } catch { continue; } // nothing there to lose
    if (!st.isFile()) continue;
    let same = false;
    try { same = hashBlob(fs.readFileSync(path.join(treeDir, rel))) === hashBlob(fs.readFileSync(dest)); } catch { same = false; }
    if (!same) collisions.push(rel);
  }
  return collisions;
}

function parsePorcelain(out) {
  const changes = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let file = line.slice(3).trim();
    if (file.includes(" -> ")) file = file.split(" -> ")[1].trim();
    if (pathClass(file)) continue; // .env / web/dist / media/ are not local work
    const status = code.includes("D") ? "deleted" : "modified";
    changes.push({ path: file, status });
  }
  return changes;
}

function httpsGet(url, { headers = {}, timeout = REQUEST_TIMEOUT_MS, redirects = 5, maxBytes = MAX_ZIP_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": USER_AGENT, ...headers }, timeout }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error("too many redirects"));
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { return reject(e); }
        return resolve(httpsGet(next, { headers, timeout, redirects: redirects - 1, maxBytes }));
      }
      if (status < 200 || status >= 300) {
        res.resume();
        const err = new Error(`HTTP ${status} for ${url}`);
        err.status = status;
        return reject(err);
      }
      const chunks = [];
      let total = 0;
      res.on("data", (c) => {
        total += c.length;
        if (total > maxBytes) { req.destroy(new Error("download exceeds size limit")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
  });
}

// One compare call answers everything: is the local commit known upstream, is
// upstream ahead, how far, and what is the new tip. 404 = the local commit does
// not exist on GitHub, i.e. local work that is not published.
async function fetchCompare(slug, localSha, branch) {
  const url = `https://api.github.com/repos/${slug.owner}/${slug.repo}/compare/${localSha}...${encodeURIComponent(branch)}`;
  const body = await httpsGet(url, { headers: { Accept: "application/vnd.github+json" } });
  let data;
  try { data = JSON.parse(body.toString("utf8")); } catch { throw new Error("unexpected response from GitHub API"); }
  const commits = Array.isArray(data.commits) ? data.commits : [];
  const tip = commits.length ? commits[commits.length - 1] : null;
  return {
    known: true,
    status: String(data.status || ""), // identical | ahead | behind | diverged
    aheadBy: Number(data.ahead_by || 0), // commits upstream has that local lacks
    behindBy: Number(data.behind_by || 0), // commits local has that upstream lacks
    tipSha: tip ? String(tip.sha || "") : null,
    tipMessage: tip ? String(tip.commit?.message || "").split("\n")[0].slice(0, 200) : null,
    tipDate: tip ? tip.commit?.committer?.date || null : null,
  };
}

const short = (sha) => (sha ? String(sha).slice(0, 7) : null);

async function getStatus() {
  const gitDir = readGitDirPath();
  if (!gitDir) return { ok: false, error: "Not a git checkout — no .git directory" };
  let info;
  try { info = readGitDirInfo(gitDir); } catch (e) { return { ok: false, error: `Cannot read .git: ${e.message}` }; }

  const bin = await gitBin();
  const slug = parseGitHubSlug(info.remote);
  // After a zip update git's HEAD/index still describe the pre-update commit,
  // so the manifest written by that update is what "local" means from now on.
  const baseline = bin ? null : readBaseline();
  const localSha = baseline ? baseline.sha : info.sha;

  let changes = [];
  let changeError = null;
  try {
    if (bin) changes = parsePorcelain(await runGit(["status", "--porcelain", "-uno", "--no-renames"], 60000));
    else if (baseline) changes = baselineWorktreeChanges(baseline);
    else changes = indexWorktreeChanges(gitDir, readIndexEntries(gitDir));
  } catch (e) { changeError = e.message; }

  let latest = null;
  let latestError = null;
  let localKnown = null; // is the local commit published upstream?
  if (!slug) {
    latestError = "origin is not a GitHub repository";
  } else if (!localSha) {
    latestError = "no local commit found";
  } else {
    try {
      latest = await fetchCompare(slug, localSha, info.branch);
      localKnown = latest.known;
    } catch (e) {
      if (e.status === 404) {
        localKnown = false;
        latestError = "local commit is not on GitHub";
      } else latestError = e.message;
    }
  }

  // Local work that upstream does not have would be destroyed by the update.
  const localAhead = localKnown === false || latest?.status === "behind" || latest?.status === "diverged";
  const updateAvailable = !!(localKnown === true && latest?.status === "ahead");
  const dirty = changes.length > 0;
  return {
    ok: true,
    gitAvailable: !!bin,
    method: bin ? "git" : "zip",
    repo: slug ? `${slug.owner}/${slug.repo}` : null,
    remote: info.remote || null,
    branch: info.branch,
    localCommit: localSha,
    localShort: short(localSha),
    localKnown,
    localAhead,
    localBehind: localKnown === true ? (latest?.behindBy || 0) : null,
    compareStatus: latest?.status || null,
    latestCommit: updateAvailable ? latest.tipSha : localSha,
    latestShort: updateAvailable ? short(latest.tipSha) : short(localSha),
    latestMessage: updateAvailable ? latest.tipMessage : null,
    latestDate: updateAvailable ? latest.tipDate : null,
    updateAvailable,
    upstreamAhead: updateAvailable ? (latest?.aheadBy || 0) : 0,
    upToDate: !!(localKnown === true && latest?.status === "identical"),
    dirty,
    dirtyCount: changes.length,
    dirtySource: bin ? "git" : baseline ? "baseline" : "index",
    baselineSha: baseline ? baseline.sha : null,
    changes: changes.slice(0, MAX_DIRTY_REPORTED),
    changeError,
    latestError,
    canUpdate: !!slug && !dirty && !changeError && updateAvailable,
    blockedReason: dirty
      ? `${changes.length} local change(s) not committed`
      : changeError
        ? `cannot verify the working tree: ${changeError}`
        : localKnown === false
          ? "local commit is not published on GitHub — push first"
          : latest?.status === "behind" || latest?.status === "diverged"
            ? `local is ${latest.behindBy || "?"} commit(s) ahead of ${info.branch} — push first`
            : latestError
              ? latestError
              : !updateAvailable
                ? "already up to date"
                : null,
  };
}

// ---- zip extraction (no `unzip` in the image; zlib only) ----

function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function extractZip(buf, destDir) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd === -1) throw new Error("not a zip archive (no end-of-central-directory record)");
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdOffset === 0xffffffff) throw new Error("zip64 archives are not supported");

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    entries.push({ name, method, compSize, externalAttrs, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  // GitHub wraps everything in "<owner>-<repo>-<sha>/"
  const tops = new Set(entries.map((e) => e.name.split("/")[0]).filter(Boolean));
  const strip = tops.size === 1 ? `${[...tops][0]}/` : "";

  let files = 0;
  for (const e of entries) {
    const rel = strip && e.name.startsWith(strip) ? e.name.slice(strip.length) : e.name;
    if (!rel) continue;
    const target = safeJoin(destDir, rel);
    if (!target) continue;
    if (rel.endsWith("/")) { fs.mkdirSync(target, { recursive: true }); continue; }

    const lho = e.localOffset;
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`corrupt local header for ${e.name}`);
    const nameLen = buf.readUInt16LE(lho + 26);
    const extraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compSize);
    let data;
    if (e.method === 0) data = Buffer.from(raw);
    else if (e.method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip compression method ${e.method} for ${e.name}`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    const mode = (e.externalAttrs >>> 16) & 0o777;
    if (mode) { try { fs.chmodSync(target, mode); } catch { /* best effort */ } }
    files++;
  }
  return { files, entries: entries.length };
}

function safeJoin(base, rel) {
  const cleaned = rel.replace(/\\/g, "/");
  if (cleaned.startsWith("/") || /^[a-z]:/i.test(cleaned)) return null; // absolute
  const target = path.resolve(base, cleaned);
  const baseResolved = path.resolve(base);
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) return null; // zip slip
  return target;
}

function walkFiles(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) walkFiles(abs, base, out);
    else out.push(path.relative(base, abs));
  }
  return out;
}

function applyExtractedTree(treeDir, managed = new Set()) {
  const present = new Set(walkFiles(treeDir).map(normPath));

  let written = 0;
  let skipped = 0;
  for (const rel of present) {
    if (pathClass(rel) === "locked") { skipped++; continue; }
    const src = path.join(treeDir, rel);
    const dest = path.join(ROOT, rel);
    if (path.resolve(dest) === path.resolve(ROOT)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    try {
      const mode = fs.statSync(src).mode & 0o777;
      if (mode) fs.chmodSync(dest, mode);
    } catch { /* best effort */ }
    written++;
  }

  // Drop files the previous deployment had and the new tree no longer contains.
  // Untracked and ignored files (.env, media/, node_modules/, queue state) are
  // left alone — "managed" is the baseline manifest, or the index on a first
  // update — and protected paths are never removed.
  let removed = 0;
  let kept = 0;
  for (const name of managed) {
    if (present.has(name)) continue;
    if (pathClass(name)) { kept++; continue; }
    try { fs.unlinkSync(path.join(ROOT, name)); removed++; } catch { /* already gone */ }
  }
  return { written, removed, skipped, kept };
}

async function performUpdate() {
  const status = await getStatus();
  if (!status.ok) throw Object.assign(new Error(status.error), { code: "NOGIT" });
  if (status.changeError) throw Object.assign(new Error(`Cannot verify the working tree: ${status.changeError}`), { code: "DIRTY" });
  if (status.dirty) {
    const listed = status.changes.slice(0, 8).map((c) => `${c.path} (${c.status})`).join(", ");
    const more = status.dirtyCount > 8 ? ` +${status.dirtyCount - 8} more` : "";
    throw Object.assign(new Error(`Refusing to update: ${status.dirtyCount} local change(s) — ${listed}${more}`), {
      code: "DIRTY",
      changes: status.changes,
      dirtyCount: status.dirtyCount,
    });
  }
  if (!status.repo) throw Object.assign(new Error("origin is not a GitHub repository"), { code: "NOREMOTE" });
  if (status.localAhead) {
    throw Object.assign(
      new Error(status.localKnown === false
        ? "Refusing to update: the local commit is not published on GitHub — pushing the local work first is required"
        : `Refusing to update: the local checkout is ${status.localBehind} commit(s) ahead of ${status.branch} — push first`),
      { code: "AHEAD", behindBy: status.localBehind }
    );
  }

  if (status.method === "git") {
    const output = await runGit(["pull"]);
    clearBaseline(); // git is authoritative again
    const after = await getStatus();
    return { ok: true, method: "git", output: output.trim(), commit: after.localCommit, commitShort: after.localShort, alreadyUpToDate: after.upToDate };
  }

  const { owner, repo } = parseGitHubSlug(status.remote);
  const branch = status.branch === "(detached)" ? "main" : status.branch;
  const url = `https://github.com/${owner}/${repo}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;
  const buf = await httpsGet(url);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schlorp-update-"));
  const treeDir = path.join(tmp, "tree");
  fs.mkdirSync(treeDir, { recursive: true });
  try {
    const { files } = extractZip(buf, treeDir);
    if (!files) throw new Error("downloaded archive contained no files");

    // What the last deployment put here — the baseline if there is one,
    // otherwise git's index.
    const baseline = readBaseline();
    const managed = baseline
      ? new Set(Object.keys(baseline.files))
      : new Set(readIndexEntries(readGitDirPath()).map((e) => e.name));

    const collisions = findUntrackedCollisions(treeDir, managed);
    if (collisions.length) {
      const listed = collisions.slice(0, 8).join(", ");
      const more = collisions.length > 8 ? ` +${collisions.length - 8} more` : "";
      throw Object.assign(
        new Error(`Refusing to update: the update would overwrite ${collisions.length} untracked file(s) — ${listed}${more}`),
        { code: "COLLIDE", changes: collisions.map((p) => ({ path: p, status: "untracked" })) }
      );
    }

    const { written, removed, skipped, kept } = applyExtractedTree(treeDir, managed);
    writeBaseline(status.latestCommit, treeDir);
    return { ok: true, method: "zip", source: url, files, written, removed, skipped, kept, baseline: BASELINE_FILE, commit: status.latestCommit, commitShort: status.latestShort };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { getStatus, performUpdate, extractZip, safeJoin };
