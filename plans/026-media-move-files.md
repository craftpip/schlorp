# 026 — Media page: "Move files" (context menu + folder-explorer dialog)

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`) + API (`api-server.js`).
> Date: 2026-09-20. Status: **Planned**.
> Scope: add a **Move files** action to the tile/selection context menu. It opens a small folder-explorer dialog starting at the **current folder**; the user browses to the target folder (folder names enter, UP button climbs, breadcrumb + close button) and moves the selected file(s) into it via a **Move** button next to each folder name, or a **Move here** confirm for the displayed folder itself. Backend gets one new endpoint, `POST /api/media/move`, with playlist/dims/order/stack cleanup mirroring the existing delete paths.

---

## 1. Objective

Right-clicking a selected file (or a multi-selection) on the media page today offers **Stack / Open / Delete** (`MediaContextMenu.jsx:40-59`). There is no way to move a file from one folder to another inside the UI.

Add a **Move files** menu item that opens a mini file explorer:

1. It starts in the **current folder** (where the right-clicked/selected file(s) live).
2. It lists **subfolders only**; each row has a **Move** button on the right.
3. Clicking a folder **name** enters that folder (the list refreshes to its subfolders).
4. An **Up** button climbs one level; a **small breadcrumb** shows the path and jumps anywhere; a **Close** button dismisses.
5. A **Move here** footer action moves into the currently displayed folder — the essential “move into what you're looking at” target, since folder rows only point at *subfolders*.

Scope is moving **files**: the single right-clicked file, or the active multi-selection. Moving stacks/piles is out of scope (§4.5).

## 2. Desired behavior (source of truth)

### 2.1 Context menu

| Entry type | “Move files” item |
|---|---|
| Right-clicked **file tile**, no multi-select | Enabled → moves that file |
| **Multi-selection** present (`selKeys` / focused `selKey`) | Enabled → moves the whole selection (same resolution as Delete, `Media.jsx:3328-3331`) |
| **Pile** (stack cell) | **Disabled** (stack transfer out of scope, §4.5) |
| Empty-area right-click, nothing selected | Disabled (nothing to move) |

Icon: `bi-arrows-move` (verified present in bootstrap-icons 1.11.3, loaded at `web/index.html:12`; `bi-folder-move` does **not** exist in that set — verified against the 1.11.3 stylesheet). Placement: directly above **Delete**.

### 2.2 Move dialog

- Centered modal in the same family as `MediaContextMenu` / `ConfirmModal`: backdrop `rgba(6,8,18,.55)` + blur, high `zIndex`, `data-testid="media-move-dialog"`, body-scroll lock, Escape + outside-click close.
- **Title bar:** `Move N item(s)` + **Close** button (`bi-x-lg`).
- **Breadcrumb:** `Media` root chip + `/ segment` chips; clicking a crumb jumps to that level; last segment = current folder. Matches the main breadcrumb look (`Media.jsx:2980-3001`).
- **Up button:** climbs to the parent; disabled at media root.
- **Folder list:** rows = `bi-folder-fill` icon + folder name (click → enter) + **Move** button on the right (click → move the item(s) into that row's folder). Empty folder → subtle “No subfolders here” hint.
- **Footer:** **Move here** (primary `btn-primary`) → moves into the currently displayed folder. Disabled when every item already lives in that folder (server also guards this).
- After a successful move: close dialog, clear selection, `refresh()` the media listing (moved files vanish from the current view), `refreshStacks()`.

### 2.3 Backend contract

`POST /api/media/move`

```jsonc
// body
{
  "folder": "current/view",      // media-relative view folder; used to resolve bare names
  "target": "where/we/browsed",  // media-relative destination folder ("" = media root)
  "names": ["a.mp4", "b.gif"]    // file names in `folder` OR media-relative sub paths (flat view)
}
```

```jsonc
// 200 response
{ "ok": true, "moved": 2, "results": [
  { "name": "a.mp4", "from": "current/view", "to": "where/we/browsed", "moved": true },
  { "name": "b.gif",  "from": "current/view", "to": "where/we/browsed", "moved": false, "error": "target exists" }
] }
```

Semantics:

- Each `name` becomes a media-relative key: a bare name resolves to `folder/name`; one containing `/` (flat view) is taken as-is so a file living in a subfolder keeps its true source path.
- Target and sources must resolve **inside** `mediaDir` (`resolveMediaOutputDir`, `api-server.js:3456`); names sanitized (reject `/`, `\`, `.`, `..`, absolute, length > 200).
- Each source must exist and be a **file** (folders rejected; moving directories is not in scope).
- Move = `fs.rename` (same volume, atomic). Moving to the same folder is skipped per-file.
- **Collision:** if `target/<name>` already exists, that file is **skipped** with `moved:false` + reason (no data loss, no silent rename); the rest still move. Reported via `results` and surfaced in the dialog's alert.
- Best-effort cleanup after the moves, mirroring `DELETE /api/media` (`api-server.js:1064-1146`):
  - **playlists** — rewrite item keys `oldRel → newRel` (`withPlaylistFile` chain).
  - **mediadims** — migrate the cached ratio entry `oldRel → newRel` (`loadMediadims`/`saveMediadims`).
  - **mediaorder** — folder scopes are keyed by **basename**, flat scopes by the media-relative key (`api-server.js:991-993`, and the delete-path prune at `api-server.js:1104-1122`): prune the basename from the source folder scope and `oldRel` from every `flat:` scope; append the basename to the **target** folder-scope order and `newRel` to flat scopes that contained `oldRel`. (`withMediaorderFile` chain.)
  - **stacks** — strip the moved base name from any `.xdlstack` in the **source** folder and dissolve stacks left with ≤1 member (reuse delete-path logic, `api-server.js:1127-1141`). No stack auto-join at the destination.

## 3. Implementation

### 3.1 Server — `POST /api/media/move` (`api-server.js`)

Insert after the folder-delete handler (`api-server.js:1194`):

```js
app.post("/api/media/move", async (req, res) => {
  try {
    const folder = String(req.body?.folder || "").trim();
    const target = String(req.body?.target || "").trim();
    const names = Array.isArray(req.body?.names) ? req.body.names.map((n) => String(n).trim()).filter(Boolean) : [];
    if (!names.length) return res.status(400).json({ ok: false, error: "names required" });
    const targetDir = resolveMediaOutputDir(target);

    const results = [];
    let moved = 0;
    for (const raw of names) {
      const key = sanitizeMoveKey(raw, folder); // bare name -> folder/name; rejects ../, abs, slashes
      if (!key) { results.push({ name: raw, moved: false, error: "invalid name" }); continue; }
      const src = path.resolve(mediaDir, key);
      if (insideMedia(src) !== true) { results.push({ name: raw, moved: false, error: "invalid path" }); continue; }
      const stat = await fs.stat(src).catch(() => null);
      if (!stat || stat.isDirectory()) { results.push({ name: raw, moved: false, error: "not found" }); continue; }
      const dest = path.join(targetDir, path.basename(src));
      if (src === dest) { results.push({ name: path.basename(src), from: key, to: target, moved: false, error: "same folder" }); continue; }
      if (await fs.stat(dest).catch(() => null)) { results.push({ name: path.basename(src), from: key, to: target, moved: false, error: "target exists" }); continue; }
      await fs.rename(src, dest);
      moved++;
      results.push({ name: path.basename(src), from: key, to: target, moved: true });
      await cleanupMoveSidecar(key, mediaRelOf(dest)); // playlists + dims + mediaorder + stacks
    }
    return res.json({ ok: true, moved, results });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});
```

Helpers (all in `api-server.js`):

- `sanitizeMoveKey(raw, folder)` — trim; reject empty, `.`, `..`, `\`, absolute; if it contains `/` use as-is (normalized without `..`), else `folder ? folder + "/" + raw : raw` with the same rejection rules. Length cap 200 (matches rename, `api-server.js:1154-1155`).
- `insideMedia(absolute)` — `path.relative(mediaDir, absolute)` not `..`-escaping, not absolute, not equal to `mediaDir` for a file.
- `mediaRelOf(absolute)` — the posix media-relative key used by playlists/dims/orders.
- `cleanupMoveSidecar(oldRel, newRel)` — wraps the existing chains:
  - playlists: load → remap `it.key === oldRel → newRel` → save if mutated.
  - dims: copy `dims[newRel] = dims[oldRel]`, delete old, save.
  - mediaorder: **basename** of `newRel` appended to the target folder scope, `newRel` added to `flat:` scopes that contained `oldRel`; **basename** of `oldRel` pruned from the source folder scope, `oldRel` pruned from every `flat:` scope.
  - stacks: read `.xdlstack` files in `path.dirname(oldSrc)` and strip/ dissolve the moved basename (copy of the delete-path block).

No streaming/queue machinery — a synchronous filesystem op; the API server is single-job already.

### 3.2 Server — unit tests (`test/unit/media-move.test.js`)

`node --test` automatically picks up `test/**/*.test.js`. Test the pure helpers against a **temp media dir** (pattern from `test/helpers/temp-state.js`): build `tmp/media/sub/a.mp4`, run `sanitizeMoveKey` / move a file into a target, assert the file landed, `insideMedia` rejects `../`, collisions report `moved:false`, same-folder is skipped. These are unit tests on extracted helpers (no live API/browser, per repo convention).

### 3.3 Frontend — new component `web/src/components/MoveDialog.jsx`

Props: `{ open, items, sourceFolder, onClose, onDone }` where `items` is the frozen array of **server-format move names** (basename for files in the source folder, full media-relative path for flat-view selections — Media.jsx prepares this per §3.4, snapshot taken at menu click so a changed selection while the dialog is open never shifts the target set).

Internals:

- `const [cwd, setCwd] = useState(sourceFolder)` — browsed location; `crumbs = cwd ? cwd.split("/") : []`.
- On open/`cwd` change: `fetch("/api/media?folder=" + encodeURIComponent(cwd))` → `dirs = j.items.filter((it) => it.dir)`.
- Header: title `Move N item(s)` + Close.
- Breadcrumb: `Media` chip (jumps to `""`) + per-segment chips (jump); current segment styled primary.
- Up button: `setCwd(cwd.slice(0, cwd.lastIndexOf("/")))`, disabled when `!cwd`.
- Rows: `<i className="bi bi-folder-fill" />` + name + Move button. Name click → `setCwd(join(cwd, name))`. Move click → `moveInto(join(cwd, name))`.
- Footer: `Move here` → `moveInto(cwd)`.
- `moveInto(target)`: `POST /api/media/move { folder: sourceFolder, target, names: items }` (`items` sent as-is — already basename for same-folder files, rel-path for flat). If `j.ok` → `onDone()`; if any `result.error` → surface via the parent's `AlertModal` and still `onDone()` (movable ones moved).
- Modal chrome (scroll lock, backdrop click-to-close, Escape, `.media-ctx-card` styling / `var(--surface)`, `var(--border)`, radius 12) copied from `MediaContextMenu.jsx:29-38`, `data-testid` on the shell so the existing outside-click exclusion keeps working if reused.

### 3.4 Frontend — wire into `Media.jsx`

- New state: `const [moveCtx, setMoveCtx] = useState(null)` — `{ files: string[] }` (media-relative keys), `null` = closed. Reset on `folder` change and on new `ctxMenu`.
- `moveTargets` resolution, memoized and mirroring the Delete block (`Media.jsx:3322-3332`): collect `[...selectedKeysForStack]`; if the right-clicked entry is a `file` with `it` present and the selection is empty, use `[rowKey(it)]`; if the entry is a pile, or the list is empty, the list stays `[]`. `canMove = moveTargets.length > 0`.
- The menu item's `disabled` prop is the single `canMove` flag (NOT `fileCount`, which is 1 even for an empty-area right-click with nothing selected). Empty-area + selection present → enabled (moves the selection); empty-area + nothing selected → disabled.
- Convert keys to names for the dialog: non-flat → `key.split("/").pop()`; flat → key as-is (server treats a slash-carrying name as a full media-relative path).
- `onMove={() => setMoveCtx({ files: moveTargets })}` — snapshot taken at click time so a selection change while the dialog is open never shifts the target set.
- Render `<MoveDialog open={!!moveCtx} items={moveNames} sourceFolder={folder} onClose={() => setMoveCtx(null)} onDone={...} />` next to `MediaContextMenu` (`Media.jsx:3299`), where `moveNames` is the §3.4-converted server-format name list derived from `moveCtx.files`.
- `onDone`: `setMoveCtx(null)`, clear selection (`setSelKey`/`setSelKeys`), `refresh()`, `refreshStacks()`.
- `MediaContextMenu` gets one new prop `onMove`; add `<MenuItem label="Move files" icon="bi-arrows-move" disabled={!canMove} onClick={() => { onClose(); onMove(); }} />` above Delete (`MediaContextMenu.jsx:59`). Pass `canMove` from `Media.jsx` (the resolved `moveTargets.length > 0` flag).

## 4. Decisions & out of scope

### 4.1 “Move here” footer

The user spec names a Move button next to **folder names** — those are the *subfolders*. A dialog user who navigates *into* a folder has no other way to target that folder, so a **Move here** confirm for the displayed folder is included. If undesired, it can be dropped — the server and per-row Move buttons are unchanged.

### 4.2 Collision policy

Skip + report, not auto-rename. No silent data overwrite or surprise `(1)` suffixes; the modal alerts on any skips.

### 4.3 Flat view

Allowed: files keep their real source path (keys with `/`), the dialog starts at the current folder, and Move-into-subfolder targeting still works since each file resolves independently.

### 4.4 Multi-folder moves in one request

One request handles files from several folders (flat view selections) — the per-file `results` report `from` per file.

### 4.5 Out of scope

- **Moving folders** (the folder chips) — only files.
- **Moving stack/pile cells** — stacks are per-folder `.xdlstack` files; a pile's Move item is disabled. (Future: transfer the stack file too.)
- **Drag-and-drop move** onto a folder chip (separate feature from the folder-browse dialog).
- **Undo / trash** — moves are immediate filesystem renames.
- No changes to `index.html` (the legacy non-React UI) or `FileViewer.jsx`.

## 5. File change list

| File | Change |
|------|--------|
| `api-server.js` | New `POST /api/media/move` after folder-delete (`:1194`); helpers `sanitizeMoveKey`, `insideMedia`, `mediaRelOf`, `cleanupMoveSidecar` |
| `test/unit/media-move.test.js` | New — unit tests for the move helpers (temp dir, no live browser) |
| `web/src/components/MoveDialog.jsx` | New — folder-explorer modal (breadcrumb, Up, folder rows w/ Move, Move here) |
| `web/src/components/MediaContextMenu.jsx` | New `Move files` menu item (icon `bi-arrows-move`) above Delete + `onMove` + `canMove` props |
| `web/src/views/Media.jsx` | `moveCtx` state, key resolution, `<MoveDialog>` render, `onDone` refresh/clear, pass `canMove` |
| `plans/026-media-move-files.md` | This plan |

## 6. Implementation steps

1. Add the four helpers + `POST /api/media/move` endpoint in `api-server.js`.
2. `test/unit/media-move.test.js`; run `npm test`.
3. Build `MoveDialog.jsx`.
4. Wire `Media.jsx` state + render + `onMove`; add the menu item in `MediaContextMenu.jsx`.
5. `cd web && npm run build` and `cd web && npm run lint`; manual pass (§7).

## 7. Verification

```bash
npm test                 # root node --test (includes the new move helper tests)
cd web && npm run build
cd web && npm run lint   # oxlint — no new warnings
```

Manual (app served against the API, e.g. `web/... dev` proxying to `:6767`):

- Select 1 file → right-click → **Move files** → explorer opens at the current folder, title shows `Move 1 item`.
- Multi-select several files → same menu → `Move N item(s)`; all move.
- Click a folder name → its subfolders list, breadcrumb grows; Up climbs; crumb jump works.
- Folder row **Move** button → files land in that folder; toast/empty-state via `refresh()`; selection cleared.
- **Move here** in a subfolder → files moved into the displayed folder.
- Breadcrumb root chip → back to media root; up disabled at root.
- Close button / backdrop / Escape → dialog closes, nothing moves.
- Target folder already contains `a.mp4` → `a.mp4` skipped with error surfaced, others moved.
- Playlist keys, `.mediadims.json`, `.mediaorder.json` scopes, `.xdlstack` members for the moved files all updated (spot-check the JSON files).
- Pile right-click → **Move files** is disabled (grayed).
