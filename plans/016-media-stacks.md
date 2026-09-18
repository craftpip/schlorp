# Plan 016 — Media Stacks: Grid-only Visual Pile + Explorer Selection + Drag-Into

**Date:** 2026-09-15
**Status:** Done
**Scope:** `api-server.js` (stacks storage + API + delete prune), `web/src/views/Media.jsx` (grid pile rendering, multi-select, context menu, drag-into), new `web/src/store/StacksContext.jsx`, new `web/src/components/MediaContextMenu.jsx`. List view untouched. No download/queue/scan change. Legacy `index.html` untouched.
**Depends on:** Plan 011 (flat/sort/`rel`), Plan 012 (grid tiles), Plan 014 (key-based selection — extended to multi-select in grid only).
**User request:** Stacks group sibling files. Explorer selection: `Shift+click` range, `Ctrl+click` toggle. Select → right-click → Stack. Add to existing stack by drag. List view shows all files normally (no stack behavior). Grid view: members pile on top of each other; clicking/selecting any card spreads the stack to normal tiles.

---

## 1. Storage — stack as a sibling file

Each stack is a **file on disk** in the same folder as its members. No central store.

- **Extension:** `.xdlstack` (proposal — confirm name)
- **Location:** alongside the media files it groups. E.g. `media/reddit/trip.xdlstack` groups `reddit/*.mp4`.
- **Content:**
  ```json
  {
    "name": "trip",
    "items": ["file1.mp4", "file2.mp4", "file3.mp4"]
  }
  ```
  Bare filenames only, no paths. Sibling rule enforced by construction (all members resolve in the same directory).
- **Limits:** max 100 `.xdlstack` files per folder (409 overflow), max 5000 items per stack (400 overflow).
- **Edge files:** `.xdlstack` is never listed as a media file in `GET /api/media`. Members are listed normally and annotated with stack membership.
- **Gitignore:** add `*.xdlstack` to `.gitignore`.

---

## 2. Backend API (`api-server.js`)

### 2.1 `GET /api/media` changes

In `listMediaDir()` (`api-server.js:741-780`), after the thumb-attachment pass (ends line 778, before `return items` on line 779): scan the same directory for `*.xdlstack` files, parse each, build a membership map:

```js
// items[i].stacks = [{ id:"trip.xdlstack", name:"trip", count:3 }, ...]
```

Stack membership attached to each member item so the frontend knows which tiles belong to a pile.

- **`.xdlstack` never appears in `items`** — filter it out in both the non-flat `readdir` path and the flat `walkMediaFlat` path (line 712), plus filter in `load()` like posters (`web/src/views/Media.jsx:323` filters `-poster.*`; add the same for `.xdlstack`).
- **Flat mode matching:** stack files group bare filenames (siblings). In flat mode a member has `rel = reddit/a.mp4`; it belongs to `reddit/trip.xdlstack` if basename `a.mp4` appears in that stack's `items`. Members in different folders never share a stack (sibling rule).

### 2.2 Endpoints

All folder-scoped (same `folder` param pattern as playlists). `Content-Type: application/json`.

| Method | Path | Body | Resp |
|--------|------|------|------|
| `GET` | `/api/stacks?folder=` | — | `{ ok, folder, stacks: [{ id, name, count, updatedAt, items:[filenames] }] }` |
| `POST` | `/api/stacks` | `{ name, folder, items:[filenames] }` | `{ ok, stack }` 201. Writes `<name>.xdlstack`. 409 dup name. 400 if items include dirs, stack files, or empty. |
| `PATCH` | `/api/stacks/:id?folder=` | `{ name }` | `{ ok, stack }` — renames file. 409 if new name exists. |
| `DELETE` | `/api/stacks/:id?folder=` | — | `{ ok }` — deletes `.xdlstack` file only. Members stay in folder. |
| `POST` | `/api/stacks/:id/items?folder=` | `{ keys:[filenames] }` | `{ ok, stack, added }` — idempotent add, dups skipped. |
| `DELETE` | `/api/stacks/:id/items?folder=` | `{ keys:[filenames] }` | `{ ok, stack, removed }` — remove members (they return to being normal tiles). |

