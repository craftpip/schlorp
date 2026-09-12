# Plan 015 — Media Playlists: Create & Hover-Add (Player + Listing)

**Date:** 2026-09-13
**Status:** Draft (plan only — no code yet)
**Scope:** `api-server.js` (playlist API + storage), `web/src/views/Media.jsx` (tile/row hover button + playlist folder-like listing), `web/src/components/FileViewer.jsx` (player button below Close), new `web/src/components/PlaylistHoverMenu.jsx` + `web/src/store/PlaylistsContext.jsx` (or lib). No download/queue/scan change. No separate route/view — playlists are listed **inside the Media page** like folders (updated per 2026-09-13 user request).
**Owner:** xdl web panel (`/media`)
**Depends on:** Plan 011 (flat/thumb), Plan 012 (grid tiles), Plan 014 (single-select key-based). Backward compatible — no existing API changed.
**User request:** In the media page create playlists, add items to them. Playlist adding UI: (1) in the video player a button **below the close button** — lowest in the header stack — on **hover** it opens the playlists I created and shows options, click toggles add/remove; (2) in the media listing, when **hover on an item** it shows that button; hovering the button shows the playlist menu with which playlists the item can be put in and which it is already in. **Everything opens on hover (mouse over), not click.** Updated: playlists themselves are **listed in the Media page only, like folders** — no separate `/playlists` page/nav.

---

## 1. Goal

Add lightweight **playlists** (named sets of media files) to the Media library:

1. **Create** playlists from anywhere (player hover menu + listing hover menu both have `New playlist` inline).
2. **Add / remove** any media file (photo/video/gif/audio — not folders) to any playlist via a **hover menu** that shows all playlists with membership indicated.
3. **Hover-only trigger** — the add-button itself appears on hover, and its menu opens on **hover over the button** (not click). Menu stays open while hovering button + menu; leaves close it. Touch/coarse-pointer falls back to tap.
4. **Two surfaces:**
   - **Player:** vertical stack on the right header: existing `[↑ ↓ badge] spacer [trash] [close]` → new column `[trash] [close] [playlist-add]` (playlist button is the lowest). Hover on that lowest button → playlist menu (right-aligned dropdown).
   - **Listing:** each item (grid tile + list row) shows a small playlist button **only on hover over the item** (opacity 0 → 1). Hovering that button → same playlist menu anchored to the button. Menu shows checkmarks for playlists the hovered file already belongs to.
5. Persisted server-side, survives reload/restart, shared across browsers.
6. **Listed in Media page like folders** — playlists appear as folder-like rows/chips at the top of the Media file browser (alongside/within the existing folder section), not in a separate page. Creating/renaming/deleting playlists also happens inline in the Media page.

Out of scope v1: drag-reorder inside playlist, auto-play playlist queue, sharing between users, server-side folder watching. No separate route/view — manage actions are inline in Media page.

---

## 2. Probe findings (current state)

| Area | Current |
|------|---------|
| **Media list model** | `Media.jsx:86-117` `filtered` → `viewable` (non-dir). Row key `rowKey(it) = isFlat ? it.rel : it.name` (`Media.jsx:161`). Global key for playlists must be **absolute media path** `folder/rel` (or `folder/name` non-flat) to be stable across flat on/off. |
| **Player header** | `FileViewer.jsx:554-565` absolute `fv-header` `flex row` with left nav `[prev badge next] spacer [delete] [close]`. Buttons are 36×36 rounded, `rgba(0,0,0,.55)` + blur. No playlist button. Close is the last/rightmost element. |
| **Listing tiles/rows** | `Media.jsx:435-503` `renderTile` + `Media.jsx:631-652` list rows. Tile: `position:relative` preview + bottom label. Row: grid `1fr auto auto auto`. No hover button today. Hover is via CSS `:hover` not explicit state. |
| **Storage pattern** | Queue → `.web-queue.json`, saved lists → `.saved-sync-state.json` (gitignored). Playlists should follow same pattern: single JSON file at repo root, gitignored, read/write with serialized queue to avoid races. |
| **API pattern** | `api-server.js:775-804` `GET/DELETE /api/media`, `/api/mediathumb`, `/api/gifvideo` — all check `resolveMediaOutputDir(folder)` containment. Playlists API will be new `GET/POST /api/playlists` etc. behind same auth middleware (`api-server.js:648`). |
| **Web routing** | `web/src/main.jsx:21-30` `/media` → `Media.jsx`. No `/playlists` route. `App.jsx:137-143` nav has 5 links. **No new route** — playlists are rendered inside `Media.jsx` alongside folders (see §5.4). |

