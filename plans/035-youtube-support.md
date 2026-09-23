# Plan 035 — YouTube Download Support (via yt-dlp)

**Date:** 2026-09-23
**Status:** Planned (not implemented — per user "dont add, tell me how")
**Trigger:** User asked "can we add youtube?" → confirmed "you'll use yt-dlp right".
**Decision:** YouTube via `yt-dlp` binary, not native page-scrape.

## 1. Why yt-dlp (not an extractor)

Current engine (`scan-videos/index.js:1025-1035`) collects `domVideos + networkVideos + site extractors` then downloads direct `mp4/m3u8/mpd` via `downloadMedia`. YouTube never exposes those:

- streams are ciphered `googlevideo.com/videoplayback` URLs (signature decipher required, rotates).
- video/audio are split DASH tracks needing `ffmpeg` merge.
- page-scrape (`ytInitialPlayerResponse`) breaks on every YouTube deploy.

`yt-dlp` already solves decipher + format pick + `ffmpeg` merge + `watch / shorts / youtu.be / embed / live` + cookies + `--max-quality` mapping. Same bypass pattern as existing `pornhub get_media` / `reddit redgifs API` branches — early-branch before generic capture.

## 2. Goal / Scope

- **In:** single-video download for `youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/shorts/ID`, `/embed/ID`, `/live/ID`, `youtube-nocookie.com`. Works via CLI (`scan-videos.js`), `POST /download`, web queue. Respects `maxQuality`. Uses logged-in profile cookies when available.
- **Out:** playlists (`list=` ignored, first video or fail), age-restricted without login (fail with clear reason), live-chat, subtitles, chapters. No `scan-saved` for YouTube (no saved-list concept here).

## 3. Architecture — where to change

```
Dockerfile                  → install yt-dlp binary (pip or static) alongside ffmpeg
scan-videos/youtube-utils.js → NEW: isYoutubeUrl, extractYoutubeVideoId, youtubeFormatForMaxQuality
scan-videos/download.js      → add downloadYoutube({ videoId|url, outputDir, filePrefix, maxQuality, headers, log, onProgress })
scan-videos/index.js         → add isYoutubeTarget detector + early-branch (skip auto-capture/scoring, call downloadYoutube, continue)
api-server.js                → no logic change (passes through run()); queue progress stage "downloading" already handles HLS tick
test/unit/youtube-utils.test.js → NEW: ID extraction + format mapping (no live network)
README.md / AGENTS.md        → provider list 5+generic → 6+generic
```

No change to `extractors.js`, `media-utils.js` scoring, `scan-saved.js`, `sync-saved-downloads.js`.

## 4. Detailed design

### 4.1 Helpers — `scan-videos/youtube-utils.js` (NEW, mirrors `reddit-utils.js`)

```js
function isYoutubeUrl(rawUrl) // hostname /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i
function extractYoutubeVideoId(rawUrl)
  // v= param, youtu.be/ID, /shorts/ID, /embed/ID, /live/ID, /v/ID → /^[A-Za-z0-9_-]{6,12}$/
function youtubeFormatForMaxQuality(maxQuality)
  // 0/falsy → "bv*+ba/b" (best); else `bv*[height<=N]+ba/b[height<=N]/b[height<=N]`
```

Exports: `isYoutubeUrl, extractYoutubeVideoId, youtubeFormatForMaxQuality`.

### 4.2 Downloader — `scan-videos/download.js`

```js
async function downloadYoutube({ url, outputDir, filePrefix, maxQuality, headers, log, onProgress })
  // 1. hasBinary check: `yt-dlp --version` (timeout 10s). Missing → throw "yt-dlp required for YouTube".
  // 2. args: ["-f", youtubeFormatForMaxQuality(maxQuality), "--merge-output-format", "mp4",
  //           "-o", path.join(outputDir, filePrefix + ".%(ext)s"),
  //           "--no-playlist", "--add-header", `Cookie:${headers.cookie}` (if present),
  //           "--add-header", `User-Agent:${headers.user-agent}`, url]
  // 3. execFile yt-dlp with FFMPEG_TIMEOUT_MS; stream stdout → log + onProgress({stage:"downloading"}).
  // 4. return { filePath } resolved from `-o` template (glob prefix.*) — same shape as downloadMedia.
```

