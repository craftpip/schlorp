# Plan 010 — Reddit Saved + Post Download Support

**Date:** 2026-08-25
**Status:** Done
**Owner:** elk profile (`/data/account-elk`) already logged into reddit as `craftpip`
**Trigger:** User added `https://www.reddit.com/user/craftpip/saved` → `folder: reddit`, `account: elk`, `schedule: manual` to `.saved-sync-state.json` and requested scraping + downloading reddit posts.

## 1. Probe findings (2026-08-25, inside xdl container, elk profile, headless)

### Saved page `https://www.reddit.com/user/craftpip/saved/`
- Final URL `https://www.reddit.com/user/craftpip/saved/`, status 200, HTML ~788KB.
- Uses new Reddit UI (`shreddit-post` web component), not old.reddit.
- Initial load: 8 `shreddit-post` elements, after one `scrollToBottom` → 33 (infinite scroll works via window scroll; virtualized but DOM grows).
- `shreddit-post` attrs observed:
  ```
  permalink="/r/titslap/comments/1vug8by/big_punching_bags/"
  content-href="https://i.redd.it/ukbn8n9raqkh1.gif"   // or https://www.redgifs.com/watch/...
  domain="i.redd.it" | "redgifs.com" | "v.redd.it" | "preview.redd.it" | "self" etc
  post-type="gif" | "image" | "video" | "link" | "gallery" etc
  id="t3_1vug8by"  // base36 id, same as comments id
  subreddit-prefixed-name="r/titslap"
  ```
- Fallback anchor extraction also works: `a[href]` with `/r/*/comments/*` → 36 unique post URLs after scroll (sample: `https://www.reddit.com/r/titslap/comments/1vug8by/big_punching_bags/`).
- Login wall: not present when elk profile logged in. If not logged, page redirects away from `/saved/` (same pattern as Instagram). Check `targetLooksSaved && !openedLooksSaved`.

### Post pages (3 samples)
| URL | domain | post-type | shreddit-post.content-href | network | `.json` (`url.json`) |
|-----|--------|-----------|---------------------------|---------|---------------------|
| `/r/titslap/comments/1vug8by/big_punching_bags/` | i.redd.it | gif | `https://i.redd.it/ukbn8n9raqkh1.gif` | `preview.redd.it/...format=mp4` mp4, no `<video>` tag initially | `url_overridden_by_dest: https://i.redd.it/ukbn8n9raqkh1.gif`, `preview.images[].variants.mp4.source.url` mp4, `is_reddit_media_domain: true` |
| `/r/BiggerThanYouThought/comments/1snz5lt/i_missed_you/` | redgifs.com | link | `https://www.redgifs.com/watch/worrisomefoolhardylonghornbeetle` | no video (iframe embed), but JSON has `media_embed.content: <iframe src="https://www.redgifs.com/ifr/...">`, `secure_media.oembed.html` same, `thumbnail` preview | `domain: redgifs.com`, `secure_media.type: redgifs.com` |
| `/r/BiggerThanYouThought/comments/1t1pwli/.../` | redgifs.com | link | `https://www.redgifs.com/watch/revolvingobedientarmedcrab` | `https://api.redgifs.com/v2/gifs/revolvingobedientarmedcrab/sd.m3u8` (HLS), `media.redgifs.com/...mobile.m4s` fetched → real video is HLS on redgifs CDN | JSON similar, plus `reddit_video_preview` fallback (v.redd.it mp4) for preview |

