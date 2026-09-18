# 023 — Media page: stacks are a Gallery-only feature (no piles in Name/Size/Time sort)

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`, `web/src/components/MediaContextMenu.jsx`).
> Date: 2026-09-18. Status: **Done**.
> Scope: make the stacks UI (pile cells, stack-colored rings, stacks-mode toggle, stack context-menu sections) appear **only when sorting is Gallery** (`sort=custom`). Name / Size / Time sorts render every file as a plain tile in its sort order — no stacks UI at all. No backend/API change, no list view change.

---

## 1. Objective

Today the grid renders stack members as a single **pile cell** regardless of which sort is active (`gridVisible`, `Media.jsx:1826-1861`, groups piles unconditionally). Piles, the stack-colored outline on member tiles, and the stacks-mode toggle therefore appear in Name/Size/Time sorts too, which is unexpected: sorting by name/size/time should show the files **as they are, one per tile, in that sorted order** — stacks are a Gallery (manual-order) display concept.

| Sort | Grid display |
|------|-------------|
| **Gallery** (`custom` — default) | As today: 2+ visible members of a stack collapse into one pile cell; stack rings + stacks-mode toggle shown; spread / open / locked modes active |
| **Name / Size / Time** | Every file is a **plain tile** in sorted order; no piles, no stack rings, no stacks-mode toggle, no stack context-menu sections |

## 2. Desired behavior (source of truth: one flag)

Introduce a single computed flag that means "stacks UI is active on this screen":

```js
// Stacks are a Gallery-sort feature. Name/Size/Time sorts show files flat.
const stacksActive = isGrid && !inPlaylistView && sort === "custom";
```

All stack UI gating in §3 keys off this one flag. List view already shows files flat (stack behavior is grid-only per Plan 016) and already renders no piles; it is untouched.

## 3. Implementation

### 3.1 `gridVisible` — no piles outside Gallery (`Media.jsx:1826-1861`)

In the `gridVisible` useMemo, after the `inPlaylistView` early return and before the existing pile-grouping loop, emit every file as a plain tile when `sort !== "custom"`:

```js
const files = filtered.filter((it) => !it.dir);
if (sort !== "custom") {
  return files.map((it) => ({ kind: "file", it, key: rowKey(it), w: 0, h: GRID_TARGET_H }));
}
```

- Add `sort` to the memo's dep array (currently `[isGrid, gridW, filtered, inPlaylistView, spreadStackId, closingSpreadId, stacksMode, folderStacks]`, line 1861).
- Files are emitted in `filtered` order (already the sorted order chosen by `applyViewOrder`, `Media.jsx:433-489`) — this satisfies "display the files as it is in their order".
- A stack with only 1 visible member already renders as a normal tile today; this branch makes that true for all stacks when sort is non-custom.

### 3.2 Member tiles — no stack-colored ring outside Gallery (`renderTile`, `Media.jsx:1581-1582` and 1657)

`renderTile` currently outlines any stack member with its stack color:

```js
const inStack = !isDir && Array.isArray(it.stacks) && it.stacks.length > 0;
```

Gate it so members are invisible members in non-custom sort (they still belong to the stack, but show no stack UI):

```js
const inStack = stacksActive && !isDir && Array.isArray(it.stacks) && it.stacks.length > 0;
```

The `outline` style at line 1657 keys off `stackColor`/`highlight` and needs no other change — with `inStack` false, `stackColor` is null and the tile renders like any normal file tile.

### 3.3 Stacks-mode toggle button hidden outside Gallery (`Media.jsx:2493-2495`)

The `media-stacks-toggle` button currently shows whenever `isGrid && !inPlaylistView`. Add the flag:

```js
{isGrid && !inPlaylistView && stacksActive && ( ... )}
```

Its state (`stacksMode`) is left untouched in non-custom sort — it is simply inert (no piles to act on) and is restored when the user returns to Gallery, preserving their stacked/open/locked preference.

### 3.4 Context menu stack sections — scope decision (recommended: hide outside Gallery)

The context menu (`MediaContextMenu.jsx`) shows stack actions (`Stack N items`, the add-to-stack grid, `Rename/Unstack/Remove from stack`) whenever a folder has stacks. Two options:

- **A (recommended):** hide all stack sections outside Gallery — pass `stacksActive` (or a `noStacks` prop) into `MediaContextMenu` and skip rendering sections at `MediaContextMenu.jsx:25-51`. Consistent with "stacks are only for gallery view": no stack UI anywhere outside Gallery.
- **B (minimal):** only gate the *pile-related* entries (`Rename stack` / `Unstack` on a pile at lines 43-45, which are unreachable outside Gallery anyway since no pile cells exist) and keep creation/add for all sorts.

Default to **A** unless the user says otherwise. This is the only scope point that affects the backend-managed stack data itself — it only hides UI, never deletes or prevents stacks from existing.

## 4. Already-gated / inert paths (no changes — verified against current code)

These consume `gridVisible` / `keyPileMap` and become no-ops automatically once `gridVisible` stops producing piles:

- **Grid click handler** (`Media.jsx:2052-2142`) — `isPile` branches unreachable.
- **Keyboard nav** (`Media.jsx:910-922, 968-986, 1183-1200`) — pile entries absent from `gridVisible`; `data-testid="media-tile-pile"` nodes never exist; `keyPileMap` (`Media.jsx:1899-1906`) is empty so Enter-to-spread never fires.
- **Custom drag/reorder** (`Media.jsx:1617, 2549-2582`) — already gated `sort === "custom"`; unaffected. `dragEnabled` already requires `sort === "custom"`.
- **Shift+WASD manual move** (`Media.jsx:1161`) — already returns unless `sort === "custom"`.
- **Roll-out/roll-in animation** (`Media.jsx:1957-2050`) — `spreadVisualOrder`/`closingVisualOrder` only collect members of a spread stack found in `gridVisible`; with no piles and spread cleared on sort change they are empty.
- **Spread/reset on sort change** — existing effect (`Media.jsx:424-429`, deps include `sort`) already resets `selKeys`/`anchorKey`/`spreadStackId` when the sort changes, and the `?spread=` sync (lines 398-416) drops the URL param with it. Edge case: a deep link like `?sort=name&spread=trip` restores `spreadStackId` from the URL (`Media.jsx:307`) but it is inert — pile groupings are gated off; it self-clears on the next sort change. Optionally also clear it in the reset effect, but not required for the behavior.

## 5. File change list

| File | Change |
|------|--------|
| `web/src/views/Media.jsx` | Add `stacksActive` flag; gate `gridVisible` pile grouping on `sort === "custom"` (add `sort` to deps); gate `inStack` ring in `renderTile`; gate `media-stacks-toggle` render |
| `web/src/components/MediaContextMenu.jsx` | *(if §3.4 option A)* accept `noStacks` prop and skip stack sections |
| `web/src/views/Media.jsx` (context-menu call site ~2790) | *(if §3.4 option A)* pass `noStacks={!stacksActive}` |
| `plans/023-stacks-gallery-only.md` | This plan |

## 6. Implementation steps

1. Add `stacksActive` flag (near `pilesLocked`, `Media.jsx:392`, or after `filtersActive` at 496).
2. Gate `gridVisible` (§3.1) + add `sort` to its deps.
3. Gate `inStack` in `renderTile` (§3.2).
4. Gate the stacks toggle button (§3.3).
5. Decision §3.4: gate context-menu stack sections (option A or B).
6. `cd web && npm run build` + manual pass (§7).

## 7. Verification

```bash
cd web && npm run build
cd ../ && npm run test:ui   # existing Vitest suite — no regressions/collisions with new gating
```

Manual:
- **Gallery sort (default):** make a stack of 3 files → 1 pile cell, ring on members, stacks toggle visible, context-menu stack sections visible. Unchanged from today.
- **Name sort on same folder:** 3 separate tiles in name order, no pile, no rings, no stacks toggle, no stack items in any tile's context menu. Empty-area context menu also shows no stack sections.
- **Size / Time sort:** same as Name — flat tiles in that sort's order (respecting asc/desc arrows).
- **Switch Name → Gallery:** piles instantly reform from the same members.
- **Switch Gallery → Name while a stack is spread / `stacksMode` = open:** pile collapses to flat tiles; `?spread=` param removed; returning to Gallery restores the prior mode.
- **Drag reorder:** still works in Gallery only; dragging is disabled (as today) in Name/Size/Time.
- **Keyboard:** arrows/pg-nav move through plain tiles only in Name/Size/Time; `Enter` on a former member opens the viewer (no spread).