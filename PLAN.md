# xdl — Revamp Plan & Progress Log

> Project: **xdl** (media downloader: CloakBrowser + Puppeteer visiting Instagram / xHamster / xVideos / Pornhub / generic)
> Runtime: Node 18+ / CommonJS / no build step. Docker: `node:20-bookworm-slim`.
> This file is the source of truth for the UI revamp. Update it as we go — we may lose context between sessions.

---

## 1. User requests (all, in order)

1. **Create a React app** for the UI. → *Superseded by #3 (user chose vanilla JS).*
2. **Make a revamp plan** for a good interface to manage "my things" (downloads, queue, saved lists, accounts/profiles, console, media).
3. **Scope = everything**: Dashboard, Downloads, Saved Lists, Sync Queue, Profiles, Console **+ new Media browser**. Replaces both `index.html` and `scan-saved.html`.
4. Build tooling: **keep vanilla JS** (no React, no Vite) — stays compatible with Docker live-mount, no build step.
5. Styling: **Bootstrap or something simple** — "simple ass app". → *Superseded by #8 (user hated Bootstrap look).*
6. **Make the software better / smooth functioning.**
7. **Save the plan to a file** (token-limit safety). ← *This file.*
8. **Modern UI, red and black themed.** Project name is **xdl**. → Bootstrap dropped, hand-rolled theme.
9. **Add all requests to the plan** and keep going. ← *This section.*

---

## 2. Decisions locked in

| Topic | Decision |
|---|---|
| Framework | Vanilla JS single-page app (no build step, no TypeScript) |
| Styling | Hand-rolled CSS, **red & black** dark theme, Inter + JetBrains Mono fonts, Bootstrap Icons (icon font only) |
| Layout | Fixed dark sidebar (236px, collapses to 64px on mobile) + content area, hash-based routing |
| Backend | Express API untouched except: new `GET /api/media` + `GET /scan-saved` → redirect |
| Deployment | `index.html` still served by Express at `/`; works with Docker live-mount as-is |
| Media browser | New feature — directory listing via `GET /api/media?folder=`, filter client-side |

---

## 3. What has been done (state at last save)

### Backend (`api-server.js`)
- **Added** `GET /api/media?folder=<rel>` → `{ ok, folder, items:[{name,dir,size,mtime}] }`. Reuses `resolveMediaOutputDir()` for safe path containment. Sorts dirs first then name. Returns 400 on invalid paths.
- **Changed** `GET /scan-saved` from serving `scan-saved.html` → `302 redirect` to `/#saved` (feature now lives in the SPA).

### Frontend (`index.html` — full rewrite, vanilla JS, red/black theme)
Single-page app, 7 views behind a sidebar, hash routing (`#dashboard` `#downloads` `#saved` `#sync` `#profiles` `#media` `#console`):

- **Dashboard**: stat cards (server online/busy, sync queue depth, shared browser status, open profiles), busy badge, quick-action buttons.
- **Downloads**: multi-URL queue (localStorage persisted), folder + max quality, Run/Pause, retry/remove/clear, thin progress bar, per-item status cards (colored left border), streaming log panel (`<details>`), parses `Downloaded media to: <path>` lines into clickable file links.
- **Saved & Lists**: scan IG saved collection (url, account, folder, optional stop-url) → filtered post URLs with per-row "Add", plus "Add all to download queue" / "Enqueue for sync" / "Copy"; and auto-sync list management (add/remove, per-list last-scan/stop state).
- **Sync Queue**: add URLs form + pending list (remove each) + completed list + clear completed.
- **Profiles**: account select, open/close visible browser (streams log), VNC session link, accounts table with live status.
- **Media**: breadcrumb navigation, up-one-level, table (name/size/modified), copy relative path, client-side filter.
- **Console**: shared streaming log (500-line cap) shared by downloads + browser-open, clear button.
- Polling: `/health` 5s, `/accounts` 15s, `/sync-config` 15s. Global log buffer reused by all streamers.

### Smoothness fixes (from request #6)
- Media filter is now **local** (no refetch per keystroke).
- Log rendering capped + shared buffer; scroll pinned to bottom.
- Queue pauses gracefully after the in-flight item.
- Added red SVG **favicon** (was 404 before).

---

## 4. Design system (red & black)

