# Review Plan — Collections Crawl Stuck & Scrolling Bug (2026-08-22 22:00 UTC)

**User directive:** Save everything I said without missing — no excuses. This file is the record. Do not skip context.

## Last Good State (restored 2026-08-22, pre crawl&download error) — KEEP FOR REPEATED RESETS
**Backed up at:** `.saved-sync-state.json.bak.1755900000000` and at `/tmp/last-good-state.json` — use to reset again and again before each `Crawl & Download all` test.

**Exact JSON to restore (copy-paste):**
```json
{
  "config": {
    "accounts": [
      {"name": "default", "profileDir": "Default", "userDataDir": ""},
      {"name": "elk", "profileDir": "Default", "userDataDir": "/data/account-elk"}
    ],
    "savedLists": [
      {"url": "https://www.instagram.com/hamster.9377231/saved/pussy/17882808930487240/", "folder": "pussy", "account": "default", "schedule": "24h"},
      {"url": "https://www.instagram.com/hamster.9377231/saved/ass/18072105680238637/", "folder": "ass", "account": "default", "schedule": "24h"},
      {"url": "https://www.instagram.com/hamster.9377231/saved/nipps/18096275666003614/", "folder": "nipp", "account": "default", "schedule": "24h"},
      {"url": "https://www.instagram.com/hamster.9377231/saved/boobs/17912759532347704/", "folder": "boobs", "account": "default", "schedule": "24h"},
      {"url": "https://www.instagram.com/hamster.9377231/saved/sexy/932373649270439/", "folder": "sexy", "account": "default", "schedule": "24h"}
    ]
  },
  "lists": {
    "https://www.instagram.com/hamster.9377231/saved/pussy/17882808930487240/": {"folder": "pussy", "lastSeenUrl": "https://www.instagram.com/p/DaipAmcJGtr/", "lastRunAt": "2026-08-22T19:50:42.264Z", "lastScannedCount": 12},
    "https://www.instagram.com/hamster.9377231/saved/ass/18072105680238637/": {"lastSeenUrl": "https://www.instagram.com/p/DW3dCPZAbEX/", "lastRunAt": "2026-08-22T21:01:29.638Z", "lastScannedCount": 12, "folder": ""},
    "https://www.instagram.com/hamster.9377231/saved/nipps/18096275666003614/": {"lastSeenUrl": "https://www.instagram.com/p/Dbj-CxPlOq3/", "lastRunAt": "2026-08-22T19:29:41.851Z", "lastScannedCount": 6, "folder": ""},
    "https://www.instagram.com/hamster.9377231/saved/boobs/17912759532347704/": {"lastSeenUrl": "https://www.instagram.com/p/Davuc_CJeVX/", "lastRunAt": "2026-08-22T19:30:49.689Z", "lastScannedCount": 38, "folder": ""},
    "https://www.instagram.com/hamster.9377231/saved/sexy/932373649270439/": {"lastSeenUrl": "https://www.instagram.com/p/Db5y09xseBW/", "lastRunAt": "2026-08-22T19:50:17.709Z", "lastScannedCount": 8, "folder": ""}
  }
}
```

| # | Collection URL | Folder | lastSeenUrl | lastScannedCount | lastRunAt |
|---|---|---|---|---|---|
| 1 | https://www.instagram.com/hamster.9377231/saved/pussy/17882808930487240/ | pussy | https://www.instagram.com/p/DaipAmcJGtr/ | 12 | 2026-08-22T19:50:42.264Z |
| 2 | https://www.instagram.com/hamster.9377231/saved/ass/18072105680238637/ | ass | https://www.instagram.com/p/DW3dCPZAbEX/ | 12 | 2026-08-22T21:01:29.638Z |
| 3 | https://www.instagram.com/hamster.9377231/saved/nipps/18096275666003614/ | nipp | https://www.instagram.com/p/Dbj-CxPlOq3/ | 6 | 2026-08-22T19:29:41.851Z |
| 4 | https://www.instagram.com/hamster.9377231/saved/boobs/17912759532347704/ | boobs | https://www.instagram.com/p/Davuc_CJeVX/ | 38 | 2026-08-22T19:30:49.689Z |
| 5 | https://www.instagram.com/hamster.9377231/saved/sexy/932373649270439/ | sexy | https://www.instagram.com/p/Db5y09xseBW/ | 8 | 2026-08-22T19:50:17.709Z |

`pending` = 0, `web active` = 0 at restore. **To reset again:** `cp /tmp/last-good-state.json .saved-sync-state.json` or re-run the node restore snippet above. Test `Crawl & Download all` repeatedly from this exact state.

