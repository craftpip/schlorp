# Plan 017 — Comprehensive Test Suite (backend + API + UI)

**Date:** 2026-09-16
**Status:** Planned — all open decisions approved, UI coverage expanded + verified against real source
**Scope:** Add automated tests for the entire xdl codebase — backend pure modules, download engines, HTTP/WS API, queue worker, sync daemon, the React SPA (`web/`) including **app design logic** (auth/decoy state machine, routing, fetch wrapper, WS reconnect, localStorage persistence) and the **FileViewer / media-explorer logic in full**, plus the legacy inline-SPA HTML pages (`index.html`, `scan-saved.html`, `landing/`).

## Goal

Give the whole project a CI-runnable test suite. Today the only test is `test/profile-routing.test.js` (51 lines, `node --test`). This plan covers:

1. **Pure logic** — every exported function in `scan-videos/*` and `queue.js`, plus extractable helpers in `sync-saved-downloads.js`.
2. **Engine internals** — scoring, prioritization, hint extraction, file-naming, byte-range/HLS logic via fixtures + a local fixture HTTP server.
3. **HTTP API + WebSocket** — real subprocess server on an ephemeral port with isolated temp state dirs; every route's 2xx/4xx contract (browser-less via the approved `QUEUE_STUB_RUNNER` hook).
4. **React SPA design logic** — the auth/decoy state machine, `window.fetch` auth wrapper, per-route guards, WS health, `xdl_*`/`haven_*` localStorage keys, and auto-logout timers.
5. **React views/stores/components** — all four stores' behavior, five views' render+fetch flows, and the full **FileViewer** playback/navigation/delete/transfer/playlist/context-menu matrix.
6. **Legacy HTML apps** — inline scripts executed inside jsdom with mocked fetch/WebSocket.
7. **Coverage reporting** — Node's built-in coverage for backend, Vitest for `web/` (floor 70% approved).

Constraints: Node `v20.20.2`, CommonJS at root, ESM in `web/`, no test tooling today. Tests must NOT require a live browser, Docker, ffmpeg, or VNC to pass. Browser/ffmpeg-dependent behavior is stubbed or listed as skipped/manual.

---

## Decisions (ALL APPROVED by user 2026-09-16)

| # | Topic | Decision | Status |
|---|---|---|---|
| D1 | Backend runner | `node --test` (root `npm test` already wired) + `node:assert/strict` | approved |
| D2 | Backend coverage | `node --test --experimental-test-coverage` (Node 20 built-in), floor **≥70% lines** | approved |
| D3 | API/WS tests | Spawn `api-server.js` as subprocess; `PORT=0` ephemeral port; temp state + media dirs | approved |
| D4 | sync-daemon testability | **Refactor approved** — wrap main in `if (require.main === module)`, add `module.exports` of internals | approved |
| D5 | Browser-less queue/API | **`QUEUE_STUB_RUNNER=1` env hook approved** — test-only branch in `api-server.js` where `run()` emits `Downloaded media to: <tmp>/stub.mp4` via the normal logging path; prod download path untouched | approved |
| D6 | React tests | Vitest + `@testing-library/react` + `@testing-library/jest-dom` + `@testing-library/user-event` + jsdom as deps in `web/` → `npm test` runs `vitest run` | approved |
| D7 | Legacy HTML tests | jsdom harness loading the actual inline scripts with stub globals | approved |
| D8 | Coverage floor | 70% lines acceptable | approved |
| D9 | Browser/ffmpeg paths | Skipped unless `XDL_LIVE=1`; manual in Docker+VNC+ffmpeg | approved |

**web/ scripts (package.json `web/`):** `"test":"vitest run"`, `"test:watch":"vitest"`, `"test:cov":"vitest run --coverage"`, vitest config `test:{environment:'jsdom', setupFiles:'./test/setup.js'}`.
**Root scripts:** `"test:cov":"node --test --experimental-test-coverage test/"`, `"test:ui":"npm --prefix web test"`, `"test:all":"node --test test/ && npm --prefix web test"`.

