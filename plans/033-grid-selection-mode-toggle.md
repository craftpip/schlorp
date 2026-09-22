# 033 — Grid selection mode toggle: single vs multi

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`, no backend change).
> Date: 2026-09-22. Status: **Proposed**.
> Scope: grid view only. List view stays single-select (`tapItem`). Touch tap behavior unchanged.

---

## 0. Understanding check

- Today right-click **adds** to the selection (join). You want right-click to **move the selection to the current item only** — for a collapsed pile that means its members become the selection and the pile stays collapsed (the outcome you get from shift+click today: whole stack selected, not opened).
- A **toggle button** beside the view-toggle (`data-testid="media-view-toggle"`) switches between:
  - **Single (button off, default):** left-click and right-click select **only** the current item (file → 1 key; pile → its member keys, no spread).
  - **Multi (button on):** left-click **toggles** the cell in/out of the selection; right-click **adds** the cell to the selection, then opens the menu (today's join behavior).
- Explicit modifiers always work regardless of mode: Shift+click = range, Ctrl+click = toggle.

## 1. Behavior matrix (grid only)

| Input | Single (off) | Multi (on) |
|-------|--------------|------------|
| Left-click file | Replace selection (today: incl. click-again-to-deselect, spread collapse) | Toggle in/out, no spread change; anchor+primary = clicked |
| Left-click pile | Spread + select first member (today; locked: select all, no open) | Toggle whole stack in/out (all members); **never** spread/collapse; anchor+primary = first member |
| Right-click file | Selects only this file, unless already selected (kept) | Opens menu, changes nothing |
| Right-click pile | Selects only its members (collapsed), unless already selected (kept) | Opens menu, changes nothing |
| Shift / Ctrl + click | Unchanged | Unchanged |

Note: single-mode pile right-click replaces with the pile's *members*, not a literal anchor-range — i.e. the shift+click outcome for "select this stack without opening it". Say so if you meant a literal anchor range instead.

## 2. Implementation

### 2.1 State + button (`Media.jsx`)

```js
const [multiSelect, setMultiSelect] = useState(false);
```

Button inside `#media-side-controls`, immediately after the `media-view-toggle` div:

```jsx
<button data-testid="media-multiselect-toggle" type="button"
  disabled={!isGrid || inPlaylistView}
  className={`btn btn-sm ${multiSelect ? "btn-primary" : "btn-outline-secondary"}`}
  onClick={() => setMultiSelect((v) => !v)}
  title={multiSelect ? "Multi-select on — clicks add/remove" : "Multi-select off — clicks select one"}
  style={{ height: 25, width: 25, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 6 }}>
  <i className="bi bi-check2-square" style={{ fontSize: 12 }} />
</button>
```

Mode is sticky across folders/sorts (like `stacksMode`); the existing selection-reset effect on `[folder, isFlat, type, filter, sort, activePlId]` still clears `selKeys`.

### 2.2 Plain left-click (`gridClickHandler`, `Media.jsx:2483-2520`)

After the `shift`/`ctrl` branches, branch the plain-click section on `multiSelect`:

- **File + multi:** `toggleSelection(entry); return;` (existing helper: add/remove, carries lone primary, sets anchor+primary, no spread for files).
- **Pile + multi:** all `cellKeys` in `selKeys` → remove them; else add them. `setAnchorKey(cellKeys[0]); setSelectedKey(cellKeys[0]); return;` No `setSpreadStackId`/`closeSpread` touch.
- **Single:** today's code untouched.

### 2.3 Right-click (`openContextMenu`)

- **Single:** moves the selection to the current cell only (file → 1 key; pile → member keys, staying collapsed), then opens the menu.
- **Multi:** selection-neutral — only opens the menu for what is already selected (actions fall back to the right-clicked entry when empty).

### 2.4 Explicitly NOT changing

- `toggleSelection` / `shiftSelectTo` / keyboard nav / Ctrl+A / Esc — untouched.
- Coarse-pointer tap branch in `gridClickHandler` — untouched.
- List rows, playlist views — untouched (`tapItem` path).
- `moveTargets`/`selectedKeysForStack`/menu actions consume `selKeys` as today.

## 3. File change list

| File | Change |
|------|--------|
| `web/src/views/Media.jsx` | `multiSelect` state; toggle button (§2.1); plain-click branch (§2.2); right-click replace-vs-join (§2.3) |
| `plans/033-grid-selection-mode-toggle.md` | This plan |

## 4. Verification

```bash
cd web && npm run build
```

Manual (Gallery folder with a 3-file stack + 2 loose files):
- **Single (default):** click file A → only A selected. Click file B → only B. Right-click B → only B + menu. Right-click pile → 3 members selected, pile collapsed + menu with Move stack. Click pile → spreads, first member selected (today).
- **Multi on:** click A → {A}; click B → {A,B}; click A again → {B}. Click pile → {B + 3 members}, pile stays collapsed. Right-click loose file C → {B, members, C} + menu.
- **Modifiers ignore mode:** Shift+click still ranges; Ctrl+click still toggles in both modes.
- **Mode switch mid-selection:** turning multi on keeps current selection; turning off keeps it too (next click replaces).
- **Sort switch / folder switch:** selection clears (existing reset); mode stays.
- **List view:** toggle disabled; rows single-select as today.