**Key takeaways:**
- **i.redd.it** posts are direct image/gif → downloadable via direct fetch (jpg/gif/mp4 variant). Preview gives mp4 alternate.
- **v.redd.it** posts (not in sample but expected) have `media.reddit_video.fallback_url` + `dash_url` + `hls_url` (seen in preview for third post: `https://v.redd.it/mkvbhztd7qyg1/DASHPlaylist.mpd` etc).
- **redgifs.com** posts: content is iframe embed. The actual mp4/m3u8 lives at `api.redgifs.com/v2/gifs/<id>` (json) → `gifs.sources` with `sd`/`hd` mp4 + `sd.m3u8`. Network capture on third post shows `api.redgifs.com/v2/gifs/.../sd.m3u8` and `.m4s` segments → behaves like HLS/DASH, needs extractor.
- **Gallery** posts (not sampled) expected: `gallery_data.items` + `media_metadata` in JSON with multiple `s.u` URLs.
- **Old path:** Reddit JSON `https://www.reddit.com/r/sub/comments/id/.json` with cookies returns full post data (including `url_overridden_by_dest`, `preview`, `media`, `secure_media`, `gallery_data`, `media_metadata`, `crosspost_parent_list`). Works with elk cookies (probe fetched via `fetch(..., {credentials:'include'})` and got JSON). No auth header needed.
- No `<video>` tags in DOM for these posts pre-interaction; rely on `shreddit-post` attrs + JSON + network (redgifs HLS) + `preview` mp4.

## 2. Goal / Scope — UPDATED 2026-08-25 per user: videos only, GIF included, photos skipped

- **Scrape reddit saved** (`/user/craftpip/saved`) via elk profile, paginating until `endUrls` (lastSeen) or no increase, collecting unique `https://www.reddit.com/r/*/comments/*` URLs. **Scope narrowed: only posts that contain video/GIF — skip pure photo/image posts and image galleries.**
- **Download reddit posts (video + GIF only)**: given a post URL, extract best **video/GIF** media and download to `media/<folder>/`. Photos skipped. Supported video sources:
  - **v.redd.it** — native Reddit video (`hosted:video` / `is_video:true` / `media.reddit_video`+`secure_media.reddit_video` `fallback_url`/`hls_url`/`dash_url` via ffmpeg)
  - **i.redd.it GIF** — `post_hint: image` with `.gif` + `preview.images[].variants.mp4` or `.gif` (GIF is wanted) → download mp4 variant if available, else gif
  - **redgifs.com** — `domain: redgifs.com` `watch/<id>` / `ifr/<id>` → resolve via `api.redgifs.com/v2/gifs/<id>` (`gif.urls.sd/hd` mp4, `sd.m3u8` HLS) — primary path for this collection
  - **Preview fallback** — `preview.redd.it` mp4 for v.redd.it previews
  - Generic external still uses existing auto-capture (dom + network) but filtered to video/GIF.
- **Out of scope for this iteration:** gallery image-only posts (e.g., `r/babitajihub` gallery 5–10 images) → **skip**, single-image jpeg/png posts → **skip**, self-text, crosspost image-only.
- Fail gracefully → snapshot on miss, `failedTargets` entry.
- Integrate with existing queue, collections UI, background sync (schedule `manual` means not auto-scanned, but UI Crawl still works).

## 3. Architecture — where to change

```
scan-videos/scan-saved.js   → add dispatcher + reddit saved scanner (new helpers)
scan-videos/reddit-utils.js  → NEW: helpers (isRedditUrl, normalizeRedditPostUrl, extractRedditId, isRedditSavedUrl, parseRedditMediaFromJson)
scan-videos/media-utils.js   → add isRedditVideoUrl / isRedditImageUrl, extend isLikelyVideoUrl to cover preview/redgifs/v.redd, add sanitize for reddit, export isRedditAsset? (minimal)
scan-videos/extractors.js    → add extractRedditMediaData(page) + extractRedditGalleryData + helpers for redgifs API fetch + v.redd.it DASH/HLS
scan-videos/download.js      → no change, but ensure ext fallback for reddit (gif→mp4)
scan-videos/index.js         → add isRedditTarget branch (UA/viewport, response interception for reddit JSON, filePrefix, candidate prioritization, gallery multi-download)
api-server.js                → generalize scan-saved handler: redditUrl detection, lastSeenUrl regex generalized, flagging generalized per account, backgroundSyncTick generalized (reddit regex, stop url handling)
web/src/views/Saved.jsx      → no required change (folder/account already generic), but ensure folder display correct
```

