# Plan 014 — Media Page: Single-Select (1-click select / 2-click open) + Stable Selection & Scroll

**Date:** 2026-09-12
**Status:** Implemented 2026-09-12 (`web/src/views/Media.jsx`, `web/src/components/FileViewer.jsx`; `web/dist` rebuilt). Manual UI passes in §6 still to be confirmed by user.
**Decisions (locked 2026-09-12):** arrow-key moves auto-scroll to follow highlight; fresh folder defaults to first item; mobile/touch keeps single-tap open (coarse-pointer exception); viewer is key-based.
**Scope:** `web/src/views/Media.jsx` (primary), `web/src/components/FileViewer.jsx` (small delete-callback change). No backend change. Legacy `index.html` untouched.
**Depends on:** Plan 011 (flatten/sort/filters/player), Plan 012 (grid tiles, `thumb`).

## 1. How selection works today (review)

Source: `web/src/views/Media.jsx` (~528 lines), `web/src/components/FileViewer.jsx`.

- **Source of truth is split three ways:**
  1. `selectedIdx` (number, index into `filtered`, default `0`) — drives `data-selected` highlight.
  2. `?sel=<rowKey>` URL param (`rowKey = rel` in flat mode, else `name`) — synced both directions via three `useEffect`s (lines ~179–231).
  3. Direct DOM highlighting via `persistHighlightMedia()` / `scrollAndHighlight()` — sets `el.style.background` + `data-highlighted` imperatively, bypassing React.
- **Single click OPENS today.** List row `onClick` (line ~447) and grid tile `onClick` (line ~337) do `setSelectedIdx(fi); if dir goFolder() else openViewer()`. Inner name buttons `stopPropagation` + open directly. There is no select-only click.
- **Viewer open** sets `viewerIdx` (index into `viewable` = non-dir `filtered`) + `?sel=<key>` (lines ~314–318, 380–387). Navigating inside the viewer (`onPrev/Next/Goto`) re-sets `?sel`.
- **Viewer close** (`handleClose`, lines ~490–506): stores `lastViewedNameRef`, sets `?sel=<keyName captured at render>`, `setViewerIdx(null)`, then `setTimeout(80ms)` finds `[data-selected=true]` / `#media-file-<key>` and calls `scrollIntoView({smooth, center})` + imperative highlight.
- **Go-up** (`goUp`, lines ~273–282): pops last path segment, stashes `selectAfterLoadRef.current = cameFrom`, navigates. `load()` (lines ~149–168) consumes it: finds matching item and `setSelectedIdx(idx)`, else **resets to `0`**.
- **Refresh / load** (`load()`): after fetch, filters posters, `setRatios({})`, then either restores `selectAfterLoadRef` target or `setSelectedIdx(0)`. A separate `selKey` effect (lines ~179–194) then maps `?sel` → `selectedIdx` if the key still exists, else clears `?sel`.
- **Scroll** (lines ~226–231): `useEffect([selectedIdx, viewerIdx])` — whenever `viewerIdx == null`, scrolls `[data-selected=true]` into view (`smooth, nearest`). So it scrolls on **every** selection change (arrows, clicks, close, delete-reload), not just fresh loads. A `suppressScrollRef` hack skips one case (same `selKey`, different index).
- **Keyboard** (lines ~233–266): arrows/WASD move `selectedIdx`, `Right/Enter/Space` opens, `g/f/t` toggle view/flat/type, `Left` goes up.

### The reported delete bug (why it jumps to top and back)

`FileViewer.doDeleteFile` → `DELETE /api/media` → `onDeleted()` → parent `load(folder)`:

1. `load()` has no pending-select target for deletes, so it does `setSelectedIdx(0)` → highlight jumps to the **top** row.
2. Viewer itself stays open at the same numeric `viewerIdx` (next file slid into that index) — correct intent, wrong selection underneath.
3. On quit, `handleClose` uses the re-rendered `viewable[viewerIdx]` key (the next file), sets `?sel`, scrolls to it — so the page visibly jumps **top → next selection**. The extra scroll comes from the scroll-on-every-`selectedIdx`-change effect firing for step 1 and the close-time `scrollAndHighlight` for step 3.

Root causes: **index-based selection** (fragile across reload/filter/delete) + **scroll on every selection change** + **delete path doesn't preserve a pending key**.

## 2. Goal

1. **1 click = select only. 2 clicks (double-click) = open** file or folder. Applies to list rows AND grid tiles.
2. **Single-select only.** No multi-select, no checkboxes, no shift/ctrl ranges.
3. **Quit viewer → previous selection kept.** Opening + closing the viewer must not move selection; the file that was selected before opening stays selected after close.
4. **Go up → the directory we came from is selected** by default.
5. **Refresh → scroll back to the selection, but ONLY on fresh content load.** Quitting the viewer must NOT scroll.
6. **Delete-in-viewer fix:** deleting the viewed image then quitting keeps selection on the next image with no top-jump; viewer just closes.

Out of scope: multi-select, rename, drag-reorder, server pagination/virtualization, touch double-tap tuning beyond default `onDoubleClick`.