---

## 3. Data model & storage

**File:** `.playlists.json` at repo root (add to `.gitignore` alongside `.saved-sync-state.json`, `.web-queue.json`).

```json
{
  "playlists": [
    {
      "id": "pl_1726130000000_ab12",
      "name": "favorites",
      "createdAt": "2026-09-13T10:00:00.000Z",
      "updatedAt": "2026-09-13T10:05:00.000Z",
      "items": [
        { "key": "reddit/abc-123.mp4", "addedAt": "2026-09-13T10:05:00.000Z" }
      ]
    }
  ],
  "updatedAt": "2026-09-13T10:05:00.000Z"
}
```

- `id`: `pl_<ms>_<rand4>` unique.
- `name`: trimmed 1-60 chars, unique case-insensitive (409 on duplicate on create; rename collision also 409).
- `key`: **canonical absolute media path** — `path.posix.join(folder, relOrName)` without leading slash, `/`-separated, e.g. `boobs/file.mp4`, `reddit/sub/file.mp4`, or `file-at-root.mp4`. Derived in frontend as `playlistKey(folder, rowKey)` and on server normalized with `path.posix.normalize`. No `..` or absolute.
- `items` max 5000 per playlist (400 on overflow).
- `playlists` max 100 total (400 on overflow).
- File I/O serialized via `queueFileChain`-style promise chain (same as `withQueueFile` in `api-server.js:178`).

**Key helpers (api-server.js):**

```js
function normalizePlaylistKey(raw) // trim, posix normalize, reject "..", "/", "\\", empty
function playlistKeyForMedia(folder, rowKey) // folder ? `${folder}/${rowKey}` : rowKey
function loadPlaylists() / savePlaylists()
```

**Cleanup on delete:** `DELETE /api/media` already deletes the file; after unlink, also prune that key from every playlist's `items` (best-effort) and `savePlaylists()` if mutated. Prevents stale dead entries from accumulating. `GET /api/playlists` may optionally filter out keys whose file no longer exists (or annotate `missing:true` — v1 just prune on delete, not on every GET to avoid scan cost).

---

## 4. Backend API (`api-server.js`)

All behind existing auth middleware. `Content-Type: application/json`.

| Method | Path | Body | Resp | Notes |
|--------|------|------|------|-------|
| `GET` | `/api/playlists` | — | `{ ok, playlists: [{ id, name, createdAt, updatedAt, count, items: [key] }] }` | Light: `count` = items.length, `items` = array of keys (strings) for quick membership checks. Full objects with `addedAt` kept internally but not needed for menu. |
| `POST` | `/api/playlists` | `{ name: string }` | `{ ok, playlist }` 201 | Trim, 1-60 chars, unique ci. Auto `id`. |
| `PATCH` | `/api/playlists/:id` | `{ name: string }` | `{ ok, playlist }` | Rename. |
| `DELETE` | `/api/playlists/:id` | — | `{ ok }` | |
| `POST` | `/api/playlists/:id/items` | `{ key: string }` | `{ ok, playlist, added: boolean }` | Add key to playlist (idempotent; `added:false` if already present). Validate key via `normalizePlaylistKey`, 400 on bad. 404 if playlist not found. |
| `DELETE` | `/api/playlists/:id/items` | `{ key: string }` (or `?key=`) | `{ ok, playlist, removed: boolean }` | Remove. Idempotent. |
| `POST` | `/api/playlists/:id/toggle` | `{ key: string }` | `{ ok, playlist, member: boolean }` | Convenience: toggles, returns new membership. Used by hover menu single click. |
| `GET` | `/api/playlists/:id` | — | `{ ok, playlist: { id, name, items:[{key,addedAt}] } }` | Detail for manage page; optionally enrich with `exists` by stat check (lazy, not blocking). |

