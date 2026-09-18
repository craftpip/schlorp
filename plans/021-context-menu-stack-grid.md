# 021 — Media context menu: stack picker as a 3-column thumbnail grid

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`, `web/src/components/MediaContextMenu.jsx`).
> Started: 2026-09-18. Status: **PLANNED** (awaiting implementation approval).
> Scope: the "add to stack" section of the grid context menu only. No backend/API change, no pile render, no drag-drop, no playlist menu, no list view.

---

## 1. Objective

The context menu's add-to-stack section currently lists stacks as text rows (name + count).
Replace that list with a **3-column × n-row grid** where each cell shows:

- the **thumbnail of the first item** in the stack, and
- the **item count** of that stack.

Everywhat else in the menu ("Stack N items" create, Open, Delete, pile actions) is unchanged.

---

## 2. Current state (diagnosis, verified in code)

### Data shape available to the menu

- `Media.jsx:2756` passes `stacks={folderStacks}`. Stacks come from `GET /api/stacks` (`api-server.js:1472`) → `readStacksInFolder()` (`api-server.js:1435`) → each entry is `{ id, name, items: [<bare basename>, …], count }`. **No thumbnail info on stack objects.**
- The grid already knows how to render a thumbnail for any file: `thrumb(it)` (`Media.jsx:1485`) — `it.thumb` poster path (video) or self-image (photo/gif) or `/api/mediathumb` (video w/o poster) or `null` (audio/other → icon placeholder).
- `items` state holds every non-dir, non-poster file in the current folder **regardless of `?q=`/`?type=` filters** — so matching a stack's first basename against `items` survives search/type filtering (better than matching against `filtered`).

### Current menu rendering (`MediaContextMenu.jsx`)

- `own` stacks (the right-clicked/selected file already belongs) render first with a `✓ ` prefix; `rest` renders below, capped at 5 (`rest.slice(0, 5)`), separated by a `<Divider>`.
- Each row is a `<MenuItem>` with `label={name}` and a trailing count `<span>` (lines 27-41).
- Menu is `minWidth: 180`, one item per row → a 3-col grid needs a wider menu.

### Key facts that make this client-side-only

- Stack items are **sibling basenames** of the current folder (`normalizeStackItem`, `api-server.js:1390`), and `items` holds exactly those files — so `items.find(it → basename(rowKey(it)) === base)` resolves the first item with no extra I/O.
- The `<img>`-based thumbnail + icon fallback under `data-testid="media-tile-*"` is a solved pattern in `renderTile` (`Media.jsx:1565-1676`); the menu cells reuse the same `thrumb()` for `src`.

---

## 3. User spec (verbatim, 2026-09-18)

> when adding to a stack, currently we are showing list of stacks, instead of list with name it will show thumbnails of the first item from the stack and show number of items in that stack, (this changes are for the context menu), instead of list grid of 3xn will be visible.

---

## 4. Design

> Decision: all client-side. No backend change — stack `items` basenames resolve against the already-loaded `items`, and `thrumb()` already produces the right URL + icon fallback.

### 4.1 Enrich stacks in `Media.jsx` (thumb resolution)

Compute the thumbnails once when rendering the menu, from the stack's first item:

- For each stack, take `first = s.items[0]`.
- Resolve it against `items` by basename: `items.find((it) => !it.dir && String(rowKey(it)).split("/").pop() === first)` — the same basename rule pile grouping already uses.
- If found → `thumb = thrumb(matchedIt)`; else → `thumb = null` (icon placeholder).
- Pass the menu a memo (e.g. `stackMenuEntries`) of `{ id, name, count, thumb }` in place of raw `folderStacks` (`count = s.count ?? s.items?.length ?? 0`, matching the current display).

Edge: a stack's first item that is a `-poster.*` file cannot be a stack member (posters are stripped from `items` by `load()`), so matching is unaffected by the poster-hiding rule.

### 4.2 Grid rendering in `MediaContextMenu.jsx`

Make the add-to-stack section a **3-column grid** with `display: grid; gridTemplateColumns: repeat(3, 1fr); gap: 6px; padding: 6px; maxHeight` handled by the cell count:

- Grid shows `own` first (member stacks carrying the ✓ indicator), then `rest` (same ≤ 5 cap preserved). The `own`/`rest` `<Divider>` inside the section is dropped — a single grid keeps visual order own → rest.
- Each cell (`data-testid="media-ctx-add-stack"`, same as today so existing selectors keep working):
  - **Thumbnail:** `thumb` URL in an `<img>` (`objectFit: cover`) on a dark `#000` background; when `thumb` is `null` show the `bi-layers` icon placeholder (same fallback pattern as grid tiles).
  - **Count badge:** pill overlaid at the top-right with `count` (reuses the existing count value; the trailing count `<span>` moves from the row into the badge).
  - **Already a member (`own`)**: `✓` overlay at the top-left + the existing accent border — replaces the old `✓ ` text prefix.
  - **Name:** not rendered as a label (spec says thumbnail + count); kept as `title` tooltip.
  - **Disabled / click:** identical rules to today — disabled when `fileCount < 1`; click → `onClose()` + `onAddToStack(s.id, s.name)`.
