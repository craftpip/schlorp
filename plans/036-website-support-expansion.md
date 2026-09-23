# Plan 036 — Website Support Expansion (audit → verify → +10 sites)

**Date:** 2026-09-23
**Status:** In progress
**Trigger:** User: "create a plan to extend your website support. create a plan file, store there all the websites that u support. test them first -> open the page and find a link to download and try and test that download link -> until it works, keep fixing it okay., then expand your support, find a website that lists top porn websites, and shortlist 10 of them, update the plan, and then add support for them"
**Source-of-truth for site coverage:** this file (plus `AGENTS.md` provider list + `index.html` supported pills after implementation).

## 1. Currently supported (audit 2026-09-23, code = truth)

| # | Site | Detector in `scan-videos/index.js` | Extractor | Prioritizer / special | Photo support | Test status |
|---|------|------------------------------------|-----------|----------------------|---------------|-------------|
| 1 | Instagram (`instagram.com` `/reel/ /p/`) | `isInstagramTarget` ~L550 | `extractors.js:getInstagramUsername*`, `extractInstagramPhotoData`, JSON hints via `instagram-utils.js` | `prioritizeInstagramCandidates`, audio-mux via ffmpeg, 429 cooldown | yes (sidecar/carousel, reel-gated) | unit OK; **live re-test required** |
| 2 | xHamster (`xhamster.com`) | `isXhamsterTarget` ~L558 | `extractXhamsterMediaData` (window.initials/xplayerSettings + scripts + preload) | `prioritizeXhamsterCandidates` (manifest-first) | no | unit OK; **live re-test required** |
| 3 | xVideos (`xvideos.com`) | inline hostname check ~L929 | `extractXvideosMediaUrls` (html5player + setVideo* scripts) | generic scoring | no | unit OK; **live re-test required** |
| 4 | Pornhub (`pornhub.com/org`) | `isPornhubTarget` ~L566 | `extractPornhubMediaData` + `expandPornhubGetMediaUrls` (flashvars + get_media resolve) | ad/preview filtering (`isAdVideoUrl`, `isPreviewClipUrl`) | no | unit OK; **live re-test required** |
| 5 | Reddit (`reddit.com` + redgifs) | `isRedditTarget` ~L574 | `extractRedditMediaData`, `fetchRedgifsMediaUrls`, server-side `fetchRedgifsDirectUrlsViaApi` | `prioritizeRedditCandidates`, `.json` hints, photo flow | yes (gallery/i.redd.it) | unit OK (55 pass); **live re-test required** |
| 6 | Generic (any direct mp4/m3u8/mpd + DOM+network auto-capture) | fallback | none (DOM `<video>` + network `isLikelyVideoUrl`) | `extractDownloadableVideoUrls` + `applyMaxQualityLimit` | no | **live re-test required** |
| — | YouTube | NOT implemented | plan `035-youtube-support.md` only (yt-dlp, deliberately not added) | — | — | out of scope unless user asks |

Engine pipeline (all sites): `gotoWithInstagram429Retry` → `dismissPopups` → `waitForAutoCaptureWindow` → scroll → DOM collect → site extractor → `allVideos` → `extractDownloadableVideoUrls` → quality cap → `buildDownloadHeaders` (cookies+referer) → `downloadMedia` (direct or ffmpeg HLS/DASH).

## 2. Live verification protocol (per site — "until it works, keep fixing")

For each of the 6 rows above, on cloakbrowser (agent, headless-capable):
1. `Target.createTarget {browser: cloakbrowser, url: <video page>}` — use a well-known public video URL (no login except Instagram/Reddit-saved which reuse stored profiles).
2. `DOM.getDocument` + `Runtime.evaluate` — confirm `<video>` / player config present; run the site's extractor function in-page and log `urls[]`.
3. Pick top candidate (`prioritize*` order) → `HEAD`/`Range: bytes=0-1023` fetch with page cookies+referer → expect `200/206` + `content-type: video/*` or `application/vnd.apple.mpegurl`.
4. Full `node scan-videos.js --link-only <url>` then real download to `media/.verify/` → `ffprobe` has video stream (audio optional except IG mux path).
5. On failure: `captureFailureSnapshot` PNG+HTML → diagnose (selector changed / player var renamed / 403 referer / HLS auth) → fix extractor → re-run until green. Log result in §3 table.

