# 024 — Media grid context menu as a centered popup with a full stacks grid (mobile-friendly)

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`, `web/src/components/MediaContextMenu.jsx`, `web/src/styles.css`).
> Started: 2026-09-19. Status: **PLANNED** (awaiting implementation approval).
> Scope: the media grid right-click context menu only — reposition from a cursor-anchored box to a **window-fixed, screen-centered popup**, and give the add-to-stack section a proper grid with room to breathe. No backend/API change, no change to menu actions or their handlers, no list/playlist view, no PlaylistHoverMenu, no FileViewer.

---

## 1. Objective

Today the grid context menu is a small box anchored at the cursor (`position: fixed; left: menu.x; top: menu.y`, `minWidth 200`) — it can clip at the screen edge and carries only a cramped 3×n stack thumbnail strip (`rest.slice(0, 5)`).

Make right-click (and mobile long-press, which already synthesizes `openContextMenu`) open a **popup that is fixed to the window and centered on screen — a modal-style dialog** (same visual language as `ConfirmModal`): dimmed full-screen backdrop + centered card. Inside the card the **add-to-stack section becomes a roomy thumbnail grid** (auto-fit columns, larger cells, and the `rest` list no longer truncated to 5) with the card body scrolling if stacks overflow. The whole thing must feel native on a phone (fit small screens, scroll-locked, big tap targets, backdrop-tap to dismiss).

Everything else about the menu — the exact actions (`Stack N items`, Open, Delete, pile Rename/Unstack/Remove-from-stack), their `onClose(); onX()` handler wiring in `Media.jsx`, selection semantics — is unchanged.

---

## 2. Current state (diagnosis, verified in code)

### Where the menu is opened (`Media.jsx`)
- Per-tile right-click: `Media.jsx:1663` → `openContextMenu(e, { kind: "file", it, key })`.
- Pile right-click + empty-area right-click: `Media.jsx:2804-2809` (empty area → `entry: { kind: "file", it: null, key: null }`).
- Mobile long-press (plan 022 touch controller): `Media.jsx:2559` synthesizes `L.openContextMenu({ clientX, clientY, preventDefault(){}, stopPropagation(){} }, entry)`.
- `ctxMenu` state holds `{ x, y, entry }` (`Media.jsx:2333`); per-tile opens also set `ctxMenuStackId` (pile → `stackId`, file → first stack id), used by the pile/flat "Remove from stack" actions at `Media.jsx:3086-3098`.
- Close-on-outside/Escape effect: `Media.jsx:2349-2359` — a `document` `mousedown` listener that ignores any event whose target matches `[data-testid="media-context-menu"]`, plus an `Escape` key handler.

### Current menu render (`MediaContextMenu.jsx`)
- Root: `position: fixed; left: menu.x; top: menu.y; zIndex: 100; minWidth: 200; …; padding: 4` (`MediaContextMenu.jsx:20-25`), `data-testid="media-context-menu"`.
- Add-to-stack section: one `Stack N items` `<MenuItem>` (create), then a grid `repeat(3, 60px)` (`Media.jsx:27-36`) — `own` (already-member stacks) first with a `✓` overlay, then `restShown = rest.slice(0, 5)`. Cells 60×48 (`StackCell`, `MediaContextMenu.jsx:78-101`), `data-testid="media-ctx-add-stack"`.
- Then `<Divider>` + Open + Delete, plus pile-only / member-only pile actions.

### Established modal pattern to mirror
- `ConfirmModal.jsx:21-29`: `position: fixed; inset: 0; zIndex: 200; display:flex; alignItems:center; justifyContent:center; padding:16; background: rgba(6,8,18,0.55); backdropFilter: blur(6px)`, inner card stops propagation; body `overflow: hidden` while open. Reuse this shell verbatim (slightly different zIndex so it never fights the confirm/alert stack).

### Key facts shaping the design
- Stack thumbnails are already resolved client-side (`stackMenuEntries`, `Media.jsx:2371-2381` — picks the member that's visually first in the current grid order). The popup only re-sizes/reflows what's already available.
- The `document` `mousedown` close listener excludes anything inside `[data-testid="media-context-menu"]` — if that testid sits on the **outer shell**, every click inside the card (backdrop excluded) is already ignored and closing stays correct; backdrop taps close the menu without extra handlers.
- `ctxMenu.x/y` are only consumed for anchoring — after this change they become unused but stay in state (harmless; `openContextMenu` signature and the touch synthesizer keep passing them).
- Mobile already reaches this menu via long-press (plan 022) — no gesture code changes needed; the popup simply replaces the finger-anchored box with a centered dialog, which is *better* on small screens (nothing pinches the viewport edge, backdrop = big dismiss target).

---

## 3. User spec (verbatim, 2026-09-19)

> in the media page, when i right click, show the context menu as a popup, that is fixe on the window, like a popup in center of the screen, it will have stacks grid so more space will be there ot show that, also this view will work well on mobile. create plan for it

---

## 4. Design

> Decision: client-side only in `MediaContextMenu.jsx` (+ small `styles.css` additions). `Media.jsx` needs no functional change — the `menu={ctxMenu}` prop and all handlers stay; only the component's *shell* changes.

### 4.1 Popup shell (replaces the anchored box)

`MediaContextMenu` renders — when `menu` is truthy — a modal shell instead of the `left/top`-anchored div:

- **Backdrop:** `position: fixed; inset: 0; zIndex: 120; display: flex; alignItems: center; justifyContent: center; padding: 20px; background: rgba(6,8,18,0.55); backdropFilter: blur(6px)` — identical to `ConfirmModal` so the two dialogs feel like one family. `data-testid="media-context-menu"` moves **to this outermost shell** so the existing outside-click exclusion in `Media.jsx:2352` keeps working exactly as-is.
- **Card:** `width: min(520px, 100%); maxHeight: calc(100vh - 48px); background: var(--surface); border: 1px solid var(--border); borderRadius: 12; boxShadow: 0 12px 32px rgba(0,0,0,.25); display: flex; flexDirection: column; overflow: hidden;` with `onClick={(e) => e.stopPropagation()}` (backdrop taps then fall through to the shell's close = tap-outside-to-dismiss).
- **Scrollable body:** action rows + stack grid live in a `flex: 1; minHeight: 0; overflowY: auto; padding: 4px` wrapper, so a folder with many stacks scrolls *inside the card* instead of overflowing the screen.
- **Scroll lock:** a `useEffect` (runs when `menu` is truthy) mirrors `ConfirmModal`: `document.body.style.overflow = "hidden"` on open, restore on close.
- **Enter animation:** a subtle `fade + scale(.98→1)` via a small CSS class on the card (~120ms, ease-out). No cursor-anchor — the popup is always centered.

The menu **items** (create / Open / Delete / pile actions) render inside the body unchanged — same `MenuItem`/`Divider`, same `data-testid`s (`media-ctx-stack-create`, `media-ctx-stack-grid`, `media-ctx-add-stack` preserved for any existing selectors).

### 4.2 Stacks grid — more room

- Grid: `display: grid; gridTemplateColumns: repeat(auto-fill, minmax(72px, 1fr)); gap: 8px; padding: 8px` (CSS class `.media-ctx-grid`, not inline, so a mobile breakpoint can shrink `minmax`).
- Cells: `aspect-ratio: 6 / 5` — taller (≈72×60) than today's 60×48, with a bigger count badge, existing `✓` member overlay + accent border, `title` tooltip, same click/disabled semantics, `loading="lazy"` thumbs. `data-testid="media-ctx-add-stack"` unchanged.
- **`rest` cap removed:** the current `rest.slice(0, 5)` (`MediaContextMenu.jsx:18`) is dropped — own stacks then **all** remaining stacks render (the card body scrolls). This is the "more space … to show that" ask.
- Ordering preserved: `own` (member) stacks first, then `rest`, one continuous grid (no `own`/`rest` divider) as today.

### 4.3 Mobile behavior

- Built on plan 022: long-press a file/pile already calls `openContextMenu` → the same popup opens, now centered and never clipped at the finger/screen edge.
- Small screens: `@media (max-width: 560px)` → card `width: min(94vw, 520px)`, `maxHeight: 72vh`, grid `minmax(56px, 1fr)`; touch targets already ≥ ~44px tall (cells + `MenuItem` padding bumped slightly via the responsive class if needed).
- Dismissal: tap the backdrop (big safe target), or `Escape` (existing key handler). Body scroll is locked while open.

### 4.4 Untouched

- All action semantics + handler wiring in `Media.jsx` (`onStack/onOpen/onDelete/onAddToStack/onRename/onUnstack/onRemoveFromStack`, `ctxMenuStackId` resolution).
- `openContextMenu` signature, `ctxMenu = { x, y, entry }` shape (x/y now unused by the renderer).
- Desktop DnD, tap-select, two-finger drag, playlist hover menu, list view, playlists, FileViewer.
- Backend, `/api/stacks`, `/api/mediaorder`.

---

## 5. Files

| File | Change |
|------|--------|
| `web/src/components/MediaContextMenu.jsx` | Replace the `left/top`-anchored root with a centered modal shell (backdrop + card + scrollable body); move `data-testid="media-context-menu"` to the shell; add body-scroll-lock `useEffect`; add a small enter animation class |
| `web/src/components/MediaContextMenu.jsx` | Stack grid → `.media-ctx-grid` (`repeat(auto-fill, minmax(72px, 1fr))`), taller `aspect-ratio: 6/5` cells, larger count badge; drop `rest.slice(0, 5)` cap (all stacks shown) |
| `web/src/styles.css` | `.media-ctx-grid`, `.media-ctx-card` (fade/scale-in), responsive `@media (max-width: 560px)` overrides (card `94vw`/`72vh`, `minmax(56px, 1fr)`) |

`web/src/views/Media.jsx` — **no functional change expected.** The existing close-on-outside/Escape effect already works through the shell testid.

---

## 6. Verification

- `cd web && npm run build` passes; `npm run lint` clean (no new warnings).
- Manual (desktop):
  1. Right-click a file tile → centered popup over a dimmed blurred backdrop; card is window-fixed (scrolls nowhere), stack grid shows member stacks first then **all** stacks, larger cells/columns.
  2. Folders with >5 stacks → card body scrolls inside the card; no page scroll.
  3. Multi-select right-click → `Stack N items` still reflects selection count; clicking a stack cell still adds/moves the selection.
  4. Pile + flat-file right-click → Remove-from-stack / Rename / Unstack rows appear exactly as today; Empty-area right-click keeps its selection-based menu.
  5. Esc and backdrop tap both close; body scroll is locked while open, restored after.
  6. All actions still fire: create, open, delete, rename, unstack, remove-from-stack.
- Manual (mobile — DevTools touch emulation or real device):
  1. Long-press a tile/pile (plan 022) → popup opens **centered**, fully on-screen, no clipping at the viewport edge.
  2. Grid fits a phone width; body scrolls; tapping the backdrop dismisses; single tap / two-finger drag unaffected.
- Regression: desktop right-click everywhere, tap-select, two-finger reorder, click-drag, list view, playlist view — unchanged.

---

## 7. Open decisions (defaults chosen unless user objects)

1. **Show all stacks, no cap** (default) — the card body scrolls when there are many. If a folder has hundreds of stacks we could cap at e.g. 48 with a "…" indicator; say so if you'd rather cap.
2. **Column count is responsive `minmax` auto-fill** (default) ≈ 6 cols at 520px / 3–4 on a phone — not a fixed count.
3. **No explicit close header/button** (default) — backdrop tap + Esc are the dismiss affordances, keeping the popup minimal. A top-right `×` is an easy add if you want a visible one on mobile.
4. **Simple fade/scale-in** with no cursor-anchored origin animation — the popup always centers.

---

## 8. Progress log

- **2026-09-19** — Diagnosed the current anchored render (`MediaContextMenu.jsx:20-36`, `rest.slice(0,5)` at :18), the open paths (`Media.jsx:1663, 2804-2809`, touch synth `2559`), and the close effect + scroll-lock precedent (`Media.jsx:2349-2359`, `ConfirmModal.jsx:21-29`). Wrote this plan. Awaiting implementation approval.
- **2026-09-19 — IMPLEMENTED, awaiting user confirm:** `MediaContextMenu.jsx` now renders a centered modal shell (backdrop `rgba(6,8,18,0.55)` + blur, `zIndex 120`, `data-testid="media-context-menu"` moved to the shell so the `Media.jsx:2352` outside-click exclusion still works; card `width:min(520px,100%)`, `maxHeight:calc(100vh - 48px)`, flex column, scrollable body; `onClick={onClose}` backdrop tap-to-dismiss + `stopPropagation` card). Added a body-scroll-lock `useEffect` while open. Stack grid switched to `.media-ctx-grid` (`repeat(auto-fill,minmax(72px,1fr))`, gap 8, padding 8), cells now `width:100%; aspect-ratio:6/5` with larger count/✓ badges, and `rest.slice(0,5)` cap removed (all stacks render, card scrolls). `styles.css`: `.media-ctx-card` (fade/scale-in keyframes) + `.media-ctx-grid`; `@media(max-width:560px)` → card `min(94vw,520px)`/`72vh`, grid `minmax(56px,1fr)`. `Media.jsx` untouched. Verified: `npm run build` ✓, `npm run lint` exit 0 (no new warnings). Manual desktop/mobile check pending user.