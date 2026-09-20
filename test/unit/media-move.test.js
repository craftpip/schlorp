const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");

const {
  sanitizeMoveKey,
  isInsideMedia,
  mediaRelOf,
  resolveMoveSource,
  posterStemOf,
  findCompanionPosters,
} = require("../../scan-videos/media-move");
const { withTempDir } = require("../helpers/temp-state");

// Mirror of the POST /api/media/move per-file decision chain in api-server.js:
// resolve -> validate -> same-folder skip -> collision skip -> rename.
async function moveOneFile(mediaDir, key, targetDir) {
  const src = resolveMoveSource(key, mediaDir);
  if (!isInsideMedia(src, mediaDir)) return { moved: false, error: "invalid path" };
  const stat = await fs.stat(src).catch(() => null);
  if (!stat || stat.isDirectory()) return { moved: false, error: "not found" };
  const base = path.basename(src);
  const dest = path.join(targetDir, base);
  if (src === dest) return { moved: false, error: "same folder" };
  if (await fs.stat(dest).catch(() => null)) return { moved: false, error: "target exists" };
  await fs.mkdir(targetDir, { recursive: true });
  await fs.rename(src, dest);
  return { moved: true, newRel: mediaRelOf(dest, mediaDir) };
}

test("sanitizeMoveKey: bare name resolves against folder", () => {
  assert.equal(sanitizeMoveKey("a.mp4", "current/view"), "current/view/a.mp4");
  assert.equal(sanitizeMoveKey("a.mp4", ""), "a.mp4");
  assert.equal(sanitizeMoveKey("  a.mp4  ", "f"), "f/a.mp4");
});

test("sanitizeMoveKey: slash-carrying key (flat view) used as-is", () => {
  assert.equal(sanitizeMoveKey("sub/a.mp4", "other"), "sub/a.mp4");
  assert.equal(sanitizeMoveKey("a/b/c.gif", ""), "a/b/c.gif");
});

test("sanitizeMoveKey: rejects traversal, absolute, backslash, dots", () => {
  assert.equal(sanitizeMoveKey("../a.mp4", "f"), null);
  assert.equal(sanitizeMoveKey("sub/../../a.mp4", ""), null);
  assert.equal(sanitizeMoveKey("/abs/a.mp4", ""), null);
  assert.equal(sanitizeMoveKey("a\\b.mp4", ""), null);
  assert.equal(sanitizeMoveKey(".", "f"), null);
  assert.equal(sanitizeMoveKey("..", "f"), null);
  assert.equal(sanitizeMoveKey("", "f"), null);
  assert.equal(sanitizeMoveKey("sub/", ""), null);
  assert.equal(sanitizeMoveKey("a.mp4", "../evil"), null);
});

test("sanitizeMoveKey: rejects overlong basenames", () => {
  assert.equal(sanitizeMoveKey(`${"x".repeat(201)}.mp4`, ""), null);
  assert.equal(sanitizeMoveKey(`${"x".repeat(196)}.mp4`, ""), `${"x".repeat(196)}.mp4`);
});

test("isInsideMedia: accepts inner files, rejects escapes and the dir itself", async () => {
  await withTempDir(async (dir) => {
    const mediaDir = path.join(dir, "media");
    await fs.mkdir(path.join(mediaDir, "sub"), { recursive: true });
    assert.equal(isInsideMedia(path.join(mediaDir, "sub", "a.mp4"), mediaDir), true);
    assert.equal(isInsideMedia(mediaDir, mediaDir), false);
    assert.equal(isInsideMedia(path.join(dir, "other.mp4"), mediaDir), false);
    assert.equal(isInsideMedia(path.resolve(mediaDir, "../evil.mp4"), mediaDir), false);
  });
});

test("move: file lands in target, source gone", async () => {
  await withTempDir(async (dir) => {
    const mediaDir = path.join(dir, "media");
    await fs.mkdir(path.join(mediaDir, "src"), { recursive: true });
    await fs.mkdir(path.join(mediaDir, "dst"), { recursive: true });
    await fs.writeFile(path.join(mediaDir, "src", "a.mp4"), "data");
    const key = sanitizeMoveKey("a.mp4", "src");
    const r = await moveOneFile(mediaDir, key, path.join(mediaDir, "dst"));
    assert.equal(r.moved, true);
    assert.equal(r.newRel, "dst/a.mp4");
    assert.equal(await fs.stat(path.join(mediaDir, "dst", "a.mp4")).then(() => true), true);
    assert.equal(await fs.stat(path.join(mediaDir, "src", "a.mp4")).catch(() => null), null);
  });
});

test("move: same folder is skipped", async () => {
  await withTempDir(async (dir) => {
    const mediaDir = path.join(dir, "media");
    await fs.mkdir(path.join(mediaDir, "src"), { recursive: true });
    await fs.writeFile(path.join(mediaDir, "src", "a.mp4"), "data");
    const key = sanitizeMoveKey("a.mp4", "src");
    const r = await moveOneFile(mediaDir, key, path.join(mediaDir, "src"));
    assert.deepEqual(r, { moved: false, error: "same folder" });
    assert.equal(await fs.stat(path.join(mediaDir, "src", "a.mp4")).then(() => true), true);
  });
});

