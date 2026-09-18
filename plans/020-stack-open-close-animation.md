# 020 — Media grid: stack open/close animation continuity (collapsed offsets + dynamic space)

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`).
> Started: 2026-09-18. Status: **IMPLEMENTED + user-confirmed 2026-09-18** (§3 spec; §4 superseded by the implemented margins-only footprint approach — see §6).
> Scope: stack open/close animation only. No backend, no selection/URL, no drag-drop behavior changes.

---

## 1. Objective

Two animation defects in stack open/close:

1. **Close:** the collapsed look (each pile card visible with a slight `PEEK` offset) does not form *during* the close animation. Cards fold/fade into the cover, then the offset pile pops in afterwards.
2. **Open:** space for the spread members appears first (instant reflow), then cards fly in. Sibling tiles should be pushed progressively as the stack opens.

---

## 2. Diagnosis (verified in code)

### Collapsed vs spread are two discrete DOM states

- Collapsed = one flex item (`renderPile`, `PEEK = 10`): container width `memberW + PEEK*(n-1)`, inner tiles overlapped with `marginLeft: -shift` where `shift = memberW - PEEK`. That overlap IS the offset look.
- Spread/closing = `gridVisible` memo: `if (spreadStackId === id || stacksMode === "open" || closingSpreadId === id)` emits N independent `kind: "file"` tiles. **Pile is unmounted** in both states.

### Close path (why offsets pop in after)

- `closeSpread()` sets `closingSpreadId = sid` + `spreadStackId = null` synchronously. Grid still renders N full tiles; pile still gone.
- `useLayoutEffect` roll-in FLIPs each tile from its grid rect toward `rollRectsRef` (peeked rects captured once at **open** time in `capturePileRect`), with `scale(target/cur)` and `opacity -> 0`. Index 0 skipped.
- Only after the `320 + (n-1)*40 + 160ms` timer does `closingSpreadId` clear and the real offset pile mount.

Result: animation endpoint is N invisible cards stacked inside the cover position, then a hard swap to the offset pile. Offsets never exist during the animation. Secondary issues: close targets go stale on scroll/resize; spread widths are per-ratio while pile widths are all `memberW` (first member's ratio), so flight also distorts; `opacity 0` hides the strips that should be forming.

### Open path (why space appears first)

- `setSpreadStackId(id)` re-renders synchronously: browser lays out N tiles immediately, siblings jump to final positions in one reflow.
- Only then does the roll-out FLIP set `transform: pileSlot - gridCell` and animate to identity with `idx*45ms` stagger.

Layout (space-making) is instant and decoupled from the visual flight: gap pops, then cards slide in.

---

## 3. User spec (verbatim, 2026-09-18 — exactly what is wanted, nothing more, nothing less)

Default view = the closed stack look (with the items inside it hanging on the side).

When opening that view: the items hanging on the sides MOVE from their initial position (their place in the closed stack) to the place where they are going to take space. WHILE doing this, the space the stack takes keeps increasing, and keeps pushing the items that are on the right, outside the stack.

When closing the stack: the same in reverse — the items MOVE in with animation to their INITIAL POSITION.

No fade-in / fade-out when opening or closing the stack — items stay fully visible throughout.

NOTHING MORE, NOTHING LESS.

---

## 4. Alternative design (documented; NOT the implemented one)

The implemented approach instead keeps the existing pile↔N-tiles DOM swap but makes the footprint itself layout-driven (see §6): the grid is `display:flex; flex-wrap:wrap`, so a negative `marginLeft` on the spread tiles is real layout — it overlaps the members at exactly `PEEK` offsets and shrinks the group footprint to pile size in the same first layout pass (no pre-swap patch needed). Animating `marginLeft` therefore grows/shrinks the footprint progressively with the flight. The earlier animated-container design below stays as a fallback but adds moving parts (container remount during transition, progress driver) that proved unnecessary:

1. **Close:** render members inside the pile container; animate each card's `marginLeft` from `GRID_GAP` (spread) to `-shift` (collapsed) and container width from `sum(widths)` to `memberW + PEEK*(n-1)` over the close duration. Offsets emerge live. Keep `opacity: 1` and pile `zIndex: members.length - i` order throughout. Swap to the static pile only at progress = 1 (no visual change at swap).
2. **Open:** exact reverse — start overlapped, animate `marginLeft`/width outward with the same progress that drives each card's flight, so surrounding flex-wrap siblings are pushed incrementally by the real animated width.
3. **Single `0 → 1` progress driver** (rAF or WAAPI) replacing the two FLIP branches + `spreadFromRectRef`/`rollRectsRef` + fade-out + teardown timer. Stagger becomes per-card delay on the same progress.
4. **No stale rects:** recapture live rects at transition start, or (preferred) no rect capture at all once the container itself is the animated element.
5. Untouched: `locked`/`open` modes, selection/?spread= URL logic (plan 019), drag-drop pile paths, list view.

---

## 5. Verification (against §3 spec)

- Open: side-hanging items visibly travel from their closed-stack slots to their spread slots; the stack's footprint grows during the flight and pushes right-side tiles progressively.
- Close: items visibly travel back into their initial closed-stack slots (nothing else changes).
- Keyboard: navigating onto a pile (WASD/landOn, Enter) plays the open roll-out; moving selection off an open pile or pressing Escape plays the close roll-in.
- `cd web && npm run build` passes.

---

## 6. Progress log

- **2026-09-18** — Diagnosed both defects to the instant layout swap + decoupled FLIP (see §2). Wrote this plan. Awaiting implementation approval.
- **2026-09-18 — FAILED ATTEMPT (reverted):** I tried a shortcut inside the existing `useLayoutEffect` FLIP (marginLeft footprint animation tacked on, close retargeted to a live anchor at opacity 1) instead of the plan's §3 (one container kept alive through the transition, no instant pile↔tiles swap). It failed on both counts: (1) open still swaps `gridVisible` pile→N-tiles synchronously, so the reflow/sibling jump happens BEFORE the effect runs — a margin tweak afterwards cannot un-jump layout, hence "still takes space then opens"; (2) the close rewrite changed transform endpoints/timing enough that the fold animation effectively disappeared instead of gathering visibly. Lesson: the instant DOM swap is the root cause and cannot be patched from inside the post-swap effect — §3 stands as written and needs the real animated-container implementation (single `0→1` progress, pile container mounted through the whole transition, swap only at progress end). Code reverted to pre-change state (`web/src/views/Media.jsx` effect restored byte-identical, `web/dist` rebuilt to original hashes); `vite build` passes, `npm test` 168/168 pass.
- **2026-09-18 — IMPLEMENTED (spec satisfied, user-confirmed):** Rebuilt the roll-out/roll-in `useLayoutEffect` in `web/src/views/Media.jsx` around a margins-only footprint animation on the spread tiles. Per-card `margin-left` animates between `0` and `-(w + GRID_GAP - STACK_PEEK_PX)` (negative = collapse; right edges advance by exactly PEEK, reproducing the pile's look in the same first layout pass). Because the grid is flex-wrap, margins are real layout: open starts collapsed (footprint = pile size) and grows, pushing following tiles progressively; close collapses, pulling them back. All opacity fade removed (items stay fully visible). Cover tile (visual idx 0) unmoved; `zIndex: total - idx` keeps pile order. Close targets are the live tiles (no stale rects); teardown-time swap to the static pile is visually identical to the animation end. Open gate = `spreadFromRectRef` (user-initiated only), close gate = `closingSpreadId` + `animatedClosingSpreadRef`; `?spread=` restore and navigation render statically as before. Safety nets: `stackAnimTimerRef` timeout clears inline styles if a roll-out `transitionend` never fires; `stackOpenCleanupsRef` detaches the open branch's `transitionend` handlers if a fast open→close reuses the same DOM nodes. `vite build` passes; `npm test` 168/168 pass.
- **2026-09-18 — keyboard-navigation open/close animated:** Mouse paths already animated (`capturePileRect`+`setSpreadStackId` on pile click/Enter/landOn; Escape+`closeSpread()`). The one dead path was keyboard movement off a spread stack — `collapseSpreadUnlessMember` in the keyboard `keydown` effect called `setSpreadStackId(null)` directly (instant collapse). Changed it to `closeSpread()` so navigating away from an open pile now plays the same roll-in animation (`?spread=`/`?s=` atomic URL write preserved via `setSelectedKeyAndSpread`). Build + 168/168 pass.