Implementation notes:
- Reuse `withPlaylistFile(fn)` serializer like `withQueueFile`.
- On `GET /api/playlists` no file → `{ playlists: [] }` (not error).
- Errors: 400 bad name/key, 404 id, 409 duplicate name.
- After any mutation, set `updatedAt` on playlist + root.
- No websocket needed v1: client polls `GET /api/playlists` on mount + after any mutation; optionally `wsBroadcast({ type:"playlists:update" })` for multi-tab live (thin, optional).

Update `.gitignore`: add `.playlists.json`.

---

## 5. Frontend architecture

### 5.1 New modules

```
web/src/store/PlaylistsContext.jsx   // React context: { playlists, loading, error, refresh, create(name), toggle(playlistId, key), add/remove }
web/src/components/PlaylistHoverMenu.jsx  // Hover menu UI (shared by player + listing)
// No new view — playlists are rendered inside Media.jsx (§5.4)
```

**PlaylistsContext** — single source:

```js
const { playlists, loading, refresh, createPlaylist, toggleItem, isMember } = usePlaylists();
// playlists: [{ id, name, items: string[], count }]
// isMember = (playlistId, key) => boolean
// toggleItem = async (playlistId, key) => { POST /api/playlists/:id/toggle {key} -> refresh }
// createPlaylist = async (name) => POST /api/playlists -> refresh
```

- `refresh()` = `fetch(/api/playlists)` → set state. Called on mount + after each mutation. No polling.
- Provide `playlistKeyOf(folder, rowKey)` helper exported for callers.
- Handle 409/400 with thrown Error for UI to show inline.

**PlaylistHoverMenu** — pure presentational + hover logic:

```jsx
<PlaylistHoverMenu
  mediaKey={key}           // canonical key e.g. "boobs/file.mp4"
  playlists={playlists}    // from context
  onToggle={(playlistId) => toggleItem(playlistId, key)}
  onCreate={(name) => createPlaylist(name).then(id => toggleItem(id, key))} // create then add
  placement="right" | "left"
  onCloseHover? // not needed, self manages
/>
```

Layout (inside the hover wrapper):
- Header `Add to playlist` (11px muted)
- Scrollable list (max-h 220, overflow auto) — each row: checkbox/check icon + name + count `· 12`. Rows with `member` get `✓` / filled `bi-check-circle-fill` + accent bg `rgba(99,102,241,.12)`.
- Click row → `onToggle(id)` (stopPropagation, no close — allow multi-add). Visual flips immediately (optimistic).
- Footer: inline `New playlist` — `<input placeholder="New playlist…" value draft onChange>` + `Create` button (disabled empty). Enter creates + adds. After create, input clears, new row appears checked.
- Empty state: `No playlists yet — create one below.`

Styling: `var(--surface)`, `var(--border)`, `var(--accent)` `#6366f1`, radius 10, shadow `0 8px 24px rgba(0,0,0,.2)`, `backdropFilter blur(12px)` consistent with `FileViewer` header. `zIndex 90` above tile/row but below viewer (80) — menu inside viewer needs higher (95). Footer `New playlist` input is the only creation entry outside the Media playlist row (also available there — see §5.4).

### 5.2 Player — `FileViewer.jsx`

Current header (`FileViewer.jsx:554-565`):

```
[left: prev badge next]  spacer  [trash (delete)] [close X]
```

New (user: button **below** close, lowest):

- Change right side to **vertical column** (flex column, gap 6) instead of row, so close is above playlist button:
  ```
  [trash]
  [close X]   ← existing, 36×36
  [playlist ⊞] ← NEW, 36×36, icon bi-collection-play or bi-plus-square, title "Add to playlist"
  ```
  Or keep horizontal then vertical inside wrapper — simplest: wrap the two rightmost buttons in a column container:

  ```jsx
  <div style={{ display:"flex", flexDirection:"column", gap:6, pointerEvents:"auto" }}>
    <button close... />
    <div style={{ position:"relative" }} onMouseEnter={...} onMouseLeave={...}>
      <button playlist ... />
      {hover && <PlaylistHoverMenu mediaKey={playlistKey} ... placement="right" />}
    </div>
  </div>
  ```