---

## Architecture / test layout

```
/www1/xdl/
  test/
    helpers/
      make-fake-page.js        # page mock: evaluate executes callbacks in a sandbox
      fixture-server.js        # local http server: /media/<file>.mp4, /*.m3u8, /*.m4a
      temp-state.js            # mkdtemp + env override/restore helpers
      api-server-harness.js    # spawn api-server.js subprocess on ephemeral port; QUEUE_STUB_RUNNER=1
      legacy-app.js            # jsdom loader for index.html / scan-saved.html / landing
    unit/
      config.test.js
      media-utils.test.js
      instagram-utils.test.js
      reddit-utils.test.js
      download.test.js
      extractors.test.js
      sync-daemon.test.js
      index-args.test.js
    api/
      health-auth.test.js
      media.test.js            # /api/media*, playlists, stacks, mediaorder, gifvideo, mediathumb
      config-accounts.test.js  # /api/config, /accounts, /sync-config, /collections/*
      queue.test.js            # /queue*, /sync-queue/*, /ws
    ui/
      legacyspa.test.js        # index.html
      scan-saved-page.test.js  # scan-saved.html
      landing.test.js
    e2e/
      live.manual.test.js      # skipped unless XDL_LIVE=1
  web/
    test/
      setup.js
      lib.test.js              # api.js request/requestStream + ws.js + router.js + fetch patch
      stores.test.jsx          # Queue / Playlists / Stacks contexts (verified behavior)
      app.test.jsx             # auth/decoy/logout state machine
      views.test.jsx           # Dashboard, Media, Saved, Profiles, Settings
      components.test.jsx      # FileViewer, MediaContextMenu, PlaylistHoverMenu, modals, ShortcutsHelp
```

---

## Backend test matrix

### `scan-videos/config.js` — `test/unit/config.test.js`
- `shouldRunHeadless`: HEADLESS unset→`!DISPLAY`, "1"/"true"/"0"/"false", env restore.
- `shouldAutoContinuePrompts`: TTY logic, `AUTO_CONTINUE`/`AUTO_CONTINUE_WAIT_MS`.
- `getInstagramUserAgent`: default iPhone UA vs custom passthrough.
- `normalizeUrl`: scheme prepend, hash strip, query keep, garbage reject.
- `resolveProfileConfig` / `resolveAccountConfig` / `normalizeAccountName`: defaults vs env vs explicit, per-account merge, cdpUrl override, "default" reserved, recursion guard.
- `normalizeCdpUrl` / `isCdpUrl`: ws/wss/http/https only, 500-char cap.
- `getStateFilePath`: env override, default path.

### `scan-videos/media-utils.js` — `test/unit/media-utils.test.js`
- `isLikelyVideoUrl`, `isStreamingManifestUrl`, `isDirectFileUrl`; `stripByteRangeParams` (removes `bytestart`/`byteend`).
- `extractQualityHint`, `metadataQualityScore`; `getInstagramAssetId`/EFG parse (urlencoded vs raw base64, missing→""); `isInstagramAudioOnlyUrl` (`dash_lna`).
- `isRedgifsUrl`/`extractRedgifsId`, `isRedditMediaUrl`, `isGifUrl`, `isImageUrl`, `isPhotoUrl`.
- `scoreDownloadCandidate` golden values (EFG bonus, bitrate scaling, direct/mp4/manifest bonuses, audio −20000, byte-range variants).
- `sanitizeFileToken` (lowercase, invalid→dash, dash trim, 64 cap, reserved names).
- `prioritizeInstagramCandidates` / `prioritizeRedditCandidates` / `prioritizeXhamsterCandidates`; `extractDownloadableVideoUrls` (blob skip, dedupe, forceInclude, sort).