## 3. Design — key-based single selection, no scroll except fresh load

### 3.1 Selection state: key, not index

- Make `?sel=<rowKey>` the single source of truth (it already survives refresh and is shareable).
- Replace `selectedIdx` as state with a **derived value**: `selectedIdx = filtered.findIndex(it => rowKey(it) === selKey)` (memo). All highlight (`data-selected`), keyboard, and scroll logic read this.
- `setSelectedKey(key)` = `setParam("sel", key)` (replace, no push). Clearing = delete param.
- Index-only helpers (`selectAfterLoadRef`, `syncedSelRef`, `lastViewedNameRef`, `lastHighlightedMediaRef`, `persistHighlightMedia`, `suppressScrollRef`, `prevSelKeyRef`) are deleted. No more imperative `el.style.background` — highlight is purely `data-selected` + existing CSS/background rule.
- `rowKey`/`sanitizeKey`/`displayName` stay as-is.

### 3.2 Click model (list + grid)

- Row/tile `onClick` → **select only**: `setSelectedKey(rowKey(it))`. No navigation, no viewer.
- Row/tile `onDoubleClick` → **open**: `it.dir ? goFolder(it.name) : openViewer(it)` (also re-asserts selection first).
- Inner buttons today (`media-row-open-folder`, `media-row-open-file`, `media-row-action-open`) currently open on single click with `stopPropagation`. Change to: single click = select (stopPropagation + set key); opening a folder/file from buttons requires double-click too — simplest consistent rule is **remove the separate open buttons' single-click open** and let row-level `onClick/onDoubleClick` own the behavior; keep Delete button single-click (destructive action, needs confirm, must `stopPropagation` so it never selects-then-opens).
- Keyboard unchanged in spirit: arrows move selection (set key of neighbour in `filtered`), `Enter/Space/Right` opens selected, `Left` goes up. Operates on derived index so it survives filtering.
- Accessibility: rows/tiles get `tabIndex={0}`, `onKeyDown Enter/Space → open` optional; `onDoubleClick` still the mouse path.

### 3.3 Viewer open/close no longer moves selection or scrolls

- `openViewer(it)`: assert `?sel = rowKey(it)` (it is already the selected key after 1-click; double-click handler sets it first), then `setViewerIdx(viewableIndex)`. Navigating inside viewer (`goViewer`) keeps updating `?sel` to the viewed key — this IS the selection tracking while browsing.
- `handleClose`: **only** `setViewerIdx(null)`. No `setParam`, no `setTimeout`, no `scrollIntoView`, no imperative highlight. Selection already equals the last-viewed key via the `goViewer` sync, satisfying "file selected before stays selected".
- Delete the `scrollAndHighlight` closure and the `setTimeout(80ms)` block.
- `popstate` (browser back closes viewer) path calls the same `handleClose` — also no scroll.

### 3.4 Go-up restores the came-from directory

- Keep the existing mechanism but as a **key**: `goUp()` sets `pendingSelectRef.current = cameFrom` (dir name; `rowKey` for dirs in non-flat mode is `name`, so it matches). `load()` consumes it: if the key exists in fresh items, `setSelectedKey(key)`; else fall back to `?sel` if still present, else select first item (decided 2026-09-12: fresh folder defaults to first item; empty folder = no selection).
- Same treatment for `goCrumb` / `goFolder` entry: entering a folder keeps `?sel` if it names an item in the new folder, else selects the first item (decided 2026-09-12).

### 3.5 Scroll ONLY on fresh content load

- Delete the `useEffect([selectedIdx, viewerIdx])` scroll-on-every-change.
- New rule: a `freshLoadRef` flag set `true` at the start of `load(folder)` (and on `folder/isFlat` change), consumed once after items render:
  ```jsx
  // after items committed and selectedIdx derived:
  useEffect(() => {
    if (!freshLoadRef.current || loading || !filtered.length) return;
    freshLoadRef.current = false;
    const el = document.querySelector('[data-selected="true"]');
    if (el) el.scrollIntoView({ behavior: "auto", block: "nearest" }); // or "center"
  }, [items, loading]);
  ```
- Refresh (`F5` / Refresh button / `load(folder)`): `?sel` persists in URL → derived index restores → single scroll to it. Viewer quit, single/double-click: no scroll. Arrow-key moves DO scroll (`block: "nearest"`) to follow the highlight (decided 2026-09-12) via an armed-flag consumed once per keypress.
- `behavior`: use `"auto"` (instant) for fresh-load restore, not `"smooth"`, so refresh lands immediately.

### 3.6 Delete paths (the reported bug)

**Delete inside viewer** (`FileViewer.doDeleteFile` + `Media.onDeleted`):
- Today `onDeleted(filePath)` triggers a blind `load(folder)` which resets selection to 0.
- New: viewer becomes **key-based** (decided 2026-09-12): it tracks the viewed file key, not a numeric index, so delete/reload can't show a stale file. Before reloading, parent computes the **next key**: change `FileViewer` to call `onDeleted({ deletedKey })` and parent computes `nextKey = viewable[viewerIdx + 1] ?? viewable[viewerIdx - 1] ?? null` BEFORE reload, sets `pendingSelectRef.current = nextKey`, and adjusts `viewerIdx`:
  - deleted last item → `setViewerIdx(idx - 1)` (viewer shows previous),
  - else stay at same `idx` (next file slides in),
  - deleted the only item → `handleClose()` (viewer closes, selection cleared).