- Hover behavior: wrapper `onMouseEnter` sets `showPlaylists=true`, `onMouseLeave` clears (with 120ms debounce to allow moving into menu). Menu positioned `absolute top: 44px right: 0` (below button) or `right: 44px top: 0` if vertical — choose `right:0 top:44` so it drops below the button, not overlapping. Must stay inside `fv-header` pointerEvents handling (header is `pointerEvents:none` with children `auto`).

- `mediaKey` for player: `playlistKeyForMedia(folderFromFilePath, rowKey)` — derive `folder` via `parseFolderBase(filePathEff).folder` and `rowKey` via base name or full rel. For viewer, `filePathEff` is canonical `folder/key`; so `key = folder ? `${folder}/${base}` : base` but if flat, `key` already contains `/`. Use `filePathEff` directly as `mediaKey` (it is already `folder/key`). Pass as `mediaKey`.

- Touch fallback: `onClick` toggles `showPlaylists` (since hover absent on coarse pointer). Detect `isCoarsePointer()` via `matchMedia("(pointer: coarse)")`.

- No navigation on playlist add — just toast-less toggle; menu stays open for multiple adds.

### 5.3 Listing — `Media.jsx`

Two places:

**Grid tiles** `renderTile(it, fi, w, h)` (`Media.jsx:435-503`):

- Tile wrapper already `position:relative`. Add playlist button as `position:absolute top:6 right:6` (top-right corner, above image). Hidden by default `opacity:0` + `pointerEvents:none`; on **tile hover** (`:hover` or `onMouseEnter` on tile) → `opacity:1` + `pointerEvents:auto`. Folders (`dir`) have no button (only files).
- Button: 28×28, `rgba(0,0,0,.55)` + blur, `bi-plus-lg` or `bi-collection-play`, white icon. Same hover wrapper as player: button + menu.

  ```jsx
  <div data-testid="media-tile-file" ... onMouseEnter={() => setHoveredKey(rk)} ...>
    ...preview...
    {!isDir && (
      <div className="media-tile-playlist-wrap" style={{ position:"absolute", top:6, right:6, opacity: hoveredKey===rk?1:0, ... }}>
        <div onMouseEnter={()=>setMenuKey(rk)} onMouseLeave={()=>setMenuKey(null)}>
          <button data-testid="media-tile-playlist-btn" ...><i className="bi bi-plus-lg" /></button>
          {menuKey===rk && <PlaylistHoverMenu mediaKey={playlistKey} ... />}
        </div>
      </div>
    )}
  </div>
  ```

- Simpler CSS-only: `.media-tile-playlist-wrap { opacity:0; transition:.12s } .media-tile-file:hover .media-tile-playlist-wrap { opacity:1 }` — plus React hover for menu open.

**List rows** `filtered.map` (`Media.jsx:631-652`):

- Similar: row is `position:relative` already. Add inline button before Delete, but **hover-only visible**. Existing actions show `Open`/`Delete`. New button sits left of Delete.

  ```jsx
  <div data-testid="media-row" ...>
    <div name>...</div>
    <span size/>
    <span time/>
    <div actions style={{ display:"flex", gap:6, alignItems:"center" }}>
      {!it.dir && (
        <div style={{ position:"relative" }} onMouseEnter={()=>setRowMenuKey(key)} onMouseLeave={()=>setRowMenuKey(null)}>
          <button data-testid="media-row-playlist-btn" style={{ opacity: rowHovered?1:0, width:28, height:28, ... }}><i className="bi bi-plus-lg" /></button>
          {rowMenuKey===key && <PlaylistHoverMenu mediaKey={playlistKey} ... />}
        </div>
      )}
      {it.dir ? Open : Delete}
    </div>
  </div>
  ```

- Row hover visibility: `onMouseEnter` on row sets `hoveredRowKey`; button opacity follows. Also CSS fallback `.mrow:hover [data-testid=media-row-playlist-btn] { opacity:1 }`.

Menu placement for rows: `position:absolute right:0 top:34` (below button, right-aligned).

**Key computation in Media.jsx:**