### 2.3 Delete prune

`DELETE /api/media` (existing endpoint): after unlinking the file, scan sibling `*.xdlstack` files in that folder. If the deleted filename appears in any stack's `items`, strip it and persist (best-effort, no error if save fails).

### 2.4 Helpers

```js
function parseStackFile(raw)  // JSON.parse + validate {name, items}
function normalizeStackItem(name)  // reject "..", "/", "\", empty
function stackIdFromFilename(filename)  // strip .xdlstack ext
function readStacksInFolder(dir)  // readdir *.xdlstack → parse all
```

---

## 3. Frontend — Selection model (grid only)

### 3.1 State

- `selKeys: Set<string>` (canonical `rowKey` values) — grid multi-select, in-memory.
- `anchorKey: string | null` — range start for Shift+click.
- `primaryKey: string | null` — last-clicked item; drives `?s=` URL param + viewer open. If multiple selected, primary is the last clicked (strongest highlight).
- **`primaryKey` always syncs to `?s=` URL param** (same pattern as Plan 014 single-select). The URL holds the *primary*; multi-select is in-memory only and resets on full reload (by design — consistent with Explorer: refresh collapses multi-selection).
- `gridVisible: Array<{ kind:"file"|"pile", ... }>` — the grid-only display sequence. Computed inside the grid branch from `filtered` after grouping. List view uses `filtered` untouched (never sees piles).
- List view: unchanged single-select (Plan 014, key-based `?s=` only).

### 3.2 Behaviors (grid tiles only — grid-specific click handler replaces shared `tapItem`)

Grid tiles must use their own click handler (Shift/Ctrl aware). `tapItem` (shared with list) only supports single-select, so grid replaces it. List rows keep `tapItem`/`openItem` unchanged.

| Input | Action |
|-------|--------|
| Plain click | `selKeys={clicked}`, `anchor=clicked`, `primary=clicked`. If a spread stack is active and clicked tile is outside it → collapse spread first, then select. |
| `Shift+click` | Range from `anchor` to clicked index in `gridVisible` order → `selKeys=range`. If no anchor, anchor = previous primary. Pile counts as 1 cell in range. |
| `Ctrl/Cmd+click` | Toggle clicked in/out of `selKeys`. `anchor=clicked`, `primary=clicked`. |
| `Ctrl+A` (grid focused) | `selKeys = all visible files+stacks in gridVisible` (exclude dirs v1). |
| `Esc` | `selKeys={primary}` (or clear all). Collapses any spread stack. |
| `Arrow` keys | Move primary in `gridVisible` order. Pile = 1 cell. `Shift+Arrow` extends range from anchor. |
| `Enter/Space` | Open primary (file → viewer, stack → spread, folder → enter). |
| Double-click | Set single selection → open (viewer or folder). Existing Plan 014 behavior. |

**Grid vs list dispatch:** in `renderTile` (grid) `onClick` calls grid-specific handler; in list row `onClick` calls `tapItem`. The grid handler receives the click event so it can read `e.shiftKey`/`e.metaKey`.

### 3.3 Highlight

- Tiles in `selKeys`: `outline: 2px solid var(--accent)` + `outline-offset: -2px`.
- Primary tile: `outline-width: 3px` + slightly stronger shadow.
- Selection toolbar (grid only): small bar above grid: `N selected · Stack (N items) · Delete · Clear`. Appears when `selKeys.size > 0`.

### 3.4 Touch / coarse-pointer

No Shift/Ctrl. Single-tap = select (same as desktop). Long-press = enters toggle mode (each subsequent tap toggles). Detect via `matchMedia("(pointer: coarse)")`.

---

## 4. Grid-only pile rendering