## 4. Detailed design

### 4.1 Helpers — `scan-videos/reddit-utils.js` (NEW)

```js
function isRedditUrl(url) // hostname /(^|\.)reddit\.com$/i
function isRedditSavedUrl(url) // /\/user\/[^/]+\/saved\/?/i
function normalizeRedditPostUrl(url) // https://www.reddit.com/r/sub/comments/id/slug/ → origin+pathname without query, ensure trailing slash, strip utm params
function extractRedditPostId(url) // pathname match /comments/([^/?#]+)/
function isRedditVideoPost(postJson) // true if video/GIF: domain redgifs.com OR v.redd.it OR is_video OR post_hint hosted:video/rich:video OR media.reddit_video OR secure_media.reddit_video OR url_overridden_by_dest includes v.redd.it OR preview mp4 gif variant; false for image-only/gallery-only
function extractRedditMediaHintsFromJsonText(rawText, postId)
  // parse JSON array (reddit .json returns [{data:{children:[{data:{...}}]}}])
  // find t3 node where id==postId or name==t3_<id>
  // collect video/GIF only:
  //  - url_overridden_by_dest (if video/gif)
  //  - preview.images[].source.url + variants.mp4/gif (only mp4/gif variants)
  //  - media.reddit_video.{fallback_url,hls_url,dash_url,scrubber_media_url}
  //  - secure_media.reddit_video same
  //  - secure_media.oembed.thumbnail_url (redgifs poster) → but resolve via redgifs API for mp4/hls
  //  - media_embed.content iframe src for redgifs → extract id
  //  - crosspost_parent_list[*] recurse
  // skip gallery_data/media_metadata for now (photos skipped per updated scope)
  // return { urls:[], redgifsIds:[] }

function isRedditGalleryJson(node) // gallery_data present — kept for future, but skipped in this iteration
```

Exports: `isRedditUrl, isRedditSavedUrl, normalizeRedditPostUrl, extractRedditPostId, extractRedditMediaHintsFromJsonText`

### 4.2 Media utils — `scan-videos/media-utils.js`

- Extend `isLikelyVideoUrl` to include reddit preview pattern? Already matches mp4/webm/m3u8/mpd → covers preview `...format=mp4`. Add redgifs detection separately.
- Add helpers:
  ```js
  function isRedditMediaUrl(url) // i.redd.it, v.redd.it, preview.redd.it, reddmedia, external-preview, redgifs.com/media, redgifs.com/watch
  function isRedgifsUrl(url) // redgifs.com/watch/ or /ifr/
  function extractRedgifsId(url) // /watch/([^/?#]+)/
  ```
- Keep scoring generic; no reddit-specific scoring needed except prioritize direct i.redd.it > preview > redgifs HLS.

### 4.3 Extractors — `scan-videos/extractors.js`

Add:

```js
async function extractRedditMediaData(page)
  // inside page.evaluate:
  // - shreddit-post: content-href, permalink, id, domain, post-type
  // - video/img tags: preview.redd.it, i.redd.it, v.redd.it
  // - a[href] containing redd.it/redgifs
  // - scan window.___r / __PRELOADED_STATE__ if present (old) via deep scan (re-use xHamster pattern)
  // - scripts text regex for i.redd.it, v.redd.it, preview.redd.it+format=mp4, redgifs watch/ifr, внеш
  // return { urls: string[], redgifsIds: string[] }

async function fetchRedgifsMediaUrls(page, redgifsId)
  // inside page context, fetch https://api.redgifs.com/v2/gifs/<id> and parse:
  //   json.gif.urls.sd / hd / vthumbnail etc, or gifs.sources { sd: url, hd: url }
  // Fallback: fetch https://www.redgifs.com/watch/<id> html and regex mp4/m3u8
  // Return [mp4Url, m3u8Url] filtered
```