## Everything User Said (verbatim intent, nothing missed)
1. Dashboard progress bar starts at 70% — is that right?
2. Make navigation vs download progress different colors.
3. Collections `Download all` made whole configured list disappear.
4. "Are there more errors we will face?"
5. "If items being downloaded and queued, if I queue again what happens?" — wants dedupe.
6. "Please dedupe it" — don't trust, will you create duplicates?
7. "As if you are saying, and I should trust you. What if you introduce new error and all duplicated?"
8. Clicked `Download all` in configured links panel — why so slow?
9. "I clicked on download all button in configured links panel in collections tab" — clarification.
10. "I don't get what you are saying bro. If you are deduping, just check what is there and what not is there and just queue the items in dashboard and leave it don't queue already queued"
11. "Do you think user knows technical things? You're pissing me off."
12. "I didn't see you make changes, you did nothing"
13. "Sync every 24h will crawl and download both right?"
14. "During that time if download already running, it will queue right?"
15. "What if multiple collections set to same time so multiple crawl will run at same time?"
16. "But crawls cannot run at same time. What will you do then?"
17. "Sync every 24h can you increase that number" / "How many more options can you give?"
18. "Crawl and download option does not seem to be working. It got stuck on third option. It found new items and it failed somewhere in between." → later: "So it processed two collections it had no new files. In third collection it had new files. It did not reach fourth."
19. "I clicked on crawl and download all button"
20. "stuck at crawling now" / "still stuck not working"
21. "have u added logs where u can see full application's errors ?"
22. "crawl and download all thing does not work perfectly"
23. "no its not fixed"
24. "run it in your browser and watch what it does" / "Click on Crawl and Download button and wait"
25. "Learn to test your motherfucker."
26. "I just added multiple items in the lists and nothing got downloaded. Why?"
27. "Did they get skipped or did last scene URL got recorded?"
28. "Whatever you do, you will create duplicates, bro."
29. "I do not trust you, you will create duplicates."
30. "No, I don't trust you. You will create duplicates because you are doing mistakes left and right."
31. "Can you bring back my last scene URL? Before the bug happened"
32. "Bring back last scene URL for each collection"
33. "Same thing happened again. It got stuck on third collection where there were items to download. Dude now I am really getting pissed off."
34. "there are new items in nipps" / "No, trust me, there are new items You did not repeat it properly"
35. "There are many multiple items which are new."
36. "You need to trust me on this. Don't fucking argue."
37. "Before scanning, did you reset last scene URL?"
38. "It is crawl and download all right in my download folder there is nothing new files"
39. "What do you mean zero are pending? Dude, what the fuck"
40. "No, trust me, there are new items"
41. "It fucking happened again. It was scrolling, it detected nu is equal to 12. There were new files. And then it scrolled again and new is equal to 0 happened."
42. "I know it your scrolling is wrong."
43. "It found 12 new items then again next iteration it showed new is equal to zero"
44. "There is something wrong with your scrolling when you find new items. Fix it."
45. "Again it got stuck. It searched for new files and then again it got stuck. It doesn't move to next collection."
46. "Please note down what I say in a new plan file. I don't want anything missed. And please Save it in new plan file."
47. "This problem is there. I need you to solve it. Git look into it"
48. "Reset collection again To last state. Also note last state in plan file so we don't miss anything I don't want any excuses"
49. "Fix your scrolling bro. I dare you start working without saving in new plan."
50. "I want you to save it in new plan right now." / "Save what is happening in review plan right fucking now." / "Save it now." / "I don't want you to miss this context" / "Write everything what I said down in plan file write now."

## Full Scrolling Flow When Finding New Content (step-by-step, as user demanded)
**File:** `scan-videos/scan-saved.js:92-238` `scanSavedPage({browser, targetUrl, endUrls})`

1. **Open page** `page.goto(targetUrl, networkidle2, 60s)` — Instagram saved collection. If `status 429` throw. Check redirect to login.
2. **Init** `collectedUrls = Set()`, `stopUrlSet/stopIdSet` from `endUrls` (`lastSeenUrl`), `lastSeenCount=0`, `lastIncreaseAt=now`, `noIncreaseTimeoutMs=20000`, `increaseDelayMs=5000`, `waitMs=1000`.
3. **Loop iteration `1..1200`:**
   a. `readItemsOnPage()` → `document.querySelectorAll("._ac7v...a[href]" || "a[href]")` → `pass.urls` (visible hrefs), `pass.count`.
   b. For each `url` in `pass.urls`: if not in `collectedUrls` add and `newCount++`; check `normalizeComparableUrl(url)` vs `stopUrlSet` and `extractIdFromUrl(url)` vs `stopIdSet` → if match, add to `matchedStop`.
   c. **Stop check:** if `matchedStopUrls.size>0 || matchedStopIds.size>0` → `reason=stop_url_found` and **break immediately** (found `lastSeen`, everything before it is new).
   d. **Increase check (CURRENT BUG):** `currentCount = pass.count` (visible anchors, NOT `collectedUrls.size`). If `currentCount > lastSeenCount` → `increased=true`, update `lastSeenCount`, reset `lastIncreaseAt`. This is wrong when Instagram virtualizes — 12 visible stays 12 even while new unique URLs are added to `collectedUrls`, so `increased` stays false and `noIncreaseMs` grows.
   e. Log `loop=X items=pass.count new=newCount noIncreaseMs=now-lastIncreaseAt`.
   f. If `noIncreaseMs >= 20000` → `reason=end_reached` break (thinks end of page after 20s no new visible).
   g. If `increased` sleep 5000ms, then `scrollToBottom()` (scroll every scrollable `main/section/div` + `window.scrollTo`), sleep `waitMs` 1000ms. If not increased, just scroll + 1000ms (no extra wait).