### 4.1 What a pile looks like

When 2+ files belong to the same stack, their grid tiles render in a **single cell** (one `gridTemplateColumns` slot), visually stacked:

```
┌──────────────┐  ← card 3 (top, fully visible)
│  ╱───────────╱│
│ │ ╱─────────╱ │  ← card 2 (offset 8px right, 8px down, scale 0.96)
│ │ │ ┌──────┐ │ │
│ │ │ │ file │ │ │  ← card 1 (offset 16px right, 16px down, scale 0.92)
│ │ │ │      │ │ │
│ │ │ └──────┘ │ │
│ │ └──────────┘ │
│ └──────────────┘
│ +3              │  ← badge showing hidden count (if >4 members)
└─────────────────┘
```

- Cell `aspectRatio: "16/10"` (same as normal tiles).
- Up to 4 visible cards at offsets `(0,0), (6,6), (12,12), (18,18)` px with scale `1.0, 0.97, 0.94, 0.91`.
- Remaining members: shown as `+N` badge on the top card.
- Top card: full thumbnail of the first visible member. Underneath cards: show thumbnail only via a 2px edge strip (left + bottom) to create depth.
- Stack badge: `bi-layers` + `N` count, top-left of cell, `rgba(0,0,0,.55)` + blur, same style as playlist hover button.

### 4.2 Spread state

- `spreadStackId: string | null` — which stack is currently spread (only one at a time).
- When `spreadStackId === stack.id` → members render as **normal individual tiles** in the grid, in their `filtered` order, no pile. Other stacks remain piled.
- **Spread triggers:** clicking any card in a pile, or selecting a card in a pile via keyboard.
- **Collapse triggers:** clicking outside the stack (another tile, empty area), pressing `Esc`, pressing another pile's card, changing `filtered` (search/sort/filter/type change re-collapses all).

### 4.3 Layout impact

- `gridVisible` is computed from `filtered` by grouping stack members into pile entries. The grouping runs **after `applyViewOrder()`** (sort order drives pile membership/order), **after filters/type/search** (so a filter showing only 1 member of a stack → no pile, just that member as a normal tile).
- A pile occupies **one grid cell** (one `gridTemplateColumns` slot). Spread members occupy N cells.
- `gridVisible.length` (for progress, scroll, keyboard nav) counts piles as 1 item each + non-stacked files. When spread, counts members individually.
- `selKeys` grid index derivation must account for pile vs spread: `gridVisibleIndex(it)` = position in `gridVisible` array (which includes piles as single entries or spread members).

**Computation location:** `useMemo` inside the grid render path (new, after the existing `rows`/`fileRows` useMemo). Input: `filtered` + stacks data. Output: `gridVisible` array with pile groupings and spread state resolved.

### 4.4 Stack tile click = spread

- `onClick` on a pile card (grid handler, NOT `tapItem`) → if not already spread → `setSpreadStackId(stack.id)` + `selKeys = stack member keys` (select all members) + `anchor = clicked member key`. When spread, member tiles use the normal grid select handler within the spread block.
- `onClick` on a normal tile (non-pile) while a stack is spread → collapse spread first, then handle normal selection.
- Double-click inside a spread stack member → open viewer (unchanged; viewer `viewable` already contains members since they are in `filtered`).

---

## 5. Context menu (grid only)

### 5.1 Trigger

`onContextMenu` on grid tiles (and on empty grid area). If right-clicked tile not in `selKeys` → set it as single selection (Explorer behavior), then open menu at cursor.

### 5.2 Menu (`MediaContextMenu.jsx`)

Absolute positioned, `zIndex: 100`, `var(--surface)` bg, `border-radius: 10px`, `box-shadow: var(--shadow-lg)`.