test("move: collision is skipped without overwrite", async () => {
  await withTempDir(async (dir) => {
    const mediaDir = path.join(dir, "media");
    await fs.mkdir(path.join(mediaDir, "src"), { recursive: true });
    await fs.mkdir(path.join(mediaDir, "dst"), { recursive: true });
    await fs.writeFile(path.join(mediaDir, "src", "a.mp4"), "new");
    await fs.writeFile(path.join(mediaDir, "dst", "a.mp4"), "existing");
    const key = sanitizeMoveKey("a.mp4", "src");
    const r = await moveOneFile(mediaDir, key, path.join(mediaDir, "dst"));
    assert.deepEqual(r, { moved: false, error: "target exists" });
    assert.equal(String(await fs.readFile(path.join(mediaDir, "dst", "a.mp4"))), "existing");
    assert.equal(String(await fs.readFile(path.join(mediaDir, "src", "a.mp4"))), "new");
  });
});

test("move: missing source and directories report not found", async () => {
  await withTempDir(async (dir) => {
    const mediaDir = path.join(dir, "media");
    await fs.mkdir(path.join(mediaDir, "src"), { recursive: true });
    await fs.mkdir(path.join(mediaDir, "dst"), { recursive: true });
    await fs.mkdir(path.join(mediaDir, "src", "asub"), { recursive: true });
    const missing = await moveOneFile(mediaDir, "src/nope.mp4", path.join(mediaDir, "dst"));
    assert.deepEqual(missing, { moved: false, error: "not found" });
    const dirKey = await moveOneFile(mediaDir, "src/asub", path.join(mediaDir, "dst"));
    assert.deepEqual(dirKey, { moved: false, error: "not found" });
  });
});

test("posterStemOf / findCompanionPosters: picks up <stem>-poster images only", () => {
  assert.equal(posterStemOf("a.mp4"), "a");
  assert.equal(posterStemOf("my.clip.mov"), "my.clip");
  assert.equal(posterStemOf("noext"), "noext");
  const entries = ["a.mp4", "a-poster.jpg", "a-poster.png", "a-poster.mp4", "a-poster-xl.jpg", "b-poster.jpg", "notes.txt", "A-Poster.WEBP"];
  assert.deepEqual(findCompanionPosters(entries, "a.mp4"), ["a-poster.jpg", "a-poster.png", "A-Poster.WEBP"]);
  assert.deepEqual(findCompanionPosters(entries, "b.mp4"), ["b-poster.jpg"]);
  assert.deepEqual(findCompanionPosters(entries, "missing.mp4"), []);
  assert.deepEqual(findCompanionPosters(entries, "a-poster.jpg"), []);
});

test("move: companion poster travels with the file, others untouched", async () => {
  await withTempDir(async (dir) => {
    const mediaDir = path.join(dir, "media");
    await fs.mkdir(path.join(mediaDir, "src"), { recursive: true });
    await fs.mkdir(path.join(mediaDir, "dst"), { recursive: true });
    await fs.writeFile(path.join(mediaDir, "src", "a.mp4"), "v");
    await fs.writeFile(path.join(mediaDir, "src", "a-poster.jpg"), "p");
    await fs.writeFile(path.join(mediaDir, "src", "b.mp4"), "v2");
    await fs.writeFile(path.join(mediaDir, "src", "b-poster.jpg"), "p2");
    const r = await moveOneFile(mediaDir, "src/a.mp4", path.join(mediaDir, "dst"));
    assert.equal(r.moved, true);
    // Endpoint poster step, mirrored: discover in source dir, rename alongside.
    const posters = findCompanionPosters(await fs.readdir(path.join(mediaDir, "src")), "a.mp4");
    assert.deepEqual(posters, ["a-poster.jpg"]);
    for (const poster of posters) {
      await fs.rename(path.join(mediaDir, "src", poster), path.join(mediaDir, "dst", poster));
    }
    assert.equal(await fs.stat(path.join(mediaDir, "dst", "a-poster.jpg")).then(() => true), true);
    assert.equal(await fs.stat(path.join(mediaDir, "src", "a-poster.jpg")).catch(() => null), null);
    assert.equal(String(await fs.readFile(path.join(mediaDir, "src", "b.mp4"))), "v2");
    assert.equal(String(await fs.readFile(path.join(mediaDir, "src", "b-poster.jpg"))), "p2");
  });
});

test("move: poster collision leaves the source poster in place", async () => {
  await withTempDir(async (dir) => {
    const mediaDir = path.join(dir, "media");
    await fs.mkdir(path.join(mediaDir, "src"), { recursive: true });
    await fs.mkdir(path.join(mediaDir, "dst"), { recursive: true });
    await fs.writeFile(path.join(mediaDir, "src", "a.mp4"), "v");
    await fs.writeFile(path.join(mediaDir, "src", "a-poster.jpg"), "new-poster");
    await fs.writeFile(path.join(mediaDir, "dst", "a-poster.jpg"), "existing-poster");
    const posters = findCompanionPosters(await fs.readdir(path.join(mediaDir, "src")), "a.mp4");
    assert.deepEqual(posters, ["a-poster.jpg"]);
    const destExists = await fs.stat(path.join(mediaDir, "dst", "a-poster.jpg")).catch(() => null);
    assert.ok(destExists, "collision detected — poster must not be overwritten");
    assert.equal(String(await fs.readFile(path.join(mediaDir, "dst", "a-poster.jpg"))), "existing-poster");
    assert.equal(String(await fs.readFile(path.join(mediaDir, "src", "a-poster.jpg"))), "new-poster");
  });
});
