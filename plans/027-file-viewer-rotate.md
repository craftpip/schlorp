# 027 — File viewer: rotate media 90° (per-file, persisted)

> Project: **xdl** — web UI (`web/src/`, React). Core change is `web/src/components/FileViewer.jsx`.
> Date: 2026-09-21. Status: **Planned**.
> Scope: add a **Rotate** button in the file viewer that rotates the displayed image/video 90° clockwise per click (cycling 0 → 90 → 180 → 270 → 0). The rotation is a **display-only** CSS transform — file bytes are never touched. The angle is **persisted per file** in `localStorage` (keyed by media-relative file path), so a file stays rotated across navigation, closing/reopening the viewer, and browser restarts. Pure frontend — no API changes.

---
## 1. Objective

`FileViewer.jsx` today shows images and videos center-fit with zoom/pan (wheel zoom, drag when zoomed). There is no way to change orientation, so a sideways photo/video has to be watched sideways.

Add:

1. A **Rotate** button in the viewer bottom controls. Each click rotates the media **90° clockwise** (0 → 90 → 180 → 270 → 0).
2. **Per-file persistence**: the current angle for each file is saved in `localStorage` keyed by the file's media-relative path (`filePath`), and restored automatically whenever that file opens in the viewer — across navigation to other files and across sessions. (**User decision 2026-09-21:** per file, not a global viewer setting.)

Scope is the React file viewer only. The legacy `index.html` UI and `api-server.js` are untouched.

## 2. Desired behavior (source of truth)

### 2.1 Rotate button

| Media kind | Rotate button |
|---|---|
| Image (`isImage`, incl. `.gif` rendered as `<img>`) | Visible → rotates the `<img>` |
| Video (`isVideo`, incl. `.gif` rendered as `<video>` via `gifAsVideo`) | Visible → rotates the `<video>` |
| Audio (`isAudio`) | Hidden (no visual to rotate) |
| Unknown format | Hidden |

- Placement: bottom `fv-controls` bar, in the same `.fv-speed` row as the **End mode** button, immediately to its left. Icon **`bi-arrow-clockwise`**, label **`Rotate`** — verified present in bootstrap-icons 1.11.3 (the CDN set loaded at `web/index.html:12`; `bi-rotate-right`/`bi-rotate-left` do **not** exist in 1.11.3 — checked against the 1.11.3 stylesheet).
- Title tooltip shows the current angle: `Rotate 90° (⇧R) · now 180°`.
- Keyboard shortcut **`⇧R`** (Shift+R) rotates too — available whenever the viewer is open, including fullscreen. Plain `r` (end-mode cycle) is unchanged; the `r` branch now requires `!e.shiftKey` so the two never collide.
- Button always available once the media kind is known (no requirement that zoom === 1).

### 2.2 Rotation semantics

- `rotate` state is one of `0 | 90 | 180 | 270` (degrees). Click → `(rotate + 90) % 360`.
- Applied to the media element as an additional CSS transform term between the existing translate and scale:
  `transform: translate(${pan.x}px, ${pan.y}px) rotate(${rotate}deg) scale(${zoom})`
  with the existing `transformOrigin` (`50% 50%`) — rotation happens about the media center, so a 90°/180°/270° turn keeps the image centered in the stage.
- **Rotated media takes the space it can take.** A 90°/270° (transposed) rotation swaps the element's size to the measured stage `(width = stage.height, height = stage.width)` before applying `object-fit: contain` and the rotation. The rotated element's bounding box therefore equals the stage, so a landscape video rotated to portrait fills the full stage height instead of being clipped to a square-ish region. Measurements come from a `ResizeObserver` on the stage (`containerRef`); at 0°/180° the element stays `100% × 100%`.
- The existing `opacity`/`transform` transition (`transform 0.15s` at zoom 1) is **kept**, so the rotate animates smoothly.
- **Display-only**: the transform is never written back to the downloaded file. Rotation persists in `localStorage`, not in media metadata. Nothing on `api-server.js`, `media/`, or ffmpeg changes.

### 2.3 Persistence (per file)

- Storage: one `localStorage` key `xdl_viewer_rotations` holding a JSON map `{ "<media-relative path>": <degrees> }`.
- Key = `filePathEff` (the same string parents pass as `filePath` / `file.filePath`, e.g. `folder/name.mp4`), which is stable across sessions. If `filePathEff` is empty (viewer opened from a bare URL with no file), rotation is applied to the session only and nothing is persisted.
- **Read**: when a new file loads (the existing reset effect on `loadedUrl`, `FileViewer.jsx:137`), `rotate` is initialized from the map.
- **Write**: a `useEffect` on `[rotate, filePathEff]` persists the new angle. A stored `0°` entry is **pruned** from the map (not stored) so the map doesn't grow with default values.
- **Delete hygiene**: after a successful `doDeleteFile` (`FileViewer.jsx:738`), the file's entry is pruned from the map so deleted files never leave stale rows.
- Value validation: only `90`, `180`, `270` are accepted on read; anything invalid → `0`.

