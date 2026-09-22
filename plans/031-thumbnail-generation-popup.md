# 031 — Media: Shift+G thumbnail generation popup (missing-only / all videos)

> Project: **xdl** — media grid UI (`web/src/views/Media.jsx`) + API (`api-server.js`) + downloader (`scan-videos/download.js`).
> Date: 2026-09-22. Status: **Done** (implemented 2026-09-22, awaiting user confirm).
> Scope: current folder only, video files only, manual trigger via Shift+G. No auto-generation on folder open, no change to download-time poster logic, no change to `/api/mediathumb` fallback.
>
> Implementation notes (corrections applied during execution):
> - **Keybind (user clarification):** `G` alone keeps its existing grid/list-view toggle role — the branch only gains `!e.shiftKey`. **Shift+G** (which *today* also toggles the view because the branch ignored modifiers) is claimed exclusively for the thumbnail popup.
> - **ffmpeg gate:** the endpoint checks `ffmpegBin` only (message `"ffmpeg not installed"` per gifvideo convention), NOT `ffprobeBin`. `generatePosterThumbnail` self-checks `hasFfmpeg()`, and ffprobe only feeds the optional duration probe which degrades gracefully when absent.
> - **Tests:** no backend HTTP endpoint-test harness exists (contrary to the original draft's "as mediathumb/gifvideo tests do"). Instead the pure folder-scan logic was exported from `scan-videos/download.js` (`posterStemOf`, `isVideoFileName`, `selectPosterTargets`) and unit-tested in `test/unit/download.test.js` — no ffmpeg, no server boot. `generatePosterThumbnail` gains the ffmpeg-less tolerance test (returns null, creates nothing).
> - **Progress (v1):** indeterminate `Generating…` message (per §3.2 decision); no per-file `i/N` streaming. Summary + auto-`refresh()` on the single JSON response.

---

## 1. Objective

Add a manual "generate thumbnails" flow for folders whose videos were added outside the downloader (no `<stem>-poster.jpg` sibling exists):

- Keybind **Shift+G** (viewer closed, not typing, no other modal open) opens a small popup.
- Popup offers exactly 2 actions:
  1. **Missing only** — generate `-poster.jpg` for video files that currently have no thumbnail (`it.thumb == null`).
  2. **All videos** — (re)generate `-poster.jpg` for every video file in the folder (overwrite existing).
- Shows progress + final summary (generated / skipped / failed), then refreshes the grid so new thumbs appear.

## 2. Desired behavior (source of truth)

- Trigger: `Shift+G` in Media library view only (**`G` alone remains the grid/list toggle**). Not while viewer open, not in playlist-expanded item view, not while typing in input/textarea/contentEditable, not while any Confirm/Prompt/Alert/delete modal open.
- Popup: centered modal, same visual language as `ConfirmModal` (dimmed backdrop + card, `maxWidth ~420`, `var(--surface)` / `var(--border)` / 12px radius — minimal, modern, elegant, no new colors).
  - Title: `Generate thumbnails`.
  - Body: one line of context, e.g. `Folder: <folder or Media root> — <N> videos (<M> missing thumbnails)`. When flat view is active, appends `Current folder only (no recursion).`
  - Three action buttons (not a radio + confirm two-step — one click starts):
    - `Generate missing (M)` — disabled when `M === 0`.
    - `Regenerate all (N)` — disabled when `N === 0`.
    - `Generate selected (K)` — disabled when `K === 0` (K = selected video tiles via `selectedKeysForStack`); posts `mode: "all"` + `keys`.
  - `Cancel` closes (also `Esc` / `Q` / backdrop click, same as `ConfirmModal`); while running the button reads `Close` and always stays clickable (job continues server-side, grid still refreshes on completion).
  - `data-testid`: `thumbgen-popup`, `thumbgen-missing`, `thumbgen-all`, `thumbgen-selected`, `thumbgen-cancel`.
- Run phase: popup switches to progress state (action buttons hidden):
  - Live progress (per user request, 2026-09-22): backend streams NDJSON — one `{"type":"progress","index":n,"total":T,"generated":G,"skipped":S,"failed":F,"file":name}` line per file, then `{"type":"done", ...summary}` — popup shows `Generating n / T · <file>` + `.progress`/`.progress-bar` (accent gradient, existing styles.css) + live counters. Early errors (400/404/503) stay single JSON.
  - Closing mid-run (`Esc`/`Q`/backdrop/`Close`) calls `closeThumbGen()` which `refresh()`es immediately (posters written so far light up), and the stream continues in the background — completion `refresh()`es again regardless of popup visibility. State read via `thumbGenStateRef` because the keydown effect closure is captured at popup open.
  - End state: summary line `Done: G generated · S skipped · F failed` (or `Failed: <error>`), + `Close`; grid auto-refreshes (`refresh()`) so `it.thumb` picks up new posters.
- Counts `N`/`M` derive client-side from already-loaded `filtered`/`items`: `fileCategory(it.name) === "video"` and `!it.dir` and (`mode === all` or `!it.thumb`). No extra fetch to compute counts.
- After run, `ShortcutsHelp` Library section gains row `{ keys: ["Shift", "G"], desc: "Generate video thumbnails (missing / all)" }`.

## 3. Implementation

### 3.1 Backend — `POST /api/posters/generate` (new, in `api-server.js`)

Reuse the exact download-time renderer — do not fork thumbnail logic:

1. `scan-videos/download.js`: export existing `generatePosterThumbnail` (+ `posterPathFor`) and the pure selector helpers `posterStemOf`, `isVideoFileName`, `selectPosterTargets` via `module.exports`. Poster logic unchanged (keeps middle-frame `scale=320:-2 -q:v 2`, 60s ffmpeg cap, best-effort null on failure); `generatePosterThumbnail` gains an `{ overwrite = false }` option (early-return for an existing poster only when not overwriting).
2. New endpoint (behind the same auth middleware as `/api/media`, adjacent to the mediathumb section):
   - Request JSON: `{ folder?: string, mode: "missing" | "all" }`. (`keys?: string[]` explicitly out of scope — folder-wide only per spec.)
   - Validation: `folder` via existing `resolveMediaOutputDir(folder)` containment check (reject `..`/absolute/escape, same as media delete + mediathumb). `mode` must be one of the two values → else 400. Missing folder dir → 404.
   - ffmpeg check via existing `ffmpegBin` → 503 `ffmpeg not installed` (gifvideo convention). ffprobe is NOT gated — `generatePosterThumbnail` self-checks `hasFfmpeg()`, and the duration probe degrades to seek-0 when ffprobe is absent.
   - Target enumeration server-side (source of truth, not client list): `readdir` the resolved dir **non-recursive, files only**; `selectPosterTargets(names, mode)` filters videos via `isVideoFileName` (shared `VIDEO_EXTS` from `download.js`, matching existing `THUMB_VIDEO_EXTS`) and for `"missing"` skips any stem with a sibling `<stem>-poster.(jpg|jpeg|png|webp|avif|gif)` (same `/-poster\./i` convention as `listMediaDir` / `isPosterFile`).
   - Execution: sequential `for` loop (avoids ffmpeg CPU thrash), `await generatePosterThumbnail(fullPath, { overwrite: mode === "all" })` per file; a null return → counted failed (`errors: [{ key, message }]`).
   - Response: single JSON `{ ok: true, folder, mode, total, generated, skipped, failed, errors: errors.slice(0, 10) }`. No streaming/SSE/polling in v1.
   - Timeout note: per-file ≤60s; folders with dozens of videos can exceed default client/proxy timeouts. Popup warns `Generating… this may take a while on large folders. Keep this tab open.` Follow-up (out of scope): NDJSON streaming or a job-id + poll.
3. Tests (`test/unit/download.test.js`, `node --test`): the selector logic is pure, so no server boot or ffmpeg needed — cases: `isVideoFileName` container gate (true for mp4/mkv/webm, false for jpg/gif/mp3/no-ext), `posterStemOf` stripping, `selectPosterTargets` missing-mode skipping (case-insensitive poster match across exts), all-mode regenerating everything, non-video files never counted, plus a `generatePosterThumbnail` tolerance test (no ffmpeg → returns null, creates nothing). No live ffmpeg required.

### 3.2 Frontend — `web/src/views/Media.jsx` (+ `ShortcutsHelp.jsx`)

1. State near other UI state (`showHelp`, `menuOpen`): `thumbGenOpen`, `thumbGenBusy`, `thumbGenResult` (single `{ ok, generated, skipped, failed, error? }` summary object — no per-file `{done,total,file}` progress in v1).
2. **Keybind split (user directive):** `Media.jsx` `lowK === "g"` view-toggle branch gains `!e.shiftKey` so `G` alone keeps its existing role. Add a **Shift+G** branch right above it:
   ```js
   if (lowK === "g" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
     e.preventDefault();
     if (!viewerOpen && !inPlaylistView) setThumbGenOpen(true);
     return;
   }
   ```
   Guard order in `onKey`: after the typing check (`INPUT/TEXTAREA/contentEditable` return) and after the modal-open early return (`confirmState/promptState/alertState/deleteTarget/...` → return), alongside the `?`/`1`/`x` shortcuts. `Q`/`Escape` close the popup first (extend the existing Q-close chain and Esc chain with `thumbGenOpen` before spread-clear); `thumbGenOpen` added to the keydown effect dep array.
3. Popup component: inline block in `Media.jsx` render (no new file), `ConfirmModal` styling tokens — fixed backdrop (`zIndex 200`, `rgba(6,8,18,0.55)` + blur), card `maxWidth 420`/`borderRadius 12`. Derived counts from the already-loaded listing (`items`): `thumbGenVideos = items.filter(!dir && fileCategory === "video")` → `{ key, name, missing: !it.thumb }`, `M = #missing`, `N = #total`. `onPick(mode)` POSTs:
   ```js
   const res = await fetch("/api/posters/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder, mode }) });
   ```
   v1 single response; while in flight show indeterminate `Generating…` + `Keep this tab open.`; on success `setThumbGenResult(j)` + `refresh()` so `it.thumb` updates; on error (503 no-ffmpeg / 400 / 500) show `Failed: <error>` inline + `Close`. The close button stays enabled during the run (job continues server-side, completion still refreshes).
4. `ShortcutsHelp.jsx`: add `{ keys: ["Shift", "G"], desc: "Generate video thumbnails (missing / all)" }` to `LIBRARY_SECTIONS` Sort & filter group.
5. What is NOT changing: `thrumb()` resolution order, `/api/mediathumb` fallback, download-time generation, flat-mode semantics (popup operates on the **current real folder**, non-recursive; body appends `Current folder only (no recursion).` when flat view is active), selection/sort/filter, `?s=` URL params.

## 4. Verification

- `npm test` (root, `node --test`) — new `selectPosterTargets` / `posterStemOf` / `isVideoFileName` / `generatePosterThumbnail`-without-ffmpeg cases pass; no live browser/ffmpeg.
- `npm --prefix web run lint` + `npm --prefix web run build` — pass.
- Manual: seed a folder with (a) video+poster, (b) video without poster, (c) photo; open folder → `Shift+G` opens popup with correct `N/M`; Missing generates only (b); delete poster → All regenerates (a)+(b); photo untouched; grid shows new thumbs after auto-refresh; `g` still toggles view, `Shift+G` never toggles view; `Esc`/`Q`/backdrop closes.
- Mobile 390px: popup fits (`maxWidth 420`, `padding 16`), buttons stack/tap-sized.

## 5. Risks / notes

- **Shift+G regression risk:** the missing `!e.shiftKey` on the `g` toggle means Shift+G *today* flips the view — the fix is one condition, but verify `g` (no shift) still toggles and `Shift+1/2/3` sort shortcuts are untouched.
- ~~Long-folder blocking: v1 single-request JSON blocks until all ffmpeg runs finish; large folders may hit timeouts~~ **IMPLEMENTED (2026-09-22):** the endpoint streams `application/x-ndjson` per-file progress + a final `done` line (headers `Cache-Control: no-cache`, `X-Accel-Buffering: no`, echoing the `/download` streaming convention; `clientGone` guard for dropped sockets). No remaining block-timeout concern — the client renders progress as lines arrive.
- **Overwrite flag:** `generatePosterThumbnail` early-returns when the poster exists — `mode: all` needs an explicit `overwrite` bypass; do not delete-then-generate (leaves a gap on ffmpeg failure — overwrite via temp + rename or direct `-y`).
- **Scope:** current-folder non-recursive only. Recursive/flat-descendant generation and per-selection (`keys[]`) generation are explicit non-goals for this plan.
  - **UPDATED 2026-09-22:** per user request, a third popup button **"Generate selected (K)"** was added — posts `{ folder, mode: "all", keys: [...] }` where `keys` are the `selectedKeysForStack` keys (grid multi-select `selKeys`, else the single `selKey`) filtered to video files in the current folder scope. Backend treats `keys` as explicit rel-path/name targets (containment-checked, file-only, video-only; `mode: "missing"` also skips keys with an existing `<stem>-poster.*` sibling), validated BEFORE the ffmpeg gate. `POSTER_SIBLING_RE` exported from `scan-videos/download.js` for per-key skip checks.
  - **BUGFIX 2026-09-22 (user report: new thumbs invisible until page reload):** reproduced live — after generate+close, fresh `items` reached state (popup counts correct) but existing tiles kept the icon. Root fix in `Media.jsx`: tiles now resolve the thumbnail through a per-render `thumbGenVideos`-style live lookup `thumbByKey` (Map from current `items`) instead of trusting the tile's `it.thumb` prop, which can lag after in-place refreshes; `thrumb(it, thumbOverride)` accepts the override. Also: `load()` fetches `/api/media` with `{ cache: "no-store" }` and returns cleanly on HTTP 304 (previously `r.json()` threw on the empty body, skipping `setItems` and setting an error), and opening the popup resets `thumbGenResult`/`thumbGenProgress` so it never shows a stale "Done". Verified end-to-end in a test browser against the live server: generate selected → Done → Close → poster tile visible with no reload; reopen shows fresh counts.
