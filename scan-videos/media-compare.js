// Image compare links (ComfyUI-style before/after slider).
//
// A link says: when the MAIN file is viewed, slide it against the SOURCE
// file. The source file itself is untouched (it shows normally). Links are
// stored by media-relative path ("a/b/x.png") in one JSON file at the app
// root: { updatedAt, links: { [mainRel]: sourceRel } }. One source per main.
// Renames/moves/deletes are mirrored so links follow their files.

const fs = require("fs/promises");
const path = require("path");

function normRel(rel) {
  const s = String(rel || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
  if (!s || s.split("/").some((p) => p === ".." || p === ".")) return "";
  return s;
}

function createCompareStore({ file }) {
  let cache = null;
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      cache = parsed && parsed.links && typeof parsed.links === "object" ? parsed.links : {};
    } catch (e) {
      if (!e || e.code !== "ENOENT") console.error("[mediacompare] load failed:", e && e.message);
      cache = {};
    }
    return cache;
  }
  async function save() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), links: cache || {} }), "utf8");
    await fs.rename(tmp, file);
  }
  // Apply fn(links) → true when changed; saves only on change.
  const mutate = (fn) => serial(async () => {
    const links = await load();
    const changed = fn(links);
    if (changed) await save();
    return changed;
  });

  return {
    async all() { return { ...(await load()) }; },
    async get(mainRel) { const l = await load(); return l[normRel(mainRel)] || null; },
    bind(mainRel, sourceRel) {
      const m = normRel(mainRel), s = normRel(sourceRel);
      if (!m || !s) return Promise.reject(new Error("main and source required"));
      if (m === s) return Promise.reject(new Error("a file can't be compared with itself"));
      return mutate((l) => { if (l[m] === s) return false; l[m] = s; return true; });
    },
    unbind(mainRel) {
      const m = normRel(mainRel);
      return mutate((l) => { if (!(m in l)) return false; delete l[m]; return true; });
    },
    // A file moved/renamed: rewrite it on both sides of every link.
    rename(oldRel, newRel) {
      const o = normRel(oldRel), n = normRel(newRel);
      if (!o || !n || o === n) return Promise.resolve(false);
      return mutate((l) => {
        let changed = false;
        if (o in l) { l[n] = l[o]; delete l[o]; changed = true; }
        for (const k of Object.keys(l)) if (l[k] === o) { l[k] = n; changed = true; }
        return changed;
      });
    },
    // A folder moved/renamed: rewrite every path under it.
    renamePrefix(oldDir, newDir) {
      const o = normRel(oldDir), n = normRel(newDir);
      if (!o || !n || o === n) return Promise.resolve(false);
      const swap = (p) => (p.startsWith(`${o}/`) ? `${n}/${p.slice(o.length + 1)}` : p);
      return mutate((l) => {
        let changed = false;
        for (const k of Object.keys(l)) {
          const nk = swap(k), nv = swap(l[k]);
          if (nk === k && nv === l[k]) continue;
          delete l[k]; l[nk] = nv; changed = true;
        }
        return changed;
      });
    },
    // A file (or, with prefix, a folder) is gone: drop every link touching it.
    forget(rel, { prefix = false } = {}) {
      const r = normRel(rel);
      if (!r) return Promise.resolve(false);
      const hit = (p) => p === r || (prefix && p.startsWith(`${r}/`));
      return mutate((l) => {
        let changed = false;
        for (const k of Object.keys(l)) if (hit(k) || hit(l[k])) { delete l[k]; changed = true; }
        return changed;
      });
    },
  };
}

module.exports = { createCompareStore, normRel };
