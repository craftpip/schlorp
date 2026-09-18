# Plan 012 — Media Page: Thumbnail (Tile) View

**Date:** 2026-09-02
**Status:** Done
**Owner:** xdl web panel (React app at `/`, `web/`)
**Scope:** `web/src/views/Media.jsx`, `api-server.js` (`GET /api/media`). Depends on Plan 011 (flatten/sort/filters/poster-hide/player) — assumes 011 is implemented.

## 1. Probe findings

- Videos are saved with a companion poster: `2busty2hide-180hyq7.mp4` ↔ `2busty2hide-180hyq7-poster.jpg` — i.e. **stem = file name minus extension, poster = `<stem>-poster.jpg`** (jpg confirmed; png/webp not observed).
- Plan 011 already:
  - Filtered `-poster.*` files out of the listing (client-side `isPosterFile()`, `Media.jsx` `load()`).
  - Added `created` + `flat=1` (`rel`) to `GET /api/media` via `listMediaDir()` (api-server.js:640).
  - Player navigates the full displayed `viewable` list (flatten + filters + sort applied).
- Media page currently is a **single list view**: rows with icon, name, size, time, actions (`media-file-*` rows, `gridTemplateColumns: "1fr auto auto auto"`). Selection + keyboard nav (`filtered`/`selectedIdx`/`viewerIdx`) is linear and view-agnostic — reusable for a grid.
- The `-poster.*` posters still exist in the folders; they were only hidden from display, so they can be reused as thumbnail **images** (express.static serves them).
- Flat root listing is large (~48k items, ~22k posters) → images must be lazy and thumbnail resolution must not add I/O.

## 2. Goal / Scope

Add a **thumbnail view** (toggleable grid of tiles) to the Media page:

1. **View toggle** — `List` (current) ↔ `Grid`, persisted in URL (`?view=grid|list`, default `list`).
2. **Tiles** — pure thumbnail tiles. No delete button, no size/time. Just the thumbnail image (plus hover tooltip name), matched to how files are displayed in the list (flatten/filters/sort apply identically, since `filtered` is the single source).
3. **Thumbnail source** — use the sibling `-poster.jpg` as the video thumbnail for now. Files without a poster (photo/gif fall back to self-image; audio/other can fall back to category icon).
4. Clicking a tile opens the existing player (same `viewable`, so next/loop/shuffle follow the displayed tile order). Folder tiles navigate (in non-flat view).

Out of scope: thumbnails generated on the server (transcoding/resizing), drag-reorder, multi-select.

## 3. Architecture — where to change

```
api-server.js                    → listMediaDir(): compute per-item `thumb` (poster sibling) without extra I/O (match within the same listing)
web/src/views/Media.jsx          → `view` URL param, Grid/List toggle, grid render (tiles), reuse filtered/selectedIdx/viewer wiring
web/dist                         → rebuild + live-mounted (already served)
```

No FileViewer changes (player already takes the full displayed list). Legacy `index.html` untouched.

## 4. Detailed design

### 4.1 Backend — `thumb` field on `GET /api/media` items (api-server.js)

