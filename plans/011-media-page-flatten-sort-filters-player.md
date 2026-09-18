# Plan 011 — Media Page: Flatten, Sorting, Type Filters, Player Changes

**Date:** 2026-09-02
**Status:** Done
**Owner:** xdl web panel (React app served at `/`, `web/`)
**Scope:** `web/src/views/Media.jsx`, `web/src/components/FileViewer.jsx`, `api-server.js` (`GET /api/media`)

## 1. Probe findings (current state)

### Media page — `web/src/views/Media.jsx` (303 lines)
- `folder` read from URL `?folder=`. `load(folder)` → `GET /api/media?folder=…` → `items` `[{name, dir, size, mtime}]` (api-server.js:599).
- Text filter from `?q=`. `filtered` then keeps **only dirs OR videos** — `Media.jsx:101` `base.filter((it) => it.dir || fileCategory(it.name) === "video")`. **Photos and GIFs are currently invisible on the Media page.**
- Table columns: `Name | Size | Time | Actions` (static header, `gridTemplateColumns: "1fr auto auto auto"`, `Media.jsx:201`). No sort interaction.
- Time column shows `timeAgo(it.mtime)` (`Media.jsx:217`) — modification time, not created time.
- Viewer wiring (`Media.jsx:231-300`): `viewable = filtered.filter(it => !it.dir)`; **`sameViewable = viewable.filter(it => fileCategory === curCat)`** — prev/next only cycles the *same category* (e.g. videos only), NOT the displayed list.
- Keyboard: arrows/`wasd`/`Space` navigate + open. Delete via `DELETE /api/media?folder=&name=` (`Media.jsx:155-161`) — rejects `name` containing `/` (api-server.js:638).

### Player — `web/src/components/FileViewer.jsx` (641 lines)
- Format detection: `isVideo` / `isAudio` / `isImage` by extension (`FileViewer.jsx:84-86`). GIF → image (`<img>`, animated OK). MKV/unknown → falls into `<video>` and silently fails.
- End-mode toggle (`cycleEndMode`, `FileViewer.jsx:235`): `none → stop → next → repeat → random → none`. Button labels/colors at `FileViewer.jsx:625-626`; `stop`/`repeat`/`random` handled in `handleVideoEndedRef` (`FileViewer.jsx:203-227`).
- End mode persisted in `localStorage` `xdl_viewer_endMode`; initial state `"none"` (`FileViewer.jsx:58`).

### Backend — `api-server.js`
- `GET /api/media` (599): one-level `readdir`, items `{name, dir, size, mtime}`, dirs-first then mtime-desc, containment via `resolveMediaOutputDir` (2070).
- `DELETE /api/media` (633): `name` must not contain `/`.
- `app.use("/media", express.static(mediaDir))` serves files (598).

### Media layout
- `media/` is mostly **one level deep**: source/account folders (`reddit/`, `boobs/`, `ass/`, …) containing files directly. Sub-sub-folders are possible (`media/studies` mounts are deeper via docker).
- Docker host bind: `/mnt/media2t/downloads/studies/xdl` → `/app/media`; `.debug-snapshots` is a directory (skip-friendly in flat mode).

## 2. Goal / Scope

Add to the Media page:

1. **Flatten toggle** — one click lists **all files recursively** under the current folder flat, each displayed as `folder name > file name.format` (e.g. `reddit > 2busty2hide-160dy37.gif`; at root `reddit > name.gif`; deeper `studies/folder > name.mp4` → `folder > name.mp4`).
2. **Sortable table headers** — Name, Size, Time click to cycle sort. **Time = file created time** (`birthtime`, fallback `ctime`/`mtime`). Dirs stay rows; flat mode has no dir rows.
3. **Media-type filter chips** — `All | Photos | Videos | GIFs`, default **All** (photos/gifs now included by default; previously hidden).
4. **Hide `-poster.*` thumbs** — the downloader writes `-poster.jpg` thumbnails next to videos (`2busty2hide-180hyq7.mp4` + `2busty2hide-180hyq7-poster.jpg`). They must NOT appear in the listing (list, player, or item count). Pattern: `/-poster\.(jpe?g|png|webp|avif|gif)$/i`.
5. **Player**
   - Views files **exactly as displayed in the list** (flat + filters + sort apply to prev/next/loop/shuffle order and the `<idx/total>` counter).
   - Supports all listed formats; unknown/unsupported extensions get a graceful fallback panel instead of a broken `<video>`.
   - **End-mode toggle keeps only `Next`, `Loop`, `Shuffle`** (drop `stop`; `none` disabled-state default stays).