### 2.4 Interaction with existing features

- **Zoom/pan**: unaffected — wheel zoom, drag-pan, and pinch all keep working. When zoomed, pan axes are not counter-rotated (v1 limitation, §4.3).
- **Navigation**: opening the same collection and coming back to a file restores its angle; opening a *different* file loads that file's own angle.
- **Fullscreen / playlist / delete / prev-next / end mode / rate / mute**: unchanged.

## 3. Implementation (all in `web/src/components/FileViewer.jsx`)

### 3.1 Persistence helpers (module scope, above the component)

```js
const ROT_STORE_KEY = "xdl_viewer_rotations"; // JSON map: media-relative filePath -> degrees (90|180|270)
function readFileRotation(fp) {
  if (!fp) return 0;
  try {
    const map = JSON.parse(localStorage.getItem(ROT_STORE_KEY) || "{}");
    const v = Number(map[fp]);
    return v === 90 || v === 180 || v === 270 ? v : 0;
  } catch { return 0; }
}
function saveFileRotation(fp, deg) { // deg 0 removes the entry
  if (!fp) return;
  try {
    const map = JSON.parse(localStorage.getItem(ROT_STORE_KEY) || "{}");
    if (deg % 360 === 0) delete map[fp];
    else map[fp] = deg;
    localStorage.setItem(ROT_STORE_KEY, JSON.stringify(map));
  } catch {}
}
```

### 3.2 State + handlers

- `const [rotate, setRotate] = useState(0);` next to the other view state (zoom/pan, `FileViewer.jsx:50-52`).
- `const rotateFile = () => setRotate((r) => (r + 90) % 360);`
- In the existing reset-on-load effect (`FileViewer.jsx:137`, deps `[loadedUrl]`): add `setRotate(readFileRotation(filePathEff));` next to the existing `setZoom(1)` / `setPan(...)` resets.
- Persist effect next to the other `localStorage` writers (`FileViewer.jsx:133-136`):

```js
useEffect(() => { saveFileRotation(filePathEff, rotate); }, [rotate, filePathEff]);
```

- In `doDeleteFile`, after the successful delete branch (`FileViewer.jsx:750`): `saveFileRotation(filePathEff, 0);`
- In the main keydown handler, add a `⇧R` branch that calls `rotateFile()` and require `!e.shiftKey` on the plain `r` (end-mode) branch so they don't collide.

### 3.3 Apply rotation to the three media elements

Change the `transform` style in each of the three media blocks (currently `translate(...) scale(...)`):

- `<img>` (image branch, `FileViewer.jsx:902`)
- `<video>` gif-as-video branch (`FileViewer.jsx:915`)
- `<video>` video branch (`FileViewer.jsx:940`)

From:
```js
transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
```
To:
```js
transform: `translate(${pan.x}px, ${pan.y}px) rotate(${rotate}deg) scale(${zoom})`
```

Also swap the element box for transposed angles so the rotated media fills the stage:

- New `stageSize` state `{ w, h }` measured via a `ResizeObserver` on `containerRef` (stage) — updates on load, window/fullscreen resize.
- Derived before render: `transposed = rotate === 90 || rotate === 270;` `mediaW = transposed && stage → stage.h else "100%"`; `mediaH = transposed && stage → stage.w else "100%"`.
- The three media blocks' `width`/`height` change from `"100%" × "100%"` to `mediaW × mediaH`. `object-fit: contain` and the `zoom===1 ? "opacity .45s ease, transform 0.15s" : "opacity .45s ease"` transition are unchanged (rotate keeps its 0.15s animation).

(Audio `FileViewer.jsx:886` and unknown-format branches render no image/video — untouched.)

### 3.4 Rotate button

In the `.fv-speed` controls row, immediately before the end-mode button (`FileViewer.jsx:941-944`):

```jsx
{(isImage || isVideo || gifAsVideoEff) && (
  <button
    type="button" tabIndex={-1}
    className="btn btn-sm btn-outline-secondary"
    onClick={rotateFile}
    title={`Rotate 90°` + (rotate ? ` (now ${rotate}°)` : "")}
    style={{ padding: "4px 8px", fontSize: 11 }}
  >
    <i className="bi bi-arrow-clockwise" /> Rotate
  </button>
)}
```

