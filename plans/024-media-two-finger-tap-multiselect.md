# 024 — Media page: two-finger tap toggles multi-selection (mobile)

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`).
> Started: 2026-09-19. Status: **IMPLEMENTED** (Media.jsx).
> Scope: mobile-only touch gesture — a **two-finger tap** adds an item to the selection or removes it, mirroring desktop Ctrl+click. Builds on plan 022's touch controller. No backend/API change, no desktop DnD change, no list view, no grid sort-model change.

---

## 1. Objective

Extend the media-grid touch vocabulary so multi-select is reachable on mobile:

| Gesture | Action |
|---|---|
| **Single tap** | Select only (unchanged) |
| **Long-press (~0.5s, stationary)** | Open the context menu at the press point (unchanged) |
| **Two-finger tap (NEW)** | **Toggle** the item in/out of the selection (add or remove) — desktop Ctrl+click parity |
| **Two-finger drag** (Gallery/custom sort only) | Reorder the single item (unchanged) — must disambiguate the *static* two-finger touch (today a silent no-op) into the tap above |

The selection made this way feeds the same multi-selection UI and batch actions as desktop multi-select (context-menu actions on `selectedKeysForStack`, batch delete, keyboard `x`, etc.) — no new surface, just a mobile entry point.

---

## 2. User spec (verbatim, 2026-09-19)

> in the media page add mobile gesture of two finger tap to add items to selection and remove from selection

Deferred / out of scope until asked: two-finger drag on non-custom sorts, multi-drag, range select, tap-and-drag selection lasso.

---

## 3. Current state (diagnosis, verified in code)

### Selection model (desktop, already correct)

- Grid tiles call `gridClickHandler(entry, e)` (`Media.jsx:2090`). Its **Ctrl/Cmd branch** (`Media.jsx:2127-2140`) is exactly "toggle in/out of selection":
  - file tile (`cellKeys = [k]`) → toggles `k` in `selKeys`;
  - pile container (`cellKeys = members.map(rowKey)`) → toggles every member key;
  - sets `anchorKey(cellKeys[0])`, persists the primary key via `setSelectedKeyAndSpread(cellKeys[0], wantCtrlSpread)` (atomic `?s=`/`?spread=` write, plan 019), and spreads a closed pile the first time (unlocked stacks mode).
- Multi-selected tiles render the shared highlight via `highlight = gridMulti && selKeys.size ? selKeys.has(rk) : isPrimary` (`Media.jsx:1608`) — the ring already reflects multi state with **no UI work**.
- Batch consumers already exist and act on `selectedKeysForStack` (`Media.jsx:2361`): context-menu stack/delete/open actions, `x` batch delete, keyboard Shift-nav, multi-drop.

### Touch controller (plan 022, custom-sort only)

- One controller on `data-testid="media-grid-files"` (`gridFilesRef`), gated by `touchGate = isGrid && !inPlaylistView && sort === "custom" && !filtersActive` (`Media.jsx:2490`).
- **Two-finger today = drag, engaged on the second `touchstart`** (`Media.jsx:2516-2547`): sets `mode = "drag"`, records both touch ids, `preventDefault()` (grab the gesture before pinch/pan), applies the ghost transform + vibrate immediately, and rAF-tracks `nearestDropInfo` from the two-finger midpoint.
- **Static two-finger release is today a silent no-op:** `onTouchEnd` drag path → `finishDrag()` (`Media.jsx:2594-2617`) computes the drop at the release midpoint; when nothing moved, `info.key === d.key` → no move, ghost cleared, nothing happens.
- Long-press timers, click suppression (`suppressUntil`), `touchSel` hit-test, `touchTileFromTarget` (skips folders), and `touchLiveRef` closures are all reusable as-is.
- `isCoarsePointer()` short-circuits `gridClickHandler` to plain select (`Media.jsx:2097-2108`), so the tap toggle **must not** reuse `gridClickHandler(entry, {ctrlKey:true})` on coarse pointers — it needs its own toggle routine (or the ctrl branch extracted into a shared helper).

### Why this design fits

- The two-finger gesture is already **grabbed from its origin** (`preventDefault` on the second `touchstart`), so both outcomes (tap → toggle, move → drag) are reachable from the same grabbed sequence without letting pinch/pan interfere.
- The only behavioral change in custom sort: *defer* the ghost/vibrate until the midpoint actually crosses the move slop, then branch at release — tap vs drag decided by motion, no arm-timer, no gesture-precedence juggling (the same principle plan 022 used to avoid long-press vs drag collisions).
- Everywhere the drag gate does **not** hold (Name/Size/Time sorts, filtered Gallery, playlist grid), a two-finger static tap still needs to work — desktop Ctrl+click works there too. A tiny **passive** (never `preventDefault`) tap-only listener handles those; passive ⇒ scroll/pinch stay untouched, and there is no drag to disambiguate.

---

## 4. Design

Two complementary pieces, both inside `Media.jsx`, both no-ops outside the grid:

### 4.1 Shared toggle routine (DRY with desktop Ctrl+click)

Extract the ctrl branch of `gridClickHandler` (`Media.jsx:2127-2140`) into a helper

```
toggleSelection(entry)   // file {kind,it,key} or pile {kind,stackId,members}
```

body = the exact ctrl-branch semantics: toggle `cellKeys` in `selKeys` (files single key; piles all member keys), set `anchorKey` to `cellKeys[0]`, `wantCtrlSpread` handling + `setSelectedKeyAndSpread(cellKeys[0], wantCtrlSpread)` atomic URL write, and spread a closed pile when `!pilesLocked` (first toggle). `gridClickHandler`'s ctrl branch becomes a one-line call to it (pure refactor — no behavior change, keeps desktop parity guaranteed by construction).

### 4.2 Custom-sort controller: movement-based tap-vs-drag (Gallery sort, no filters)

Extend the plan-022 controller (`touchGate` unchanged) at the second-finger engage point:

- On second `touchstart`: keep `mode = "drag"` + id bookkeeping + `preventDefault` (gesture grabbed immediately, as today — pinch/pan never start for either outcome). **Defer** the ghost transform + vibrate until motion begins.
- `onTouchMove` (mode `"drag"`, both fingers down): track the two-finger **midpoint**. Until the midpoint moves > `TOUCH_SLOP_PX` from the engage point, do nothing but suppress (preventDefault) — this is the tap-phase. Once it crosses slop → mark `drag.moved = true`, apply ghost + vibrate, and begin the existing rAF `nearestDropInfo`/auto-scroll loop (existing behavior after that point).
- `onTouchEnd` (drag path, wrong-finger-up): if `drag.moved` → existing `finishDrag()` commit **unchanged**. If `!drag.moved` → it was a **two-finger tap**: clear ghost/drop-info, set `suppressUntil` (no stray click collapses the new selection), haptic tick, and call `toggleSelection(entryFor(drag.key))` where `entryFor` resolves the tile (`{kind:"file", it, key}`) or pile (`{kind:"pile", stackId, members}`) via the existing `touchLiveRef.current` lookup used by `fireHold`. The target tile = the one under the first finger's start point (`drag.key` already carries it — same rule as the drag).
- Empty-area / folder targets: `touchTileFromTarget` already rejects folders and empty grid; two-finger tap there stays a no-op (consistent with today's no-op drag).

### 4.3 Tap-only passive layer (non-custom sorts & playlist grid)

Where the drag controller is off — `isGrid && !(isGrid && !inPlaylistView && sort === "custom" && !filtersActive)` (i.e. every other grid case) — attach a **second, passive** controller:

- `touchstart`/`touchend`, **never `preventDefault`** → one-finger scroll and two-finger pinch-zoom remain fully native.
- Track a first finger on a file tile / pile (via `touchTileFromTarget`, folders skipped). When a **second** finger lands while the first is still down, record both ids + midpoint. If both lift and the midpoint never moved > `TOUCH_SLOP_PX` → two-finger tap → `toggleSelection` (same routine) + haptic tick. Any move past slop or a single-finger release → cancel (it was scroll / pinch / a normal tap — all native).
- Target = the first-finger tile (or midpoint hit-test fallback if the first finger was on empty space — prefer the tile under the midpoint when the first touch wasn't a tile).
- Bind on the same `gridFilesRef` container, cleanup on gate change/unmount, repeat-safe (React 19 StrictMode double-invoke guarded by the existing effect-cleanup pattern).

### 4.4 Interaction matrix (no collisions)

| Gesture | File tile | Pile container | Folder chip / empty area |
|---|---|---|---|
| One-finger tap | select only | spread+select (existing) | folder nav / nothing |
| One-finger long-press | context menu | pile context menu | nothing |
| Two-finger static tap | **toggle selection** | toggle members | nothing |
| Two-finger drag (custom) | reorder single item | n/a (no pile drag, plan 022) | nothing |

Desktop is untouched: Ctrl+click → same `toggleSelection` via the refactor; Shift range, plain click, DnD, keyboard all unchanged.

### 4.5 Untouched

- Desktop mouse DnD, `gridClickHandler` plain/shift branches, keyboard nav, `?s=`/`?spread=` model, `moveKeys`/`stackDrag.js`, `/api/mediaorder`.
- List view (no touch multi-select there).
- Plan 022 gestures' existing behavior (tap, long-press menu, two-finger drag commit).
- Pile drag remains disabled on mobile.

---

## 5. Files

| File | Change |
|------|--------|
| `web/src/views/Media.jsx` | Extract `toggleSelection` from the ctrl branch of `gridClickHandler` (call it from ctrl-click); extend the custom-sort controller with motion-slop tap detection + toggle-on-static-release (defer ghost/vibrate until slop); add the passive tap-only controller for non-custom grid cases |

No CSS, no API, no other files. (`styles.css` already carries the touch `user-select` guards from plan 022.)

---

## 6. Verification

- `cd web && npm run build` passes; `npm run lint` no new warnings; root `npm test` stays green (168/168).
- Manual — DevTools mobile emulation + touch:
  1. **Two-finger tap** a file tile → tile joins the selection (ring appears); a second two-finger tap on the **same** tile → it leaves the selection.
  2. Two-finger tap a second, different tile → both selected; context menu / `x` batch delete act on both (existing multi-select UI).
  3. **Custom sort regression:** two-finger *drag* still reorders a single item and persists `/api/mediaorder`; the ghost now only lifts once motion starts (a static two-finger touch no longer flashes the ghost).
  4. **Open pile:** two-finger tap a pile → all members selected; tap again → all deselected; a closed pile spreads on first toggle (same as Ctrl+click).
  5. **Non-custom sorts / filtered / playlist grid:** two-finger tap still toggles; one-finger scroll and pinch-zoom are unchanged (passive listener).
  6. **Desktop regression:** Ctrl+click toggles exactly as before (refactored path), Shift range / plain click / DnD / long-press menu unaffected.
  7. Gated no-ops: folder chips, empty grid area, list view — two-finger tap does nothing.

---

## 7. Open decisions (defaults chosen unless user objects)

1. **Motion-based disambiguation, no timer** — static two-finger = tap (toggle); motion past ~10px = drag (reorder). Honest and instant (plan 022 principle).
2. **Two-finger tap works in ALL grid sorts + playlist grid**, matching desktop Ctrl+click scope; the drag remains custom-sort-only.
3. **Toggle target = tile under the first finger** (same rule as the existing drag), with a midpoint fallback when the first finger wasn't on a tile.
4. **Pile toggle = all members** (Ctrl+click parity, locked or open); a closed pile also spreads on first toggle.
5. **No extra affordance/button** — the gesture is the entry point, consistent with the rest of the mobile vocabulary.

---

## 8. Progress log

- **2026-09-19** — Analyzed the plan-022 controller (`Media.jsx:2490-2640`): two-finger static release is currently a silent no-op (drag branch, `finishDrag` no-move). Confirmed the ctrl branch of `gridClickHandler` (`Media.jsx:2127-2140`) is the exact desktop toggle, that `isCoarsePointer()` short-circuits it (`Media.jsx:2097-2108`), and that multi-selection rendering/batch consumers need no change. Wrote this plan. Awaiting implementation approval.
- **2026-09-19 — Implemented.** All edits in `web/src/views/Media.jsx`:
  - Extracted `toggleSelection(entry)` (shared toggle for file tiles + piles) before `gridClickHandler`; the ctrl branch now calls it (desktop path unchanged in behavior).
  - Custom-sort controller: second-finger engage no longer early-returns on piles and no longer applies ghost+vibrate; drag state gains `pile`, `allowDrag: !pile`, `moved:false`. `touchmove` slop-gates the lift: static midpoint = tap phase, motion past `TOUCH_SLOP_PX` (10px) engages drag (ghost scale + haptic), moved piles cancel. `finishDrag` commits a no-move release as a toggle via `tapEntryFor`, moved+no-allowDrag is a no-op; `touchLiveRef` carries `toggleSelection`.
  - New passive tap-only controller (gated `isGrid && !touchGate`, i.e. all non-custom sorts + playlist + filtered): passive listeners never `preventDefault`, so scroll/pinch stay native; target = first-finger tile with midpoint `elementFromPoint` fallback; static two-finger release toggles selection, motion (one or two fingers) past slop aborts.
  - Added `ref={gridFilesRef}` to the playlist-view `media-grid-files` container so the passive controller attaches there.
  - Verified: `npm run lint` no new warnings; `npm run build` passes. (Manual touch re-test still to be done on device — see Verification.)