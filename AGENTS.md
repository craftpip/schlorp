# AGENTS.md — schlorp / scan-videos Codebase Guide

## Project Overview

**schlorp** — Node.js CLI + API server that drives CloakBrowser (stealth Chromium via Puppeteer) to visit URLs and download video media from Instagram, xHamster, xVideos, Pornhub, and generic sites. Includes a Docker+VNC setup and an Instagram saved-collection sync daemon.

- **Runtime:** Node 18+ (Docker: `node:20-bookworm-slim`)
- **Language:** JavaScript (CommonJS)
- **Packages:** `cloakbrowser ^0.4.10`, `dotenv ^17.3.1`, `express ^5.2.1`, `puppeteer-core ^24.37.5`
- **External binary:** ffmpeg (required for HLS/DASH muxing)
- **Entry points:** `schlorp-cli` (CLI), `api-server.js` (API), `sync-saved-downloads.js` (daemon)
- **Scripts:** `npm start`/`npm run api` → `node api-server.js`; `npm run scan` → `node schlorp-cli`; docker scripts for compose

## Directory Layout

```
/workspace/
  .env                          # Local env vars (BROWSER_USER_DATA_DIR, HEADLESS, etc.)
  .dockerignore
  .gitignore                    # Ignores media/, node_modules/, .saved-sync-state.json
  .download-queue.json          # Sync daemon queue: { pending: [], completed: [] }
  .saved-sync-state.json        # Per-list scan state (lastSeenUrl, lastRunAt, etc.)
  package.json
  Dockerfile
  docker-compose.yml            # app (port 6767, 6777:6777, 6778:6778 via xdl-bridge)
  docker/entrypoint.sh          # Starts Xvfb + fluxbox + x11vnc + noVNC if ENABLE_VNC=1
  api-server.js                 # Express API (port 3000, single-job concurrency)
  schlorp-cli                   # CLI entry: loads dotenv, calls ./scan-videos/index.run()
  sync-saved-downloads.js       # Daemon: polls Instagram saved collections via API
  index.html                    # Download UI (inline SPApp)
  scan-saved.html               # Scan saved collection UI
  media/                        # Download output dir (empty, gitignored)
  scan-videos/
    index.js                    # Core scan/download engine (830 lines) — exports { run }
    browser.js                  # Browser launcher — exports { buildBrowserFromLocalProfile }
    config.js                   # Env config helpers — exports { shouldRunHeadless, shouldAutoContinuePrompts, getInstagramUserAgent, waitForEnter, normalizeUrl, resolveProfileConfig }
    download.js                 # Media downloader (HTTP + ffmpeg for HLS/DASH) — exports { hasFfmpeg, muxVideoAndAudio, mediaHasAudio, downloadMedia }
    extractors.js               # Site-specific page-evaluate extractors — exports { extractXhamsterMediaData, extractXvideosMediaUrls, extractPornhubMediaData, getInstagramUsername, getInstagramUsernameFromOembed }
    instagram-utils.js          # Instagram helpers — exports { isReservedInstagramName, extractInstagramShortcode, extractInstagramUsernameFromJsonText, extractInstagramMediaHintsFromJsonText, filterInstagramCandidatesForTarget }
    media-utils.js              # URL parsing/scoring — exports { isLikelyVideoUrl, stripByteRangeParams, isStreamingManifestUrl, isDirectFileUrl, extractQualityHint, metadataQualityScore, isInstagramAudioOnlyUrl, getInstagramAssetId, scoreDownloadCandidate, prioritizeInstagramCandidates, extractDownloadableVideoUrls, prioritizeXhamsterCandidates, sanitizeFileToken }
    scan-saved.js               # Instagram saved page scanner — exports { scanSavedPage }
```

## API Endpoints