Thumbnails are derived from the **same directory listing**, so no extra filesystem probes: the poster files are already items (they're only hidden client-side).

In `listMediaDir()`, after building `items`, do one O(n) pass:

```js
// index poster items by their key: rel-without-extension (flat) / name-without-extension (non-flat)
const posterByStem = new Map();
for (const it of items) {
  const m = /^(.*)-poster\.(jpe?g|png|webp|avif|gif)$/i.exec(it.rel || it.name);
  if (m) posterByStem.set(m[1].toLowerCase(), it);   // keep first poster ext found
}
for (const it of items) {
  if (it.dir) continue;
  const key = (it.rel || it.name).replace(/\.[^.]+$/, "").toLowerCase();
  const poster = posterByStem.get(key);
  it.thumb = poster ? (poster.rel || poster.name) : null;  // relative path, / separated
  delete poster? // no — poster items stay in items (client hides them), thumb just referenced
}
```

- `thumb` = path relative to the requested `folder` (same semantics as `rel`), or `null`.
- Flat: `rel` matching makes `reddit/a.mp4` ↔ `reddit/a-poster.jpg` match (`reddit/a` both sides).
- Non-flat: `name`-based mapping (`a.mp4` ↔ `a-poster.jpg`).
- Works with the poster-exclusion from Plan 011 automatically (poster tiles stay hidden; their URL now powers the video tile image).
- Alternative noted: `fs.access` per candidate poster — rejected because O(n) in-memory matching is free.

### 4.2 Frontend — view toggle + URL param (`Media.jsx`)

- New URL param `view`: `searchParams.get("view") === "grid"` → `isGrid`. Toggle button in the toolbar next to the Flatten/toggle group:
  - List: `<i bi-list-ul /> List`, Grid: `<i bi-grid-3x3-gap-fill /> Grid` (both as one segmented control with the selected state).
  - `setParam("view", "grid"|"list")` — list = delete param.
- Keep posters-hidden filter (`isPosterFile`) in `load()` — grid must not render posters as tiles either.
- `filtered` pipeline (flatten + type chips + text + sort) is **shared** — the grid shows exactly the same items as the list, so "view files as displayed" holds by construction.

### 4.3 Grid / tile render (`Media.jsx`)

When `isGrid`, replace the row table with a responsive CSS grid:

```
display: grid
gridTemplateColumns: repeat(auto-fill, minmax(150px, 1fr))   // ~128-160px tiles
gap: 10px
```

Tile (`filtered.map(fi)`), reusing `selectedIdx` for keyboard/highlight parity:

```jsx
<div key={…} id={`media-file-${sanitizeKey(rowKey(it))}`} data-filename={rowKey(it)}
     data-selected={fi === selectedIdx}
     style={{ aspectRatio: "16/10", background: "var(--surface-2)", border: …,
              outline/border highlight when selected, overflow: "hidden", cursor: "pointer", position: "relative" }}
     title={displayName(it)}
     onClick={() => { setSelectedIdx(fi); it.dir ? goFolder(it.name) : openViewer(it); }}>
  {it.dir ? (
    <folder-tile icon bi-folder-fill + name label>
  ) : thrumb(it) ? (
    <img src={toMediaUrl(folder, thrumb(it))} loading="lazy" decoding="async"
         style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
  ) : (
    <category-icon placeholder (bi-file-earmark-*, large, centered)>
  )}
  {!it.dir && <name-caption bar (optional, dim) …>}
</div>
```

- `thrumb(it)` — poster path when present:
  ```js
  const thrumb = (it) => (isFlat ? it.thumb : it.thumb ? `${folder ? folder + "/" : ""}${it.thumb}` : null)
  ```
  Actually keep it simple: `it.thumb` is already folder-relative (same as `rel`), so `toMediaUrl(folder, it.thumb)` works for both flat and non-flat. For **photo/gif** items with no poster, use the file itself as the thumbnail (`toMediaUrl(folder, it.rel || it.name)`) so those tiles show a real preview; **audio/other** → category icon. (Video with no poster → icon placeholder.)
- **No delete button, no size/time** in tiles (per requirement). Selection highlight via existing `[data-selected]` background/border instead of the row background.
- Keyboard nav unchanged (`selectedIdx` moves linearly; Enter/Space opens viewer / folder). Default non-flat cursor wrap naturally by the grid.
- Open player from grid → same `openViewer`/`viewable` path, so `view=grid` + player work together with flatten/filters/sort. On close, highlight restores on the tile (id/`data-filename` logic unchanged).

### 4.4 Performance

- `<img loading="lazy" decoding="async">` — only visible posters load (critical for flat root ~26k non-poster files).
- No server-side image processing; posters are small JPGs already.
- If the grid stutters at 26k DOM nodes, note mitigation (virtualization) as follow-up — not blocking.

## 5. Edge cases

- **Video without poster** → icon placeholder tile (no broken image).
- **Photo/gif tiles** → self-image thumbnail; gif animates on hover iff small (browser decides) — acceptable.
- **Poster referenced but deleted** → `<img>` falls back to placeholder via `onError={(e)=>{e.currentTarget.remove()}} → icon` (add onError to swap to placeholder). (Deleting posters is normal via list view.)
- **Flat + same filename in two folders** → `key`/`id` use `rowKey` (rel), already unique from Plan 011.
- **View switching** resets nothing (selection/viewer preserve; `filtered` unchanged).
- **Folder tiles in grid** (non-flat): navigate on click; show with folder icon + name (no thumbnail).

## 6. Implementation steps

1. `api-server.js`: add poster-index pass in `listMediaDir()` to populate `thumb`. `node --check api-server.js`; curl probe `?folder=reddit` shows `thumb` for videos, `null` for photos/gifs/audio.
2. `web/src/views/Media.jsx`:
   - `isGrid` from `?view=grid`; List/Grid toggle control.
   - `thrumb()` helper (poster → self image for photo/gif → icon), `onError` fallback.
   - Conditional render: existing table when list (`!isGrid`), new tile grid when `isGrid` (dirs + files), selected highlight, title tooltip.
3. Rebuild `cd web && npm run build`; verify `dist` regenerated (live-mounted, served).
4. Manual passes (§8).

## 7. Risks / mitigations

- **Large flat grid (26k items)** → many DOM nodes. Mitigate: lazy images; if unreadable, follow-up virtualization (react-window style) or server pagination — documented, not blocking.
- **Poster naming drift** (poster ext not jpg) → map scans all `-poster.<img>` extensions; first match wins.
- **Broken poster after deletion** → `onError` placeholder swap.
- **Browser autoplay on gif tiles** — no autoplay; only static cover; gif `<img>` animates inline (expected).
- Backend payload grows by one `thumb` string per file (~26k × ~30B ≈ 0.8 MB flat root) — acceptable; same-order as existing `rel`.

## 8. Verification

- API: `curl '…/api/media?folder=reddit'` → mp4 items have `thumb:"<stem>-poster.jpg"`; photo/gif/mp3 items `thumb:null`; `?flat=1` maps correctly across folders.
- UI (hard refresh for new bundle):
  - Toggle Grid at root (flat off) → folder tiles + real files; posters not shown as tiles.
  - Toggle Grid with Flatten on → all files flat, tiles show correct `folder>` tooltips, videos use their poster thumbnails.
  - Apply type chip (Videos) + sort (Time desc) → grid order matches list order; player next/loop/shuffle follows tile order.
  - Click photo/gif tile → player opens it (self-thumbnail tile); click video w/o poster → icon tile still opens.
  - Select with arrows/WASD, Enter/Space opens; `data-selected` highlight moves across tiles; close viewer highlights the tile.
  - No delete/size/time controls visible anywhere in grid view.
  - Delete a video's `-poster.jpg` in list view → grid tile shows icon, no broken image.
- `npm run lint` (no new errors), `node --check api-server.js`.

## 9. Change log

- 2026-09-02: Initial draft — thumbnail/grid view, `?view=grid`, `thumb` field derived in-memory from poster items, tiles without delete/info, self-thumbnails for photo/gif, icon fallback, lazy loading.