Items:
- `Stack N items` — enabled when 2+ files selected, all in same folder, no dirs/stacks in selection. Triggers name prompt → create.
- `Add to stack ▸` submenu — enabled when 1+ files selected + stacks exist in this folder. Lists stacks by name, click = add selected keys. (Touch fallback for drag.)
- Separator
- `Open` — opens primary (viewer). Same as double-click.
- `Delete` — deletes selected files (with confirm).
- Separator (if stack tile right-clicked)
- `Rename stack` — inline input → `PATCH .../rename`.
- `Unstack (keep files)` — `DELETE .../id`. Members return to normal tiles.
- `Remove from stack` — `DELETE .../id/items`. Only when right-clicking a member of a spread stack.

### 5.3 Create flow

1. Right-click → `Stack 3 items`.
2. `PromptModal`: `Name this stack` (default: `Stack <folder> <date>`). Enter/OK →
3. `POST /api/stacks { name, folder, items: selKeys }`.
4. On success: `refresh()`, pile forms immediately. Members disappear as individual tiles, stack badge appears.
5. On 409: inline error `A stack named "..." already exists in this folder`.

---

## 6. Drag into existing stack (grid only)

### 6.1 Drag source

- Every grid tile gets `draggable="true"` (except stack piles, which are not draggable — members inside a spread stack can be dragged individually).
- `onDragStart`: `dataTransfer.setData("application/x-xdl-stack", JSON.stringify([...selKeys]))`, `effectAllowed = "move"`.
- Dragging a pile card (not spread) → drag only that card's key (not the whole stack).

### 6.2 Drop target

- Pile tiles and stack-related tiles: `onDragOver` → `preventDefault` + highlight ring (`outline: 3px solid var(--accent)`).
- `onDrop`: extract keys from `dataTransfer`, `POST /api/stacks/:id/items { keys }`. Show toast `Added N (skipped M already in)`.

### 6.3 Coexistence with existing custom-sort drag (validated)

The grid container already has `onDragOver`/`onDrop` for **custom-sort reordering** (`Media.jsx:1362-1379`), gated on `dragEnabled = sort === "custom" && !inPlaylistView && !isDir && !filtersActive` (line 1097). Drop lands on the *tile*, then bubbles to the container.

- **Stack-drag wins locally:** the pile tile's own `onDragOver`/`onDrop` call `e.preventDefault()` + `e.stopPropagation()`. The container reorder handler never sees the drop event when it lands on a pile tile.
- **Custom sort still works for non-pile tiles:** drop on a normal tile bubbles to the container (no `stopPropagation` there) → reorder as today.
- **Behavior matrix:**
  - Drop on pile tile + sort says `custom` → the tile's `onDrop` (stack add) fires; container handler suppressed. Stack add takes precedence (user intent is explicit — target is a stack pile).
  - Drop on pile tile + any other sort → container handler no-ops anyway (its `dragEnabled` guard); stack add fires.
  - `dragKeys`/`dragKeyRef` (reorder machinery) must not be updated when the drop target is a pile tile — reset the drag state rather than reordering.

### 6.4 Touch fallback

No HTML5 DnD on touch. Select files → long-press or context menu → `Add to stack ▸` submenu listing stacks in the folder (same API call as desktop context menu submenu).

---

## 7. Edge cases

- **Stack in non-grid view:** members render as normal list rows (no pile, no spread, no stack badge). List view is always flat.
- **Sort/filter/type/search changes:** re-collapse all spreads. Pile order follows current sort. `q` filter showing only 1 member of a stack → pile shows just that member as a normal tile (pile of 1 = no pile).
- **Flat mode:** stacks shown as `folder/name (N)` badge in tile. Members hidden from flat list (flat mode = collapsed view). Flat grid pile same as non-flat.
- **Pile of 1 (after remove/missing):** auto-converts to normal tile (pile of 1 = no pile).
- **Missing member (deleted externally):** not shown in pile; `N` badge reflects present files. Stack view shows `File not found` dimmed + `Remove`. If all members missing → pile shows empty state `Stack empty (0 files) · Delete stack`.
- **Corrupt `.xdlstack` (bad JSON):** folder listing shows warning badge `⚠ corrupt stack` on the folder; stack file ignorable. Delete allowed.
- **Name collision (`trip.xdlstack` exists in folder):** `POST /api/stacks` → 409.
- **Cross-folder drag/drop:** blocked v1. All selected keys + target stack must be in the same folder.
- **5000-item / 100-per-folder caps:** 400 responses with message.
- **Keyboard nav across pile boundary:** pile counts as 1 cell in arrow navigation; `Enter` on pile → spread, arrows now navigate within spread members.

