# xdl — Revamp Plan & Progress Log

> Project: **xdl** (media downloader: CloakBrowser + Puppeteer visiting Instagram / xHamster / xVideos / Pornhub / generic)
> Runtime: Node 18+ / CommonJS / no build step. Docker: `node:20-bookworm-slim`.
> This file is the source of truth for the UI revamp. Update it as we go — we may lose context between sessions.
>
> **Detailed plans now live in `plans/`** — active: `plans/002-react-panel.md` (React rebuild + WebSocket + sequential queue, 2026-08-22). 001 archived to `/tmp`.

---

## 1. User requests (all, in order)

1. **Create a React app** for the UI. → *Superseded by vanilla JS.*
2. **Make a revamp plan** for a good interface to manage "my things" (downloads, queue, saved lists, accounts/profiles, console, media).
3. **Scope = everything**: Dashboard, Downloads, Saved Lists, Sync Queue, Profiles, Console **+ new Media browser**. Replaces both `index.html` and `scan-saved.html`.
4. Build tooling: **keep vanilla JS** (no React, no Vite) — stays compatible with Docker live-mount, no build step.
5. Styling: **Bootstrap or something simple** → superseded.
6. **Make the software better / smooth functioning.**
7. **Save the plan to a file** (token-limit safety).
8. **Modern UI, red and black themed.** → superseded by lovable light theme (2026-08-22).
9. **Add all requests to the plan** and keep going.
10. **2026-08-22: How good is http://10.69.1.164:7866/#dashboard, make the UI lovable and good looking, organize the items nicely, it should be logically placed. The main goal is to download video files.** ← *Current work.*

---

## 2. Decisions locked in (2026-08-22 — lovable revamp)

| Topic | Decision |
|---|---|
| Framework | Vanilla JS single-page app, hash routing `#dashboard` `#downloads` `#saved` `#sync` `#profiles` `#media` `#console` — no build step |
| Styling | Hand-rolled CSS, **lovable light theme**: `Instrument Sans` + `JetBrains Mono`, violet/indigo gradient `6366f1 → 8b5cf6 → ec4899`, Bootstrap Icons only |
| Layout | **App shell → responsive layout**: Desktop: dark sidenav (272px, `0f172a → 1e1b4b` gradient) + main column with sticky blurred topbar (`f6f7fb` backdrop). Mobile: sidenav becomes drawer with backdrop. Fixes previous horizontal topbar overflow. |
| IA principle | **Download is hero**: Dashboard *is* the download entry point. Logical order by frequency: `Main (Dashboard/Downloads/Media)` → `Sources (Saved/Sync)` → `System (Profiles/Console)` |
| Backend | Express API untouched except `GET /api/media` + `GET /scan-saved → 302 /#saved` (from earlier revamp) |
| Deployment | `index.html` served at `/` (105k bytes), Docker live-mount compatible |

---

## 3. Dashboard assessment — http://10.69.1.164:7866/#dashboard

### Before (2026-08-22 pre-revamp) — 6/10
- Beige `faf9f7` paper theme, 6px radius, flat cards — utilitarian, not delightful. No visual hierarchy.
- Horizontal topbar held 7 nav links + health — overflow on laptop, no grouping, hard to scan (`index.html:71` topbar).
- Dashboard showed 4 stat cards + quick-action buttons but **no download input above the fold** — user had to switch to Downloads tab to do the primary job.
- Downloads form was cramped 3-col row, tiny textarea, generic `Add` — didn't feel primary.
- Media was plain table without breadcrumbs/pills, saved/sync all same card style.

### After — lovable (2026-08-22)
Score: **9/10 for the goal (download-first)** — needs real-user validation on queue throughput.

