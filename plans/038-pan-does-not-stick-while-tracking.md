# Plan 038 — Pan does not stick while stabilization is on (snaps back to the middle when the mouse leaves)

**Date:** 2026-09-29
**Status:** Planned (not started — recorded from a user bug report)
**Trigger:** User: "in file viewer when stabilization is active, and i have zoomed in, that time pan does not work, i can pan but when i leave my mouse it snaps to middle of the video"
**Project:** **xdl** — web UI, `web/src/components/FileViewer.jsx` (the tracker's auto-center pass).
**Queue position:** next xdl plan after `037-stabilize-across-seeks.md` (Done).

## 1. The report, precisely

- Stabilization is **active** (subject tracking or BG tracking; `T` toggles auto-center).
- The view is **zoomed in**.
- Dragging pans the picture — that part works while the mouse is held down.
- **On release / mouse-leave the view snaps back to the middle of the video** and the
  chosen framing is lost.

So the pan is applied and then *undone* by something that only runs when the drag
ends. Not a "drag is broken" bug — a "nothing protects the user's pan once the
pointer is gone" bug.

## 2. Where to look (read these first)

`FileViewer.jsx`, the auto-center block in the tracking tick (~lines 1749–1826):

- The **only** thing that pauses auto-center is `!dragRef.current.dragging`
  (line 1749). The moment the drag ends, the pull resumes with **no immunity
  window** — so anything the pull considers "drift" is eaten as soon as the user
  lets go. That matches "I can pan, then it snaps".
- **Subject mode target** (lines 1760–1767): `tX = st.offX - base.x` where
  `base = computeCenterPan(st, z, rect, rot)`. The comment above the block claims
  "the user pan offset is eased through offX/offY so the compensation and the
  tracked point keep working untouched" — check whether the target actually
  preserves the user's pan or whether it re-derives the pan from the tracked
  point each tick (which would make the pan a fixed point only at offset 0).
- **Zoom feeds the target** (`z = trackViewRef.current.zoom`, line 1754): at
  `zoom > 1` a small on-screen correction is a much larger move in source pixels,
  and the pull speeds (`TRACK_AUTOCENTER_REACH` / `_PULL` / `_MAX`, lines 47–50)
  are computed from the *rect*, not from the zoomed scale. Verify whether the
  snap is a constant-speed walk to the middle (target wrong) or a proportional
  one (scale wrong) — the fix differs.
- **BG mode** (lines 1789–1823) already has the shape the fix probably wants:
  the view may roam freely, and only a **band** (`TRACK_AUTOCENTER_BAND`) starts
  a `TRACK_AUTOCENTER_HOLD` (2 s) countdown before the spring homes in. Subject
  mode has no band and no hold at all.
- `TRACK_AUTOCENTER_HOLD` / `TRACK_AUTOCENTER_RAMP` / `TRACK_AUTOCENTER_HOME`
  (lines 68–70) and `onMouseLeave={handleMouseUp}` on the stage (line 2712) —
  the mouse-leave path ends the drag, which is exactly the moment the snap
  fires.

## 3. Desired behavior

- A pan the user made while zoomed **persists**. Letting go of the mouse must not
  undo it.
- Auto-center keeps doing its actual job: pulling the view back when it has
  drifted *on its own* (compensation runaway, BG mode), and re-homing after a
  seek or a big jump.
- The distinction to make explicit: **drift the tracker introduced** vs **framing
  the user chose**. Auto-center may correct the first; it must not touch the
  second.
- Cheapest honest escape hatches already exist: `T` (hold = auto-center off) and
  the recenter control. Whatever the fix is, keep both working, and make sure the
  button's title still describes what it does.

## 4. Fix directions (pick one, do not do all)

1. **Post-drag immunity** — smallest change: after a drag ends, hold auto-center
   off for `TRACK_AUTOCENTER_HOLD` and re-arm the band from where the user left
   the view, instead of resuming the pull against the user's own offset.
2. **Make the user's pan the reference** — in subject mode, capture the pan
   offset at drag end and treat *that* as `tX/tY` (what BG mode does with its
   band), so the pull only corrects movement away from where the user put it.
3. **Band + hold for subject mode too** — give subject mode the same
   roam-then-countdown-then-spring shape BG mode has, so a small deliberate pan
   is inside the free zone and only a real excursion is corrected.
4. **Explicit "user framing" flag** — a ref set on drag end while `zoom > 1` and
   cleared by recenter / a seek / zoom-out, which suppresses the pull entirely
   until then. Most predictable, most state.

Whatever is chosen: **verify zoomed and unzoomed, subject and BG mode, after a
drag and after a seek** — the last one is the case plan 037 just made sure works,
and it must not regress.

## 5. Before starting

- The working tree is **dirty**: an uncommitted `FileViewer.jsx` rewrite
  (`+784/−…`, incl. a ~395-line `refreshGrid`) plus the keyboard-hint work and a
  `Media.jsx` change are all uncommitted since 2026-09-28. Land or stash those
  first — this fix goes on top of them, and "the snap" may well have arrived with
  that rewrite. `git diff web/src/components/FileViewer.jsx` before reading
  anything else.
- No plan file covers the keyboard-hint work; unrelated, but it is in the same
  files.
- Verify in the browser against a real video in the `schlorp` app (container is
  up, `web/dist` is built from the dirty tree), not by reading the transform
  math alone.