---

## 8. File change list

| File | Change |
|------|--------|
| `.gitignore` | Add `*.xdlstack` |
| `api-server.js` | `parseStackFile`/`readStacksInFolder`/`normalizeStackItem`; `GET /api/media` stack-annotates items; 6 stack endpoints; delete-prune hook in `DELETE /api/media` |
| `web/src/store/StacksContext.jsx` | **NEW** — per-folder stacks state, CRUD, membership helpers |
| `web/src/components/MediaContextMenu.jsx` | **NEW** — right-click context menu (stack create, add-to-stack submenu, rename/unstack/remove) |
| `web/src/views/Media.jsx` | Grid multi-select state (`selKeys`, `anchorKey`, `primaryKey`) + Shift/Ctrl handlers; pile rendering in grid (`renderPile`); `spreadStackId` state; drag-drop sources + targets; context menu wiring; selection toolbar; list view untouched |
| `plans/016-media-stacks.md` | This plan |

---

## 9. Implementation steps (order)

1. **Backend storage + API + delete prune.** `node --check api-server.js`. Curl smoke test: create stack → list → add items → remove items → rename → delete → verify prune on file delete.
2. **`StacksContext.jsx`** + provider in `main.jsx`. Fetches stacks per folder. No UI yet.
3. **Selection model (grid).** `selKeys`/`anchorKey`/`primaryKey` state + click/Shift/Ctrl/keyboard handlers in grid tiles. `Ctrl+A` and `Esc`. Toolbar `N selected` appears when selection non-empty. Verify: click → Shift range → Ctrl toggle → Esc clear. List view single-select unchanged.
4. **Context menu (`MediaContextMenu.jsx` + wiring in `Media.jsx`).** `onContextMenu` on tiles + empty area. Menu items: `Stack N`, `Open`, `Delete`, `Add to stack ▸`. Create flow: menu → PromptModal → POST → pile forms.
5. **Pile rendering (grid only).** `renderPile(stack, members)` in `renderTile` path when tile belongs to a stack pile. CSS transform offsets, badge, shadow depth. `filtered` index derivation updated for pile-as-one-cell.
6. **Spread state.** `spreadStackId` + click-to-spread + collapse rules. Verify: click pile → spread; click outside → collapse; filter change → collapse.
7. **Drag-drop (desktop) + touch submenu.** `draggable` sources, `onDragOver`/`onDrop` targets on pile tiles. `Add to stack ▸` submenu in context menu.
8. **Stack management (inside spread).** Right-click member → `Remove from stack`. Right-click pile → `Rename stack` / `Unstack`.
9. **`cd web && npm run build`** + manual passes (§10).

---

## 10. Verification

```bash
node --check api-server.js
cd web && npm run build
```

