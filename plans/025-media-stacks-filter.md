# 025 — Media page: "Stacks" type filter (show only current stacks in the gallery)

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`).
> Date: 2026-09-19. Status: **Done**.
> Scope: add a **Stacks** chip to the type filter bar (`All · Img · Vid · GIF → + Stacks`). When active, the gallery shows **only the files that belong to a current stack** in this folder; non-stack files are hidden. Stack members still collapse into pile cells (existing gridVisible machinery) so the "current stacks" appear as stacks. No backend/API change, no list-view semantic change, no `StacksContext.jsx` change.

---

## 1. Objective

The type filter bar (`Media.jsx:2916-2920`) currently offers **All / Img / Vid / GIF**, backed by `TYPE_CHIPS` (`Media.jsx:102`) and applied per-file in `applyViewOrder` (`Media.jsx:447`) via `fileCategory(it.name)`. Stacks are already modeled on the client & server: each media item carries `it.stacks = [{id, name, count}]` (server annotates in `GET /api/media`, `api-server.js:820-824`), and in Gallery sort 2+ visible members of a stack render as one **pile cell** (`gridVisible`, `Media.jsx:1859-1899`).

Add a **Stacks** filter chip: selecting it hides every non-stack file and keeps only stack members, so the grid displays exactly the current stacks available in this gallery (folders stay visible, as with every other type filter).

| Type chip | Grid shows |
|-----------|-----------|
| `All` | everything (today) |
| `Img` / `Vid` / `GIF` | only files whose extension category matches (today) |
| `Stacks` **(new)** | only files belonging to a stack in this folder; non-stack tiles hidden; 2+ visible members of the same stack still form a pile |

## 2. Desired behavior (source of truth)

A file passes the type filter when:

```js
if (type === "stacks") {
  if (!(Array.isArray(it.stacks) && it.stacks.length > 0)) return false; // not a stack member → hide
} else if (type !== "all" && fileCategory(it.name) !== type) {
  return false;
}
```

- **Stacks = available in the gallery:** membership comes from the same `it.stacks` data already used by pile grouping, so only stacks that actually exist in this folder/view pass. There is no separate "list of all stacks ever" to consult.
- Folders stay visible (`Media.jsx:441`) — unchanged, same as Img/Vid/GIF.
- Grid (Gallery sort): member files group into pile cells exactly like today; a stack with 1 visible member renders as its single tile (it *is* the stack's presence).
- List view / non-Gallery sorts: type filter still applies (files pass/fail per the rule above); no piles are rendered there today, so stack members just show as rows/tiles — consistent with how Img/Vid/GIF behave outside Gallery.
- Playlist view: the same rule filters playlist items to stack members if the chip is active; stacks themselves are a grid-only concept, so this only ever hides non-member rows (acceptable, matches existing filter semantics).

## 3. Implementation

### 3.1 Add the chip (`Media.jsx:102`)

```js
const TYPE_CHIPS = [["all", "All"], ["photo", "Img"], ["video", "Vid"], ["gif", "GIF"], ["stacks", "Stacks"]];
```

Placed **last**, after GIF. The render loop (`Media.jsx:2917-2919`), `setType` (`Media.jsx:170`), the `?type=` URL param, and the `t` keyboard cycle (`Media.jsx:1096-1102`, which derives its order from `TYPE_CHIPS.map((c) => c[0])`) all pick up the new value with **no further edits** — `type === "stacks"` flows through `setParam("type", "stacks")` and `searchParams.get("type")`.

### 3.2 Apply the filter (`Media.jsx:447`)

Replace the single per-file category check with the branching rule from §2:

```js
if (type === "stacks") {
  if (!(Array.isArray(it.stacks) && it.stacks.length > 0)) return false;
} else if (type !== "all" && fileCategory(it.name) !== type) {
  return false;
}
```

### 3.3 Already working, no changes needed

- **Piles form from the filtered set** — `gridVisible` (`Media.jsx:1859`) consumes `filtered`, which already ran `applyViewOrder`; with only stack members left, pile grouping produces exactly the current stacks (Gallery sort only, per Plan 023).
- **`filtersActive`** (`Media.jsx:499`) becomes true for `type !== "all"`, so reorder drag/stack drag stays disabled while the Stacks filter is on — same as Img/Vid/GIF.
- **Empty state** — folder with no stack members shows the existing `media-empty-filters` notice with its "Clear search & type filter" button (`Media.jsx:509-516`).
- **Reset on change** — the existing reset effect (`Media.jsx:427-432`) already resets multi-select/spread when `type` changes.

## 4. File change list

| File | Change |
|------|--------|
| `web/src/views/Media.jsx` | `TYPE_CHIPS`: append `["stacks", "Stacks"]`; `applyViewOrder` line 447: branch for `type === "stacks"` (stack-membership check) |
| `plans/025-media-stacks-filter.md` | This plan |

No server, store, or other component changes.

## 5. Implementation steps

1. Append the `["stacks", "Stacks"]` entry to `TYPE_CHIPS` (`Media.jsx:102`).
2. Update the type filter in `applyViewOrder` (`Media.jsx:447`) with the stacks branch.
3. `cd web && npm run build` + manual pass (§6). Lint: `cd web && npm run lint` (oxlint).

## 6. Verification

```bash
cd web && npm run build
cd web && npm run lint
```

Manual (run the web app against the API, e.g. `npm run dev` in `web/` proxying to `:6767`):
- Folder with stacks + loose files → click **Stacks**: only pile cell(s)/stack-member tiles remain; loose files are gone; folders still listed.
- Stack state sanity: open a pile (click member) → spread shows the members; collapse back.
- All / Img / Vid / GIF unchanged from today.
- No-stack folder + **Stacks** selected → "No files match the current filters" empty notice; Clear button restores the view.
- `t` keyboard cycle now walks All → Img → Vid → GIF → Stacks.
- List view: **Stacks** shows only stack-member rows (no piles, as today).