| Method | Path | Input | Output | Notes |
|--------|------|-------|--------|-------|
| GET | `/` | — | HTML | Serves `index.html` |
| GET | `/scan-saved` | — | HTML | Serves `scan-saved.html` |
| GET | `/health` | — | `{ ok, shuttingDown, busy, browserReady }` | Health check |
| POST | `/sync-queue/pending/add` | JSON: `urls` (array, req), `folder` (opt) | `{ ok, added, skipped, pending }` | Adds URLs to the sync download queue (dedupes vs pending/completed/lastSeen) |
| POST | `/sync-queue/pending/remove` | JSON: `url` (req) | `{ ok, removed }` | Removes matching pending item(s) from the sync queue |
| POST | `/download` | JSON/query: `link` (req), `folder` (opt), `maxQuality` (opt) | `text/plain` streaming | Downloads media. Busy → 429. |
| POST | `/scan-saved` | JSON/query: `url` (req), `endUrls` (opt), `account` (opt, default "default") | `{ ok, urls, ids, ... }` | Scans IG saved page using account's profile. |
| GET | `/api/mediaorder` | query: `folder` (opt), `flat` (opt "1") | `{ ok, scope, order }` | Custom grid order per folder+flat scope (`.mediaorder.json`) |
| GET | `/api/setup/state` | — | `{ ok, needsSetup, kind: new\|returning\|encrypted, files, folders, encrypted, patternSlot, unlocked }` | First-run wizard (plan 043), only while no panel password is set. `encrypted` = key file on the drive: the first password set must be the drive's (it unlocks + becomes the panel password; or unlock with the pattern via `/api/vault/unlock`, then any new password) |
| GET | `/api/vault/status` | — | `{ ok, available, exists, unlocked, patternSlot, hasPattern, keyId, copies, autoLockMinutes }` | Media encryption state (plan 039) |
| POST | `/api/vault/setup` | JSON: `password` (panel password) | vault status | One-time: random key pair sealed with the panel password; 409 if a vault exists. Never automatic |
| POST | `/api/vault/unlock` | JSON: `password` or `pattern` `{size:5,dots}` | vault status | Opens the private key into memory (also happens automatically on login) |
| POST | `/api/vault/lock` | — | vault status | Wipes the private key from memory |
| POST | `/api/media/lock` | JSON: `action` ("lock"/"unlock"), `keys` (media-relative files), `dirs` (media-relative folders, recursive) | `{ ok, job }` | Background encrypt/decrypt job (one at a time, 409 if busy); file keys include `<stem>-poster.*` |
| GET | `/api/media/lock/job` | — | `{ ok, job }` | Current/last lock job progress (also WS `media:lock`) |
| POST | `/api/media/lock/cancel` | — | `{ ok, job }` | Stop the running lock job after the current file |
| POST | `/api/media/upload` | query: `folder` (opt), `path` (req, may contain sub-folders); body = raw file bytes | `{ ok, name, rel, locked }` | Streams to disk (encrypted when `ENCRYPT_NEW_MEDIA=1`); collisions → `name (1).ext` |
| POST | `/api/auth` | JSON: `password` | `{ ok, token }` | Public: password login → in-memory session token (cookie + `x-xdl-session`); also unlocks the vault. Rate-limited |
| GET | `/api/auth/methods` | — | `{ ok, loginPattern, preferLogin, minDots }` | Public: what the login box offers |
| POST | `/api/auth/pattern` | JSON: `pattern` `{size:5,dots}` | `{ ok, token }` | Public: pattern login → session token; also unlocks the vault via its pattern slot |
| GET | `/api/auth/session` | — | `{ ok }` | Session probe |
| GET/POST | `/api/security`, `/api/security/password` (`currentPassword`, `newPassword`), `/api/security/pattern` (`pattern` or null, `password`), `/api/security/prefs` (`preferLogin`, `autoLockMinutes`) | | settings | Password/pattern stored as scrypt hashes in `.xdl-auth.json` (root, gitignored); changing them re-seals the vault slots |
| GET/POST | `/api/config` | `{key,value}` | schema groups | Settings page: friendly schema (`settingsSchema()`), type-checked; keys set by the container env are `lockedByContainer` (409 on save) |
| POST | `/api/restart` | JSON: `force` (opt) | `{ ok }` | Exits so Docker restarts the app (409 while a job runs unless forced) |
| PUT | `/api/mediaorder` | JSON: `folder` (opt), `flat` (opt), `order` (array, req) | `{ ok, scope, order }` | Saves custom grid order (deduped, sanitized, max 20000) |

## Environment Variables (all optional, defaults in parens)

### Core
- `PORT` (6767) — API server port
- `HEADLESS` (`!process.env.DISPLAY`) — browser headless mode
- `API_HEADLESS` (falls back to HEADLESS) — headless mode for API
- `BROWSER_USER_DATA_DIR` (`~/.config/cloakbrowser-profile`) — Chrome profile dir
- `BROWSER_PROFILE_DIR` (`Default`) — profile subdir
- `BROWSER_PATH` — custom Chrome/Chromium binary
- `INSTAGRAM_USER_AGENT` — custom UA for Instagram (default: iPhone Safari)
- `AUTO_CONTINUE` (`!process.stdin.isTTY`) — auto-continue prompts without waiting
- `AUTO_CONTINUE_WAIT_MS` (0) — ms to wait before auto-continue
- `MEDIA_RANGE_SIZE` (100) — media grid rail: files per range
- `KEYBOARD_HINTS` (1) — show keyboard shortcut hint pills on buttons (0 = hide)