- Cell sizing: ~60×48 px (fixed, `objectFit: cover`). Menu `minWidth` bumped from `180` to `3 * 60 + 2 * 6 + padding` ≈ **200** so 3 cells fit one row.

### 4.3 Untouched

- `<MenuItem>` create/Open/Delete, pile-only Rename/Unstack/Remove-from-stack, non-pile stackId Remove-from-stack.
- All behavior handlers in `Media.jsx` (`onAddToStack`, `onStack`, … signatures unchanged — only the `stacks` prop payload gains `thumb`).
- Backend, `/api/stacks`, `StacksContext`, tests (none reference these rows beyond `data-testid`).

---

## 5. Files

| File | Change |
|------|--------|
| `web/src/views/Media.jsx` | Resolve per-stack first-item thumbnails (basename match against `items` + `thrumb()`); pass enriched `stacks` (adds `thumb`) to `<MediaContextMenu>` |
| `web/src/components/MediaContextMenu.jsx` | Replace the two `own`/`rest` `<MenuItem>` lists with one 3-col grid (own first, ✓/count overlays, icon fallback, `title`=name); widen menu `minWidth` ≈ 200 |

---

## 6. Verification

- `cd web && npm run build` passes.
- Manual (right-click on a file / multi-selected files / empty area inside a folder that has stacks):
  - Stack section shows a 3×n grid, cells = first-item thumbnails + count badges, no text name rows.
  - Own/member stacks appear first with a ✓ indicator; clicking any cell still adds the selection to that stack (existing move semantics).
  - Stack whose first item matches a file → real thumb (poster/self-image or `/api/mediathumb`); stack whose first item is missing or unfiltered → `bi-layers` placeholder.
  - Hovering a cell shows the stack name tooltip; menu width fits 3 columns.
  - Rest cap ≤ 5 preserved; "Stack N items", Open, Delete, pile actions unchanged.

---

## 7. Open decisions (defaults chosen unless user objects)

1. **Stack name not shown on the tile** — only as a `title` tooltip. Spec asks for thumbnail + count only.
2. **`✓` member indicator moves from text prefix to a top-left overlay badge** (member-first ordering preserved).
3. **Rest-stack cap (5) preserved** as today; a taller grid is a possible follow-up, not part of this change.

---

## 8. Progress log

- **2026-09-18** — Diagnosed current render path (`MediaContextMenu.jsx:16-41`, `Media.jsx:2756`), confirmed stack item shape and client-side thumb resolution path (`api-server.js:1435`, `Media.jsx:1485`). Wrote this plan. Awaiting implementation approval.