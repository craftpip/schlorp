const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { createCompareStore, normRel } = require("../../scan-videos/media-compare");

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xdl-compare-"));
  const file = path.join(dir, ".mediacompare.json");
  return { file, store: createCompareStore({ file }), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("normRel trims slashes and rejects traversal", () => {
  assert.equal(normRel("/a/b.png/"), "a/b.png");
  assert.equal(normRel("a\\b.png"), "a/b.png");
  assert.equal(normRel("../x.png"), "");
  assert.equal(normRel(""), "");
});

test("bind stores main → source, persists, and unbind removes it", async () => {
  const { file, store, cleanup } = await freshStore();
  try {
    await store.bind("f/after.png", "f/before.png");
    assert.equal(await store.get("f/after.png"), "f/before.png");
    assert.equal(await store.get("f/before.png"), null, "the source itself gets no compare");
    const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
    assert.deepEqual(onDisk.links, { "f/after.png": "f/before.png" });
    // Re-binding replaces the source (one per main).
    await store.bind("f/after.png", "f/other.png");
    assert.equal(await store.get("f/after.png"), "f/other.png");
    assert.equal(await store.unbind("f/after.png"), true);
    assert.equal(await store.unbind("f/after.png"), false);
    assert.deepEqual(await store.all(), {});
    // A fresh store reads what was saved.
    await store.bind("a.png", "b.png");
    assert.deepEqual(await createCompareStore({ file }).all(), { "a.png": "b.png" });
  } finally { await cleanup(); }
});

test("bind refuses self-compare and empty paths", async () => {
  const { store, cleanup } = await freshStore();
  try {
    await assert.rejects(store.bind("a.png", "a.png"));
    await assert.rejects(store.bind("", "a.png"));
  } finally { await cleanup(); }
});

test("rename follows the file on both sides of a link", async () => {
  const { store, cleanup } = await freshStore();
  try {
    await store.bind("main.png", "src.png");
    await store.bind("other.png", "src.png");
    await store.rename("src.png", "moved/src.png");
    assert.deepEqual(await store.all(), { "main.png": "moved/src.png", "other.png": "moved/src.png" });
    await store.rename("main.png", "k7q2m9x4c8v1b3n6");
    assert.deepEqual(await store.all(), { k7q2m9x4c8v1b3n6: "moved/src.png", "other.png": "moved/src.png" });
  } finally { await cleanup(); }
});

test("renamePrefix rewrites paths under a renamed folder only", async () => {
  const { store, cleanup } = await freshStore();
  try {
    await store.bind("shots/a.png", "shots/b.png");
    await store.bind("shotsX/c.png", "shots/d.png");
    await store.renamePrefix("shots", "renders");
    assert.deepEqual(await store.all(), { "renders/a.png": "renders/b.png", "shotsX/c.png": "renders/d.png" });
  } finally { await cleanup(); }
});

test("forget drops every link touching a deleted file or folder", async () => {
  const { store, cleanup } = await freshStore();
  try {
    await store.bind("a.png", "b.png");
    await store.bind("c.png", "b.png");
    await store.bind("d/e.png", "f.png");
    await store.bind("g.png", "h.png");
    await store.forget("b.png");
    assert.deepEqual(await store.all(), { "d/e.png": "f.png", "g.png": "h.png" });
    await store.forget("d", { prefix: true });
    assert.deepEqual(await store.all(), { "g.png": "h.png" });
  } finally { await cleanup(); }
});
