# 028 — Docker build: lightweight image + faster build

> Project: **xdl** (schlorp) media downloader.
> Date: 2026-09-21. Status: **Planned**.
> Trigger: "build file is too huge, takes lots of time to build — are we using alpine? …use a lightweight image and make build faster, remove the not needed packages."
> Scope: `Dockerfile` + `docker/entrypoint.sh` + `docker-compose.yml` + tests + AGENTS.md note only. No app logic changes. No VPN/gluetun/xdl-bridge changes (red line).

---

## 1. Objective

Produce a Docker image that is:
1. **Smaller** — drop unneeded OS packages.
2. **Faster to build** — minimize the two dominant build costs (apt layer + the ~200MB CloakBrowser Chromium download) and keep layers cacheable.
3. **Functionally identical** — headful browser + Xvfb + VNC + ffmpeg muxing all still work; existing tests pass.

## 2. Baseline (facts gathered 2026-09-21)

**Current image:** `node:20-bookworm-slim` (`Dockerfile:1`, Debian — **not** Alpine).

**Apt layer (`Dockerfile:5-22`)** installs: `ffmpeg xvfb fluxbox x11vnc novnc websockify procps socat fonts-liberation ca-certificates libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libxcomposite1`. This is the slowest layer (ffmpeg + the X/VNC stack on Debian).

**What actually uses each package:**

| Package | Used by | Verdict |
|---|---|---|
| `ffmpeg` | `scan-videos/download.js` (HLS/DASH mux), `api-server.js` | **KEEP** — core feature |
| `xvfb` | `entrypoint.sh:9` — always started (headful needs it) | **KEEP** |
| `fluxbox` | `entrypoint.sh:11` — window manager for the X display | **KEEP** |
| `x11vnc` | `entrypoint.sh` `vnc-start`; API `POST /vnc/start:stop` (`api-server.js:2035,2048`); UI "Open VNC desktop" | **KEEP** (compose sets `ENABLE_VNC=1`) |
| `novnc` | `vnc-start` (`/usr/share/novnc/utils/novnc_proxy`), UI noVNC link (:6778) | **KEEP** |
| `websockify` | `vnc-start` fallback kill + `novnc` dep | **KEEP** |
| `procps` | nothing — entrypoint already writes a `ps` shim *specifically to avoid needing it* (`entrypoint.sh:77-86`) | **REMOVE** |
| `socat` | legacy compat bridge only (`entrypoint.sh:15-19` :3000/5900/7900). AGENTS.md says host publishing now goes through `xdl-bridge`; these are the old gluetun-era ports. | **REMOVE** (see §4.1 decision) |
| `fonts-liberation` | Chromium font rendering / CloakBrowser fingerprint | **KEEP** (small) |
| `ca-certificates` | node/https + browser | **KEEP** |
| `libnspr4 libnss3 libatk* libxcomposite1 libatspi2.0-0` | CloakBrowser Chromium shared libs | **KEEP** (glibc-only, see §3) |

**CloakBrowser binary download — the second big build cost:**
- `postinstall: "cloakbrowser install"` (`package.json`) runs during `npm ci` → downloads a **prebuilt glibc Chromium (~200MB)** into `$HOME/.cloakbrowser` (`dist/cli.js`, `dist/config.js:103-108`).
- **BUT** the image sets `ENV CLOAKBROWSER_CACHE_DIR=/data/cloakbrowser` (`Dockerfile:35`), and `.docker-compose.yml` mounts a **named volume** at `/data/cloakbrowser`. The app resolves the binary from `CLOAKBROWSER_CACHE_DIR` (`dist/puppeteer.js:39`), **not** from `~/.cloakbrowser`.
- Net effect today: the build-time ~200MB binary is baked into the image, then **ignored at runtime** (cache dir env wins). Worse, on a fresh volume the app **re-downloads 200MB at first browser launch** (slow first job).

**Alpine constraint (the "are we using alpine?" question):**
- CloakBrowser ships ONE prebuilt binary per platform: `linux-x64` / `linux-arm64` (`dist/config.js:31-54:84-86`). There is **no musl/alpine build** (no `musl`/`glibc` branching in `dist/download.js`).
- Running that glibc Chromium on Alpine would need `gcompat`/glibc-shim — a compatibility crutch that risks breaking the C++ fingerprint patches (the whole point of CloakBrowser) and is known-flaky for puppeteer/playwright. **Alpine is rejected as the base** unless a spike proves an actual size gain compelling enough to risk stealth.

## 3. Decisions locked