- **Grid pile:** open folder with `trip.xdlstack` containing 3 files → 1 pile cell, 3 card edges visible, badge `3`.
- **Spread:** click any card in pile → members spread to 3 normal tiles; click empty area → re-collapses.
- **Create stack:** select 3 files via Shift+click → right-click → `Stack 3 items` → enter name → pile forms, `GET /api/media` shows stack annotation.
- **Add via drag:** drag file onto pile → toast `Added 1`, pile `N` increments.
- **Add via context menu:** select file → right-click on pile → `Add to stack ▸ trip` → done.
- **Remove from stack:** spread stack → right-click member → `Remove from stack` → member returns to normal tile, pile shrinks. If pile has 1 → becomes normal tile.
- **Unstack:** right-click pile → `Unstack (keep files)` → stack file deleted, all members become normal tiles.
- **Delete prune:** `DELETE /api/media` on a member → member removed from stack on disk, pile shrinks.
- **List view:** same files, same folder → 3 normal list rows, no pile, no stack badge, no context menu stack items. Selection = single-select.
- **Flat mode:** stack shown as `folder/trip (3)`, members hidden from flat list.
- **Cross-folder select:** select files from `reddit/` and `boobs/` → right-click → `Stack N items` disabled/blocked with message.
- **Empty stack:** remove last member → pile shows `Stack empty` + `Delete stack`. Delete stack → file removed.
- **Refresh:** pile persists (stack file on disk).
- **Keyboard:** arrows move through pile as 1 cell; `Enter` spreads; arrows in spread move through members; `Esc` collapses.
- **Corrupt stack file:** manually edit `.xdlstack` to invalid JSON → folder shows `⚠ corrupt` badge, stack ignorable.

---

## 11. Validation review (2026-09-15 — refresh against current code)

Re-verified against `api-server.js` and `web/src/views/Media.jsx` (current HEAD). Confirmed points + corrections folded into the sections above:

- **`listMediaDir()`** (`api-server.js:741-779`): thumb-attachment pass ends at line 778, `return items` at 779. Stack-annotation insert goes right before the return. Non-flat `readdir` and flat `walkMediaFlat` (line 712, called at 744) both must filter `.xdlstack`. **Flat member matching is by basename within the same folder stack file** (sibling rule) — member `rel = reddit/a.mp4` ↔ stack file `reddit/trip.xdlstack` when `a.mp4` ∈ its `items`.
- **`DELETE /api/media`** (`api-server.js:1015`): `fs.unlink` at 1028, playlist prune at 1029-1045, dims prune at 1046, custom-order prune at 1055. Stack prune goes with the other prunes (strip deleted filename from sibling `.xdlstack` files, best-effort).
- **`filtered` is shared by list view, `viewable` (viewer), `allSelectable` (keyboard), and `rows`/`fileRows`.** Piles must NOT be baked into `filtered` — grouping happens in a grid-only `gridVisible` sequence (see §4.3). List/viewer/keyboard keep operating on `filtered`. Viewer already contains members (they're plain filtered items), so spread-member viewer open works with no viewer changes.
- **Grid click currently routes through shared `tapItem`** (Media.jsx:965, called from tile `onClick` at line 1108; `openItem` at 959). Grid replaces `tapItem` with a Shift/Ctrl-aware handler (see §3.2). List rows (1408, 1463) keep `tapItem`.
- **Existing custom-sort drag-drop** is wired at container level (Media.jsx:1362-1379, gated on `dragEnabled` at 1097). Coexistence solved via `stopPropagation` on pile-tile drop handlers (see §6.3).
- **`rows`/`fileRows` useMemo** (Media.jsx:956) computes pixel rows from `filtered`; in grid mode it must consume `gridVisible` instead so piles occupy one flex cell of `w×h`.
- **Writes to `.xdlstack` files reuse the existing serialized write-chain pattern** (`withPlaylistFile`/`withMediaorderFile`/`withMediadimsFile` — same shape; pick the playlist one as the closest template). Implement `withStacksFile` scoped per-folder so e.g. `reddit/` writes never serialize behind `boobs/` writes. Writes are small.
- **`PromptModal`** (`web/src/components/PromptModal.jsx`) exists — reuse for stack naming. **`ConfirmModal`** exists — reuse for stack-delete confirm. **No `MediaContextMenu`** exists — new component required (§5.2).
- **Custom sort + piles:** `applyViewOrder` mutates `filtered` order; grouping happens after it, so pile order follows the sort. Dragging to reorder *within* a spread stack is out of scope v1.
