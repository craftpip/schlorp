# 030 — Media page: sticky overflow (`...`) menu on mobile

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`, `web/src/styles.css`).
> Date: 2026-09-21. Status: **Done** (implemented 2026-09-21).
> Scope: mobile (`≤640px`) sticky toolbar only. Desktop unchanged. No backend/API change, no URL-param change, no selection/sort/filter semantics change.
>
> Implementation note (deviation from §3.1 draft): no wrapper `media-menu-panel`
> div — toolbar and side controls stay in their exact desktop DOM positions and
> collapse via a `menu-open` class + `data-menu-open` attribute on `media-sticky`
> (`Media.jsx:3147`). Toggle testid is `media-menu-toggle` as planned. This keeps
> the desktop render byte-identical with zero conditional JSX.
>
> Follow-up 2026-09-21 (360px / Galaxy S23): filter input compact in open panel
> (`flex:0 1 110px`, 28px high); breadcrumb path hidden while menu open
> Follow-up 2026-09-21 (360px / Galaxy S23, continued): Up also hidden while
> menu open (open row = ✕ pinned right); sort "Gallery" abbreviated to "Gal"
> on mobile only via dual spans (`media-sort-full`/`media-sort-abbr`, desktop
> keeps full label; Name/Size/Time already ≤4 chars, unchanged).
>
> Follow-up 2026-09-21 (fixed 3-row panel): toolbar children grouped into
> `media-tools-row` wrappers (`display:contents` on desktop = zero desktop
> change; real flex rows on mobile-open) — row1 search+refresh, row2
> type+flatten; toggle moved before side controls so row3 (view/sort,
> swipeable on overflow) drops to its own line.
>
> Follow-up 2026-09-21 (✕ placement): toggle moved after side controls so the
> close button sits in row 3 with the ordering buttons; side controls share
> the row (`flex:1 1 auto`, swipeable) with ✕ pinned right.

---

## 1. Objective

On mobile the sticky menu (`data-testid="media-sticky"`, `Media.jsx:3144`) currently takes **4 rows**:
row 1 filter alone (`.media-filter{flex:1 1 100%}`), rows 2–3 refresh + type chips + Flatten wrapping, rows 3–4 breadcrumbs + Up + view-toggle + sort-bar (Gallery/Name/Size/Time labels are the widest item).

Collapse it to a persistent **1 row** (breadcrumbs + `...` menu button). Tapping `...` reveals all filter options in an inline expanding panel (pushes grid down). Agreed layout:

```
Collapsed (1 row):  [⌂ Media / foo / bar] [↑ Up] [...]

Expanded:           [⌂ Media / foo / bar] [↑ Up] [✕]
                    [Filter files…          ] [⟳]
                    [All][Img][Vid][GIF][Stacks]
                    [view][stacks][Gallery][Name][Size][Time][Flatten]
```

## 2. Desired behavior (source of truth)

- Collapsed sticky = breadcrumb row only: `media-breadcrumb-path` (scrollable `nowrap`, `flex:1`) + `media-up` (icon-only on mobile) + menu toggle right (`data-testid="media-menu-toggle"`, `bi-three-dots` → `bi-x-lg`, `aria-expanded`, `aria-controls="media-menu-panel"`).
- Expanded panel (`data-testid="media-menu-panel"`) contains the *same* controls, not duplicates: `media-filter` + `media-refresh` (row 2), `media-type-filter` (row 3, icon-only as today), view-toggle + `media-sort-bar` + flatten (row 4 group).
- Panel stays open across filter/type/sort/view/flatten interactions (multi-apply). Closes on: toggle press, `Escape`, folder/Up/root/playlist navigation (`goCrumb`, `goUp`, root button, playlist open/close).
- Desktop (`>640px`): toggle hidden, panel always visible, layout byte-identical to today.
- Inline expansion (panel in normal flow, pushes grid down). No overlay/outside-click/focus-trap. `scrollSelectionIntoView` already reads live `sticky.offsetHeight` (`Media.jsx:886-887,1098`) — no scroll math changes.
- Minimal, modern, elegant: no new colors, existing `.btn`/icon sizes, panel separated by existing `border-bottom` on the sticky.

## 3. Implementation

### 3.1 `Media.jsx`

1. State near other UI state (e.g. after `showHelp`): `const [menuOpen, setMenuOpen] = useState(false);`
2. Restructure sticky block (`Media.jsx:3144-3195`):
   - `media-breadcrumbs` row stays on top; append toggle button at its end (inside the right-side group, after sort-bar container — or as its own trailing element; must be visible even when panel closed).
   - Wrap the `media-toolbar` div (`3145-3154`) + the view/sort controls currently inside `media-breadcrumbs` right group (`3179-3193`) into panel container `<div data-testid="media-menu-panel" className={menuOpen ? "media-menu-panel open" : "media-menu-panel"} ...>`. Breadcrumb path + Up stay outside.
   - Simplest robust variant: keep DOM order, give `media-toolbar` and the right-side controls wrapper a shared parent panel div. Move `media-view-toggle` + `media-sort-bar` out of the breadcrumbs row into the panel (they are view controls, not navigation).
   - `Escape` handling: extend existing Esc branch (`Media.jsx:1137`) — if `menuOpen`, close it first (before spread-collapse? menu close is sticky-level, spread is grid-level; order: help → ctxMenu → modals → menu → spread).
   - Navigation closes: `goCrumb`, `goUp`, root button `onClick`, `openPlaylist`/`closePlaylist` call `setMenuOpen(false)`.
3. No testid/icon/behavior changes to existing controls — only their container.

### 3.2 `styles.css` (`@media(max-width:640px)` block, ~669-701)

- `.media-menu-toggle{display:inline-flex}` (hidden by default on desktop: `.media-menu-toggle{display:none}` outside the query).
- Mobile: `.media-menu-panel{display:none}` / `.media-menu-panel.open{display:flex; flex-direction:column; ...}`; breadcrumb row `flex-wrap:nowrap`, path `overflow-x:auto`.
- Keep `.media-filter{flex:1}` (not 100%) *inside the open panel* so filter + refresh share row 2: `.media-menu-panel.open .media-filter{flex:1 1 auto; max-width:none}`.
- Type chips + sort/view groups: `flex-wrap:wrap` inside panel (they may wrap within the panel — acceptable, panel is temporary).

### 3.3 What is NOT changing

- All `data-testid`s, URL params (`q/type/sort/dir/view/flat/spread`), keyboard shortcuts (`1` focuses filter — should auto-open panel first on mobile if closed), filter/sort/selection logic.
- `1`-key shortcut: if panel closed on mobile, open it then focus (else focus lands in a `display:none` input).

## 4. Verification

- `npm --prefix web run lint` (oxlint) + `npm --prefix web run build` (vite) — must pass.
- Manual/DOM check: render Media at 390px width; assert collapsed sticky shows only breadcrumb + toggle (1 row); toggle opens panel with all controls functional; `Escape`/navigation closes; desktop width shows no toggle and full toolbar.
- No `web/test` suite exists (root `test/` is backend only) — no new test files; verify via build + DOM audit.

## 5. Risks / notes

- Moving view-toggle/sort-bar out of the breadcrumbs row changes desktop DOM order unless the panel is transparent on desktop (panel = `display:contents` on desktop so visual order is identical). Prefer `display:contents` wrapper on desktop to avoid any desktop regression.
- Inline expansion shifts grid content down — expected and accepted (vs overlay).
