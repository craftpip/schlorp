# AGENTS.md — xdl / scan-videos Codebase Guide

## Project Overview

**xdl** — Node.js CLI + API server that drives CloakBrowser (stealth Chromium via Puppeteer) to visit URLs and download video media from Instagram, xHamster, xVideos, Pornhub, and generic sites. Includes a Docker+VNC setup and an Instagram saved-collection sync daemon.

- **Runtime:** Node 18+ (Docker: `node:20-bookworm-slim`)
- **Language:** JavaScript (CommonJS)
- **Packages:** `cloakbrowser ^0.4.10`, `dotenv ^17.3.1`, `express ^5.2.1`, `puppeteer-core ^24.37.5`
- **External binary:** ffmpeg (required for HLS/DASH muxing)
- **Entry points:** `scan-videos.js` (CLI), `api-server.js` (API), `sync-saved-downloads.js` (daemon)
- **Scripts:** `npm start`/`npm run api` → `node api-server.js`; `npm run scan` → `node scan-videos.js`; docker scripts for compose

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
  scan-videos.js                # CLI entry: loads dotenv, calls ./scan-videos/index.run()
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
scan-videos/download.js      → { hasFfmpeg, muxVideoAndAudio, mediaHasAudio, downloadMedia }
scan-videos/extractors.js    → { extractXhamsterMediaData, extractXvideosMediaUrls, extractPornhubMediaData, getInstagramUsername, getInstagramUsernameFromOembed }
scan-videos/instagram-utils.js → { isReservedInstagramName, extractInstagramShortcode, extractInstagramUsernameFromJsonText, extractInstagramMediaHintsFromJsonText, filterInstagramCandidatesForTarget }
scan-videos/media-utils.js   → { isLikelyVideoUrl, stripByteRangeParams, isStreamingManifestUrl, isDirectFileUrl, extractQualityHint, metadataQualityScore, isInstagramAudioOnlyUrl, getInstagramAssetId, scoreDownloadCandidate, prioritizeInstagramCandidates, extractDownloadableVideoUrls, prioritizeXhamsterCandidates, sanitizeFileToken }
scan-videos/scan-saved.js    → { scanSavedPage({ browser, targetUrl, endUrls?, waitMs?, exitWaitMs?, maxIterations?, log? }) }
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
- CLI: `node scan-videos.js open-browser --account work` opens browser for that specific profile
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

- **docker-compose.yml** defines `app` (web API + VNC) — single service `xdl` (container_name `xdl`), network_mode `container:gluetun-nordvpn2`
- `app` internal: `6767` (API), `6777` (VNC), `6778` (noVNC) — forwards via `xdl-bridge` socat bridge (`6767:6767`, `6777:6777`, `6778:6778`); compat socat inside entrypoint keeps old `7866:3000`/`7906:7900` working
- `gluetun-nordvpn2` no longer publishes host ports — all host publishing is via `xdl-bridge` (alpine/socat)
- Volumes: `.` → `/app` (live code), `/mnt/media2t/downloads/studies/xdl` → `/app/media`, `browser-data` volume
- Entrypoint (`docker/entrypoint.sh`): always starts Xvfb + fluxbox (needed for headful), conditionally starts x11vnc/noVNC when VNC enabled; VNC toggle persisted in `/data/browser/.vnc-enabled`

> **RED LINE — VPN folder off-limits:** Never modify `/www1/vpn/*` (`gluetun-*` compose, keys, configs). VPN is managed separately. All host port publishing must go through `xdl-bridge` socat, not gluetun `ports:`.

## Notes for agents
- All source files use CommonJS (`require`/`module.exports`)
- No TypeScript, no build step
- No test framework or test files exist
- `package-lock.json` exists; use `npm ci` for deterministic installs (as Dockerfile does)
- ffmpeg must be installed for HLS/DASH support; checked at runtime via `hasFfmpeg()`
- `.dockerignore` excludes `node_modules`, `media`, `docker-compose*.yml`
- `.gitignore` excludes `media/`, `node_modules/`, `.saved-sync-state.json`
- Always check `scan-videos/index.js` for the main orchestration logic, and `scan-videos/media-utils.js` for URL scoring/prioritization