### `scan-videos/instagram-utils.js` — `test/unit/instagram-utils.test.js`
- `isReservedInstagramName`, `extractInstagramShortcode` (p/reel/reels/tv), `isInstagramReelTargetUrl`, `isInstagramAvatarUrl`.
- `parseJsonWithInstagramPrefix` (`for (;;);` strip).
- `extractInstagramUsernameFromJsonText`; `extractInstagramUsernameFromSsrScripts` via `makeFakePage` (fixture = real `XDTMediaDict` shape `"code":"DdSewIihI-K"` + `"user":{"username":"sophiaar.luv"}`; skips other scripts).
- `extractInstagramMediaHintsFromJsonText`: target-node finder, **foreign-shortcode subtree skip** (rail media with own `code` excluded — the DdSewIihI-K fix), video key priority (`video_url→playback_url→dash_url→hls_url`), photo nodes excluded, 80k/120k caps.
- `extractInstagramImageHintsFromJsonText`, `dedupeInstagramPhotos`, `filterInstagramCandidatesForTarget` (URL match → assetId match → passthrough).

### `scan-videos/reddit-utils.js` — `test/unit/reddit-utils.test.js`
- URL predicates, `normalizeRedditPostUrl`, `extractRedditPostId`, `isRedditVideoPost`.
- `extractRedditMediaHintsFromJsonText` (t3 find, gallery order, reddit_video/hls fallback, crosspost, oembed iframe, redgifs); `extractRedditImageHintsFromJsonText`, `dedupeRedditPhotos` (`i.redd.it` preference, `-v0-` dedupe).

### `scan-videos/download.js` — `test/unit/download.test.js`
- `hasFfmpeg` (boolean only), `extFromContentType`, `sniffMediaKind` magic bytes (ftyp/GIF89a/JPEG/PNG/RIFF), `gifDimensions`.
- `buildOutputFilePath` (timestamp on/off, extension substitution, collision).
- `createAbortControllerWithTimeout`/`fetchWithTimeout` (mock fetch → AbortError → "timed out"; success passthrough).
- `downloadStreamingManifest` via fixture server (master .m3u8 variant selected by score; mux skipped w/ `hasFfmpeg=false` mock).
- `downloadMedia` via fixture server: content-type ext selection, magic-byte rename, progress callback, 1×1 placeholder rejection, partial unlink on mid-stream error, byte-range URL.

### `scan-videos/extractors.js` — `test/unit/extractors.test.js`
- `getInstagramUsername` chain via `makeFakePage`; **regression: never falls back to logged-in user when SSR carries author** (the `hamster.9377231` trap); `getInstagramUsernameFromOembed` (ok/404).
- `extractInstagramPhotoData` (srcset, carousel Next walk max 10, og:image).
- `extractXhamsterMediaData` / `extractXvideosMediaUrls` / `extractPornhubMediaData` (fixture HTML + fake page).
- `extractRedditMediaData`, `fetchRedgifsMediaUrls` (deep-scan + watch-page fallback).

### `scan-videos/scan-saved.js` — `test/unit/scan-saved.test.js`
- `extractIdFromUrl`, `normalizeComparableUrl`; loop via `makeFakePage` (target-id stop, no-increase timeout, page-wide fallback, IG 429 cooldown).

### `scan-videos/index.js` — `test/unit/index-args.test.js`
- `parseCliArgs` (extend existing): all flags, combined, `--`, unknown flags.
- FilePrefix construction for IG (`username-shortcode`) and Reddit (`subreddit-postid`).

### `queue.js` — ~~`test/unit/queue.test.js`~~ **SKIPPED (user decision 2026-09-16)**
Nothing imports the root `queue.js` (orphaned dead code; api-server has its own inline web queue); its queue-file path is hardcoded with no env override, so a unit test would require a 3rd unapproved prod-code hook. Real queue behavior is covered by `test/api/queue.test.js` (`/queue*`, `/sync-queue/*`, `/ws`) + web QueueContext tests under `QUEUE_STUB_RUNNER`.