### Media encryption & login (plans 039/040)
- `ENCRYPT_NEW_MEDIA` (0) — encrypt new downloads + uploads; needs a panel password and a set-up vault. Read live. Works while the vault is locked.
- **One secret:** the panel password (no length rule; Settings shows a time-to-crack estimate) plus an optional 5×5 pattern (≥8 dots). Neither is stored readably: login checks use scrypt hashes in `.xdl-auth.json`; `UI_PANEL_PASSWORD` in `.env` is migrated into the hash once at startup and blanked. The browser keeps only a session token (memory-only on the server; restart = log in again). Header/query password auth no longer exists; internal calls use the loopback `X-Xdl-Internal` token.
- **Vault v3** (`.xdl-vault.json` at the media root **and every drive mount root inside media/**): random X25519 key pair; public key in the clear (encrypts), private key sealed in two slots — scrypt(password) and scrypt(pattern, 2× cost). Login with either secret unlocks; Lock now / idle auto-lock (`autoLockMinutes`) wipe the key from memory. A stolen drive is only as safe as the weaker of the two secrets.
- **Hidden names (plan 041):** locking renames the file to a random 16-char code with **no extension** (`k7q2m9x4c8v1b3n6`) — posters too, each with its own unrelated code; the real name is stored encrypted in the file and the server/UI read the type from it (`realNameOf()`, `displayName`; generic icons while the vault is locked) (format `XDLENC03`, name block after the header). `/api/media` and playlist items return it as `displayName` only while the vault is unlocked; downloads use it. Unlocking restores it (collisions → `name (1).ext`). Posters pair with their file through the real names only (`companionPosterNames()`); playlists, `.mediadims.json`, `.mediaorder.json` and stacks follow the rename (`renameMediaKeyInPlace`). Encrypted uploads/downloads get code names straight away.
- File format `XDLENC03` (`scan-videos/media-crypto.js`): per-file random key wrapped to the vault public key, chunked AES-256-GCM. `/media/*` decrypts on the fly with Range support (423 while locked); server-side ffmpeg/ffprobe read encrypted files through the loopback URL (`ffInputFor()`) — never pass an encrypted path to ffmpeg directly.
- A vault is only created by explicit setup; the panel password can't be removed while one exists. `.xdl-created.json` (root) keeps original creation times of re-decrypted files.

### Capture Timing
- `AUTO_CAPTURE_TIMEOUT_MS` (30000) — max wait for media signals
- `AUTO_CAPTURE_QUIET_MS` (1800) — quiet period before proceeding
- `AUTO_CAPTURE_POLL_MS` (250) — poll interval

### Timeouts
- `API_JOB_TIMEOUT_MS` (1800000) — max API job duration (30m)
- `DOWNLOAD_FETCH_TIMEOUT_MS` (300000) — HTTP fetch timeout (5m)
- `FFMPEG_TIMEOUT_MS` (900000) — ffmpeg timeout (15m)
- `FFPROBE_TIMEOUT_MS` (120000) — ffprobe timeout (2m)

### Instagram/Sync
- `INSTAGRAM_429_COOLDOWN_MS` (300000) — cooldown after 429
- `SAVED_SYNC_DOWNLOAD_DELAY_MS` (20000) — delay between sync downloads
- `SAVED_SYNC_STATE_FILE` (`.saved-sync-state.json`)
- `SAVED_SYNC_QUEUE_FILE` (`.download-queue.json`)
- `SAVED_SYNC_RETRY_DELAY_MS` (3000)
- `SAVED_SYNC_RETRY_COUNT` (20)
- `API_BASE` (`http://localhost:3001`) — base URL for sync daemon API calls

### Docker
- `ENABLE_VNC` (0) — start VNC in container
- `VNC_PORT` (6777)
- `NOVNC_PORT` (6778)

## Module Exports Map

```
scan-videos/index.js         → { run(urls, options) }
scan-videos/browser.js       → { buildBrowserFromLocalProfile(options) }  // options.account supported
scan-videos/config.js        → { shouldRunHeadless, shouldAutoContinuePrompts, getInstagramUserAgent, waitForEnter, normalizeUrl, resolveProfileConfig, loadAppConfig, resolveAccountConfig, getStateFilePath }
scan-videos/download.js      → { hasFfmpeg, muxVideoAndAudio, mediaHasAudio, downloadMedia, downloadStreamingManifestViaBrowser, parseM3u8Playlist, parseM3u8Attributes, ... }
scan-videos/extractors.js    → { extractXhamsterMediaData, extractXvideosMediaUrls, extractKvsMediaData, extractEpornerMediaData, extractBeegMediaData, extractSpankbangMediaData, extractJavMediaData, extractPornhubMediaData, getInstagramUsername, getInstagramUsernameFromOembed }
scan-videos/instagram-utils.js → { isReservedInstagramName, extractInstagramShortcode, extractInstagramUsernameFromJsonText, extractInstagramMediaHintsFromJsonText, filterInstagramCandidatesForTarget }
scan-videos/media-utils.js   → { isLikelyVideoUrl, stripByteRangeParams, isStreamingManifestUrl, isDirectFileUrl, extractQualityHint, metadataQualityScore, isInstagramAudioOnlyUrl, getInstagramAssetId, scoreDownloadCandidate, prioritizeInstagramCandidates, extractDownloadableVideoUrls, prioritizeXhamsterCandidates, isAdVideoUrl, isPreviewClipUrl, sanitizeFileToken }
scan-videos/scan-saved.js    → { scanSavedPage({ browser, targetUrl, endUrls?, waitMs?, exitWaitMs?, maxIterations?, log? }) }
scan-videos/site-hosts.js     → { SITE_HOSTS, hostMatchesSite, siteOfHostname }  // canonical + mirror hosts per site (plan 036 §8)
scan-videos/media-crypto.js   → { encryptFileInPlace(pub), decryptFileInPlace(priv), decryptRange(priv), createDecryptStream, encryptIterableToFile(pub), readFileHeader, createVault, openVault(slot), setVaultSlot, vaultPublicKey, isLockableName, ... }  // plan 039 v3
scan-videos/media-vault.js    → { createMediaVault({ mediaDir, rootDir, isProtected }) }  // setup/unlock(slot)/lock/setSlot, encryptKey()/decryptKey(), per-drive copies, lock cache, created-time overrides
scan-videos/pattern-auth.js   → { createPatternAuth({ rootDir }) }  // password/pattern hashes, rate limiter, sessions, prefs, .env password migration
```

## Key Patterns

### Concurrency model
- API server: **single-job** (`activeJob`). Busy → HTTP 429. Job timeout recycles browser.
- Sync daemon: **single-threaded** event loop. Processes one scan or download at a time.

### Browser lifecycle
- Shared singleton via `getSharedBrowser()` / `closeSharedBrowser()` in `api-server.js`.
- `buildBrowserFromLocalProfile()` clones profile if locked (removes lock artifacts).
- Uses CloakBrowser (stealth Chromium) via `cloakbrowser/puppeteer`.

### Core scan flow (`scan-videos/index.js`)
1. Parse args/options
2. Open browser (or accept injected browser)
3. For each URL:
   - Detect site type (Instagram, xHamster, Pornhub, xVideos, generic)
   - Set Instagram mobile UA if IG target
   - Navigate with Instagram 429 retry logic
   - Auto-capture: poll DOM + network until media signals settle
   - Collect video URLs (DOM + network interception)
   - Site-specific extraction (xHamster/Pornhub/xVideos)
   - Score/prioritize candidates, apply quality cap
   - Download with browser cookies/headers
   - For Instagram: detect audio-less video, download companion audio, ffmpeg mux

### Instagram specifics
- Mobile viewport (430x932), mobile UA
- Response interception for GraphQL/API JSON data
- Shortcode extraction from `/reel/CODE`, `/p/CODE`
- Audio companion detection via `efg.vencode_tag = "dash_lna"`
- ffmpeg mux if downloaded video lacks audio track
- 429 detection: cooldown then throw with `error.status = 429`

### Sync daemon (`sync-saved-downloads.js`)
- Saved collection URLs + accounts read from `.saved-sync-state.json` `config.savedLists` (no longer hardcoded)
- Each saved list entry has `url`, `folder`, and `account` fields
- Accounts defined in `config.accounts` with `name` and `profileDir` (userDataDir falls back to env default)
- State in `.saved-sync-state.json` + `.download-queue.json`
- Randomized: which list to scan, which queued URL to download, when to take breaks
- Dynamic rate (target tasks/hour based on queue depth)
- Exit on 429, graceful SIGTERM/SIGINT

### Multi-account support
- `.saved-sync-state.json` holds both config (`config.accounts`, `config.savedLists`) and runtime state (`lists`)
- `config.js` exports `loadAppConfig()` (reads config section) and `resolveAccountConfig(name, accounts)` (merges with defaults)
- `browser.js` `buildBrowserFromLocalProfile({ account: "name" })` looks up the account's profile config
- `api-server.js` maintains `browsersByAccount` Map — a separate browser instance per account, created lazily
- `POST /scan-saved` accepts optional `account` param; uses per-account browser if not "default"
- CLI: `node schlorp-cli open-browser --account work` opens browser for that specific profile
- Default account "default" uses `BROWSER_USER_DATA_DIR` / `BROWSER_PROFILE_DIR` env vars

### Error handling
- `ApiError` class (sync daemon) with `status` and `retryable` fields
- `withRetries()` helper with exponential-like backoff
- Instagram 429 → cooldown, then non-retryable error
- Job timeout → recycle browser, throw

### Response streaming (API)
- `/download` returns `text/plain`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`
- Streams log lines; final line is `Downloaded media to: <path>`
- Frontend parses this to create download links

### Instagram JSON response format
- Instagram wraps responses in `for (;;);` prefix
- Utilities in `instagram-utils.js` strip this before JSON.parse
- Deep-search for `video_url`, `asset_id` matching the target shortcode

## Docker

- **docker-compose.yml** defines `app` (web API + VNC) — single service `schlorp` (container_name `schlorp`), network_mode `container:gluetun-nordvpn2`
- `app` internal: `6767` (API), `6777` (VNC), `6778` (noVNC) — forwards via `xdl-bridge` socat bridge (`6767:6767`, `6777:6777`, `6778:6778`); compat socat inside entrypoint keeps old `7866:3000`/`7906:7900` working
- `gluetun-nordvpn2` no longer publishes host ports — all host publishing is via `xdl-bridge` (alpine/socat)
- Volumes: `.` → `/app` (live code), `/mnt/media2t/downloads/studies/xdl` → `/app/media`, `browser-data` volume
- Entrypoint (`docker/entrypoint.sh`): always starts Xvfb + fluxbox (needed for headful), conditionally starts x11vnc/noVNC when VNC enabled; VNC toggle persisted in `/data/browser/.vnc-enabled`

> **RED LINE — VPN folder off-limits:** Never modify `/www1/vpn/*` (`gluetun-*` compose, keys, configs). VPN is managed separately. All host port publishing must go through `xdl-bridge` socat, not gluetun `ports:`.

## Notes for agents
- All source files use CommonJS (`require`/`module.exports`)
- No TypeScript, no build step

### Web builds — sourcemaps stay ON
- We are in active development: **never make a production build with sourcemaps disabled.** `web/vite.config.js` must keep `build.sourcemap: true`, and `web/dist/assets/*.js.map` must be committed alongside the bundle.
- Reason: browser console errors must map back to real source lines (`web/src/...`), not minified bundle offsets. If a build ever ships without `.map` files, that is a bug — fix the build, don't work around it.
- Verify after any web build: the new `assets/index-<hash>.js` has a sibling `index-<hash>.js.map`, and the `.map` is actually served (a 200, not 404) — otherwise the console falls back to useless minified stacks.

### Tests
- Backend/API tests live in `test/` and run with `node --test` (`npm test`); coverage via `npm run test:cov` (`--experimental-test-coverage`).
- Web UI tests live in `web/test/` and run with Vitest + Testing Library (`npm run test:ui`, `npm --prefix web test`); coverage via `npm run test:ui -- --coverage`.
- Everything: `npm run test:all` (root + web).
- Tests never require a live browser, Docker, ffmpeg, or VNC — browser/ffmpeg behavior is stubbed or gated behind `XDL_LIVE=1` (skipped by default).
- Two test-only prod hooks exist and must NOT be removed or "cleaned up":
  - `QUEUE_STUB_RUNNER=1` in `api-server.js` (gated env branch with a stub job runner for browser-less `/queue` contract tests; off by default).
  - `sync-saved-downloads.js` guards main with `if (require.main === module)` and exports its internals for unit tests.
- `package-lock.json` exists; use `npm ci` for deterministic installs (as Dockerfile does)
- ffmpeg must be installed for HLS/DASH support; checked at runtime via `hasFfmpeg()`
- `.dockerignore` excludes `node_modules`, `media`, `docker-compose*.yml`
- `.gitignore` excludes `media/`, `node_modules/`, `.saved-sync-state.json`
- Always check `scan-videos/index.js` for the main orchestration logic, and `scan-videos/media-utils.js` for URL scoring/prioritization