- `--bg #0b0b0e`, panels `#16161b` / `#1c1c22`, borders `#26262e`.
- Accent `--accent #10b981`, bright `#34d399`, dim glows `rgba(16,185,129,*)` + green radial gradient in page background. Danger/error semantic red `--danger #f05454`.
- Brand: red gradient play-mark + "xdl". Sidebar active item gets red left bar + gradient wash.
- Buttons: red gradient primary with glow; ghost/outline variants; status pills (`success/danger/primary/secondary/warning/info`) all dark translucent.
- Console: near-black `#0a0a0d`, mono font, red detail accents.
- Custom scrollbars, `::selection` red, `:focus-visible` red ring, view fade-in animation.

---

## 5. Redesign roadmap for "smooth functioning"

### Done
- [x] New `GET /api/media` listing endpoint
- [x] `/scan-saved` → SPA redirect
- [x] Full SPA with 7 views, all old features ported + Media browser
- [x] Red/black modern theme (Bootstrap CSS removed)
- [x] Local media filtering

### Next (in priority order)
1. **Preview media inline** — play video/audio files in the Media view (`<video>`/`<audio>` modal) instead of only opening a new tab. (Small JS addition.)
2. **Download button per file** in Media (re-download to a chosen folder) or at least a "reveal" path.
3. **Job status feedback** — show active job type in header everywhere (currently only dashboard badge + health busy flag).
4. **Auto-refresh Media view** with optional "watch mode" toggle (poll every 15s) so newly downloaded files appear live.
5. **Retry-on-429 UX** — surface 429 cooldown in the UI ("Instagram rate-limited, cooling down" banner) instead of a raw error line.
6. **Batch URL field on Dashboard** quick download box (currently only quick-action nav buttons).
7. **Confirmation dialogs** for destructive actions (clear queue / clear completed / remove list).
8. **Keyboard shortcuts** (e.g. `1..7` switch views, `Enter` runs queue from Downloads).
9. **Better sync status** — show daemon uptime / last task from state (`lists[].lastRunAt`) on Dashboard.

### Backend candidates (only if needed)
- `GET /api/job` — expose current active job (type, startedAt) so UI can show live "busy" detail.
- `DELETE /media/:path` guarded delete (with trash instead of rm) — only if user wants in-app deletion.

---

## 6. Testing / verification

- `node --check` on extracted `<script>` → **OK**
- `node --check api-server.js` → **OK**
- CSS brace balance → **152/152 OK**
- **Live HTTP test** (api-server on `:3211`): `/health` OK, `/api/media` OK (empty dir), `/api/media?folder=../../etc` → 400 with safe error, `/scan-saved` → 302 → `/#saved`, `/` serves the SPA. **All verified.**
- **Headless Chrome audit** (installed missing system libs, launched cloakbrowser Chromium headless):
  - Theme applied: body bg `rgb(11,11,14)`, red radial gradient, Inter font, 236px sidebar, red gradient brand mark, white active nav.
  - All 7 views navigate correctly + sidebar active state tracks hash; only one view visible at a time.
  - No console/HTTP errors after favicon fix.
- **Environment limitation (resolved for testing)**: local sandbox couldn't launch Chromium (missing `libglib-2.0.0`, then `libcairo`, etc.) — fixed by `apt-get install` of Chrome runtime deps. Browser-dependent flows (real downloads / IG scans / open-browser) still need the Docker host because they need a real profile + VNC.
- Visual screenshots exist at `/tmp/xdl-dashboard.png`, `/tmp/xdl-downloads.png` (this model can't view images, but the computed-style audit above is authoritative).

## 7. Notes / gotchas

- Keep the JS inside `index.html` self-contained and dependency-light (only Bootstrap Icons CDN + Google Fonts).
- URLs are always rendered with `textContent` / `createTextNode` (XSS-safe).
- `toMediaUrl()` maps backend log paths (`media/sub/file.mp4` or `/media/...`) to served `/media/...` links.
- Sync daemon (`sync-saved-downloads.js`) unchanged — it only talks to the JSON API.
- `.gitignore` already covers `media/`, `node_modules/`, state files.

---

## 8. Next session — resume here

1. Read this file.
2. `git status` in `/www1/xdl` to see current diff (index.html + api-server.js + PLAN.md changed).
3. Continue roadmap items in §5 order, or whatever the user asks.
4. Verify browser-dependent flows on the Docker host (`xdl-app` on port 7866). Quick local static check: `PORT=3211 node api-server.js` then screenshot via headless Chrome.