```js
const playlistKey = (it) => {
  const rk = rowKey(it); // rel or name
  return folder ? `${folder.replace(/\/$/,"")}/${rk}` : rk; // canonical absolute
};
```

For flat mode `rk` already contains `sub/filename`; joining still correct: `folder/sub/file`.

### 5.4 Playlists displayed in Media page like folders (`Media.jsx`) — updated 2026-09-13

No separate route or nav. Playlists are rendered **inside the Media page**, visually like folders.

**Where they appear:**

- **Grid view** (`Media.jsx:603-619` `media-grid-folders` / `media-grid-files`): add a first section **`media-grid-playlists`** directly above the existing Folders section, inside the same `media-grid-tiles` column:
  ```
  [Playlists header + New input]   ← new, always at top when not inside a playlist
  [Folders header + folder chips]  ← existing
  [Files header + file tiles]      ← existing
  ```
  Playlists section header: `Playlists` (small muted 11px) + `count` badge + `New` inline input (see below). Chips use the same `FOLDER_CHIP_W/H` (220×56) layout as folder chips (`Media.jsx:414`) but with different icon/color to distinguish:
  - Folder chip: `bi-folder-fill` #f59e0b (existing)
  - Playlist chip: `bi-collection-play-fill` or `bi-music-note-list` #6366f1, label `name · count`, e.g. `favorites · 12`
  - Hover on playlist chip shows a tiny `⋯` or pencil/trash affordance on the right (only on chip hover) via `onMouseEnter` — not a separate page.

- **List view** (`Media.jsx:624-658` table): playlists appear as **rows at the top**, before folder rows and file rows, sharing the same `mrow` grid but with `data-testid="media-row-playlist"`:
  ```
  [playlist rows]  ← new
  [folder rows]    ← existing dirs
  [file rows]      ← existing files
  ```
  Row columns: `Name (icon + name) | Count | Time (updatedAt) | Actions`. Icon `bi-collection-play`. `Size` column shows `count` instead of bytes; `Time` shows `timeAgo(playlist.updatedAt)`. Actions column has hover-only `Rename` / `Delete` (see manage inline).

**Create inline in Media page:**
- Grid: inside Playlists header, an inline `<input placeholder="New playlist…" />` + `Create` button (28px height, `btn-primary`). Same input also available as a `+ New playlist` dashed chip at the end of the playlist chips row for discoverability.
- List: above the playlists rows (between sticky toolbar and list header) a compact `New playlist` input row, or as first row with dashed border.
- Creation → `POST /api/playlists {name}` → `refresh()` → new chip/row appears instantly. If created via hover menu (`PlaylistHoverMenu` footer), same API is called and the Media section also updates via context refresh.

**Click / double-click semantics (mirror folders, reuse plan 014 single-select):**

- **Single click** on playlist chip/row → select only (`setSelectedKey` with key `playlist:<id>`). No navigation. Allows keyboard nav.
- **Double-click** (or `Enter` on selected) → **open playlist**: set URL param `?pl=<id>` (or `?playlist=<id>`; use obfuscated `?p=` base64url like `?f=`/`?s=`). While `pl` is set, the Media content switches to **playlist view**:
  - Breadcrumbs show `Media / Playlists / <playlist name>` (extra crumb after `Media`). `Up` returns to `Media` (clear `pl`).
  - Folder section hidden (playlists are global, not per-folder).
  - File listing shows **only items in that playlist** (resolve each `key` to `toMediaUrl`; skip missing files — dimmed or pruned). Reuse existing `viewable`/`filtered` pipeline but source is `playlist.items` filtered by current folder/flat? Simpler: ignore `folder`/`flat`/`type`/`q` while in playlist view — show the playlist's items flat as `folder > name` labels, still sortable by name/size/time via existing sort toggles. `q` filter still applies (search inside playlist).
  - Grid/List toggles still work on playlist items.
  - Selection model unchanged (`rowKey` for playlist items is the canonical key `folder/rel`).

**Manage inline (rename/delete) in Media page:**