Out of scope: legacy `index.html` (dead code — `/` serves `web/dist`), dashboards/completed lists, HLS transcoding.

## 3. Architecture — files to change

```
api-server.js                    → GET /api/media: add created (birthtime) + flat=1 recursive listing (helper walkMedia)
web/src/views/Media.jsx          → flat toggle, sortable headers, type chips, player viewable = displayed list
web/src/components/FileViewer.jsx→ end-mode cycle (next/loop/shuffle only), format fallback UI, safe migration of stored "stop"
web/dist                         → rebuild (npm run build) and serve; no restart needed for code (dist served), but api-server needs reload for the API change
```

Backend `DELETE /api/media` **unchanged** — flat-mode delete forwards `folder=<parent>` + `name=<basename>` (see §4.4).

## 4. Detailed design

### 4.1 Backend — `GET /api/media` gains `created` + `flat=1`

**Always** add per-item `created`:
```js
const birth = stat.birthtime && Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtime : null;
const created = birth || stat.ctime || stat.mtime;
// item.created = created.toISOString(); item.mtime unchanged
```

**`flat=1`** — recursive walk of `resolveMediaOutputDir(folder)`:

```js
const FLAT_MAX_DEPTH = 32;
async function walkMedia(dir, relPrefix, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;            // never follow links (containment)
    const full = path.join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (rel.split("/").length > FLAT_MAX_DEPTH) continue;
      await walkMedia(full, rel, out);
      continue;
    }
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || stat.isDirectory()) continue;
    out.push({ name: entry.name, rel, dir: false, size: stat.size, mtime: stat.mtime.toISOString(), created: /* same logic */ });
  }
}
```

- Only **files** are emitted in flat mode (no dir rows).
- Response: `{ ok, folder, flat: true, items }`. Items carry `rel` (path relative to the requested `folder`, `/`-separated).
- Non-flat path unchanged (keeps `name`/`dir`/`size`/`mtime` + new `created`).
- Sort: server keeps current order (or insertion order for flat). **Client owns all sort decisions** (default: creation time desc; see §4.3).

### 4.2 Frontend — state model (`Media.jsx`), all URL-backed

**Poster-thumb filter** — at `load()` time, drop items matching `isPosterFile()` (`/-poster\.(jpe?g|png|webp|avif|gif)$/i`) so the item badge, list rows, and player navigation all stay consistent (dirs always kept).

New URL search params on top of `folder`/`q`:
| param | values | default |
|-------|--------|---------|
| `flat` | `1` | off |
| `type` | `all`\|`photo`\|`video`\|`gif` | `all` |
| `sort` | `name`\|`size`\|`time` | (none) |
| `dir`  | `asc`\|`desc` | (none) |

Helpers `setParam(k,v)` / `clearParam(k)` update `searchParams` with `{ replace: true }`.

`load(folder)`:
```js
const r = await fetch(`/api/media?folder=${encodeURIComponent(folder)}${flat ? "&flat=1" : ""}`);
// flat → items now have .rel; non-flat unchanged
```

**Category mapping** (extend existing `fileCategory`):
```js
video: mp4 webm mkv mov m4v avi mpg mpeg 3gp flv ts m3u8
photo: jpg jpeg png webp bmp avif          // gif NOT here
gif:   gif
audio: mp3 m4a aac ogg wav flac opus       // no chip, included in All only
other: everything else                     // included in All only
```

**Display pipeline** (replaces `Media.jsx:88-102`):
```
base = flat ? items(flat)                 // files only, each has rel
            : items                        // dirs + files

1) type chip  : type=photo → cat photo; video → cat video; gif → cat gif; all → everything
2) text filter: same as today (`!neg term`, matches display name for flat items: strip " > " or match against rel — use full label for matching)
3) dir filter : non-flat keeps dirs; flat already files-only
```