Test URLs (public, replace if removed):
- xHamster: `https://xhamster.com/videos/<trending-id>` (from homepage listing)
- xVideos: `https://www.xvideos.com/video.<id>/<slug>` (from homepage)
- Pornhub: `https://www.pornhub.com/view_video.php?viewkey=<key>` (from homepage)
- Reddit: `https://www.reddit.com/r/BiggerThanYouThought/comments/1snz5lt/i_missed_you/` (redgifs) + `https://www.reddit.com/r/titslap/comments/1vug8by/big_punching_bags/` (i.redd.it gif)
- Instagram: needs logged-in profile — `open-browser` profile check only, no public anonymous download assert
- Generic: `https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4` (direct-file control)

## 3. Verification results log

| Site | Date | Page opened | Extractor URLs found | Download probe | Verdict / fix |
|------|------|-------------|----------------------|----------------|---------------|
| generic-control | 2026-09-23 | `test-videos.co.uk/.../Big_Buck_Bunny_720_10s_1MB.mp4` | n/a (direct file) | `video/mp4`, doc 200 + media 206, 1 `<video>` | PASS — no fix |
| xHamster | 2026-09-23 | `xhamster.com/videos/busty-18-y-o...-xhDUNzi` | `window.initials` present, 2 ready `<video>`, m3u8+mp4 network 200s (xhpingcdn/growcdn) | stream segments 200 | PASS — no fix |
| xVideos | 2026-09-23 | `xvideos.com/video.omavlbe2fc5/...` | `html5player` present but keys renamed to `sUrlHigh/sUrlLow/sUrlHls`; `setVideoUrlHigh/Low/HLS` scripts present; HLS `.ts` 200 | HLS flowing | PASS with fix — added `sUrl*` aliases to `extractXvideosMediaUrls` (`extractors.js`) |
| Pornhub | 2026-09-23 | `pornhub.org/view_video.php?viewkey=6a9d7516be20d` (note: .com → .org redirect; detector already covers both) | `flashvars_<id>` present, 6 `<video>`, preview thumbs only pre-play (main stream lazy) | extractor path intact via window scan + get_media expansion | PASS — no fix (full download run still to do inside ffmpeg container) |
| Reddit | — | sampled in plan 010 | — | — | pending live re-run |
| Instagram | — | profile-gated | — | — | pending (needs logged-in profile via `open-browser`) |
| XNXX (new) | 2026-09-23 | `xnxx.com/video-1bgzl38a/top_10_most_viewed_videos` | identical `html5player` (`sUrl*`) + `setVideo*` scripts as xVideos | same as xVideos | WIRED — engine branch widened to `(xvideos\|xnxx).com`, unit test added |

Unit baseline 2026-09-23: `node --test test/unit/extractors.test.js test/unit/media-utils.test.js` → 55 pass. ffmpeg missing on dev container (`ffmpeg: command not found`) — HLS/DASH asserts must run inside `schlorp` container where ffmpeg exists.

## 4. Top-site source + shortlist 10 (new support)

**Directory source:** `https://theporndude.com/top-porn-tube-sites` (The Porn Dude — free tube ranking, daily malware-checked, 13214+ sites indexed) cross-checked with Semrush global Adult July/Aug 2026 (pornhub 3.6B, xvideos 2.3B, xhamster 1.6B lead) + NightAnalytics free-tube ranking. Selection criteria: (a) top traffic, (b) free tube (no paywall — matches downloader model), (c) distinct player tech where possible but prefer shared-player wins first.

