# 034 — Media grid range-ruler scrollbar

> Range size: **100 files per range** (`MEDIA_RANGE_SIZE` in `.env`, default 100, clamped 10–5000). Served live via `GET /api/client-config` (no web rebuild needed); also editable in Settings → Core (writes `.env`).

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx` + `web/src/styles.css`, no backend change).
> Date: 2026-09-22. Status: **Implemented** (2026-09-22: rail + minis + pile-atomic + scroll-spy in `Media.jsx`, styles in `styles.css`; `npm run lint` clean, `npm run build` OK).
> Scope: grid view only (`?view != list`). List view unchanged.

---

## 0. Request (consolidated)

Grid view gets a vertical range scrollbar on the right side, Google-Photos-timeline style:

- Not a timeline — **ranges of 50 items**, ruler-like numbered segments, click jumps to that range.
- **Gallery (`sort=custom`, time-desc): rail follows the grid top→bottom; ONLY the labels count from 0 at the bottom.** Example with 120 items, top→bottom: `120-100`, `100-50`, `50-0` (chunk boundaries anchored at the bottom, so the top chunk is the partial one). (2026-09-22: briefly reversed the whole segment order by mistake — reverted; order always = grid order, Gallery differs in labels only.)
- **Other sorts (Name / Size / Time): labels count from the top.** Top→bottom: `1-50`, `51-100`, `101-120`.
- **1-based labels** (inclusive): `1-50`, not `0-50`. Last range may be partial (`101-120`).
- Each range segment shows **2 thumbnails** of items in that range.
- Piles stay **closed** on jump. A pile split across a boundary **belongs wholly to the top range** (the range holding its first file in view order); the full pile shows/jumps with that range.

## 1. Definitions (locked)

- **Counted set = `viewable`** (`filtered.filter(it => !it.dir)`). Folders/playlist chips excluded.
- **Position = index in current view order** (0 = visual top). Range `k` (0-based) covers 1-based positions `[k*50+1, min((k+1)*50, N)]`.
- **Rail order always = grid order (top→bottom) in every mode.** Gallery differs in labels only (0-based from the bottom).
- **Playlist view (`?pl=`)**: ascending rail like normal sorts.
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

- Layout: flex row beside `media-grid-files` — files `flex:1`, rail fixed ~64px wide, borderless/transparent. Rail: `position: sticky; top: 76px; max-height: calc(100vh - 100px)` (stretches to viewport bottom); overflow-y auto.
- Segment = `<button data-testid="media-range-ruler-seg">` with a **vertical stack of 2 full-bleed photo blocks** (range content as `background-image: cover`, full rail width, 64px each — no boxes/borders) + range label overlaid at the bottom (white + scrim gradient). Hovering a photo pops a fixed preview sized to the image's real ratio (natural dims preloaded once per URL, cached, fit within 320px; cover fills exactly, no letterbox, no fill bg, full opacity). **Highlight = opacity**: inactive `.45`, hover `.8`, active `1` (scroll-spy maps top-visible tile → range). **One-way follow (page→rail only, no scroll sync)**: body scroll brings the ACTIVE segment into view, centered in the rail box when possible. The rail never drives the page — use click-to-jump. rAF-throttled; rail glides via `scroll-behavior:smooth`, jumps via smooth `scrollTo`, reduced-motion falls back to instant. **Overflow shadows**: inset box-shadow on rail top/bottom whenever that side has more to scroll (refreshed on rail scroll incl. programmatic writes, show/segments change, window resize). Click-to-jump unchanged.
- No drag-scrub bubble (Photos shows a big overlay while dragging) — click-to-jump + active-follow only. Add later if wanted.

## 4. Thumbnails (2 per range)

- Source: reuse tile resolver `thrumb(it)` (poster sibling → photo/gif file itself → `/api/mediathumb` for video). No new endpoints; browser cache shared with grid tiles.
- Pick **first 2 files assigned to that range (post pile-assignment) that yield a thumb URL**, in view order (Gallery: topmost-first within the range). Pile member → use pile cover thumb (first member's thumb).
- Fallbacks: <2 thumb-bearing files → show what exists; none → neutral icon block. A thumb URL that 404s renders an empty neutral block (backgrounds have no error event). Rendered as `background-image` divs (no `<img>`), so no native lazy-loading — fine, ~20 small images, all cache hits from on-screen tiles.

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
