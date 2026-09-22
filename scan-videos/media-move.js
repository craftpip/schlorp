// Media "Move files" path helpers (plan 026).
//
// Pure, mediaDir-parameterized helpers so unit tests can run them against a
// temp dir without starting the API server (api-server.js listens on require,
// so it cannot be imported by tests).

const path = require("path");

function normalizeFolder(folder) {
  const s = String(folder || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!s) return "";
  const n = path.posix.normalize(s);
  if (!n || n === "." || n.startsWith("..") || path.isAbsolute(n)) return null;
  return n;
}

// Resolve a move `name` to a media-relative posix key. Bare names resolve
// against `folder`; keys containing "/" (flat view selections) are taken
// as-is so a file living in a subfolder keeps its true source path.
// Returns null when invalid.
function sanitizeMoveKey(raw, folder) {
  const s = String(raw ?? "").trim();
  if (!s || s === "." || s === "..") return null;
  if (s.includes("\\") || s.startsWith("/") || s.includes("\0")) return null;
  if (s.split("/").includes("..")) return null;
  const base = s.split("/").pop();
  if (!base || base === "." || base === ".." || base.length > 200) return null;
  let key;
  if (s.includes("/")) {
    key = path.posix.normalize(s.replace(/^\/+/, ""));
  } else {
    const f = normalizeFolder(folder);
    if (f === null) return null;
    key = path.posix.normalize(f ? `${f}/${s}` : s);
  }
  if (!key || key === "." || key.startsWith("..") || path.isAbsolute(key)) return null;
  return key;
}

// True when `absolutePath` is a file-sized path strictly inside `mediaDir`
// (the dir itself and any escape are rejected).
function isInsideMedia(absolutePath, mediaDir) {
  const rel = path.relative(mediaDir, absolutePath);
  if (!rel || rel === ".") return false;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

// Posix media-relative key for an absolute path inside `mediaDir`
// (playlists/dims/orders key format).
function mediaRelOf(absolutePath, mediaDir) {
  return path.relative(mediaDir, absolutePath).split(path.sep).join("/");
}

function resolveMoveSource(key, mediaDir) {
  return path.resolve(mediaDir, ...String(key).split("/").filter(Boolean));
}

// Poster/thumbnail companions: listMediaDir attaches `<stem>-poster.<img>`
// as a file's thumbnail, so a move carries those files along.
const POSTER_IMG_EXT = /\.(jpe?g|png|webp|avif|gif)$/i;

function posterStemOf(fileBase) {
  const s = String(fileBase || "");
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(0, i) : s;
}

// From a directory entry-name list, return the poster companions of
// `fileBase`: "<stem>-poster.<img>" (case-insensitive), excluding the file
// itself and non-image files.
function findCompanionPosters(entryNames, fileBase) {
  const stem = posterStemOf(fileBase).toLowerCase();
  const self = String(fileBase || "").toLowerCase();
  const out = [];
  for (const name of entryNames || []) {
    const n = String(name || "");
    const low = n.toLowerCase();
    if (!n || low === self) continue;
    if (!POSTER_IMG_EXT.test(n)) continue;
    if (low.startsWith(`${stem}-poster.`)) out.push(n);
  }
  return out;
}

// Stack-aware move planning (pure): given the stacks of one source folder
// and the basenames requested to move out of that folder, split stacks into
// fully-covered ones (every member moves → the .xdlstack file travels too,
// no removal notice) and partial ones (only some members move → those
// members leave the stack, shown as a removal notice).
// `stacks` entries look like { id, name, items: [basename] }.
// Returns { full: [stack], partialBases: [basename...] } where partialBases
// are the distinct moving basenames that leave at least one (partial) stack.
// A basename in both a full stack and a partial stack still counts as
// partial — it leaves the partial stack behind.
function splitStacksByCoverage(stacks, moveBases) {
  const set = new Set((moveBases || []).map((b) => String(b)));
  const full = [];
  const partialSet = new Set();
  for (const s of stacks || []) {
    const items = Array.isArray(s && s.items) ? s.items.map((x) => String(x)) : [];
    if (!items.length) continue;
    const moving = items.filter((x) => set.has(x));
    if (!moving.length) continue;
    if (moving.length === items.length) full.push(s);
    else for (const x of moving) partialSet.add(x);
  }
  return { full, partialBases: [...partialSet] };
}

// Custom-order slot memory (gallery moves): when a file with a manual
// position leaves a folder scope, its index is stashed; if the same basename
// returns to that scope it is re-inserted at the remembered slot (round-trip
// stable). Files with no remembered slot stay out of the scope array and
// render in the date-desc bucket (frontend applyViewOrder).
const MOVED_SLOT_CAP_PER_SCOPE = 500;

function stashMovedSlot(slots, scope, key, index) {
  if (!slots || typeof slots !== "object") return;
  if (!scope || !key) return;
  const i = Number(index);
  if (!Number.isFinite(i) || i < 0) return;
  if (!slots[scope] || typeof slots[scope] !== "object") slots[scope] = {};
  const bucket = slots[scope];
  bucket[String(key)] = Math.floor(i);
  const keys = Object.keys(bucket);
  while (keys.length > MOVED_SLOT_CAP_PER_SCOPE) delete bucket[keys.shift()];
}

function takeMovedSlot(slots, scope, key) {
  if (!slots || typeof slots !== "object" || !scope || !key) return null;
  const bucket = slots[scope];
  if (!bucket || typeof bucket !== "object") return null;
  const k = String(key);
  if (!(k in bucket)) return null;
  const i = Number(bucket[k]);
  delete bucket[k];
  if (!Object.keys(bucket).length) delete slots[scope];
  return Number.isFinite(i) && i >= 0 ? Math.floor(i) : null;
}

module.exports = { normalizeFolder, sanitizeMoveKey, isInsideMedia, mediaRelOf, resolveMoveSource, posterStemOf, findCompanionPosters, splitStacksByCoverage, stashMovedSlot, takeMovedSlot, MOVED_SLOT_CAP_PER_SCOPE };