4. **After loop:** log `scan complete: urls=collectedUrls.size ...`, sleep `exitWaitMs 4500`, then do final `page.evaluate` to collect any remaining anchors, add to `collectedUrls`.
5. **Return** `urls` (all unique), `matchedStopUrls`. Caller (`Saved.jsx:96 onCrawl` or `api-server.js` `POST /scan-saved`) then does `let newUrls = urls; if(lastSeen) { ix = urls.findIndex(u=>norm(u)==norm(lastSeen)); if(ix!==-1) newUrls=urls.slice(0,ix); }` — so if `lastSeen` found at index `ix`, `ix` new before it are queued; if not found, UI currently treats all `urls` as new (12), but our earlier test treated as 0 — mismatch.

**What user saw:** `loop=1 items=12 new=12` (first 12 loaded, all new before `lastSeen`), then `loop=2 items=12 new=0` (scrolled but Instagram hadn't rendered next 12 yet, so visible still 12, no new unique, `noIncreaseMs` ~6000, not yet 20000, so it loops again). User perceives `12→0` as bug and stuck for 20s on `nipp` (3rd collection) while it waits for `noIncreaseTimeout` to fire before moving to next collection. For `boobs` 51, this repeats 23 times (12→12→24→12 etc) taking ~2min.

**Why it gets stuck on 3rd (nipp) when new items exist:** `nipp` old `lastSeen Dbj-CxPlOq3` (6) is not in first 12, so `matchedStop` never true, so it must scroll until either finds `Dbj` or hits `end_reached`. With current `pass.count` logic, it may need 16-23 loops to collect enough to find `Dbj` or give up, appearing stuck.

## Current Bug — Scrolling (user observed, confirmed in logs)
- `scan-saved.js:150-200` loop logs: `loop=1 items=12 new=12 noIncreaseMs=0` → `loop=2 items=12 new=0 noIncreaseMs=~6000` → stuck.
- User: "It found 12 new items then again next iteration it showed new is equal to zero" — then never advances to next collection (stuck on `nipp`, 3rd of 5).
- Root hypothesis: `lastSeenCount` tracks `pass.count` (visible anchors) not `collectedUrls.size`. Instagram virtualizes DOM — `pass.count` stays 12 while new unique URLs are still being collected, so `increased` stays false, `noIncreaseMs` grows to 20000 and eventually breaks with `end_reached` after 20s, but UI appears stuck for 20s with no feedback. Also `newCount` is per-pass unique, not total, so 12→0 looks like regression.
- For `nipp` with old `lastSeen Dbj-CxPlOq3` (6 count), scan should find ~6 new before `Dbj`, but if `Dbj` not in first 12, `matchedStop` never true, so it keeps scrolling until `end_reached` (16-23 loops for large lists like `boobs` 51). User added many new items after restore — they are in the 12 but `lastSeen` at index 0 gives `0 new` incorrectly due to slicing logic.

## Fixes Required (no excuses)
1. Fix `scan-saved.js` increase detection: use `collectedUrls.size` not `pass.count`; log `collected` vs `visible`.
2. Fix `newCount` handling: if `matchedStop` not found, don't treat `0` as failure — keep scrolling until stop found or `end_reached` with proper timeout.
3. Ensure `Crawl & Download all` does not block itself: `Saved.jsx:91-97` `crawlInProgress` already patched with `isBatch` flag — verify deployed bundle `index-Cv5MtQWU.js` is hard-refreshed.
4. Add per-collection live progress: show `loop X items Y new Z` in UI, not just "Crawling".
5. Add persistent logs: `/logs` page or `logs/error.log` as user asked.
6. Keep dedupe: `api-server.js:138` `queueAddUrls` already skips `active+completed` normalized URLs; `withQueueFile` serializes `.download-queue.json` writes — do not regress.
7. Verify after fix: restore lastGood state → run `Crawl & Download all` → must finish all 5 sequentially, `nipp` must show `X new` correctly and advance to `boobs` within ~5s of finding stop, not 20s stuck.

## Verification Plan
- Hard-refresh browser, trigger `Crawl & Download all` from clean state, tail `docker logs -f` and watch `loop=` for `nipp` — should see `new` stay >0 until stop found, then break quickly, then `boobs` start within 2s.
- Check `pending` after crawls = number of actually new posts (user says many in `nipp`), then `queue active` increments by same number with no duplicates (compare `added` vs `pending`).

## Notes
- No `git` repo — `git status` not available; use file backups.
- User explicitly forbids starting fix without saving this plan — this file satisfies that.