Reuse `sanitizeFileToken` for `filePrefix` (title or `youtube-<id>`).

### 4.3 Engine — `scan-videos/index.js`

- Detector next to `isInstagramTarget` (`~line 550`):
  ```js
  const isYoutubeTarget = isYoutubeUrl(targetUrl);
  const youtubeVideoId = isYoutubeTarget ? extractYoutubeVideoId(targetUrl) : "";
  ```
- Early-branch before auto-capture/xhamster block (`~line 901`):
  ```js
  if (isYoutubeTarget) {
    if (!youtubeVideoId) { failedTargets.push({url, reason:"Invalid YouTube URL — no video ID."}); continue; }
    filePrefix = sanitizeFileToken(await page.title()) or `youtube-${youtubeVideoId}`;
    headers = await buildDownloadHeaders(targetUrl); // reuse cookies/UA
    result = await downloadYoutube({ url: targetUrl, ... });
    downloadedFiles.push(...); continue;
  }
  ```
- `parsed.linkOnly`: run `yt-dlp -g -f <format>` and log URLs instead of downloading (mirrors `qualityCappedUrls` log path).
- No change to `prioritize*` / `applyMaxQualityLimit` — YouTube never enters `allVideos`.

### 4.4 Dockerfile / env

- `Dockerfile`: `RUN pip install -U yt-dlp` (or `COPY --from=...` static binary). Keep `ffmpeg` as-is — yt-dlp calls it for merge.
- Optional `YT_DLP_BIN` env override (same pattern as `FFMPEG_BIN` in `api-server.js:17`).
- Local dev: `pip install yt-dlp` / `brew install yt-dlp`.

### 4.5 Filename / quality

- Default `filePrefix`: page `document.title` sanitized, fallback `youtube-<id>` (same convention as `reddit-<id>` at `index.js:1218`).
- `maxQuality` (e.g. `--max-quality 720`): mapped via `youtubeFormatForMaxQuality`, not `applyMaxQualityLimit`.

## 5. Implementation steps

1. `Dockerfile` + local install `yt-dlp`; verify `yt-dlp --version` + `ffmpeg -version`.
2. Create `scan-videos/youtube-utils.js` (detector + ID + format).
3. Add `downloadYoutube` to `scan-videos/download.js` (+ export).
4. Wire `isYoutubeTarget` early-branch in `scan-videos/index.js` (detect, prefix, headers, linkOnly, download, continue).
5. Unit test `test/unit/youtube-utils.test.js` (watch/shorts/youtu.be/embed/live/invalid + format mapping).
6. Update `README.md:78`, `AGENTS.md` provider list, `PLAN.md` if needed.
7. Manual test (live, gated — never in CI):
   - `node scan-videos.js --link-only https://www.youtube.com/watch?v=<id>`
   - `node scan-videos.js --max-quality 720 https://youtu.be/<id>`
   - `POST /download {link: "https://www.youtube.com/shorts/<id>"}` → `Downloaded media to:` + `/media/*.mp4` playable.
   - Missing binary → clear `yt-dlp required` error, no hang.

## 6. Risks / mitigations

- `yt-dlp` outdated vs YouTube player → pin + periodic `yt-dlp -U`; error surfaces as `failedTargets` reason, not hang (timeout = `FFMPEG_TIMEOUT_MS`).
- Age-restricted / login-walled → needs profile cookies; reuse `page.cookies()` → `--add-header Cookie:`; else fail with `Login required` reason.
- Playlist URL with `list=` → force `--no-playlist` (single video only).
- Binary missing in CI/Docker cache → `hasYtDlp()` gate; tests stub `downloadYoutube` (same `XDL_LIVE=1` gate as browser/ffmpeg tests).
- Two test-only hooks stay untouched: `QUEUE_STUB_RUNNER=1`, `require.main === module` guard.

## 7. Verification

- `node --check scan-videos/youtube-utils.js scan-videos/download.js scan-videos/index.js`
- `npm test` (backend, no live browser/yt-dlp needed — YouTube paths stubbed).
- Live (inside container): 3 URLs above → mp4 in `media/`, `ffprobe` has audio+video, poster `-poster.jpg` generated.
- `curl /health` OK; queue progress shows `downloading` stage during `yt-dlp` run.
