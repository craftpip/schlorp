# 019 — Media grid: double-keypress entering/leaving a pile (selection race)

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`).
> Started: 2026-09-16. Status: **DOUBLE-PRESS AND CLOSE-FLICKER FIXED + VERIFIED (build and live browser)**.
> How to read this file: it is the source of truth for this task. Update it as
> work proceeds — objective, root cause, fix plan, verification, and notes.

---

## 1. Objective

Fix the Media grid-view bug where **navigating into or out of a pile (stack)
with WASD requires pressing the move key TWICE** for the selection to change.
One keypress should move the selection as far as the user expects — a single
press lands on/leaves the pile exactly once.

Scope:
- Only the grid view (`isGrid`, `gridClickHandler`, WASD `landOn` path,
  Enter-open-pile path, and the pile spread `?spread=` sync).
- No backend changes. No CSS changes. URL params remain the single source of
  truth for selection (`?sel=`/`?s=`) and spread (`?spread=`).

---

## 2. Root cause (DIAGNOSED, with evidence)

### Symptom
Press `d` (right) onto a pile → selection appears to not move. Press `d` again
→ it moves. Same when leaving a pile (moving off a member back to single
tiles). The *spread opening/closing itself* happens on the first press; only the
**selection URL write is lost**.

### Mechanism — two separate `setSearchParams` writes in one gesture, plus a stale chained write

URL params are the selection source of truth:
- `selKey` is derived from the URL (`searchParams.get("s")` → `decB64`, else
  `?sel=`), and `setSelectedKey(k)` writes only when `k !== selKey`
  (`Media.jsx` ~L166-173).
- The pile **spread id is also URL state** (`?spread=`), seeded from the query
  string and kept in sync by a **deferred effect** (`Media.jsx` ~L320-336):

```js
useEffect(() => {
  // Keep ?spread= in sync: state is source of truth; the URL is a hint.
  const cur = searchParams.get("spread") || "";
  const want = spreadStackId || "";
  if (cur === want) return morph;
  const t = setTimeout(() => {
    setSearchParams((prev) => {
      const ns = new URLSearchParams(prev);
      if (spreadStackId) ns.set("spread", spreadStackId); else ns.delete("spread");
      return ns;
    }, { replace: true });
  }, 0);
  return () => clearTimeout(t);
}, [spreadStackId, searchParams]);
```

When the user presses a move key onto a pile, ONE gesture issues **two**
separate `setSearchParams` calls:

1. The **selection write** — `landOn(…)` pile branch / `selectSingleKey(k)` →
   `setSelectedKey(fk)` → `setParam("sel", fk)`.
2. The **spread write** — `setSpreadStackId(entry.stackId)` at the same site,
   which triggers the deferred `?spread=` effect above. Its functional updater
   chains off `prev` — the URL at the time the *deferred* callback runs.

Both run in the same render batch/gesture. The deferred callback's `setTimeout(0)`
fires **after** the selection write has been flushed, but the two writes are
**not merged together in one functional `setSearchParams`** — so the spread
effect writes from a snapshot of the URL that may already contain the *new*
`?sel=`, OR (the clobber case) the selection index logic re-reads a stale
`selKey` because the deferral races the same-batch state commit. Net effect:
the `?sel=` update is lost on the first press → user must press again.

This is a **same-batch race**: multiple `setSearchParams` calls from one event
(one direct, one deferred via effect) are not guaranteed to compose
functionally. The author already documented the hazard at ~L322 ("Deferred a
tick so an incoming pile-spread grab can't both write (out-of-order
double-write clobber)") — the deferral alone is insufficient because the writes
still target different params from different closures.

### Assertion (confirmed during implementation 2026-09-16)
Byte-exact reads (via `sed` → `/tmp`, which renders without the multi-line
display ghosting that corrupts direct reads of this file) confirm the race at
**eight** call sites (all write BOTH selection and spreadStackId in one
gesture). Also resolved: selection URL param is **`?s=<base64url rowKey>`**
(`setParam` maps `k === "sel"` → key `"s"` with `encB64`, deleting legacy
`?sel=`); `selKey` reads `?s=` first with `?sel=` fallback. Spread URL sync is
the deferred effect at ~L321-340. `setAnchorKey`/`setSelKeys` are pure state
(no URL writes); `setSearchParams` is react-router's `useSearchParams` setter.
- `selectSingleKey(k)` — `collapseSpreadUnlessMember(k)` then `setSelectedKey(k)`
- `landOn(el, dir)` pile branch — `setSpreadStackId(entry.stackId)` + `setSelectedKey(fk)` (guard uses `stacksModeRef`, not `spreadStackIdRef`)
- Enter-key open-pile — `setSpreadStackId(pileId)` + `setSelectedKey(fk)` (guard: `!spreadStackIdRef.current && stacksModeRef.current !== "locked"`, single `if (entry)` check)
- `gridClickHandler`: coarse-pointer pile branch (`pilesLocked ? cellKeys : [cellKeys[0]]`), ctrl-toggle pile branch (conditional spread), plain-click pile spread branch, deselect path + final select path (both after `closeSpread()`)

### Decision (resolved during implementation)
`setParam("sel", v)` writes **`?s=<base64url>`** and deletes legacy `?sel=`
(`setParam` maps the key; `selKey` reads `?s=` first). So the atomic helper
writes `?s=` + `?spread=` in one functional updater, mirroring that encoding.

---

## 3. Fix plan

**Approach: make the selection + spread URL writes atomic in a single
functional `setSearchParams`.** Eliminate the separate deferred-spread write
(NOT by deleting the effect — by making selection changes route through a
helper that also writes `?spread=` in the SAME functional updater, so the
deferred effect sees `cur === want` and early-returns).

1. Add an atomic helper, e.g.:
   ```js
   const setSelectedKeyAndSpread = (k, spreadId) => {
     const next = k || "";
     const spr = spreadId || null;
     if (next === selKey && (spreadStackIdRef.current || null) === spr) return;
     // functional updater: set BOTH params in one call
     setSearchParams((prev) => {
       const ns = new URLSearchParams(prev);
       if (next) ns.set("sel", next); else ns.delete("sel");
       const enc = /* base64? matching setParam */;
       ...
       if (spr) ns.set("spread", spr); else ns.delete("spread");
       return ns;
     }, { replace: true });
   };
   ```
   (must match existing `setParam` semantics for `?sel=` vs `?s=`: check exact
   key names at the call site).
2. Replace the selection-only writes at the FOUR pile sites above with
   `setSelectedKeyAndSpread(k, spreadId)` so one gesture → one functional write
   covering both params.
3. The deferred spread-sync effect stays for the non-selection spread paths
   (e.g. `?spread=` restore on load, folder nav that clears it, ESC-close) but
   now early-returns when the atomic helper already wrote the URL — no second
   clobbering write.

### Alternative (weaker, rejected)
Make the deferred effect merge `sel` from `searchParams` (functional) instead
of deleting it — but that still leaves two writes per gesture and the other
params (`spread` vs `sel` ordering) can still race other state. Atomic single
write is cleaner.

### What was implemented (2026-09-16)
`setSelectedKeyAndSpread(k, spread)` in `Media.jsx` (~L181): single functional
`setSearchParams` writing `?s=` (base64, legacy `?sel=` deleted) + `?spread=`
(add/delete) together, with a no-op guard (`k === selKey` and spread unchanged
vs `spreadStackIdRef`). All state calls (`setSpreadStackId`, `setSelKeys`,
`setAnchorKey`, `capturePileRect`, `closeSpread`) kept exactly as-is — only the
URL writers were swapped:
- `selectSingleKey` → atomic with `keep` computed by mirroring
  `collapseSpreadUnlessMember`'s ref-based membership test (ref scope — state
  `isSpreadMember` would be stale there);
- `landOn` pile → atomic with `entry.stackId` (locked mode: keep current ref
  value, selection-only semantics preserved);
- Enter-pile → atomic with `pileId`;
- coarse-pointer pile → atomic with `pilesLocked ? spreadStackId : entry.stackId`;
- ctrl-toggle pile → atomic with conditional `wantCtrlSpread`;
- plain-click pile spread → atomic with `entry.stackId` (locked sub-branch
  left sel-only: no spread change possible, no race);
- deselect path → atomic `("", null)` (spread state is always null here —
  `closeSpread()` fires above or inside);
- final select path → atomic with `(spreadStackId && isSpreadMember(k)) ? spreadStackId : null`.
Left untouched (no co-occurring spread write, no race): shift-range branch,
`selectOnly`/`openItem`/`openViewer`/`goViewer`/`tapItem`, selection restore
(~L470-495), deferred `?spread=` sync effect (now no-ops after atomic writes).
Fixed during implementation: a typo (`cellCells0`) caught on re-read before
verification — corrected to `cellKeys[0]`.

---

## 4. Verification

- [x] `vite build` passes (40 modules, no errors) — syntax/JSX/transform check.
- [x] All 8 call sites re-read byte-exact after editing; typo caught and fixed.
- [x] Manual: in grid view, `A` from `valiente.reed...mp4` into `Stack 4`
  selected `julieta.allegretti...mp4` and set both `?s=` and `?spread=` on
  the first press. One `D` returned to `valiente.reed...mp4` and cleared
  `?spread=`.
- [ ] Regression spot-checks: `?spread=` restore on reload, folder nav clears
  it, shift/ctrl multi-select, locked-piles mode, coarse-pointer tap.

---

## 5. Progress log
- **2026-09-16** — Triage. Read `Media.jsx` selection/spread code paths; found
  same-batch double `setSearchParams` race (direct selection write + deferred
  `?spread=` effect write) — root cause of the "press twice" symptom
  documented above, including call-site list.
- **2026-09-16** — Implemented atomic `setSelectedKeyAndSpread` + wired all 8
  pile entry/exit sites (WASD `landOn`, Enter-open, click ×4 incl. ctrl-toggle
  and deselect/collapse tail, `selectSingleKey`). Resolved open questions:
  selection param is `?s=` base64; `landOn` guard uses `stacksModeRef`;
  Enter-pile uses single `if (entry)`; no `willExpand` variable exists (earlier
  ghosted read artifact — real click logic is `pilesLocked`/`spreadStackId`
  guards). `vite build` passes. Manual browser check still pending.
- **2026-09-16** — User: double-press fixed, but NEW symptom: collapse animation
  plays correctly, then AFTER completion the pile re-opens and instantly
  collapses again (second cycle very fast). Investigation: mapped ALL
  `setSpreadStackId` writers (grep) — re-spread to a non-null id only happens
  in event handlers (WASD `landOn`, Enter-open, click ×4, cover `onDoubleClick`
  which writes NO url, `cycleStacksMode` X-key/toolbar). NO timer writes a
  spread id (teardown timer only clears `closingSpreadId`); NO url→state
  restore effect exists (only 2 `?spread=` readers: state init + sync effect).
  Ruled out: member-tile dblclick (opens viewer), ESC (no url write, no race),
   bubbling (spread members are top-level cells; nesting is only collapsed
   cascade previews). Static analysis exhausted — moving to live repro with
   timestamped logging of spread/closing/url transitions to catch the writer.
- **2026-09-16** — Live repro in a newly created Chrome tab confirmed the
  selection write was still being overwritten: one `A` added `?spread=` but
  left `?s=` on the old file. The deferred spread effect used React Router's
  render-time URL snapshot. It now copies `window.location.search` when its
  timer runs, preserving the selection URL already committed by the gesture.
  Rebuilt the web app and verified one-key entry and exit against `Stack 4`.
- **2026-09-16** — Click-collapse flicker root cause: the roll-in animation
  cleanup cleared the folded inline styles before the close timer unmounted the
  cards. That made them visibly reopen, then abruptly disappear when the pile
  re-formed. Closing cards now retain their final folded state until unmount. A
  live mutation capture recorded one folded-state write, no restored/open-state
  write, and the pile present after the closing window.
