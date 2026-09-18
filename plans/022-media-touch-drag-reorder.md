# 022 — Media page: touch gestures — tap select, long-press context menu, two-finger drag (mobile)

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`).
> Started: 2026-09-18 / revised 2026-09-18. Status: **PLANNED** (awaiting implementation approval).
> Scope: mobile-only touch gestures on the media grid — single tap selects, long-press opens the context menu, two-finger touch drags (single-item reorder). No multi-drag / multi-select drag on mobile. No backend/API change, no desktop DnD change, no list view, no playlist view.

---

## 1. Objective

On mobile devices, map the media grid touch vocabulary cleanly so no two gestures collide:

| Gesture | Action |
|---|---|
| **Single tap** | Select only (no open, no menu) — current coarse-tap grid behavior, kept |
| **Click & hold (~0.5s, stationary)** | Open the **context menu** at the press point (synthesized for iOS, unified with Android) |
| **Two-finger touch** | **Drag** the tile under the fingers to reorder (single item); release commits via `/api/mediaorder` |
| (deferred) | Multi-select on mobile — needs its own mechanism, agreed to design later |

This dissolves the previous long-press-drag design: drag no longer competes with long-press (which is the OS-standard context-menu gesture), and two-finger is unambiguous against scroll/tap/open, so no arm-timer or gesture-precedence juggling is required.

---

## 2. User spec (verbatim, 2026-09-18)

> click and hold on a item will enable it for drag, i will drag the item and leave it where i want to drop it,
> this changes is for mobile device

Revision 1 (2026-09-18):

> also few more gesttures that also to be added, lets say i want to select multiple, i will click and hold, it will select the item + make it move, now i leave the item where it was , so it remains selected and is not moved, now i select and hold another item that item also gets selected with the previously selected item, then i tap with two fingers that will open the context menu, does this conflict with anything already built ?

Revision 2 (2026-09-18) — **supersedes 022-rev1's gesture map**:

> touch and hold already is open context menu, we wil have to think something else for multiple selects,
> so it so that two finger touch does the drag, click clicks does selects only, no multiple drags on mobile,
> then click long press on item will be context menu. update the plan.

Net decisions: **long-press = context menu**, **two-finger = drag**, **tap = select only**, **no multi-drag on mobile**. Multi-select mechanism on mobile is explicitly undecided → deferred (see §4.9).

---

## 3. Current state (diagnosis, verified in code)

### Desktop reorder path (grid only)

- Gate: `dragEnabled = sort === "custom" && !inPlaylistView && !isDir && !filtersActive` (`Media.jsx:1617`). Folders never draggable; pile containers draggable via `isCustomReorder` (`Media.jsx:2229`).
- Tiles: `draggable={dragEnabled || (gridMulti && !isDir)}`, `onDragStart` sets `dragKeyRef` (single file) or `dragKeysRef` (pile block), `onDragEnd` clears + clears `dropInfo` (`Media.jsx:1632-1656`).
- Grid container (`data-testid="media-grid-files"`) owns `onDragOver` → `nearestDropInfo(container, clientX, clientY, skip)` → `setDropInfo({key, side, align})`, and `onDrop` (single file + pile-block paths, `Media.jsx:2549-2583`).
- `nearestDropInfo` (`Media.jsx:677-729`) is pure point-in-container hit-testing over `[data-filename]` elements, skipping dragged keys and inner pile cascade tiles, resolving pile containers to edge member keys. Takes `(container, px, py, skip)` — reusable from touch coordinates (the two-finger midpoint).
- Persist: `saveCustomOrder(order)` PUTs `{ folder, flat, order }` to `/api/mediaorder` (`Media.jsx:628-635`); `moveCustomKey(s)` compute the new visible sequence via `moveKeys` (`stackDrag.js:6`).
- Drop indicator: `dropInfo.key/align` renders `data-testid="media-drop-line"` on the tile (`Media.jsx:1618, 1705-1718`); piles render their own side bar (`Media.jsx:2282`).

### Selection & context menu (already the right shape)

- Coarse single tap in grid **already selects only** (no open): `gridClickHandler` coarse branch → `setSelKeys([k]); setAnchorKey(k); setSelectedKey(k)` (`Media.jsx:2052-2069`). Matches "click = select only".
- Long-press today → OS `contextmenu` / iOS selection callout. Tiles carry `onContextMenu → openContextMenu(e, entry)` (`Media.jsx:1630, 2298`); menu actions resolve against `selectedKeysForStack` (`Media.jsx:2323`). The menu itself needs **no change** — we only need to *reliably trigger* it from touch on both platforms.
- `openContextMenu(x, y, entry)` is position-agnostic (takes `clientX/clientY`) — synthesizing it from a touch point is trivial.

### Why touch needs new code

- HTML5 `draggable` + `onDragStart/Over/Drop` **does not fire from touch** — mobile has no reorder path.
- iOS never fires `contextmenu` on touch; Android fires it at ~500ms long-press → two different experiences today. To behave uniformly, we synthesize/gate the context menu ourselves on long-press.
- Two-finger touch is a pinch-zoom candidate on iOS → the drag gesture must consume it before the browser does.

---

## 4. Design

> Decision: client-side only in `Media.jsx` (+ small CSS). Reuse `nearestDropInfo`, `dropInfo` rendering, the desktop single-file `onDrop` commit block, `saveCustomOrder`, `openContextMenu`, `selectedKeysForStack`. No new API, no change to desktop handlers, `moveKeys`/`stackDrag.js` untouched.

Attach the touch controller to the grid container **only when the desktop gate holds**: `custom` sort + grid + not playlist view + no search/type filters + not a folder (`Media.jsx:1617` shape). Otherwise no interception — scroll/tap/open behave exactly as today.

### 4.1 Tap = select only

- No code needed in grid (verified: coarse tap already selects only). Just confirm no regression: a tap must **not** open the viewer, **not** open the menu, and **not** arm anything.
- Leave the follow-up long-press logic out of the tap path entirely (tap is `touchend < ~500ms` with no movement → nothing happens; the OS click/selection behavior runs as today).

### 4.2 Long-press = context menu (~500ms, stationary)

- `touchstart` on a tile/pile (native, non-passive on the grid; track `touch.identifier`): record start point/time + target. Start a **~500ms timer**.
- If the finger moves **> ~10px** or lifts **before** the timer → cancel (it was a scroll / tap). No `preventDefault` until the timer fires, so normal scrolling stays intact.
- On fire (finger still down, within slop): call `openContextMenu({ clientX, clientY }, entry)` with `entry` = the tile/pile under the finger (desktop right-click parity — menu targets the tapped item's stack context; actions act on `selectedKeysForStack`). `clientX/Y` = the recorded press point.
- Suppress the synthesized `click` that follows the release (flag) so opening the menu doesn't also change the selection (desktop right-click doesn't change selection either).
- **Uniform cross-platform `contextmenu` handling:** bind a native `contextmenu` listener on the grid. If a touch long-press is in progress → `preventDefault()` (Android's native long-press menu suppressed so ours opens once); `preventDefault()` also right after we synthesize our menu. When no touch gesture is active → pass through so **desktop right-click keeps working**.
- Haptic tick `navigator.vibrate?.(15-20)` on open where supported; silent no-op elsewhere (iOS Safari lacks it).

### 4.3 Two-finger drag = single-item reorder

No long-press arm needed — two fingers on a tile are unambiguous against every other gesture.

- **Engage:** when a second `touchstart` lands on the grid while the first touch is already down (both `touch.identifier`s tracked), and the first touch started on a file tile (not empty grid/folder) → switch to the **`drag`** gesture immediately:
  - Drag target `dk` = the tile under the **first** touch's start point.
  - `preventDefault()` the second `touchstart` (non-passive) so it can't become a pan/pinch start.
- **Drive (`touchmove`, rAF-throttled):** compute the **midpoint** of the two active touches. Hit-test `nearestDropInfo(gridEl, midX, midY, dk)` → `setDropInfo(info)` (`sameDropInfo` guard). Ghost: `transform: translate(dx, dy) scale(1.05)` on the held tile (transform doesn't perturb flex layout). Auto-scroll if the midpoint is within ~60px of the viewport top/bottom (rAF `window.scrollBy` steps; culled-in tiles re-render and become hittable).
- **Scroll + pinch lock (same mechanics validated earlier):** once engaged, `preventDefault()` a native non-passive `touchmove` listener bound on the grid — this stops page pan *and* pinch-zoom for the two-finger sequence (finger movement is what would have begun the pan/pinch; we own it from the start). **Do not** set `touch-action: none` — it is locked from the gesture origin, can't change mid-gesture, and would break one-finger scroll starting on a tile. Keep `touch-action: pan-x pan-y`.
- **Release (`touchend` of either finger, then both up):** final `nearestDropInfo` at the final midpoint, then commit exactly like desktop single-file drop (`Media.jsx:2569-2582`): `detachIfOutsideSpread([dk], info.key)` → spread-pile join check (`addStackItems` + `refreshStacksAndAnnotate`) → `moveCustomKey(dk, info.key, info.side === "after")`. No valid `info`, or `info.key === dk` → no-op.
- **No move, no-op:** two-finger touch that lifts without moving = no reorder, no menu, no selection change. It's simply a cancelled drag.
- **Selection untouched:** two-finger drag does **not** change `selKeys`/`?s=` — mobile has no multi-select drag (see §4.9). Single item moves alone.
- **Always cleanup:** clear timers/refs/flag, remove native listeners, strip ghost styles, `setDropInfo(null)`, suppress the follow-up `click`.

### 4.4 Visuals / CSS

- Dragged tile: `transform: scale(1.05) + translate(dx, dy)`, elevated shadow, `z-index` above grid, `transition: transform .12s`; drop line reuses existing `media-drop-line`.
- Grid container keeps `touch-action: pan-x pan-y`; the two-finger gesture owns scroll/pinch suppression via the native non-passive `touchmove` `preventDefault` (§4.3).
- **Mobile text-selection guard (validated):** grid tile captions are real text, so iOS would show the long-press selection callout while the context-menu timer runs. Add `user-select: none` / `-webkit-user-select: none` / `-webkit-touch-callout: none` to grid file+pile tiles (list rows already set `userSelect: "none"`).

### 4.5 Known limitation (same as desktop, non-blocker)

`contentVisibility: auto` culls offscreen layout boxes, so `nearestDropInfo` only sees in-view tiles (identical to today's mouse path). Auto-scroll brings remote targets back and re-renders them; hit-testing runs a rAF *after* each `scrollBy` step.

### 4.6 Piles on mobile (default: no pile drag)

- Long-press a pile → pile context menu (existing pile actions) — no drag.
- Two-finger drag on a pile container → **not** engaged (a pile is a group; "no multiple drags on mobile"). Only single file tiles respond to two-finger drag.
- Note: a spread pile's member tiles are single file tiles (stack members are individually draggable like any file, exactly as desktop treats inner tiles).

### 4.7 Multi-select on mobile — deferred (user decision)

The previous long-press-range-select idea is **dropped** (long-press belongs to the context menu now). Mobile multi-select needs its own mechanism and is out of scope for this plan — to be designed separately. Current desktop multi-select (Shift/Ctrl-click) and the multi-selection-aware context menu are untouched; on mobile the context menu still acts on the current (single) selection.

### 4.8 Untouched

- Desktop mouse DnD handlers, `dragKeyRef/dragKeysRef`, Shift/Ctrl-click, keyboard nav, single-select `?s=` model, stacks/piles create/rename/delete, `moveKeys` math, `/api/mediaorder` payload.
- List view, playlist view, folders (no touch interception there).
- Simple single-tap select (unchanged). Desktop `onContextMenu` fully intact (suppression only fires during touch gestures).
- Multi-select: unchanged everywhere until §4.7 lands.

---

## 5. Files

| File | Change |
|------|--------|
| `web/src/views/Media.jsx` | Touch controller on the grid container: tap passthrough, ~500ms long-press → `openContextMenu` at press point, two-finger engage → single-item drag via `moveCustomKey` + desktop single-file commit block; native non-passive `touchmove`/`touchstart(2nd touch)`/`contextmenu` listeners; click-suppression flags after menu/drag releases |
| `web/src/styles.css` (or tile inline styles) | Dragged tile class (scale, shadow, z-index); `user-select`/`-webkit-touch-callout` on grid tiles |

---

## 6. Verification

- `cd web && npm run build` passes; `npm run lint` clean.
- Manual on a real mobile device (or DevTools mobile emulation with touch):
  1. **Single tap** on a grid tile → tile selects, nothing opens, no menu.
  2. **Long-press (~0.5s, stationary)** a file tile → context menu opens at the finger (iOS + Android identical); selection unchanged; releasing does not deselect or open.
  3. **Two-finger touch on a file tile and drag** → tile lifts, drop line tracks the two-finger midpoint, near-viewport-edge auto-scrolls; release moves that **single** item and persists `/api/mediaorder` (one PUT). Selecting other tiles beforehand does NOT move them (no multi-drag).
  4. Two-finger touch that lifts without moving → nothing happens.
  5. Desktop regression: right-click still opens the context menu; mouse drag reorder unaffected; Shift/Ctrl-click multi-select unaffected.
  6. Gated cases do nothing: non-custom sort, active search/type filter, playlist view, folders, list view — tap/long-press/two-finger behave as a normal browser (scroll/select natives).
  7. Pile: long-press a pile → pile context menu; two-finger drag over a pile does not engage. Spread pile member tiles drag individually like any file.

---

## 7. Open decisions (defaults chosen unless user objects)

1. **Long-press ~500ms, move slop ~10px** — matches OS long-press feel; two-finger needs no timer at all.
2. **Two-finger drag target = tile under the first finger; movement reference = midpoint of the two touches.** Natural for "put both fingers on the item, drag away".
3. **Two-finger drag = single item only; piles not draggable on mobile** (honors "no multiple drags"). A pile-block two-finger drag can be added later if wanted.
4. **No dedicated drag handle** — the touch gesture is the handle.
5. **Multi-select on mobile deferred** (§4.7) — needs a separate design; long-press is taken by the context menu.

---

## 8. Progress log

- **2026-09-18** — Diagnosed desktop reorder path (`Media.jsx:628-650, 677-729, 1614-1656, 2549-2583`), confirmed HTML5 DnD is desktop-only and `nearestDropInfo` is touch-reusable. Wrote long-press-drag plan. Awaiting approval.
- **2026-09-18 (validation)** — Corrected scroll-lock mechanics (native non-passive `touchmove` preventDefault, not `touch-action: none`), `contextmenu` suppression must be touch-gesture-conditional, grid tiles need `user-select`/`-webkit-touch-callout` guards.
- **2026-09-18 (rev2 — supersedes gesture map)** — Per user revision: **long-press = context menu** (drop drag), **two-finger touch = drag** (drop the long-press-arm design entirely), **tap = select only** (already the grid behavior), **no multi-drag on mobile** (drag moves one item; piles not draggable). Multi-select deferred to its own design. Plan rewritten accordingly; awaiting implementation approval.
- **2026-09-18 (implemented)** — Touch controller added in `Media.jsx` (~250 lines before the grid render): native `touchstart/move/end/cancel` + `contextmenu` + capture `click` listeners on `data-testid="media-grid-files"` (new `gridFilesRef`), gated to custom-sort grid with no filters; long-press (~500ms) synthesizes `openContextMenu` at the press point (file + pile entries); second finger engages single-item drag tracked by touch midpoint, commits via the desktop single-file block (`detachIfOutsideSpread` → spread-join → `moveCustomKey`) into `/api/mediaorder`; ghost = direct-DOM transform (React-safe, no extra renders); release clicks + late native contextmenus suppressed ~600ms. `styles.css`: `user-select`/`-webkit-touch-callout`/`touch-action` guards on grid tiles. Fixed during review: effect re-attaches on `filtered.length` so first load into an empty folder binds listeners. Verified: `npm run build` ✓, `npm run lint` (no new warnings) ✓, root `npm test` 168/168 ✓. Manual on-device check (tap / long-press menu / two-finger drag / pinch passthrough / desktop regression) still to be done by the user on mobile.