- `load()` then restores `pendingSelectRef` instead of index 0 → **no top-jump**. Viewer never closes on delete (except single-item case), and quitting later does not scroll (§3.3).

**Delete in list view** (`delFile`): same `pendingSelectRef` treatment — select neighbour (`next ?? prev ?? none`) after reload instead of falling back to index 0.

## 4. Implementation steps

1. `Media.jsx` — selection core:
   - Derive `selKey`/`selectedIdx` from `searchParams`; add `setSelectedKey`; remove `selectedIdx` state + the 3 sync effects + `suppressScrollRef`/`syncedSelRef`/`selectAfterLoadRef`(→`pendingSelectRef`)/`lastViewed*`/`persistHighlightMedia`.
   - `load()`: set `freshLoadRef.current = true` at start; on success apply `pendingSelectRef` → existing `?sel` → (folder-entry default) instead of `setSelectedIdx(0)`.
   - Replace scroll effect with fresh-load-only effect (§3.5).
2. `Media.jsx` — clicks: rows + tiles `onClick=select`, `onDoubleClick=open`; inner open buttons → select-or-remove; keep Delete single-click + `stopPropagation`; add `tabIndex` + `title` hint ("Double-click to open").
3. `Media.jsx` — viewer wiring: `openViewer`/`goViewer` assert sel; `handleClose` = close only (delete scroll/highlight block); keyboard effect reads derived index.
4. `Media.jsx` + `FileViewer.jsx` — delete: parent-computed `nextKey` + `pendingSelectRef`; viewer-index adjust; single-item → close. `onDeleted` signature change (1 call site).
5. `goUp`/`goCrumb`/`goFolder` use `pendingSelectRef` (came-from name for up; none for others).
6. Rebuild: `cd web && npm run build` (dist is served live). `npm run lint`, `node --check` unaffected (no server change).
7. Manual passes (§6), incl. the exact delete-in-viewer repro.

## 5. Edge cases

- **Double-click also fires two `click` events** → selection sets twice to the same key (idempotent), then open. No toggle, no harm.
- **Single click on already-selected file** → no-op (same key), no open, no scroll.
- **Filter/sort/type/flat changes**: `filtered` reorder → derived index follows the key; if key filtered out, highlight disappears but `?sel` stays (restores when filter cleared). No scroll (not a fresh load).
- **Flat mode**: keys are `rel` paths; delete-next computation identical.
- **Missing key after refresh** (file deleted externally): clear `?sel`, select nothing, no scroll.
- **Empty folder**: no selection, empty-state message, no scroll.
- **Dirs in flat mode**: none listed (flat walks files only) — unaffected.
- **Touch devices (decided 2026-09-12: mobile exception)**: single tap OPENS on touch/small screens (coarse pointer), select-only applies to desktop mouse. Detect via `matchMedia("(pointer: coarse)")` or touch events; single-tap open preserves current mobile UX.
- **Existing `?sel` deep links / tests** referencing `data-selected`/`data-filename` keep working — attributes unchanged.

## 6. Verification

- [ ] Single click row/tile → highlight moves, nothing opens, URL `?sel` updates, no scroll jump.
- [ ] Double-click file → viewer opens that file; quit (`x`/backdrop/Esc) → viewer closes, same file still highlighted, **no scroll**.
- [ ] Double-click folder (or Enter) → enters; Up/Left → back in parent with the came-from folder highlighted.
- [ ] Refresh with selection deep in list → after load, view scrolls once to the highlighted row; arrow-key moves scroll to follow highlight (`nearest`); viewer quit never scrolls.
- [ ] **Delete repro:** open viewer on image N of M, delete (trash/`y y`) → viewer now shows N+1 without closing, list behind shows N+1 selected, no top-jump; quit viewer → N+1 still selected, no scroll. Delete last image → viewer shows previous; delete only image → viewer closes, empty state.
- [ ] List-view delete → neighbour selected after reload.
- [ ] Keyboard: arrows move single highlight; Enter opens; `g/f/t` still toggle.
- [ ] Grid tiles behave identically to list rows.
- [ ] `cd web && npm run lint` clean; `npm run build` regenerates `dist`.

## 7. Risks

- Users trained on single-click-open will double-click by habit for a while → mitigate with `title` tooltips + one-line hint in toolbar ("Click to select · double-click to open").
- `onDoubleClick` + text selection: rapid double-click may select label text — cosmetic; `user-select:none` on rows already largely covers it.
- Removing the close-time scroll may strand selection off-screen after heavy viewer browsing (e.g. advanced 50 files with Shuffle) → acceptable per requirement ("should not scroll each time I quit the viewer"); user scrolls or a future "reveal selection" shortcut can be added.