### `sync-saved-downloads.js` (refactor approved) — `test/unit/sync-daemon.test.js`
- `require.main` guard + exported internals: `randomBetween`, `randomChoice`, `normalizeUrl`, `enqueueUrls` (newest-first, dedupe vs pending+completed+lastSeen), `saveQueue` trim, `ApiError.status/retryable`, `postJson` classification (429/503), `isRateLimitMessage`/`isRateLimitError`, `withRetries` backoff + non-retryable on rate limit, `extractApiProcessFailureMessage`, rate bounds, `loadState` sanitization.

---

## HTTP API + WebSocket test matrix — `test/api/`

Harness `startTestApiServer()`: spawn `node api-server.js` child with `PORT=0` + temp `SAVED_SYNC_STATE_FILE`/`SAVED_SYNC_QUEUE_FILE`/`XDL_WEB_QUEUE_FILE`, temp `media/`, `UI_PANEL_PASSWORD=testpass`, `HEADLESS=true`, `API_HEADLESS=true`, and **`QUEUE_STUB_RUNNER=1`** for the queue suites. Parse real port from "API server listening on http://localhost:<port>"; wait for `/health` 200. `stopTestApiServer()`: SIGTERM + wait exit.

### `health-auth.test.js`
- `/health` → `{ok,shuttingDown,busy,browserReady,accountBrowsersReady,manualBrowsers}`.
- Auth matrix: no password → `{protected:false}`; with password → 401 without creds; `x-panel-password` header / `?password=` / `xdl_session` cookie; wrong password 401; logout clears.