**What changed in `index.html`:**
- **Sidenav grouping**: `Main` (Dashboard, Downloads, Media library) / `Sources` (Saved & Lists, Sync Queue) / `System` (Profiles, Console) with active gradient (`6366f1 → 8b5cf6`) and icon badges. Health card + VNC link in footer. Pro-tip card.
- **Topbar**: sticky `rgba(246,247,251,.85)` blurred, shows current view title/sub + health pill, mobile menu button.
- **Dashboard hero**: `hero-download` gradient-bordered card (`6366f1 → 8b5cf6 → ec4899` outer, white inner) with title `Quick download`, description, **supported pills** (IG pink, xH red, xV blue, PH orange, +generic) and full-width textarea + folder/quality row + `Add to queue` gradient button. This makes download possible without leaving dashboard.
- **Stats**: 4 cards with colored icons (indigo/violet/emerald/amber), hover lift, radial accent, badge `OK/READY`.
- **Downloads view**: filter pill group `All/Active/Done/Failed` with counts, progress card (`f8fafc` bg, 8px gradient bar with shimmer), `queue-card` with left-border state (`running` indigo wash, `done` green, `error` red wash), drag-over highlight on textarea.
- **Saved**: two-column cards, `LIVE SCAN` badge, helpers under inputs, results with per-row `Add`.
- **Media**: breadcrumb pills (`House > Media`), folder-fill amber icon, filter + refresh topbar action.
- **Console**: dark `0f172a` terminal shared buffer, 500-line cap.
- **UX polish**: `eyebrow` pill, `supported-pill`, `quick-action primary`, `healthPulse` dot animation, `fadeIn` view transition, drag & drop for URLs, local filter, 272→280px responsive.

All JS IDs preserved (`dl-form`, `dl-urls`, `dl-folder`, `dl-quality`, `dl-filters`, `sv-form`, `media-rows`, etc.) — logic in `index.html:650` intact.

---

## 4. What has been done (cumulative)

### Backend (`api-server.js`)
- `GET /api/media?folder=<rel>` → `{ ok, folder, items:[{name,dir,size,mtime}] }` with `resolveMediaOutputDir()` containment, dirs-first sort, 400 on invalid.
- `GET /scan-saved` → `302` to `/#saved`.
- Health: `GET /health` returns `busy`, `browserReady`, `accountBrowsersReady`.

### Frontend (`index.html` — current 105k, lovable theme)
- 7 views, hash routing, `localStorage` queue (`xdl.queue.v1`), streaming `/download` logs, `Downloaded media to:` → clickable `/media/...` links, polling `/health` 5s / `/accounts` 4s / `/sync-config` 15s.
- Verification: `node -e` html length 105601 + ids present OK, `curl /health` OK, `curl /` 105665 bytes, DOM audit via CloakBrowser (`4153d56b2180`) shows `Download videos, effortlessly.` hero visible at `x:496 y:70`.

---

## 5. Roadmap — next

### Done (2026-08-22)
- [x] Lovable light theme + dark sidenav
- [x] Download-first IA (hero on dashboard, logical grouping)
- [x] Drag & drop, gradient progress, queue states, supported pills
- [x] Responsive drawer, topbar viewMeta, health pill

### Next (priority)
1. **Inline media preview** — `<video>` modal in Media instead of only new-tab.
2. **Per-file download/re-queue** from Media.
3. **Global job banner** — show active job type in topbar everywhere (now only badge + health).
4. **Media watch mode** — auto-poll 15s toggle so new files appear live.
5. **429 cooldown banner** — surface Instagram rate-limit instead of raw error.
6. **Dashboard batch box** already done (hero is the box) — consider adding recent downloads list on dashboard.
7. **Confirm dialogs** for destructive clears.
8. **Keyboard shortcuts** `1..7` switch views.

### Backend candidates
- `GET /api/job` expose active job detail
- `DELETE /media/:path` with trash

---

## 6. Testing / verification

- `node --check` extracted script → OK; `api-server.js` → OK
- Live: `curl http://10.69.1.164:7866/health` → `{"ok":true,"browserReady":true}`
- Live: `http://10.69.1.164:7866/` → `200 105665 bytes`
- Headless DOM audit: title `xdl — video downloader`, sidenav + hero visible, all 7 views route correctly.
- Screenshot via `web_page_screenshot` was garbled (GPU) — validated via `DOM.getDocument` instead.

## 7. Notes / gotchas

- Keep JS self-contained, dep-light (Bootstrap Icons CDN + Google Fonts only). URLs via `textContent`.
- `toMediaUrl()` maps backend paths to `/media/...`.
- Sync daemon `sync-saved-downloads.js` unchanged.
- `.gitignore` covers `media/`, `node_modules/`, state files.
- After CSS change, clients need hard refresh (`Ctrl+F5`) due to no cache-busting on `/` (ETag only).

---

## 8. Next session — resume here

1. Read this file.
2. `git status` in `/www1/xdl` — diff is `index.html` + `PLAN.md`.
3. Continue roadmap §5 or user request.
4. Quick check: `PORT=3211 node api-server.js` or `curl http://10.69.1.164:7866/health`.