Also extend generic `scoreDownloadCandidate` already handles.

### 4.4 Saved scanner — `scan-videos/scan-saved.js`

- Add helpers: `isRedditSavedUrl`, `extractRedditIdFromUrl` (base36 id), `normalizeRedditUrl`, `readRedditItemsOnPage`.

```js
async function readRedditItemsOnPage(page)
  // evaluate:
  // 1) shreddit-post[permalink] → https://www.reddit.com + permalink
  // 2) a[href] with /r/*/comments/* → absolute https://www.reddit.com + pathname (strip query/hash)
  // dedupe, filter valid reddit post URLs
  // return { urls, count }

async function scanRedditSavedPage({browser,targetUrl,endUrls,log,waitMs,exitWaitMs,maxIterations})
  // mirrors scanSavedPage but:
  // - no mobile UA (desktop reddit)
  // - scroll logic same but wait for shreddit-post increase
  // - stopUrl/id handling uses reddit id (base36) via extractRedditIdFromUrl
  // - 429 handling generalized (reddit may return 429 too)
  // - redirect check: if targetLooksSaved (reddit /saved) and openedUrl not /saved → throw login expired
```

- Export `scanSavedPage` dispatcher:
  ```js
  async function scanSavedPage(options)
    if (isRedditSavedUrl(options.targetUrl)) return scanRedditSavedPage(options)
    else return scanInstagramSavedPage(options)
  ```
  Keep existing Instagram logic as `scanInstagramSavedPage`.

### 4.5 Download engine — `scan-videos/index.js` — UPDATED: video/GIF only

- Add `isRedditTarget` detector alongside isInstagram:
  ```js
  const isRedditTarget = /(^|\.)reddit\.com$/i.test(hostname)
  ```
- If `isRedditTarget`:
  - No mobile UA, but keep desktop UA (default). Optionally set `accept-language`.
  - Intercept responses: if `reddit.com` + `content-type json` or url includes `.json`, buffer text → `extractRedditMediaHintsFromJsonText(text, redditPostId)` → collect `redditHintUrls`, `redgifsIds` (video/GIF only, photos skipped). Also handle `api.redgifs.com` responses (json) → collect `redgifsHintUrls`.
  - Early skip: if JSON indicates photo-only (image jpeg/png without mp4/gif variant and not redgifs/v.redd.it), log and `failedTargets.push({url, reason: "No video/GIF found — photo-only, skipped"})` and continue (no snapshot needed).
- DOM collection:
  - `domVideos` already, plus `redditData = await extractRedditMediaData(page)` (returns urls + redgifsIds) — extractor filters to video/GIF via `isLikelyVideoUrl` + `preview ...format=mp4` + `.gif` + redgifs.
  - `xhamsterData`, `pornhubData`, `xvideos` unchanged.
  - For reddit, also fetch redgifs via page fetch if needed: for each redgifsId, `await page.evaluate(fetchRedgifsJson)`.
- `allVideos` includes `...redditData.urls, ...redgifsMp4Urls, ...networkVideos` etc. Gallery ignored (photos skipped).
- File prefix: `filePrefix = subreddit-postId` e.g., `titslap-1vug8by` or `BiggerThanYouThought-1snz5lt`, fallback `reddit-<id>`.
- Candidate filtering for video/GIF only:
  ```js
  const redditVideoCandidates = filteredUrls.filter(u => isLikelyVideoUrl(u) || /\.gif(\?|$)/i.test(u) || isRedgifsUrl(u) || /preview\.redd\.it.*format=mp4/i.test(u))
  // prioritize: i.redd.it gif mp4 variant > v.redd.it DASH/HLS > redgifs mp4 > redgifs m3u8 > preview mp4
  candidatesToTry = prioritizeRedditCandidates(redditVideoCandidates)
  ```
  If empty after video filter → fail with photo-skipped reason.