### `media.test.js`
- GET `/api/media` (folder listing, `flat=1`, `.xdlstack` excluded, item shape, 400 bad folder); `/api/mediadims`; `/api/mediaorder` GET/PUT sanitize (`\`, leading `.`, `..`, dedupe, cap 20000, 400 missing array).
- DELETE `/api/media` prune (playlists/dims/mediaorder/stacks), 400 path-escape, 404.
- `/api/playlists` CRUD + toggle/items (409 dup, 400 full, 404, enrich `missing`); `/api/stacks` CRUD + items + dissolve-on-≤1.
- `/api/gifvideo` (400 not-gif, 503 no-ffmpeg); `/api/mediathumb` (400 no key, 404 not video, 503 no-ffmpeg).

### `config-accounts.test.js`
- `/api/config` GET 6 groups + POST allowlist-only (unknown → 400, newline reject).
- `/accounts` CRUD ("default" reserved, 409 dup, cdpUrl validation, cdp/status, reset, delete-default rejection).
- `/sync-config` GET/POST normalization ("30m" default); `/collections/crawl-all` 503/409 contract; `/set-last-seen` 400; `/clear-memory`; `/resume` 400; `/sync-queue/pending/add|remove|clear` (dedupe, `{ok,added,skipped,pending}`).

### `queue.test.js` (QUEUE_STUB_RUNNER=1)
- `/queue/add` (`urls[]`/`url`/`links[]`), `/remove`, `/retry` (404 unknown), `/clear` variants (keeps running), `/cancel`, `/pause`/`/resume`, `/gap` (400 min w/o max).
- GET `/queue` → `{ok, active, completed, gap, gapWait, paused}`.
- `/download`: 400 missing link; 429 when busy; **streaming `#chunk#`/`#field#` protocol emits `Downloaded media to:` lines under stub runner** (asserts the exact framing the web client and sync daemon parse).
- WebSocket `/ws`: connect → `queue:snapshot`+`health`; send `queue:add` → snapshot reflects; pause freezes `gapWait`; `job:progress`/`job:log` shapes.

---

## UI test matrix — `web/` (expanded per user request; verified against real source)

### `test/setup.js`
`import '@testing-library/jest-dom'`; afterEach: unmount, reset `window.fetch`, clear localStorage/sessionStorage, remove `window._xdlFetchPatched` + restore original fetch so the App patch is re-testable, stub `WebSocket`.

### `lib.test.js` — app design primitives
- **api.js `request`**: `x-panel-password` header from localStorage `xdl_panel_pw`; error extraction (`json.error` > `json.message` > text > `HTTP N`); blob mode; onChunk; 2xx parse.
- **api.js `requestStream`**: mock ReadableStream emitting real `#chunk#`…`#field#` framing → `lambda`→onChunk / `progress`→onProgress; **partial-frame buffering across reads**; ≥400 JSON error parse; null-body error.
- **ws.js `useWebSocket`**: `{connected,lastMessage,send}`; connect→`connected:true` + backoff reset 1000; `onclose` reconnect delay `min(retry,10000)` then `×1.5` capped 10000; `onerror`→`ws.close()`; invalid JSON swallowed; `send` guarded JSON; unmount sets closed + clears timer (**no reconnect**); `path` change re-runs.
- **App fetch patch**: applied exactly once (`window._xdlFetchPatched`); injects **both** `x-panel-password` and `x-admin-password` from `xdl_admin_pw`/`xdl_panel_pw`; preserved options/headers merge; subsequent patch-mount does not double-wrap.
- **router.js**: `navigateTo` hash behavior.

### `stores.test.jsx` — verified context behavior
- **QueueContext**: mount → `fetch("/queue")` + **1s interval poll** (vi.useFakeTimers); WS dispatchers: `queue:snapshot` (active/completed/gap/gapWait/paused), `queue:paused`, `queue:gap` (waiting→gapWait object, else null), `job:progress` (merges stage/pct/detail/filePath into that active id), `job:log` (**append + cap 500 lines per id**), `health` (no-op). Actions: `pause`/`resume` optimistic flip + **rollback on non-ok** (`/queue/pause`, `/queue/resume`); `setGap(minMs,maxMs)` → POST `/queue/gap` `{minSeconds,maxSeconds}` (Math.round); `add(urls, folder, maxQuality, account)` → POST `/queue/add` `{urls,folder,maxQuality,account:account||undefined}`; `remove` optimistic filter + POST `/queue/remove {id}`; `retry`/`retryAll` loop; `clearCompleted`/`clearActive` optimistic + POST `/queue/clear {which}`. Throw error from response JSON on failure. `useQueue` outside provider throws. *(Auth header covered by App patch; contexts use bare `fetch`.)*
- **PlaylistsContext**: **no localStorage seed** (removed from earlier versions) — `refresh()` GET `/api/playlists` on mount → `{ok, playlists}` else error state; `loading` lifecycle. `playlistKeyForMedia(folder,rowKey)`: trailing-slash trim, backslash→slash, strip leading slashes, `folder ? folder/key : key`. Actions: `createPlaylist(name)` POST → returns `j.playlist` + refresh, 409 surfaced; `renamePlaylist(id,name)` PATCH `/api/playlists/:id`; `deletePlaylist(id)` DELETE; `toggleItem(id,key)` POST `:id/toggle {key}` → `j.member`; `addItem(id,key)` POST `:id/items {key}` → `j.added`; `removeItem(id,key)` DELETE `:id/items {key}` → `j.removed`; all re-`refresh()`. `isMember(id,key)` from `pl.items.includes(key)`. Outside-provider throw.
- **StacksContext**: `folderKey(folder)` trim + strip trailing slashes. `refresh(folder)` GET `/api/stacks?folder=` → stores per-folder map; `createStack({name,folder,items})` POST `/api/stacks`; `renameStack(id,name,folder)` PATCH `/api/stacks/:id`; `deleteStack(id,folder)` DELETE `:id?folder=`; `addItems(id,keys,folder)` POST `:id/items {keys,folder}` → `j.added`; `removeItems(id,keys,folder)` DELETE `:id/items` → `j.removed`; each re-`refresh(folder)`; `stacksForFolder(folder)`.

### `app.test.jsx` — auth/decoy/design state machine (verified)
- **Boot**: fetch hits `/api/auth/status`; `{protected:false}` → authed instantly; protected + no stored pw → decoy; protected + stored pw → auto-POST `/api/auth` to validate; fetch failure → treated as unprotected. `auth.checking` → blank loading screen.
- **Decoy "Memo"**: renders todo list seeded from defaults when localStorage `haven_todos_v1`/`haven_todo_groups_v1` empty; persist on add/toggle/clear-done; filters All/To do/Done with live counts; group filter chips; add task (new group auto-added if typed); add group; remove group → tasks moved to Inbox + confirm() (stub); progress bar pct; `document.title === "Memo"`.
- **Login entrance**: Ctrl+Shift+L opens modal (logged-out+protected); Esc closes; **5 clicks on the decoy footer** also opens it.
- **Successful login**: POST `/api/auth {password}` → `j.ok` → sets localStorage `xdl_admin_pw` + `xdl_panel_pw` + `xdl_last_activity`, swaps to schlorp shell. Wrong password → `j.error || "Invalid password"` shown, no keys set.
- **Auto-logout**: touch events (keydown/click/mousedown/touchstart/scroll) write `xdl_last_activity`; 30s interval check; **>600000 ms → `doLogout()`** (POST `/api/auth/logout`, clears `xdl_admin_pw`/`xdl_panel_pw`/`xdl_last_activity`, returns to decoy). Fake timers.
- **Esc+Backquote**: holding **both Escape and Backquote** together (keydown) → immediate logout, then cleared on keyup/blur. (NOT a timer reset — verified.)
- **Shell chrome**: schlorp logo (`/logo.png`), health dot (busy→amber / browserReady→green / else gray), Logout button, NavLinks Dashboard/Media/Collections/Profiles/Settings + `/api/media`/`?` fallback routes; `hasFlagged` warning icon on Collections when `/sync-config` poll (5s) shows a **configured** savedList row `paused:true`. `*` route → dashboard.
- **WS health**: raw `/ws` socket updates `health` from `{type:"health"}`; bad JSON swallowed.

### `views.test.jsx`
- **Dashboard**: queue snapshot render from mocked `/queue`; download form POSTs streaming-friendly `/download` and parses `#chunk#` lines incl. final `Downloaded media to:`; addMany; health wall.
- **Media** (explorer, 2669 lines — behavior level): renders `/api/media` (folder groups + flat); search `?q=`/`?mode=` (default `filename`); grid/list toggle persisted `xdl.gridview` (default grid); multi-select `Map<relPath,item>` + bulk ops; folder nav + `directoryList`; `crewReorderMode`; upload mode (drag-drop to `/api/media`, category, limit-exceeded, per-file results); gatekeeper valve `xdl.media.gatekeeper.valve`; preview opens FileViewer; mediaorder PUT; per-item mediathumb calls; delete confirm → DELETE `/api/media`; rename; move; stacks/playlist context menu wiring.
- **Saved**: collections render; crawl-all → POST `/collections/crawl-all`; scan-saved results (ids/urls/meta); sync-queue add/remove/clear; gap controls; resume.
- **Profiles**: GET `/accounts` table; create POST `/accounts`; delete; default-reset rejection; cdp/status button; open-browser; config save.
- **Settings**: GET `/api/config` → 6 groups + var metadata; POST save allowlisted vars only (unknown/newline error surfaced).

### `components.test.jsx` — FileViewer (full matrix; props `{src,title,filePath,url,file,viewable,idx,onPrev,onNext,onGoto,onClose,onDeleted}`)
**Pure helpers:** `parseFolderBase` (split at `/media/`, folder/base); `toMediaUrlLocal` (path rules: `/media/` slice, leading-slash add); `deriveTitleLocal` (filename regex `-\d+\.[a-z0-9]+$` strip + `[-_]+`→space + 60-char ellipsis; URL-path decode fallback; hostname fallback; invalid URL passthrough).

**Media type detection:** extension→video/audio/image/gif/pdf/text; MIME fallback via metadata load when extension ambiguous; `viewMode` auto/blob/stream persistence (`xdl.fileview.viewmode`); GIF-as-video toggle (`xdl.fileview.gifasvideo`).

**Playback:** play/pause + toggle; seek granularity `seekBase` (zoom 33 / slow 32 / seekframes 33 / normal 1000), frame-by-frame in seekframes (`hasSeekFrames`); rate menu 0.25–2 (`xdl.fileview.rate`); mute+unmute with volume restore (`xdl.fileview.muted`); loop toggle (`xdl.fileview.loop`); endMode cycle next→repeat→random→none (`xdl.fileview.endmode`); countdown-to-next on end; flash-on-end (`xdl.fileview.flash`); buffered rendering; duration/currentTime synced; `doesMediaHaveAudio`/`noAudioTrack`; audio-track + video-track enumeration/selection; output-audio-device change via `navigator.mediaDevices.enumerateDevices`; HLS source path.

**Navigation/teardown:** onPrev/onNext (disabled at 0/last when `viewable` bounded), onGoto(idx), onClose; `onDeleted` fired after successful delete AND after transfer.

**Delete/transfer/playlists:** context menu at x/y with actions; delete → ConfirmModal → DELETE `/api/media` → onDeleted; transfer → PromptModal (target folder) → move endpoint → onDeleted; add-to-playlist → PlaylistHoverMenu → `addItem`/`toggleItem`; remove-from-playlist.

**UI chrome:** fullscreen enter/exit + error path; Esc exits fullscreen + closes modal; ShortcutsHelp open/close; zoom in/out/reset (`xdl.fileview.zoom`); status + `mediaError`/`loadFailed` fallback UI.

### Other components
- **MediaContextMenu** (`{menu,onClose,stacks,selCount,onStack,onOpen,onDelete,onAddToStack,onRename,onUnstack,onRemoveFromStack}`): null→no render; `menu={entry,stackId}`; pile vs file vs **selection count wins** (`selCount>1`); `memberOf` = entry `it.stacks` ids + pile's own `stackId`; list split **own stacks first, then ≤5 rest**, divider between; disabled rules: "Stack N items" disabled at <2, "add to stack" at <1; Open/Delete always; pile-only Rename/Unstack (keep files)/Remove-from-stack; non-pile w/ stackId → Remove-from-stack; `stopPropagation` on click.
- **PlaylistHoverMenu** (`{mediaKey,placement,onCreated,showIndex}`): empty-state text; letter hotkey logic (first list per first-letter shows letter badge; **`extraIds` = subsequent same-letter lists + non-letter names → numbered 1–9** when `showIndex`); toggle w/ per-list button disabled while pending + error line; create: trim, disable when empty/creating, Enter submits, `maxLength=60`, **auto-adds `mediaKey` to the new playlist**, `onCreated(pl)`; member state from `pl.items.includes(mediaKey)`; count badge `pl.count ?? items.length`.
- **AlertModal / ConfirmModal / PromptModal**: message/label props, confirm/cancel/Enter-submit callbacks, autofocus, danger styling.
- **ShortcutsHelp**: static table, close button.

---

## Legacy HTML app tests — `test/ui/`

Harness `legacy-app.js`: `new JSDOM(html, {runScripts:'dangerously', url:'http://localhost:6767/'})`; stub globals (`fetch`, `WebSocket`, `navigator.clipboard`, localStorage) via `beforeParse`; extract inline `<script>` text and eval so page functions are reachable.

### `legacyspa.test.js` (`index.html`)
`parseDownloadedPaths` (`/^Downloaded media to:\s+(.+)$/`), `parseLinks`, `isPostUrl`/`filterPostUrls` (`/^\/(p|reel|tv)\//`), `domainOf`, `formatBytes`, `formatDate`, `novncUrl` (port 6778), `createQueueItemsFromInput`; view routing (dashboard/saved/sync/profiles/media/console); mocked fetch flows: `refreshHealth`, profiles table, `/download` streaming → `parseDownloadedPaths`, `svForm` → `/scan-saved`; localStorage `xdl.queue.v1` round-trip.

### `scan-saved-page.test.js` (`scan-saved.html`)
`parseEndUrls`, `renderList` (textContent-safe), `setMeta`, form submit success/error, button re-enable in `finally`.

### `landing.test.js`
Install toggles + copy buttons via `navigator.clipboard`; easter-egg handlers don't crash; links use `localhost` (no live IP).

---

## E2E / manual tier — `test/e2e/live.manual.test.js`
Gated behind `XDL_LIVE=1`; Docker + VNC + ffmpeg only: `buildBrowserFromLocalProfile`, `run()` on fixture Reddit/IG URL, `muxVideoAndAudio` audio path. Documented manual steps; skipped by default.

---

## Harness summary

| File | Purpose |
|---|---|
| `test/helpers/make-fake-page.js` | `page.evaluate(fn,…args)` runs callbacks in sandbox; `goto`/`waitForFunction`/`click`/`url`/cookies stubs |
| `test/helpers/fixture-server.js` | mp4 / master+variant m3u8 / m4a; call tracking; `listen(0)` |
| `test/helpers/temp-state.js` | `withTempState(fn)` — mkdtemp + env set/restore in `finally` |
| `test/helpers/api-server-harness.js` | spawn/stop api-server subprocess; parse port; health pump; sets `QUEUE_STUB_RUNNER=1` |
| `test/helpers/legacy-app.js` | jsdom loader for the 3 HTML pages |
| `web/test/setup.js` | jest-dom, fetch/WS/localStorage mocks, `_xdlFetchPatched` reset |

---

## Implementation order

1. Backend pure units — `config`, `media-utils`, `instagram-utils`, `reddit-utils` (fixtures incl. DdSewIihI-K regressions).
2. Engine units — ~~`queue.js` (injectable)~~ skipped (orphaned, user decision), `download.js` (fixture server), `extractors.js` (fake-page), `scan-saved`, `index` args.
3. **sync-daemon refactor (approved) + tests.**
4. **API harness (incl. `QUEUE_STUB_RUNNER`, approved)** + route suites → `health/auth` → `media` → `config/accounts` → `queue/ws`.
5. web/ foundation — vitest setup, `lib.test.js`, `app.test.jsx` (auth machine).
6. web/ stores → views → components (FileViewer matrix last, largest).
7. Legacy HTML jsdom suites.
8. Coverage gate + `test:all`; report per-file coverage.

## Acceptance criteria
- `npm test` green with zero browser/ffmpeg/network requirements; `npm run test:all` green (root + web).
- Coverage ≥70% lines on `config`, `media-utils`, `instagram-utils`, `reddit-utils`, `download` (non-ffmpeg), `api-server` route layer, and the web store/lib/auth layers.
- Fixture-based regressions for all four DdSewIihI-K fixes (foreign-shortcode subtree skip, SSR username, viewport-band filter, audio-only exclusion).
- Auth/decoy/logout state machine, WS backoff, and `#chunk#`/`#field#` stream parsing have dedicated tests; FileViewer matrix fully asserted.
- Prod changes limited to the 2 approved touches: `sync-saved-downloads.js` `require.main` guard + exports; gated `QUEUE_STUB_RUNNER` branch in `api-server.js`.

## Closed decisions (see table above)
D4 `require.main`/exports refactor — **approved**. D5 `QUEUE_STUB_RUNNER=1` — **approved**. D6 web/ devDeps — **approved**. D8 70% floor — **approved**. No open questions.