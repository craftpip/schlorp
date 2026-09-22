# 034 — Media grid range-ruler scrollbar

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx` + `web/src/styles.css`, no backend change).
> Date: 2026-09-22. Status: **Proposed** (plan only, not implemented).
> Scope: grid view only (`?view != list`). List view unchanged.

---

## 0. Request (consolidated)

Grid view gets a vertical range scrollbar on the right side, Google-Photos-timeline style:

- Not a timeline — **ranges of 50 items**, ruler-like numbered segments, click jumps to that range.
- **Gallery (`sort=custom`, default): ranges start from the bottom** — top of rail = highest range. Example with 120 items, top→bottom: `120-101`, `100-51`, `50-1`.
- **Other sorts (Name / Size / Time): ranges start from 0/1 on top** — top→bottom: `1-50`, `51-100`, `101-120`.
- **1-based labels** (inclusive): `1-50`, not `0-50`. Last range may be partial (`101-120`).
- Each range segment shows **2 thumbnails** of items in that range.
- Piles stay **closed** on jump. A pile split across a boundary **belongs wholly to the top range** (the range holding its first file in view order); the full pile shows/jumps with that range.

## 1. Definitions (locked)

- **Counted set = `viewable`** (`filtered.filter(it => !it.dir)`). Folders/playlist chips excluded.
- **Position = index in current view order** (0 = visual top). Range `k` (0-based) covers 1-based positions `[k*50+1, min((k+1)*50, N)]`.
- **Gallery flip is display-only**: same position partition; rail order reversed and each label printed `end-start` (`120-101`); normal sorts print `start-end` (`101-120`).
- **Playlist view (`?pl=`)**: ascending rail like normal sorts.
- **Visibility**: show rail only when `isGrid && gridW && viewable.length > 50`. Hidden at ≤640px width.
- **Range size**: constant `RANGE_SIZE = 50`.

## 2. Pile-atomic rule (locked)

- Pile members are consecutive in `filtered`/`viewable` order and can straddle a 50-boundary (e.g. members at file-positions 48–52).
- **Whole pile is assigned to the range containing its first member in view order** (= visually topmost member = "top range" of the two it straddles). It appears/counts only there; the next range starts at the file after the pile.
- Jump target: range start position → if it falls on a non-first pile member, jump to the pile container (`[data-filename="stack:<id>"]`). Never auto-spread.
- Active-range detection: a visible pile maps to its first member's range.
- Rejected alternative: counting a pile as 1 cell (would make ranges hold ≠50 files).

## 3. UI (Google-Photos-style rail)

- Layout: flex row beside `media-grid-files` — files `flex:1`, rail fixed ~64px wide. Rail: `position: sticky; top: <sticky-toolbar-height + 12px>; max-height: 60vh; overflow-y: auto`.
- Segment = `<button data-testid="media-range-ruler-seg">` containing **2 square minis** (~28×28px, `border-radius: 6px`, `object-fit: cover`, 4px gap) + range label below/beside. Muted label text; accent dot/ring on the **active** range (follows window scroll via rAF-throttled scroll listener mapping top-visible tile → range). Hover = accent wash. Minimal, one accent, 8px radii.
- No drag-scrub bubble (Photos shows a big overlay while dragging) — click-to-jump + active-follow only. Add later if wanted.

## 4. Thumbnails (2 per range)

- Source: reuse tile resolver `thrumb(it)` (poster sibling → photo/gif file itself → `/api/mediathumb` for video). No new endpoints; browser cache shared with grid tiles.
- Pick **first 2 files assigned to that range (post pile-assignment) that yield a thumb URL**, in view order (Gallery: topmost-first within the range). Pile member → use pile cover thumb (first member's thumb).
- Fallbacks: <2 thumb-bearing files → mini + icon placeholder box; video with no poster → tile's icon fallback. Mini `onError` → swap to icon box, never a broken-image glyph.
- Perf: `<img loading="lazy" decoding="async">`, fixed CSS size (no layout shift). ~20 tiny imgs for 10 ranges, all cache hits from on-screen tiles.

## 5. Interaction

- Click segment → resolve range-start position → file key (or pile container) → `window.scrollTo` (sticky-toolbar offset, same pattern as `scrollSelectionIntoView`; page keeps window scroll, no new scroll container) → `setSelectedKey` to jumped file (pile: first member) so arrow-key nav continues. No `?spread=` change, no viewer open.
- Native buttons → Tab/Enter free. No new shortcuts.
- Derives from existing memos (`viewable`, `sort`, `selKey`, `folderStacks`) — recomputes on filter/type/sort/folder/spread change, zero fetches.

## 6. Touch list (after approval — do NOT implement from this plan alone)

1. `web/src/views/Media.jsx`
   - `RANGE_SIZE = 50` + `rangeSegments` memo: positions, 1-based labels, gallery flip, pile-first-member assignment, `minis: [url|null, url|null]` via `thrumb`.
   - Rail JSX (`data-testid="media-range-ruler"`) beside `media-grid-files` in the non-playlist grid branch (+ ascending variant for playlist branch).
   - `jumpToRange(pos)` via `gridFilesRef` / `[data-filename]` + sticky offset + `setSelectedKey`; scroll-spy effect for active segment.
2. `web/src/styles.css`
   - `.media-range-rail / .media-range-seg / .media-range-minis` + active state + `@media(max-width:640px){display:none}`.
3. Verify: 120-file folder in Gallery (`120-101 / 100-51 / 50-1` top→bottom) vs Name sort (`1-50 / 51-100 / 101-120`); boundary-pile assignment + minis; video-no-poster fallback; ≤50 hidden; mobile hidden; `npm run lint` (oxlint). No web test runner exists (`web/package.json` has no `test` script), so manual + lint.
