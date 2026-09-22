# 029 — Playlist: stack badge + expand in place (same pile logic as folders)

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`).
> Date: 2026-09-21. Status: **Plan only**.
> Scope: playlist (saved list) grid view shows only added files, badges stack members, expands a stack in place using the existing folder pile machinery. List view stays flat. Playlist grid reorder moves by tile unit (whole stack moves together). No download/queue/scan change.

---

## 1. Objective

Playlists (`.playlists.json`, "saved lists") and stacks (`.xdlstack` piles) are disconnected today:

* playlist item = `{key: "folder/file.mp4"}` flat ref (`web/src/store/PlaylistsContext.jsx:66-76`).
* stacks are per-folder, grid-only, explicitly disabled in playlist view (`Media.jsx:340`: `folderStacks = isGrid && !inPlaylistView ? ... : []`, `Media.jsx:1991-1993`: playlist `gridVisible` returns flat files).

Goal: in playlist grid view, a tile that belongs to a stack shows a stack badge; clicking it replaces that tile slot with the full source stack (same pile open/close/spread/animation as folder view). Only added files are ever listed — expansion is on-demand, per-tile, local state.

Agreed decisions (user-confirmed):
1. Same-folder members only; show all N members on expand (1 stack max per file, as designed today).
2. Members already in the playlist keep saved-icon highlighted (as today); other members show plain + one-tap add via existing `PlaylistHoverMenu` toggle.
3. List view stays flat (no badges, no expansion).
4. Grid reorder: playlist custom-order drag moves by tile unit; expanded/collapsed stack moves as one block. Member order inside expansion = folder view `filtered` order (custom order if set, else latest-first), not a second playlist-local stack order.

## 2. Desired behavior (source of truth)

* Playlist grid tile whose `key` belongs to a source-folder stack renders a `bi-stack + N` badge (same visual language as folder piles).
* Click badge (or pile Open action) → that slot expands in place: collapsed tile unmounts, N member tiles mount in `filtered` folder order. Non-members dimmed + `not in list` hint. Saved members show playlist check.
* Collapse (Escape / badge toggle / navigate away) returns to single tile. Expansion state is per-tile local (`expandedPlaylistStackKey`), never persisted; only explicit adds mutate `.playlists.json`.
* Single-file add path unchanged (`PlaylistHoverMenu.jsx:18-29` toggle). Grouping is never automatic — no phantom files.
* Dangle-safe: stack renamed/deleted/dissolved to ≤1 member → badge disappears, tile behaves as plain file. No stored `stackId` refs in playlists.
* Reorder (new): playlist grid `sort=custom` drag moves tile units. Collapsed stack-member tile drags its whole future block; expanded block drags as one block via existing `dragKeysRef` whole-block path (`Media.jsx:152-153,1807`). Drop commits playlist order (see §3.3). Filters/search disable drag (same `filtersActive` gate as folders).

## 3. Implementation

### 3.1 Resolve stacks for playlist items (client join, no backend change)

Today `refreshStacks(folder)` runs only when `!inPlaylistView` (`Media.jsx:458-460`). Playlist items carry no `it.stacks` (detail endpoint enriches `missing` only, `api-server.js:1424-1428`).

* On playlist view, collect distinct source folders from `playlistDetail.items` keys (`key.split("/").slice(0,-1)`), call `refresh()` / `stacksForFolderAll(sourceFolder)` for each (reuse `StacksContext.jsx:14-30,87-89` per-folder cache).
* Build `playlistStackOf: Map<playlistKey, {id,name,count,members}>` by matching each playlist key's basename against source-folder stack `items[]`. First match wins (1-stack invariant).
* Feed into the existing `gridVisible` pile path instead of the flat early-return at `Media.jsx:1991-1993`: count visible members per stack id from the joined map, group 2+ into `{kind:"pile"}` with `members` in folder `filtered` order (same loop as `Media.jsx:2000-2028`), spread via existing `spreadStackId` / `stacksMode` / `closingSpreadId` state. Reuse pile cell, `capturePileRect`, roll-out/roll-in animation untouched.

No new pile component, no parallel spread state.

### 3.2 Badge + expand/collapse (playlist grid only)

* `renderTile` (playlist branch): if `playlistStackOf.has(key)`, render stack badge; click → set expanded key (and `capturePileRect` for animation continuity, same as folder pile click).
* Expanded rendering: same spread branch as folders (`Media.jsx:2016-2018`) — member tiles with `inPlaylist` prop driving saved-icon highlight vs dimmed `not in list` + add button (`toggleItem`).
* Guards: `isGrid && inPlaylistView && sort === "custom"` only (mirrors `stacksActive`, Plan 023). List view, Name/Size/Time sorts: no badges, no expansion.

### 3.3 Playlist reorder (new persistence)

Today playlist order = `items[]` insertion order (`applyViewOrder` returns `base` as-is for playlists, `Media.jsx:491-494`; drag gated `!inPlaylistView`, `Media.jsx:662,1771`).

* Server: add `PUT /api/playlists/:id/order {order:[key]}` — validates keys ⊆ existing items (same key hygiene as `POST :id/items`), rewrites `items[]` order, bumps `updatedAt`, reuses `withPlaylistFile` chain (`api-server.js:1363-1413`). Prune paths (delete/move) keep working since they key off values, not positions.
* Client: enable existing `moveKeys`/`saveCustomOrder` drag path for `inPlaylistView` grid-custom, with drag unit = tile (`stack:key` collapsed or expanded member block). Commit via new endpoint, optimistic update + `refreshPlaylists`.
* Stack member order inside expansion is NOT playlist-ordered — always folder `filtered` order (§2). Only top-level playlist tile sequence is reorderable.

## 4. File change list

| File | Change |
|------|--------|
| `web/src/views/Media.jsx` | playlist stacks join (§3.1); `gridVisible` playlist branch groups piles via same machinery; badge + expand/collapse; enable drag-reorder for playlist grid-custom |
| `api-server.js` | `PUT /api/playlists/:id/order` (reorder persistence) |
| `web/src/store/PlaylistsContext.jsx` | `reorderItems(id, order)` client for new endpoint |
| `test/` | playlist order endpoint + `moveKeys` block-move unit tests (existing `node --test` suite, no live browser) |
| `plans/029-playlist-stack-expansion.md` | This plan |

No `.xdlstack` format change, no `.playlists.json` item schema change (still `{key, addedAt}`), no scan/queue/sync change.

## 5. Implementation steps

1. Server: `PUT /api/playlists/:id/order` + tests.
2. Client join: source-folder stack resolution for playlist items.
3. `gridVisible`: route playlist grid-custom through pile grouping (reuse folder path).
4. Badge + expand/collapse + saved-highlight/dimmed states.
5. Playlist grid drag-reorder by tile unit → new order endpoint.
6. `cd web && npm run build`, `npm run lint`, `npm test` / `npm run test:all`.

## 6. Verification

```bash
npm test
cd web && npm run build && npm run lint
```

Manual:
* Playlist with 1 member of a 5-stack → tile shows badge, list shows 1 item only.
* Click badge → slot expands to 5 in folder order; saved member(s) checked, others dimmed with working add-toggle; collapse restores single tile.
* Stack renamed/deleted in source folder → playlist badge disappears, no errors.
* Drag collapsed tile → whole stack block moves; order persists after reload.
* List view: flat rows, no badges. Name/Size/Time sorts: no piles.
