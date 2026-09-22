# 032 — Flat sorts (Name/Size/Time): keep stack color ring + stack context-menu actions, no piles

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`, `web/src/components/MediaContextMenu.jsx`).
> Date: 2026-09-22. Status: **Proposed**.
> Amends: Plan 023 (stacks gallery-only) — keeps §3.1 pile gating, revises §3.2 ring gating + §3.4 menu gating.
> No backend/API change, no list view change, no drag/reorder change.

---

## 0. Understanding check (what you asked for)

Switching the sort bar between **Gallery / Name / Size / Time**:

| Sort | Display today (023) | Display you want |
|------|---------------------|------------------|
| **Gallery** (`custom`) | Stack members collapse into one **pile cell**; member tiles carry a **stack-colored ring**; items can be added into stacks (drag-onto-pile, context menu) | Unchanged |
| **Name / Size / Time** | Every file is a **plain single tile** in sorted order — **no ring, no stack menu** | Every file is still a **plain single tile** in sorted order (no piles), **but** the tile keeps its **stack-colored ring** showing which stack it belongs to |

Plus, in Name/Size/Time:

- Items **can't be moved** (no drag-reorder — as today).
- **Right-click on an item** must offer: **Delete / Move files / Add to stack / Create stack from selection** (same file-level stack actions as Gallery). Pile-only actions (`Rename stack`, `Unstack` on a pile) stay Gallery-only because there are no pile cells to click outside Gallery.

If that table matches your intent, the implementation below is the complete scope.

---

## 1. Objective

Split Plan 023's single `stacksActive` flag into two concerns:

1. **Pile grouping** — Gallery-only (unchanged: `sort === "custom"`).
2. **Stack membership hint + file-level stack actions** — all grid sorts (new): ring + create/add/remove via context menu work in Name/Size/Time too.

Single tiles in flat sorts are display-only w.r.t. stacking: they show *where* they belong, and the menu mutates the underlying `.xdlstack` files, but the grid never collapses them into piles.

---

## 2. Current behavior (023, verified)

- `stacksActive = isGrid && !inPlaylistView && sort === "custom"` (`Media.jsx:466`).
- `gridVisible` (`Media.jsx:2161-2162`): `if (!stacksActive)` → flat file tiles. No piles in Name/Size/Time. **Keep as-is.**
- `renderTile` (`Media.jsx:1887`): `const inStack = stacksActive && ...` → **no ring** in flat sorts. **Change.**
- Context menu call site (`Media.jsx:3697`): `noStacks={!stacksActive}` → all stack sections hidden in flat sorts (`MediaContextMenu.jsx:47-82`). **Change.**
- Stacks toggle (`Media.jsx:3377`): `disabled={!stacksActive}`. Irrelevant in flat sorts (no piles to act on). **No change.**
- Custom drag-reorder + Shift+WASD manual move already gated `sort === "custom"` (`Media.jsx:1387, 1935, 3439, 3449`). **No change — satisfies "items can't be moved".**
- `openContextMenu` (`Media.jsx:2678-2704`) already derives `ctxMenuStackId` from `entry.it.stacks[0]` for file entries — works in flat sorts with no code change once the menu stops hiding those sections.

---

## 3. Desired behavior

### 3.1 Grid tiles in Name/Size/Time

- Each file tile whose `it.stacks` is non-empty renders the **same 3px stack-colored ring** (`stackBorderColor(stacks[0].id)`) as in Gallery.
- Tiles stay **single** — one tile per file, in `filtered` (sorted) order. No pile cells, no spread, no `stacksMode` effect.
- Ring color follows the existing adjacency-avoidance pass (`Media.jsx:2199-2214`), which already iterates `gridVisible` and reads `e.it.stacks[0].id` for file entries — it works on flat tiles with no change.

### 3.2 Context menu in Name/Size/Time (grid, non-playlist)

Enabled on **file tiles** and **empty-area/selection** menus:

- `Stack N items` (create from selection, `fileCount >= 2`) — enabled.
- `Stacks in this folder` grid (add-to-stack; own stacks with ✓ on top) — enabled. Picking another stack moves the file there (existing `onAddToStack` move-leave logic, `Media.jsx:3735-3763`, unchanged).
- `Remove from stack` (file-member branch, `MediaContextMenu.jsx:77-82`, driven by `ctxMenuStackId`) — enabled when the right-clicked file is a member.
- `Open`, `Create folder`, `Move files`, `Delete` — unchanged (already visible in all sorts).
- Pile-only branches (`MediaContextMenu.jsx:69-76`: `Rename stack` / `Unstack` on `isPile`) stay unreachable in flat sorts — no pile entries exist in `gridVisible`, so no UI change needed there.

### 3.3 Explicitly NOT changing

- No pile grouping in flat sorts (`gridVisible` flat branch stays).
- No drag-reorder in flat sorts; no drop-onto-pile targets in flat sorts (no piles exist — add-via-drag stays Gallery-only; add-via-menu works everywhere).
- No stacks toggle behavior change (stays disabled outside Gallery).
- No list-view change (always flat, no rings — as today).
- No backend change (`.xdlstack` CRUD unchanged; menu calls the same `POST/PATCH/DELETE /api/stacks*` paths).

---

## 4. Implementation

### 4.1 `Media.jsx` — split the flag (§2 → two flags)

Near `stacksActive` (`Media.jsx:466`), add:

```js
// Piles collapse only in Gallery. Membership hint (ring) + file-level
// stack menu are grid-wide (Gallery + Name/Size/Time).
const stacksPileActive = stacksActive; // === isGrid && !inPlaylistView && sort === "custom"
const stacksHintActive = isGrid && !inPlaylistView;
```

Keep `stacksActive` name (or alias it) to minimize diff — `gridVisible`, toggle, and pile paths keep using it. Only the two call sites below switch to the wider flag.

### 4.2 `renderTile` — ring in all grid sorts (`Media.jsx:1887`)

```js
// before
const inStack = stacksActive && !isDir && Array.isArray(it.stacks) && it.stacks.length > 0;
// after
const inStack = stacksHintActive && !isDir && Array.isArray(it.stacks) && it.stacks.length > 0;
```

The `outline` style at ~1984 keys off `stackColor` — no other change. `stackBorderColor` + adjacency pass untouched.

### 4.3 Context-menu call site — stop hiding stack sections in flat sorts (`Media.jsx:3697`)

```js
// before
noStacks={!stacksActive}
// after — hide stack UI only where stacks never apply (playlist view)
noStacks={inPlaylistView}
```

(`inPlaylistView` is in scope at the call site. If preferred, pass `noStacks={!stacksHintActive}` — equivalent.)

No change inside `MediaContextMenu.jsx` required: the `!noStacks` gates at lines 47/48/64 plus the `isPile` / `stackId` branches behave correctly once `noStacks` is false — file entries get create/add/remove, pile-only entries stay unreachable with no piles present.

### 4.4 Verify-only (no edits)

- `gridVisible` flat branch (`2161-2162`) — unchanged.
- `openContextMenu` sid derivation (`2681-2686`) — unchanged; confirm `Remove from stack` resolves via `ctxMenuStackId` for flat file entries (handlers at 3764-3786 already fall back to it).
- Drag-reorder guards (`1387, 1935, 3439, 3449`) — unchanged.
- Stacks toggle (`3377`) — unchanged.

---

## 5. File change list

| File | Change |
|------|--------|
| `web/src/views/Media.jsx` | Add `stacksHintActive` flag (§4.1); ring gating `stacksActive` → `stacksHintActive` (§4.2); `noStacks={!stacksActive}` → `noStacks={inPlaylistView}` (§4.3) |
| `web/src/components/MediaContextMenu.jsx` | No change (gates already correct once `noStacks` is false) |
| `plans/032-flat-sort-stack-rings-and-menu.md` | This plan |

Three-line diff by design. If the diff grows beyond these call sites, scope has crept — stop and re-check.

---

## 6. Implementation steps

1. Add `stacksHintActive` next to `stacksActive` (`Media.jsx:466`).
2. Switch `inStack` in `renderTile` (§4.2).
3. Switch `noStacks` at the context-menu call site (§4.3).
4. `cd web && npm run build`.
5. Manual pass (§7) + `npm run test:ui` (no regressions expected; existing 023 assertions on flat-sort *piles* still hold — only rings/menu change).

---

## 7. Verification

```bash
cd web && npm run build
cd ../ && npm run test:ui
```

Manual (same folder with a 3-file stack + 1 unstacked file):

- **Gallery:** 1 pile + ring behavior unchanged; toggle enabled; drag-reorder works; drag-onto-pile works.
- **Name sort:** 4 single tiles in name order; the 3 members each show their stack-colored ring; unstacked file shows no ring. No piles, stacks toggle disabled.
- **Size / Time sort:** same as Name, in that sort's order (asc/desc arrows respected).
- **Right-click member in Name sort:** menu shows `Stack N items`, `Stacks in this folder` (own stack ✓ on top), `Remove from stack`, plus Open/Create folder/Move/Delete. `Add to stack → other stack` moves it (ring color changes to the new stack). `Remove from stack` strips the ring.
- **Right-click unstacked files (multi-select) in Name sort:** `Stack 2 items` creates a new stack; rings appear immediately; switching to Gallery shows the new pile.
- **Gallery → Name → Gallery round-trip:** piles reform from the same members; rings match across sorts.
- **Drag in Name sort:** tiles not draggable for reorder (as today); no drop highlight on tiles.
- **Empty-area right-click in Name sort:** stack create/add sections behave as in Gallery (selection-based).
- **Playlist view / list view:** unchanged (no stack UI as today).