- Hover on a playlist chip/row reveals small icons: `pencil` (rename) / `trash` (delete). Clicking `pencil` swaps label for inline `<input>` + `Save`/`Cancel` (Enter/Esc). `Save` → `PATCH /api/playlists/:id {name}` (409 on duplicate). `Delete` → `confirm("Delete playlist \"name\"? Files stay in Media.")` → `DELETE /api/playlists/:id`.
- While inside a playlist (`?pl=<id>`), the playlist header also shows `Rename` / `Delete` buttons, and each item tile/row has a `Remove from playlist` `×` (hover-only) that does `DELETE /api/playlists/:id/items {key}` without leaving the playlist view.
- No nav link, no `web/src/views/Playlists.jsx`, no `main.jsx`/`App.jsx` change.

**State sharing:**

- `PlaylistsContext` provides `playlists` to both the hover menus (§5.2/§5.3) and the Media playlist section. `Media.jsx` reads `playlists` and derives `playlistRows` / `playlistChips` directly — no extra fetch.

**URL param:**

- `pl` (or `p` obfuscated) = playlist id. When present, `Media.jsx` skips the normal `GET /api/media` listing and instead renders `GET /api/playlists/:id` items (still use `GET /api/media` metadata for size/mtime lazily or after initial detail's `items` array; enrich via `HEAD` or reuse `listMediaDir` stats — v1 can fetch sizes via `GET /api/playlists/:id` enriched server-side, or client fetches `GET /api/media?flat=1` once and joins by key).

---

## 6. Hover interaction spec (must match user wording)

- **Trigger:** `mouseEnter` on the playlist button → set `open=true`. `mouseLeave` on the **combined** button+menu wrapper → start 120ms timeout to close (cancel if re-enter). This ensures moving cursor from button into the menu does not close it. No click required on desktop.
- **Everything on hover:** both *opening the menu* and *showing the button* are hover-driven:
  - Listing button visibility = hover over the **item** (tile/row). Not always visible.
  - Menu visibility = hover over the **button** (or menu itself).
- **Click inside menu:** toggling a playlist is a click on a row → `toggle` → optimistic checkmark flip, menu stays open (user may add to multiple playlists without reopening).
- **Create flow:** input focused → type name → `Enter` or `Create` click → `POST /api/playlists {name}` → on success `POST /api/playlists/:id/items {key}` → menu updates (new row checked). Inline error shown below input (duplicate name → "Already exists").
- **Membership indication:** rows for playlists containing `mediaKey` show solid check `bi-check-circle-fill` in accent `#6366f1`, plus subtle bg highlight. Others show empty `bi-circle`.
- **Touch / coarse pointer:** hover not available → fallback to **tap to toggle menu**. Detect `matchMedia("(pointer: coarse)")`. On coarse, button is always visible (opacity 1) at 32px, tap toggles menu, tap outside closes.
- **Keyboard:** `Esc` closes menu (if open) before closing viewer. No tab-trap.

---

## 7. Edge cases

- **Folders:** no playlist button (only files have keys). `isDir` check guards.
- **Stale keys:** file deleted/moved → `DELETE /api/media` prunes key from all playlists (api-server). `GET /api/playlists` still returns remaining keys; playlist view may show missing files as dimmed with `File not found` and offer `Remove` (client checks `fetch` HEAD or `GET /api/media` existence optionally).
- **Duplicate names:** case-insensitive unique — server 409, UI shows inline error, input stays.
- **Long names:** truncate in menu (`textOverflow ellipsis`, `maxWidth 180`), tooltip shows full `title`.
- **Many playlists (50+):** menu scrolls (`maxHeight 220`, `overflowY auto`, custom scrollbar). Search not needed v1.
- **Many items per playlist (5000):** `GET /api/playlists` returns keys array (5000 strings ~ ~150KB worst) acceptable; playlist view paginates (show first 100 + `Show more`).
- **Flat vs non-flat keys:** canonical key is always absolute `folder/rel` — works in both modes. Menu membership check uses canonical key, not display name.
- **Concurrent writes:** file chain (`withPlaylistFile`) serializes.
- **Auth:** all playlist routes behind same password middleware.
- **No embedded `key` with `..` or `/` start:** 400.

---

## 8. File change list

| File | Change |
|------|--------|
| `.gitignore` | Add `.playlists.json` |
| `api-server.js` | Add `loadPlaylists`/`savePlaylists`/`withPlaylistFile`/`normalizePlaylistKey`/`playlistKeyForMedia`; 7 endpoints (`GET /api/playlists`, `POST /api/playlists`, `PATCH /api/playlists/:id`, `DELETE /api/playlists/:id`, `POST /api/playlists/:id/items`, `DELETE /api/playlists/:id/items`, `POST /api/playlists/:id/toggle`) + prune on `DELETE /api/media`; enrich `GET /api/playlists/:id` items with `size/mtime/created` for Media playlist view |
| `web/src/store/PlaylistsContext.jsx` | **NEW** — context + `usePlaylists()` hook, `playlistKeyForMedia` helper, refresh/create/toggle/rename/delete |
| `web/src/components/PlaylistHoverMenu.jsx` | **NEW** — hover menu: list with checkmarks, inline create, empty state (no manage link — playlists are in Media) |
| `web/src/components/FileViewer.jsx` | Right header → column; add playlist button **below close** (lowest); hover wrapper + `PlaylistHoverMenu`; derive `mediaKey` from `filePathEff` |
| `web/src/views/Media.jsx` | Import context/menu; add hover button to `renderTile` (top-right, opacity on tile hover) + list rows (hover-only before Delete); hover wrappers with `onMouseEnter/Leave`; `playlistKey(it)` helper; **render playlists like folders** — grid section `media-grid-playlists` (chips, #6366f1, `bi-collection-play-fill`) above folders + list rows `media-row-playlist` at top; inline `New playlist` inputs; `?pl=<id>` playlist view (breadcrumbs, hide folders, show playlist items with remove `×`); inline rename/delete on chips/rows |
| `plans/015-media-playlists.md` | This plan |

No changes to `web/src/main.jsx`, `web/src/App.jsx`, `scan-videos/*`, `Dockerfile`, legacy `index.html`, queue. No new route/view.

---

## 9. Implementation steps (order)

1. **Backend storage** — `api-server.js`: helpers + `.playlists.json` file handling + `.gitignore`. `node --check api-server.js`.
2. **Backend API** — 7 endpoints + prune hook in `DELETE /api/media` + enriched `GET /api/playlists/:id` (size/mtime). Smoke with `curl`:
   ```bash
   curl -X POST http://localhost:6767/api/playlists -H "x-panel-password: ..." -d '{"name":"favs"}'
   curl http://localhost:6767/api/playlists -H "x-panel-password: ..."
   curl -X POST http://localhost:6767/api/playlists/<id>/toggle -d '{"key":"boobs/a.mp4"}'
   ```
3. **Frontend context** — `web/src/store/PlaylistsContext.jsx` + wrap in `main.jsx` (`<PlaylistsProvider>` inside `<QueueProvider>` or alongside) — context only, no route change.
4. **Hover menu component** — `web/src/components/PlaylistHoverMenu.jsx` (stateless, receives `mediaKey`, `playlists`, callbacks). Story in isolation.
5. **Player integration** — `web/src/components/FileViewer.jsx`: column layout, lowest button, hover wrapper, coarse-pointer tap fallback. Wire `usePlaylists()`.
6. **Listing integration — hover add** — `web/src/views/Media.jsx`: `playlistKey` helper, `hoveredKey`/`menuKey` state, button in `renderTile` (top-right, opacity on tile hover) + list rows (hover-only before Delete), hover wrappers, same `PlaylistHoverMenu`. Touch fallback.
7. **Listing integration — playlists like folders** — `web/src/views/Media.jsx`: render `media-grid-playlists` chips (grid) + `media-row-playlist` rows (list) above folders; inline `New playlist` inputs; `?pl=<id>` playlist view (breadcrumbs `Media / <playlist>`, hide folders, show playlist items); inline rename/delete on chips/rows + item `Remove from playlist` × inside playlist view. `node --check` / `npm run build`.
8. **Build & verify** — `cd web && npm run build` (vite), hard refresh, check `GET /health`.

---

## 10. Verification

```bash
node --check api-server.js
cd web && npm run build
```

- **API:** `POST /api/playlists {name:"favs"}` → 201; duplicate ci → 409; `POST /api/playlists/:id/toggle {key:"boobs/a.mp4"}` → `member:true` then `false` on second toggle; `GET /api/playlists` shows `count`; `DELETE /api/playlists/:id` removes.
- **Player:** open any video/image in Media viewer → right header shows vertical stack `[trash] [X] [⊞]` where `[⊞]` is lowest. **Hover** on `[⊞]` → menu appears below it with playlist options + `New playlist` input. Click a playlist → checkmark appears, click again → unchecked, menu stays open. Create `my list` in the menu → new row appears checked. Move cursor away → menu closes after ~120ms. On mobile (coarse pointer) button always visible, tap toggles menu.
- **Listing — grid:** hover over any tile → small `+` button fades in at top-right. Hover that button → same menu appears anchored to tile. Checkmarks reflect membership for that file. Adding to a playlist then hovering same file again shows it checked. Adding from tile then opening same file in player shows checked there too (shared context).
- **Listing — list:** hover over any row → `+` button fades in before Delete. Hover button → menu. Same membership checks.
- **Folders:** no playlist button visible on folder tiles/rows.
- **Playlists like folders — grid:** at `/media` root (empty folder) grid shows a top section `Playlists` with chips (e.g. `favorites · 12` with `bi-collection-play-fill` #6366f1) above the `Folders` section; `+ New playlist` input/chip visible there. Creating a playlist adds a new chip. Single click selects, double-click opens playlist → grid now shows only that playlist's items (breadcrumbs `Media / favorites`), folder chips hidden, `Up` returns. Hover on playlist chip shows pencil/trash on chip hover — rename inline, delete with confirm.
- **Playlists like folders — list:** list shows playlist rows at top before folder/file rows, with `collection-play` icon, `count` in Size col, `updatedAt` in Time col. Same double-click to open, inline rename/delete on hover.
- **Playlist view:** open `favorites` (double-click) → URL has `?pl=<id>` (or `?p=`), view shows its items (flat `folder > name` labels if from different folders), still sortable/filterable by `q`; each item has hover `+` for moving to other playlists plus `× Remove from playlist` when inside the playlist. `Up` / breadcrumb `Media` clears `pl`.
- **Prune:** add `boobs/a.mp4` to a playlist → `DELETE /api/media?folder=boobs&name=a.mp4` → `GET /api/playlists` no longer contains that key.
- **No separate page:** `/playlists` does not exist; all create/rename/delete happens in `/media`. Nav unchanged (5 links).
- **Reload:** create playlist + add file → refresh browser → `GET /api/playlists` still shows it and chip persists.
- **No regressions:** `GET /api/media?flat=1` still has `thumb`/`created`; `FileViewer` end modes / delete / `y y` still works; `Media` single-select + viewer close no-scroll still works (plan 014).

---

## 11. Risks & mitigations

- **Hover on touch devices unusable** → coarse-pointer fallback to tap toggle, button always visible on touch.
- **Menu overflow near viewport edge** → menu is `right:0` below button; if near bottom, flip to `bottom:44px top:auto` (detect via `getBoundingClientRect` in menu, simple flip).
- **Many playlists → tall menu** → scroll container + max-height.
- **Stale keys after external file moves outside app** → prune only on app-initiated delete; orphaned keys remain until manually removed — acceptable v1, playlist view shows missing indicator.
- **Z-index clash (viewer 80, menu 90/95)** → set menu `zIndex:95` inside viewer, `90` in listing.

---

## 12. Change log

- 2026-09-13: Initial draft — playlists as `.playlists.json` sets of canonical media keys; 7 REST endpoints; hover menu (`PlaylistHoverMenu`) used in both player (button below Close, lowest) and listing (item-hover button), all on hover; manage page `/playlists`.
- 2026-09-13: Update per user — playlists listed **in Media page only like folders** (grid chips `media-grid-playlists` + list rows `media-row-playlist` at top, `#6366f1` icon, double-click opens `?pl=<id>` filtered view). Removed separate `Playlists.jsx`/`/playlists` route/nav; inline create/rename/delete in Media page.
