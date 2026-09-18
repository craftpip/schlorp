# Plan 002 — React Panel Rebuild (WebSocket + Sequential Queue)

**Date:** 2026-08-22
**Status:** Done
**Scope:** Recreate `index.html` panel in React. Backend: add WebSocket live updates. Queue: add → queued → processed one-by-one. Current site moves to `/legacy`; new React app serves at `/`. Visible queue = queued + running; done/failed move to separate Completed queue.

## Goal

Replace the vanilla JS single-file `index.html` SPA with a React app that is dynamic and live:

1. **React panel** — same features as today, no vanilla.
2. **Dynamic via WebSocket** — page updates live without polling/reload. Progress, queue status, health, media appear in real time.
3. **Queue is sequential** — when user adds items they go to a queue; queue is processed one at a time, in order, automatically. One worker, FIFO.

Constraints: Node 18+, Docker live-mount, `cloakbrowser`/`puppeteer` backend untouched except download/queue API. Keep `media/` output dir, same `/media` serving. **Routing:** `/` = new React app; `/legacy` = current vanilla `index.html` (preserved verbatim).

---

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Build | Vite + React 18 + JS (no TS to match repo) | Fast, standard, no build pain. JS keeps parity with current codebase. |
| Location | `web/` folder at repo root (`web/src/`, `web/dist/`) | Isolates build from API. `api-server.js` serves `web/dist` as static. |
| Styling | Keep current CSS variables + `instrument sans`/`jetbrains mono` + `bootstrap-icons` | Reuse lovable theme from 001. No Tailwind churn. Global CSS file + component CSS where needed. |
| Routing | `react-router-dom` HashRouter (`#/dashboard` etc.) | Keeps `#dashboard` deep-links working. |
| WS lib | `ws` on server, native `WebSocket` on client | Minimal dep, works with Express on same port. No socket.io overhead. |
| State | React Context + useReducer for queue, Zustand not needed | Queue is central but small. Context + reducer is enough. |
| Persistence | Queue persisted server-side (`queue.json`) + mirrored to client via WS | Single source of truth. Survives reload/reconnect. Not localStorage-only. |
| Docker | Multi-stage build: `web` build stage → copy `dist` to runtime | No live `npm run dev` in prod. Dev uses Vite proxy. |
| Legacy | Current `index.html` + `scan-saved.html` stay intact, served at `/legacy` and `/legacy/scan-saved` | Zero regression risk; rollback is just a reverse proxy change. Keep until React reaches parity. |
| Root | `web/dist` served at `/`; if `dist` missing during dev, fallback to legacy with banner | Prevents blank page before first build. |

---

## Architecture

```
Browser (React)  <--WebSocket-->  api-server.js (Express + ws on same HTTP server)
   |                                    |
   | POST /queue/add {urls,folder}      | queue.json { active:[queued|running], completed:[done|failed] }
   | POST /queue/clear, /queue/remove  | single worker loop (active → completed on finish)
   | WS events: active:update, completed:update, job:progress, job:log
```

### Server changes (`api-server.js`)