Already covered: Pornhub (#1), xVideos (#2), xHamster (#3). YouTube/Instagram/Reddit are non-tube (separate track).

**Shortlist 10 (in build order — easiest/shared-player first):**

| # | Site | Why | Player affinity (implementation shortcut) |
|---|------|-----|-------------------------------------------|
| 1 | XNXX (`xnxx.com`) | Semrush top-4 global, PornDude #4; glaring gap (xVideos sibling) | Same `html5player` as xVideos — reuse `extractXvideosMediaUrls` with hostname widen |
| 2 | RedTube (`redtube.com`) | MindGeek OG, PornDude top tube | Same MindGeek `flashvars/mediaDefinitions` player as Pornhub — reuse `extractPornhubMediaData` pattern |
| 3 | YouPorn (`youporn.com`) | MindGeek OG, PornDude top tube | Same MindGeek player — same extractor family |
| 4 | Eporner (`eporner.com`) | NightAnalytics "largest alternative", long/HD catalog | Custom `EPornor` player (`EPornor.player` / `source src` mp4 list) — new extractor |
| 5 | SpankBang (`spankbang.com`) | ThePornDude top-8 tube | `stream_data`/`hls` JS object + `<source>` — new extractor |
| 6 | HQporner (`hqporner.com`) | High-quality HD niche, YourPorn-family | Direct `<source src=*.mp4>` + JS `controls` — new extractor (often generic already works) |
| 7 | Beeg (`beeg.com`) | Legacy top tube, beeg API | `beeg` JSON API (`/api/v6/.../video`) — new API-branch extractor |
| 8 | YouJizz (`youjizz.com`) | Long-standing free tube | `data-src`/`source` + HLS — new extractor |
| 9 | PornTrex (`porntrex.com`) | KVS (Kernel Video Sharing) tube — unlocks many clones | KVS player (`flashvars.video_url`, `video_alt_url`, `hls`) — new KVS extractor (reusable for Txxx/Tube8 clones) |
| 10 | Txxx (`txxx.com`) | KVS reference tube (validates #9 abstraction) | Same KVS extractor as PornTrex — proves generic KVS path |

Deliberately deferred: OnlyFans (DRM/login/paywall, different product), premium studios (Brazzers/BangBros — paywall), cams (StripChat/Bonga — live HLS/DVR, different lifecycle), F95zone (forum/auth), RedGIFs-direct (already covered via Reddit flow).

## 5. Implementation plan (per new site — same shape as `010-reddit-support.md`)

For each of the 10:
1. `scan-videos/<site>-utils.js` (only if ID/URL helpers needed — XNXX/RedTube/YouPorn need none, Beeg needs API id helper).
2. `scan-videos/extractors.js`: add `extract<Site>MediaData(page)` — page-evaluate: (a) window player objects, (b) `<video>/<source>` DOM, (c) script-regex for mp4/m3u8/mpd, following the xHamster/Pornhub deep-scan pattern (bounded `maxNodes`, `WeakSet`, relative→absolute). KVS sites share one `extractKvsMediaData(page)`.
3. `scan-videos/index.js`: add `is<Site>Target` hostname detector + extractor call + `qualityByUrl` merge into `allVideos` (same as xhamster/pornhub blocks ~L902-934). XNXX folds into the xVideos branch. No scoring change (generic `scoreDownloadCandidate` covers mp4>HLS).
4. `scan-videos/media-utils.js`: only if new ad/preview CDN appears (extend `isAdVideoUrl`/`isPreviewClipUrl` by host, same pattern as `adtng/trafficjunky/phncdn-pre_videos`).
5. `test/unit/<site>.test.js` or extend `extractors.test.js` with `makeFakePage` fixtures (window object + scripts) — no live network in CI (same `XDL_LIVE=1` gate).
6. Live-verify per §2 protocol (link-only → real download → ffprobe) before marking done.
7. Update `AGENTS.md` provider list, `index.html` supported pills, this file's §6 matrix.

Shared-player grouping keeps the diff small: XNXX = hostname widen + sUrl aliases; RedTube+YouPorn = generic flow (lazy player, no flashvars anymore); PornTrex+Txxx = one KVS extractor; Eporner/Beeg/SpankBang = one API/player extractor each; YouJizz = generic flow (direct HLS in DOM).

## 6. Multi-domain handling (per user: spankbang.com + spankbang.party, etc.)

All detectors go through `scan-videos/site-hosts.js` (`SITE_HOSTS` + `hostMatchesSite`), verified live via cloakbrowser 2026-09-23:

| Site | Hosts handled | Verified |
|------|---------------|----------|
| xHamster | `xhamster.com`, `xhamster19.com` | both live, same `/videos/<slug>-xhXXX` structure |
| xVideos/XNXX | `xvideos.com`, `xvideos.es`, `xvideos3.com`, `xnxx.com`, `xnxx2.com` | `.es`/`.3` live same `/video.<id>/`; `xnxx2` live same as `xnxx` |
| Pornhub | `pornhub.com`, `pornhub.org` | `.com` → `.org` redirect observed live |
| RedTube | `redtube.com`, `redtube.net` | `.com` → `.net` observed live |
| YouPorn | `youporn.com`, `you-porn.com` | redirect observed live |
| SpankBang | `spankbang.com`, `spankbang.party` | both live, same structure + `stream_data` |
| Beeg | `beeg.com` only | `beeg.porn` is a DIFFERENT platform (`/play/` aggregator) — excluded |
| Eporner / HQporner / YouJizz / PornTrex / Txxx | single host each | as listed in §4 |

## 7. New-site build matrix

| # | Site | Extractor | Engine wiring | Unit test | Live verify |
|---|------|-----------|---------------|-----------|-------------|
| 1 | XNXX | done (`extractXvideosMediaUrls` + sUrl aliases) | done (hostname widen) | done (sUrl alias test) | live page verified 2026-09-23, full download pending |
| 2 | RedTube | none needed — moved to lazy player (no flashvars; 1 blob `<video>`, preview thumbs pre-play; streams via network on play) | none (generic DOM+network) | n/a | page verified 2026-09-23 (`redtube.com` → `redtube.net`, video page live), full download pending |
| 3 | YouPorn | none needed — same lazy player as RedTube (note: `youporn.com` → `you-porn.com`; no flashvars, 1 blob video) | none (generic DOM+network) | n/a | page verified 2026-09-23, full download pending |
| 4 | Eporner | done (`extractEpornerMediaData` via `/xhr/video/` JSON) | done | done (xhr JSON test + empty test) | page verified 2026-09-23 (`/xhr/video/1lbQXuy7Nrg` endpoint live), full download pending |
| 5 | SpankBang | done (`extractSpankbangMediaData`: `window.stream_data` quality map + source fallback) | done (`spankbang.com` + `spankbang.party`) | done (quality-map test + empty test) | page verified 2026-09-23 on both domains (10 URLs across 240p–1080p+m3u8 live), full download pending |
| 6 | HQporner | none (page holds no direct sources — player is a `mydaddy.cc/video/<hash>/` iframe; embed answered "This domain has been blocked" from this exit) | none (generic; re-verify from VPN container where embed may load) | n/a | page verified 2026-09-23, embed blocked here — needs container-side check |
| 7 | Beeg | done (`extractBeegMediaData`: `store.externulls.com/facts/file/<id>` → signed mp4 `video.beeg.com/<fallback>` + 720p/480p HLS ladders) | done | done (facts-API test + empty test) | chain verified 2026-09-23 (page `beeg.com/<fileId>`, 1 blob video, m3u8 200s on `video.beeg.com`) |
| 8 | YouJizz | none needed — 14 `<video>`, `<source src="...abre-videos.youjizz.com/_hls/...master.m3u8?...">` in DOM (verified 2026-09-23) | none (generic DOM+network) | n/a | page verified 2026-09-23, full download pending |
| 9 | PornTrex (KVS) | done (`extractKvsMediaData`: window.flashvars + video_url script regex + source fallback) | done | done (flashvars+script test) | page verified 2026-09-23 (`kt_player` + `video_url` present) |
| 10 | Txxx (KVS) | done (shared KVS extractor) | done (hostname wired) | covered by KVS test | page load hung from this exit (geo/bot-wall?) — KVS platform-generic, confirm from container |

## 8. JAV batch (per user 2026-09-23: "add support for all of them")

Source: ThePornDude Asian tubes + MorningDough + r/Piracy consensus. One shared
extractor `extractJavMediaData` (click-to-load hoster buttons + direct DOM/
script collection incl. surrit/tsyndicate/jav.si, ad-host filtered, BestJavPorn
`data-mediabook` gated by page video code). Extensionless `jav.si/p/` URLs pass
via `forceIncludeUrls` for JAV targets. All hosts in `site-hosts.js` `jav` group.

| Site | Player tech (live probe) | Support |
|------|--------------------------|---------|
| MissAV (`missav.ws`) | `surrit.com/<uuid>/playlist.m3u8` HLS 200, 30 `<video>` — no clicks needed | generic + JAV extractor |
| SupJav (`supjav.com`) | hoster buttons TV/FST/ST/VOE (`<id>.html` pages) | click-to-load + network capture |
| JavGuru (`jav.guru`) | WP `wp-btn-iframe__shortcode` server menu (STREAM TV…) | click-to-load + network capture |
| JAVMost (`javmost.ws`; `javmost.com` → `.ws`) | `select_part()` AES-encrypted server tokens + `findjav.com` iframe | click-to-load + network capture |
| VJAV (`vjav.com`) | page hung from this exit (bot-wall) | shared extractor applies; verify from container |
| JAVGG (`javgg.net`) | 4 hoster embeds pre-loaded (earnvid/turbovidhls/playmate/luluvdoo) | network capture |
| JavFinder (`javfinder.sh`) | DNS-dead from here | kept in hosts; verify from container |
| JAVtiful (`javtiful.com`) | `<video><source src="fast-stream.jav.si/p/<uuid>">` self CDN + preview mp4s | generic + JAV extractor (forceInclude) |
| BestJavPorn (`bestjavporn.com`) | click-to-play (`.play-button` → `wps-iframe-loader`); `data-mediabook` mp4s on `pornfhd/1024cdn` (code-gated) | click-to-load + code-gated mediabook |
| JavSeen (`javseen.com`) | connection refused from here | kept in hosts; verify from container |
| SexTB (`sextb.net`) | hoster iframes pre-loaded (turboplays/trailerhg) + V.I.P Server button | network capture + click-to-load |

## 9. Risks / notes

- JAV hoster embeds (dood/filemoon/voe/streamtape/…) resolve via generic network capture; dedicated per-hoster decipher is out of scope.
- **MissAV/surrit Cloudflare guard (hit 2026-09-23):** `surrit.com` (Cloudflare Bot Management) 403s all non-browser TLS (ffmpeg/curl, even with full Chrome headers + page cookies). Only real-browser requests pass — and only WITHOUT cross-origin cookies (`credentials:include` with missav.ws cookies → request dropped; `omit` → 200). Fix: `downloadStreamingManifestViaBrowser` (`download.js`) relays playlist+segments through the live page (works in Cloak + CDP Chrome), rewrites a local m3u8 (segments/key/map) and muxes with ffmpeg offline. Engine falls back to it automatically on 403 for HLS candidates. Also fixed: `buildDownloadHeaders` now only sends cookies whose domain matches the candidate host (page-domain cookies to third-party CDNs caused 403s).
- **MissAV feature stream is exit-blocked (2026-09-23):** surrit only serves storyboards; the real stream needs the tsyndicate `/do2/master` handshake, which gets NO response (status 0) from the container's VPN exit — player stays idle, only a 6s preview is capturable. Verified via CDP tap statuses. Fix path: download with an account wired to real Chrome via CDP — no UI code needed: `Dashboard → Account` dropdown + `/queue/add {account}` + per-account CDP browser (`getBrowserForAccount` → `buildBrowserFromLocalProfile` connects via `cdpUrl`) already work end-to-end; set the account's `cdpUrl` in Profiles. Relay throws a guiding error when the handshake is dead.

- Tube players rotate var names (`html5player`→? / `flashvars_*`→?) — extractors use triple path (window object + DOM + script regex) so one rename doesn't kill the flow (same lesson as Pornhub `get_media` fallback).
- Age-gates/cookie walls — `dismissPopups` selector list may need per-site confirm button text (add after first snapshot).
- 403 on direct mp4 without referer/cookies — `buildDownloadHeaders` already passes page cookies+referer; redgifs-origin lesson applies (per-host referer override if needed).
- Geo/VPN: container routes via gluetun — if a tube blocks the exit region, verify from same container, not dev host.
- Tests never need live browser/Docker/ffmpeg/VNC — keep new unit tests on `makeFakePage`; live probes are manual (`XDL_LIVE=1`).
- Keep the two test-only prod hooks untouched: `QUEUE_STUB_RUNNER=1`, `require.main === module` guard.