- Single candidate loop as Instagram does (downloadMedia with headers from page.cookies). No gallery multi-download in this iteration.
- `buildDownloadHeaders` already generic; works for reddit (needs referer + cookies).
- Error: reddit may 403 preview urls without proper referer/cookie — ensure headers include cookie.

### 4.6 API server — `api-server.js`

- `POST /scan-saved`:
  - Already has `account` param → elk will use `/data/account-elk`.
  - After `result = await scanSavedPage(...)`, handle `folderParam` case:
    - Currently `firstPostUrl` via `instagram\.com/(p|reel|tv)` regex only → extend to `isRedditPostUrl` (`reddit\.com/r/.+/comments/`) and update `st.lists[key].lastSeenUrl` accordingly.
    - `crawlCollectAndQueue` also filters `instagram` only for lastSeen logic in background sync; generalize there too.
  - Flagging: `isRedirect` regex already includes `redirected from saved page` → keep; ensure reddit redirect throws same message (`Reddit redirected from saved page...`); flag per account same.
  - `scanSavedPage` log forwarding unchanged.

- `backgroundSyncTick()`:
  - Loop over `savedLists`; currently checks `paused`, schedule, lastRun, then scans via `scanSavedPage` with `endUrls = [lastSeen]`.
  - After scan, currently does `const firstPostUrl = urls.find(u => /instagram.../)` → extend to reddit regex OR fallback to `urls[0]` for generic.
  - `newUrls` slice logic uses `normalizeSyncUrl` correctly for reddit (origin+pathname) → works.
  - `queueAddUrls(newUrls, folder, null)` already generic.
  - Update `state.lists[targetUrl]` folder/lastSeen/lastRunAt.

- No change to `/download` single-url flow; it just calls `run({urls:[link]})` which now supports reddit via `isRedditTarget`.

### 4.7 Download flow general media — UPDATED: video/GIF only, photos skipped

- `media-utils.extractDownloadableVideoUrls` currently filters `isDirectFileUrl || isStreamingManifestUrl`. For reddit video/GIF iteration:
  - `.gif` now counts as downloadable video variant (GIF wanted). Add `isGifUrl` check or allow `.gif` via `forceInclude` for reddit.
  - `.jpg/.png/.webp` alone → not video, should be excluded for reddit (photos skipped). No gallery handling.
- Solution: in `index.js` for reddit, build `forceIncludeSet = new Set([...redditHintUrls.filter(u => /\.gif(\?|$)/i.test(u) || /preview.*format=mp4/i.test(u) || isRedgifsUrl(u) )])` and pass `{qualityByUrl, forceIncludeUrls: forceIncludeSet}` to `extractDownloadableVideoUrls`. Then `.gif` is kept via forceInclude, but `.jpg` is not (photos skipped). For non-reddit, behavior unchanged.

## 5. Redgifs support notes

- `https://www.redgifs.com/watch/<id>` page loads via iframe embed. The API `https://api.redgifs.com/v2/gifs/<id>` returns JSON with `gif.urls.sd` (mp4) and `gif.urls.hd`, `gif.urls.hd` may be null, plus `gif.urls.sd` HLS variant `sd.m3u8` via search in page.
- Probe showed `api.redgifs.com/v2/gifs/revolvingobedientarmedcrab/sd.m3u8` fetched directly — so we can first try direct fetch from API, fallback to generic auto-capture.
- No auth needed for redgifs API.
- Downloader will use ffmpeg for HLS; direct mp4 can go via `downloadMedia` direct.

## 6. Implementation steps