| Topic | Decision | Why |
|---|---|---|
| Base image | **Stay `node:20-bookworm-slim`** | CloakBrowser binary is glibc; Alpine needs a shim that risks stealth → not "no-brainer" trade |
| `procps` | **Remove** | Redundant (`ps` shim + `/proc` scans already in entrypoint) |
| `socat` + compat bridge block (`entrypoint.sh:14-19`) | **Remove** | Legacy gluetun-era ports; host publishing is via xdl-bridge |
| VNC stack | **Keep** (it's actively used) | VNC is the visible UI path to a headful browser |
| ffmpeg | **Keep** | HLS/DASH muxing is core; without it downloads degrade to video-only |
| Chromium binary | **Seed `/data/cloakbrowser` during build** so the named volume copy-up provides it; no runtime re-download (§4.2) | Removes the "download 200MB on first job" delay AND the double-storage |

## 4. Implementation

### Phase 0 — measure baseline (one-time, before any edit)

```bash
docker build --progress=plain -t schlorp-app-image:baseline . 2>&1 | tee /tmp/build-baseline.log
docker image inspect schlorp-app-image:baseline --format '{{.Size}}'
docker image history schlorp-app-image:baseline --format '{{.Size}}\t{{.CreatedBy}}' | head -15
```
Record: total wall time per layer, uncompressed image size, and the npm/apt layer sizes. This is the before-number every later phase compares against.

### Phase 1 — package trim (small, safe win)

1. `Dockerfile:5` — drop `procps`.
2. Drop `socat`; delete the compat bridge `if … socat …` block + pid writes in `entrypoint.sh:14-19`.
3. Confirm nothing else in the repo shells out to `socat`/`ps`: `grep -rn "socat\|procps\|/bin/ps" --include=*.js app api-server.js scan-videos sync-saved-downloads.js .` (none expected).
4. Keep the rest; verify headful VNC smoke (§5).

### Phase 2 — kill the redundant Chromium download (biggest build+runtime win)

Restructure `Dockerfile` so the stealth Chromium goes where the app actually looks, exactly once:

1. Set the cache dir **before** `npm ci` so the build-time install already targets it:
   ```dockerfile
   ENV CLOAKBROWSER_CACHE_DIR=/data/cloakbrowser
   RUN mkdir -p /data/cloakbrowser /data/browser /app/media
   COPY package*.json ./
   RUN npm ci --omit=dev   # postinstall downloads binary straight into /data/cloakbrowser
   ```
2. The named `cloakbrowser-cache` volume copy-up (Docker seeds empty named volumes from image content on first use) then provides the binary on first `compose up` → **no build re-download, no runtime download, no 200MB dead weight in `~/.cloakbrowser`.**
3. Optionally move the npm+cache step into a small multi-stage `browser-dl` stage and `COPY --from` the seeded cache dir — keep if it measurably helps cache isolation, skip otherwise (minimal change principle).
4. **Gotcha to document:** copy-up only happens on a *fresh, empty* volume. An already-populated `cloakbrowser-cache` volume will NOT pick up a new binary version — document "delete volume to force re-seed" in a Dockerfile comment near the volume and in AGENTS.md.

### Phase 3 — Alpine spike (gated experiment, expected rejection)

Do NOT merge without tests. If someone wants the number:
1. Branch: `node:20-alpine`, `apk add --no-cache` equivalents, `gcompat` + `libstdc++`.
2. Gate on: `cloakbrowser doctor` passes, `node --test test/` passes, live headful smoke against a bot-detection URL still passes.
3. Report the size delta vs Phase-0 baseline. If the delta is < 40% or any stealth check fails → keep Debian. (Likely outcome.)

### Phase 4 — verification + docs

1. Run §5 checks.
2. Update `AGENTS.md` Docker bullets + `plans/028` status + `PLAN.md` §8 resume note with the "delete `cloakbrowser-cache` volume after image changes" gotcha.

## 5. Verification matrix

| # | Check | Command / oracle | Pass |
|---|---|---|---|
| 1 | Image builds | `docker compose build` | exit 0 |
| 2 | Smaller than baseline | compare phase-0 size vs new size (target: measurable drop; exact threshold in plan) | `< baseline` |
| 3 | No socat/procps in image | `docker run --rm schlorp-app-image sh -c 'command -v socat ps'` | both absent |
| 4 | Tests | `npm test` (root) — tests must not require browser/Docker per AGENTS.md | all pass |
| 5 | ffmpeg present | `docker run --rm schlorp-app-image ffmpeg -version` | exit 0 |
| 6 | Xvfb/fluxbox start | `docker compose up -d`; `docker exec schlorp ls /tmp/xvfb.pid /tmp/fluxbox.pid` | both files |
| 7 | VNC reachable | `curl -sf http://127.0.0.1:6778/vnc.html` and `:6777` raw | 200 / connects |
| 8 | Binary seeded, no re-download | `docker exec schlorp sh -c 'ls /data/cloakbrowser'` (non-empty); container log shows no first-launch download | seeded, no download |
| 9 | Health | `curl http://127.0.0.1:6767/health` | `{"ok":true,…}` |
| 10 | Rebuild with cache | second `docker compose build` — unchanged layers hit cache | fast, no redownload |

## 6. Rollback

`git checkout -- Dockerfile docker/entrypoint.sh` (this repo is not under git — copy the originals to `/tmp/backup-028/` before editing). For a lingering bad volume: `docker compose down -v` then recreate (re-seeds from the image).

## 7. Open questions (user to decide)

1. **Remove `socat` compat ports?** Assumes nothing still hits `:7866/:7906` (old gluetun-era). If the user's dashboards still use them, keep `socat` — it's a small package; the real savings are elsewhere.
2. **Chromium binary in image vs lazy download:** plan chooses in-image seed (best UX). Alternative (skip `--ignore-scripts` download → ~200MB smaller image, but 200MB download on very first browser use) rejected unless the user prefers minimal image over first-run speed.
3. **ffmpeg degradation option** (strip ffmpeg → much smaller/faster build but no HLS/DASH muxing) — offered only because `download.js` already degrades gracefully; **not recommended** since IG downloads frequently need audio muxing.