- **Legacy move:** keep current `index.html` as `legacy/index.html` (copy, don't delete). Add routes:
  ```js
  app.use("/legacy", express.static(path.join(rootDir, "legacy")));
  app.get("/legacy", (_req,res)=>res.sendFile(path.join(rootDir,"legacy/index.html")));
  // keep /scan-saved → redirect to /legacy/#saved for old bookmarks or to /#saved for new app
  ```
  `GET /` switches to serving `web/dist/index.html` (with `express.static` for `web/dist/assets`). If `web/dist` absent, log warning and temporarily serve `legacy/index.html` at `/` with `X-Legacy-Fallback: 1` header so we never ship a blank page.
- Attach `ws` WebSocketServer to same `http.createServer(app)`.
- New module `queue.js` (or inline):
  - `queue = { items: [{id, url, folder, status: queued|running|done|error, logs, filePath, createdAt, startedAt, finishedAt }] }`
  - `add(urls)` → push `queued` items, broadcast `queue:update`.
  - Worker: `while(true) { item = queue.find(queued); if(!item) wait; set running; run download (existing scan-videos/index.run); set done/error; broadcast }` — one at a time, FIFO.
  - `loadQueueState()` on boot from `queue.json` file; `save()` on every transition.
  - On WS connect: send `queue:snapshot` + `health` immediately.
  - Broadcast `health` every 5s or on change; `queue:update` on every item transition + log chunk.
- Keep existing `POST /download` for now but deprecate; new path is `POST /queue/add` → worker handles it. Or make `/download` enqueue and return `{queued:true}`.
- WS message types server→client:
  - `queue:snapshot` — full queue
  - `queue:update` — {item} or full queue diff
  - `job:log` — {id, chunk}
  - `health` — {busy, browserReady, shuttingDown}
  - `media:changed` — trigger media refetch
  - `error` — {message}

### Client changes (`web/src/`)

**Folder layout:**
```
web/
  index.html
  vite.config.js (proxy /api + /ws to :3000)
  package.json
  src/
    main.jsx (HashRouter)
    App.jsx (shell: sidenav + topbar + outlet)
    lib/api.js (fetch wrappers)
    lib/ws.js (useWebSocket hook, auto-reconnect with backoff)
    store/QueueContext.jsx (reducer, actions: add, remove, retry, clear)
    components/
      Sidenav.jsx, Topbar.jsx
      QueueList.jsx, QueueItem.jsx, AddForm.jsx (url textarea + folder + quality)
      ProgressBar.jsx, LogView.jsx
    views/
      Dashboard.jsx (AddForm + QueueList + ProgressBar + LogView) ← the main page
      Media.jsx, Saved.jsx, Sync.jsx, Profiles.jsx, Console.jsx
    styles/globals.css (ported from index.html lovable theme)
```

**Key hooks:**
- `useWebSocket(url)` — connects to `ws://host/ws`, auto-reconnect (exponential 1s→10s), exposes `send`, `connected`, `lastMessage`. On `queue:snapshot`/`queue:update` dispatches to QueueContext.
- `useQueue()` — `items`, `add(urls)`, `retry(id)`, `remove(id)`, derived `progress {total,done,running}`.

**Queue behavior (frontend):**
- `AddForm` submit → `POST /queue/add` (or `ws send queue:add`) → server pushes `queue:update` → UI re-renders. No polling.
- `QueueItem` status colors: queued (muted), running (indigo pulse), done (green), error (red). Running shows live logs via `job:log` WS chunks.
- No auto-re-run of done/error on reload — server queue persists, client just renders snapshot.

### Queue & dynamic behavior (user: quick, responsive, per-step progress, fail→next)

**Responsiveness:**
- Add is optimistic: textarea → `POST /queue/add` → server broadcasts `queue:update` within <100ms, UI appends card instantly. No page reload, no spinner blocking input.
- All updates push over WS (no polling). Client subscribes once, receives `queue:snapshot` on connect + incremental `queue:update`/`job:progress`/`job:log`. Reconnect uses exponential backoff 1s→10s with missed-event replay via snapshot.
- Rendering is incremental: only the affected `QueueItem` re-renders (React key by `id`, memo). 500-item queue stays smooth.

**Per-step progress (every stage reported):**
Each item moves through these stages, each broadcast as `job:progress {id, stage, pct, detail}` and visible on the card + top progress bar:
1. `queued` — waiting (shows position: "3rd in queue")
2. `browser` — acquiring browser (`busy → wait or reuse`)
3. `navigating` — `page.goto(url)` (url shown)
4. `capturing` — auto-capture polling DOM/network for media signals
5. `extracting` — site extractor running (IG/xH/xV/PH/generic)
6. `downloading` — `downloadMedia` streaming bytes (show `received/total` if known, else spinner + `downloading…`)
7. `muxing` — ffmpeg mux when video lacks audio (show `muxing…`)
8. `done` — final `filePath` + size, link to `/media/...` | `error` — reason, Retry button
9. Top bar: `3/10 done · 1 running · 2 failed` + progress `30%` updates on every stage change, not just done.

Server emits `job:progress` from inside `scan-videos/index.js` via a `onProgress(stage, data)` callback threaded through `run()` → `downloadMedia`; client maps stage→label/pct (e.g., navigating 15%, capturing 25%, downloading 40-90%, muxing 95%).

**Fail → next (never stalls queue):**
- If any stage throws (429, timeout, no media, ffmpeg fail), item is set `error` with `reason` (exact error message), `finishedAt`, and persisted; worker **immediately picks next `queued` item** — queue never blocks on a failure.
- `error` cards show `reason` + `Retry` (re-queues at tail) + `Remove`. Bulk `Clear failed` available.
- `POST /queue/add` while worker is running just appends; worker's loop wakes via `EventEmitter` (`queue:add` → `notify()`), not polling.
- Server boot: any leftover `running` → `error: Interrupted — server restarted. Hit Retry.` then worker resumes with next queued.
- Client: `job:log` chunks are ring-buffered per item (last 500 lines) so console view can replay without flooding WS (throttled to ≤50 msgs/sec per item, coalesced).

---

## UI Spec (React port of 001)

- Keep lovable theme: `f6f7fb` bg, dark sidenav `0f172a→1e1b4b`, hero gradient border `6366f1→8b5cf6→ec4899`, card radii, bootstrap-icons only.
- Dashboard = single view: hero `Add videos` form on top, queue panel below (filters All/Active/Done/Failed, progress bar, cards, collapsible live logs).
- Other views unchanged in IA: Media, Saved & Lists, Sync Queue, Profiles, Console.
- Topbar: live health pill (WS `health`), busy indicator when worker running.

---

## Steps to build

1. **Move current site to `/legacy` (no React yet)** — `mkdir -p legacy && cp index.html legacy/index.html && cp scan-saved.html legacy/scan-saved.html` (keep originals until verified). Patch `api-server.js` per "Server changes" above so `/legacy` serves the old site and `/` has the fallback. Verify `curl /legacy` = old 95k HTML, `curl /` = fallback legacy, `/health` unchanged. Commit: legacy move only.
2. **Scaffold `web/`** — `npm create vite@latest web -- --template react`, add `react-router-dom`, `ws` to server. Verify `vite build` → `dist`, then `curl /` serves React (fallback gone).
3. **Port styles** — copy CSS variables/theme from `legacy/index.html` to `web/src/styles/globals.css`. Visual parity check vs :7866 (`/legacy` as reference).
4. **Shell** — `App.jsx` + `Sidenav` + `Topbar` + HashRouter with 6 routes (`#/dashboard` etc.). Empty views stubbed.
5. **WebSocket plumbing** — server `ws` attach + broadcast helpers; client `useWebSocket` with reconnect. Smoke test: health pill goes live on new `/`.
6. **Queue module (server)** — `queue.json` persistence + single worker loop wrapping existing download engine. Expose `POST /queue/add`. Legacy `POST /download` stays for `/legacy` compat.
7. **Dashboard (React)** — `AddForm` → queue, `QueueContext` via WS, sequential processing proven (add 3 URLs → see them run 1-2-3 on `/`).
8. **Other views** — port Media/Saved/Sync/Profiles/Console one by one, each fed by WS or fetch. Keep checking `/legacy` still works.
9. **Docker** — `Dockerfile` multi-stage (web build → runtime copy `web/dist`), `docker-compose.yml` healthcheck still hits `/health`. Verify `docker compose build && up`.
10. **Cutover complete** — docs updated, `/legacy` remains as escape hatch. No deletion of legacy until 002 marked Done and manual QA passes.

## Verification

- After step 1: `curl -s http://localhost:3000/legacy | head -1` contains old `xdl — video downloader`, `curl -s http://localhost:3000/health` = `{ok:true}`.
- After step 2: `npm run build` succeeds, `web/dist/index.html` exists, `curl -s http://localhost:3000/ | grep -q "vite"` or React root, hard-refresh shows React app at `/`, `/legacy` still shows old app.
- Add 3 URLs on `/` → queue shows 3 cards, status cycles queued→running→done one by one, progress bar increments, logs stream live over WS (not polling).
- Reload mid-run on `/` → reconnects, snapshot shows correct running item, logs resume.
- `docker compose build && up` still works, media persists to `/mnt/media2t/downloads/studies/xdl`, both `/` and `/legacy` reachable.

## Risks / out of scope

- WS auth: same origin, no auth needed (local network). Add later if exposed.
- Backpressure: log chunks throttled (max 100 lines/sec broadcast) to avoid WS flood.
- Not in this plan: TS migration, Tailwind, job cancel/pause (queue is run-to-completion; add later).