**Display name** — helper `displayName(it, flat)`:
- non-flat: `it.name`
- flat: `it.rel`.replace(/\//g, " > ")  → `subfolder > file.mp4`

Row `<title>`, folder crumbs **unchanged**, but crumbs/folders hidden in flat mode (no dir navigation) — keep crumbs row visible but only "Media" home works; simpler: keep as-is, dir rows simply absent.

**Row data**: non-flat uses `it.size`, `it.created` (fall back to `it.mtime`); flat uses same fields on the flattend item.

**Delete in flat mode** — file at `folder=N&rel=sub/a.mp4`:
```js
const slash = rel.lastIndexOf("/");
const parent = slash === -1 ? folder : `${folder ? folder + "/" : ""}${rel.slice(0, slash)}`;
const base = slash === -1 ? rel : rel.slice(slash + 1);
fetch(`/api/media?folder=${enc(parent)}&name=${enc(base)}`, { method: "DELETE" })
```
Backend `DELETE` unchanged (name has no `/`). Keep `onDeleted` reload.

**`toMediaUrl(folder, relOrName)`** — encode per segment (do NOT encode `/`):
```js
const base = folder ? `${folder}/${relOrName}` : relOrName;
return "/media/" + base.split("/").map(encodeURIComponent).join("/");
```
Pass to viewer `src` / `filePath` = `${folder}/${rel}` so `parseFolderBase` inside FileViewer computes the right parent+base on delete.

### 4.3 Sortable headers (`Media.jsx`)

Header row keeps `gridTemplateColumns: "1fr auto auto auto"`; **Name, Size, Time cells become buttons**:

- Click cycle: `none → default dir → flip → none`:
  - Name → asc → desc
  - Size → desc → asc
  - Time → desc → asc (newest first first-click)
- Active column shows `▲`/`▼`; inactive click resets others (single active sort at a time). Third click clears (`sort`/`dir` removed from URL, back to server/default order).
- Default order (no active sort): non-flat = server order (dirs-first, time desc); flat = `created` desc.
- Sorting applies to the **displayed rows** (dirs included when non-flat; flat has no dirs). Compare: name `localeCompare`; size numeric; time `created` ISO string (fallback `mtime`) timestamp.

### 4.4 Player wiring — view files as displayed (`Media.jsx:231-300`)

**Remove category grouping.** `viewable = filtered.filter(it => !it.dir)` and pass the **full** list to the player:

```jsx
<FileViewer
  src={toMediaUrl(folder, item.rel || item.name)}
  title={displayName(item)}          // shown as label in player header
  filePath={folder ? `${folder}/${item.rel || item.name}` : (item.rel || item.name)}
  viewable={viewable}                // full displayed+filtered+sorted list
  idx={viewerIdx}                    // index within that list (was sameViewable-relative)
  onPrev={() => setViewerIdx(i => Math.max(0, i-1))}
  onNext={() => setViewerIdx(i => Math.min(viewable.length-1, i+1))}
  onGoto={setViewerIdx}
/>
```

- Player counter `Id <idx+1> / <total>` then reflects position in the **displayed list**.
- `handlePrev/handleNext/handleGoto` in Media map directly to full-list indices (no `origIdx` mapping needed).
- Same for player `onDeleted` → reload; existing clamp effect (`Media.jsx:169-174`) still guards stale idx.
- Title: flat item → `displayName` (`folder > name`), non-flat → `name`.

### 4.5 Player — end-mode toggle: next / loop / shuffle only (`FileViewer.jsx`)

- New cycle: `none → next → repeat(loop) → random(shuffle) → none`. **Remove `stop`.**
  ```js
  const cycleEndMode = () => setEndMode((m) => m === "none" ? "next" : m === "next" ? "repeat" : m === "repeat" ? "random" : "none");
  ```
- Labels/icons: `none` → default "End" (aria: no end action), `next` → "Next", `repeat` → "Loop", `random` → "Shuffle". Remove the `stop` color/icon branch.
- `handleVideoEndedRef`: drop the `stop` branch; keep `next`, `repeat` (restart current), `random` (pick different idx).
- Keyboard `r` unchanged (still cycles).
- **Migration**: on init, map stored `"stop"` → `"next"`:
  ```js
  const saved = localStorage.getItem("xdl_viewer_endMode");
  const initEnd = saved === "stop" ? "next" : (saved === "repeat" || saved === "random" ? saved : "none");
  ```

### 4.6 Player — supports all listed formats

- Keep `isVideo/isAudio/isImage` detection; add GIF explicitly to image path (already works via `<img>`).
- Add **fallback for unknown/other** extensions (replace the `else` `<video>` branch — `FileViewer.jsx:585`):
  ```jsx
  ) : isFormatKnown ? (
    <video … />
  ) : (
    <div fallback panel>
      <i className="bi bi-file-earmark-x" /> Cannot preview {ext} in browser — 
      <a href={loadedUrl} target="_blank" rel="noopener" download>Open / download original</a>
    </div>
  )}
  ```
- `isVideo/isAudio/isImage` become conservative: unknown ext → `isFormatKnown = isVideo||isAudio||isImage`; timeline/controls hidden for unknown; wheel/keyboard guarded by existing `isVideo || isAudio` checks (already safe).
- `m3u8/ts` (streamed files, rare in media dir): `isVideo` true; Chrome may not play m3u8 natively — leave as-is (out of scope), note in risks.

## 5. Edge cases

- **birthtime = epoch / unsupported FS**: guard `birthtimeMs > 0`, fall back `ctime` → `mtime`; API always returns a valid `created`.
- **Empty/media root flatten**: `flat=1` at `folder=` shows every file across all source folders — that's the intended use; large dirs (e.g. `ass/`, `boobs/` thousands of files) make one big response — acceptable now, note perf risk.
- **Symlinks**: skipped in flat walk (containment/cycles); non-flat `readdir` unchanged.
- **Stale player idx after filter/sort change**: existing clamp effect (`Media.jsx:169`) keeps it in-range.
- **Delete during flat**: parent folder computed from `rel`, backend delete unchanged.
- **Old stored endMode `"stop"`**: migrated to `"next"` on load.

## 6. Implementation steps

1. `api-server.js`: add `created` per item in `GET /api/media`; add `walkMedia` recursive helper; wire `flat=1` param. `node --check api-server.js`.
2. `web/src/views/Media.jsx`:
   - URL helpers `setParam/clearParam`; flat toggle button; type chip group (All/Photos/Videos/GIFs); sortable header buttons with `▲/▼`.
   - `load()` passes `flat=1`; **hide `-poster.*` thumbs via `isPosterFile()`**; display pipeline (type + text + dirs) over `items`/`rel`; `displayName()` → `folder > name`.
   - Rows use `created` (fallback `mtime`) for Time; flat delete parent/base derivation; `toMediaUrl` segment-encoding.
   - Player: drop same-category grouping; pass full `viewable` + `viewerIdx`; direct prev/next/goto.
3. `web/src/components/FileViewer.jsx`:
   - `cycleEndMode` → next/repeat/random only; labels "Next/Loop/Shuffle"; drop `stop` branches; migrate stored `"stop"`.
   - Unknown-format fallback panel (non-video/audio/image ext).
4. Verify then `cd web && npm run build`, reload API server (systemd/docker workflow: `docker restart xdl` or the project's `docker:restart`), check `/health`.
5. Update AGENTS.md module map / API table if `GET /api/media` contract changed (`created`, `flat`).

## 7. Risks / mitigations

- **Large flat responses** (thousands of files) → slow first render. Mitigate: server already cheap; if needed later stream or chunk + client virtualize. Not blocking.
- **MKV/AVI/HEVC in `<video>`** → browser may not decode; fallback panel covers *unknown* ext only, known-but-undecodable stays black — acceptable, out of scope (no transcode).
- **m3u8 in `<video>`** (Chrome lacks native HLS) → rare in output dir; if shown, user can still download. Note only.
- **birthtime missing** → fallback chain above; never blank.
- **Legacy `index.html`** untouched/dead — no risk.

## 8. Verification

- `node --check api-server.js`
- `curl 'localhost:6767/api/media?flat=1'` (with panel password header) → items have `rel` + `created`, include `reddit/*.gif`, no `dir:true` rows.
- `curl 'localhost:6767/api/media?folder=reddit'` → items have `created`.
- `cd web && npm run build` (oxlint + vite) succeeds; `curl /` serves `web/dist/index.html`.
- Manual UI:
  - Toggle flatten at root → all files flat, labels `folder > name.gif`; open a photo, reach a GIF, video; prev/next cycles the displayed order including mixed types.
  - **No `-poster.*` thumbnails appear** in flat or per-folder listing, and none in player navigation.
  - Type chips: Photos only / Videos only / GIFs only / All; player navigation respects active chip.
  - Click Name/Size/Time headers → direction toggles, arrows show, third click resets; Time sorts by created (verify a freshly downloaded file sorts to top under Time desc).
  - Delete a file while flattened → parent path derived correctly, list reloads.
  - Player end-mode: cycle shows only Next / Loop / Shuffle; `r` cycles; video end behavior matches (next file / repeat / random).
  - Open a `.txt`/`.json` in the list → fallback panel with download link, no broken video element.
- `docker restart xdl` (or `npm run docker:restart`) and `GET /health`.

## 9. Change log

- 2026-09-02: Initial draft — flatten, sortable headers (time=created), type chips default All, player navigates displayed list, end-mode next/loop/shuffle only, format fallback.
- 2026-09-02: Added `-poster.*` thumbnail exclusion from Media listing + player (client-side `isPosterFile()` filter in `Media.jsx`).