1. Create `scan-videos/reddit-utils.js` (helpers + JSON parser). Write unit probes via `node --test` if desired.
2. Update `scan-videos/media-utils.js` (add reddit helpers, export).
3. Update `scan-videos/extractors.js` (add `extractRedditMediaData`, `fetchRedgifsMediaUrls` via page.evaluate).
4. Update `scan-videos/scan-saved.js` (add reddit reader + scanner, dispatcher, keep instagram as is).
5. Update `scan-videos/index.js` (detect reddit, intercept reddit JSON, call reddit extractor, handle redgifs API fetch, filePrefix, gallery multi-download, forceInclude).
6. Update `api-server.js` (generalize lastSeen regex, crawlCollectAndQueue firstPostUrl fallback, backgroundSyncTick firstPostUrl, flagging).
7. Manual test:
   - `docker exec xdl node -e "require('./scan-videos/scan-saved').scanSavedPage(...)"` for reddit saved (expect >30 urls).
   - `curl -X POST http://localhost:6767/scan-saved -H "x-panel-password: ..." -d '{"url":"https://www.reddit.com/user/craftpip/saved","account":"elk"}'`
   - Download single post via `POST /download` with elk? Actually download uses shared browser (default) — need to ensure reddit download uses default or elk? By default `run` uses default profile; for reddit, elk cookies needed. Should pass `account`? `/download` currently no account param. Add optional `account` to `/download` or ensure shared browser has reddit cookies? Elk is separate. For now test with `account: elk` via direct `run` with `browser` from elk.
   - `POST /queue/add` via UI Dashboard? Test via API queue.
8. Build `web/dist` if UI changes, `docker restart xdl`, verify health.

## 7. Risks / mitigations — UPDATED

- Reddit UI changes (`shreddit-post` attrs rename) → fallback to anchor regex ensures coverage.
- Gallery posts → **intentionally skipped** this iteration (video/GIF only per user). Code will detect gallery and log skip; future plan can re-enable via `media_metadata` `s.u` if user wants photos later.
- Redgifs API rate limit → fallback to iframe embed `src` parsing.
- `preview.redd.it` mp4 URLs require `s` param signature → fetching via browser cookies ensures valid.
- Large saved list (many scrolls) → `maxIterations 1200`, `waitMs 2000`, `noIncreaseTimeout 5000` matches IG; reddit may load slower → keep same but probe showed fast. 466 total posts; early probe took ~12 scrolls.
- ffmpeg not found → same check as IG (hls need).
- Schedule `manual` means background sync skips (parseScheduleToMs returns Infinity) → UI Crawl-all still enqueues via `/scan-saved?folder=reddit`. Only video/GIF posts will be queued after filtering.

## 8. Verification — UPDATED: video/GIF only

- After code: `node --check scan-videos/*.js` and `npm run api` smoke.
- Inside container: run video-only download probes and check `media/reddit/` files exist:
  - i.redd.it GIF → `https://www.reddit.com/r/titslap/comments/1vug8by/big_punching_bags/` (expect mp4 from preview)
  - redgifs → `https://www.reddit.com/r/BiggerThanYouThought/comments/1snz5lt/i_missed_you/` and `.../1t1pwli/...` (expect mp4 via api.redgifs.com)
  - v.redd.it → `https://www.reddit.com/r/TikTok_Tits/comments/19dlqil/famous4mypersonality/` (expect `fallback_url` mp4/HLS)
  - negative: photo-only `https://www.reddit.com/r/babitajihub/comments/1v9cfpi/jalvaa/` (gallery) should log `photo-only, skipped` and not download.
- Check `GET /health`, `POST /scan-saved` reddit returns `urls` video-only count (should be ~? less than 466 total), `pending` queue length increments only for video/GIF.
- Logs: `docker logs xdl --tail=200` shows `[sync] reddit → X new` video count.

## 9. Change log

- 2026-08-25: Initial plan for full saved + all media (including galleries/images).
- 2026-08-25 22:15 UTC: Updated per user — scope narrowed to **videos + GIF only**, photos skipped. Updated §2, §4.1, §4.5, §4.7, §7, §8.