No new CSS required — reuses the existing `.fv-controls .btn` / `@media (max-width: 640px)` styling already applied to sibling buttons.

### 3.5 Files touched

| File | Change |
|------|--------|
| `web/src/components/FileViewer.jsx` | `rotate` state, `readFileRotation`/`saveFileRotation`, `rotateFile`, reset-on-load read, persist effect, delete prune, 3 transform strings, stage-dimension swap + `ResizeObserver`, Rotate button, `⇧R` key handler (`r` branch now `!e.shiftKey`) |
| `web/src/components/ShortcutsHelp.jsx` | New `⇧R` row in VIEWER_SECTIONS (Rotate 90°) |
| `plans/027-file-viewer-rotate.md` | This plan |

No API, no test files, no legacy `index.html`, no `ShortcutsHelp.jsx` (no new shortcut).

## 4. Decisions & out of scope

### 4.1 Per-file persistence

User-confirmed choice (2026-09-21): each file remembers its own rotation, keyed by media-relative `filePath` in `localStorage` (`xdl_viewer_rotations` map). Not a global viewer pref like `xdl_viewer_rate`/`xdl_viewer_muted`. Rotating one file never affects another.

### 4.2 Single 90° clockwise button

One button cycles 0 → 90 → 180 → 270 → 0. No separate counterclockwise ("undo") button — three more clicks reach any desired 90° step. A counterclockwise variant can be added later if wanted; the storage/transform design is identical.

### 4.3 Transform composition with zoom/pan

Rotation sits **between** translate and scale, about the media center (`transformOrigin: 50% 50%`). At zoom 1 this is exactly a centered turn. When zoomed in, the pan axes are **not** remapped to the rotated coordinate system, so drag-pan while rotated may feel axis-swapped — accepted for v1; the element stays centered and nothing breaks. (Counter-rotating the pan deltas is a possible follow-up.)

### 4.4 Display-only, file bytes untouched

Rotation is a pure CSS transform. The downloaded file on disk, its EXIF, and any server-side data are never modified, so nothing in the media library pipeline (`scan-videos`, `api-server.js`, ffmpeg) is involved.

### 4.5 Out of scope

- **Keyboard shortcut** — `⇧R` rotates (added; `ShortcutsHelp.jsx` VIEWER_SECTIONS updated with a `⇧R` row).
- **Slider/arbitrary angles** — 90° steps only.
- **EXIF write-back / server-side rotate** — would permanently alter files; not requested.
- **Global rotation** (one angle for every file) and **per-folder** rotation.
- **Legacy `index.html` UI** and `api-server.js`.
- **Tests** — the web app has no test runner configured (`web/package.json` ships only `dev`/`build`/`lint`/`preview`); verification is build/lint + manual (§6). Root `test/` is backend-only.

## 5. Implementation steps

1. Add `ROT_STORE_KEY`, `readFileRotation`, `saveFileRotation` helpers at module scope in `FileViewer.jsx`.
2. Add `rotate` state + `rotateFile`; extend the reset-on-load effect with `setRotate(readFileRotation(filePathEff))`.
3. Add the persist effect; add the delete prune in `doDeleteFile`.
4. Update the three `transform` strings to include `rotate(${rotate}deg)`.
5. Add the Rotate button in the `.fv-speed` row before the end-mode button.
6. Add the `⇧R` key handler; update `ShortcutsHelp.jsx`.
7. `cd web && npm run build` and `cd web && npm run lint`; manual pass (§6).

## 6. Verification

```bash
cd web && npm run build
cd web && npm run lint   # oxlint — no new warnings
```

Manual (app served against the API, e.g. `web` dev proxying to `:6767`):

- Open an image → **Rotate** (or press **⇧R**) → turns 90°; again → 180°, 270°, back to 0°. Tooltip shows the current angle. Plain `r` still cycles end mode.
- Navigate **Next/Prev** away and back to the same file → its angle is restored; a different file shows its own angle (or no rotation).
- Close the viewer (q/Esc) and reopen the same file → still rotated. **Hard-reload the app** → still rotated (`xdl_viewer_rotations` in DevTools Application → Local Storage).
- Rotate a **video** → works identically; playback, seek, mute, rate, fullscreen all unaffected.
- Zoom in (wheel), then rotate → element stays centered, pan still works (axes not counter-rotated — expected, §4.3).
- Rotate an image, then **delete** it → `xdl_viewer_rotations` no longer contains that path.
- Open an **audio** file → no Rotate button shown; unknown-format file → none.
- `localStorage` tamper test: set `xdl_viewer_rotations` to garbage / an angle like `45` → file opens at 0°, no crash.
```