# schlorp machine — feed it links. enjoyyy.

Stealth browser goes brrr. A tiny Node CLI + API + UI that visits pages and **yoinks the good bits** — if it plays video, the worm can probably schlorp it. HLS/DASH? `ffmpeg` muxes it. You click, it *schlorps*.

- **Goofy on the outside, serious about the schlorp:** auto-captures DOM + network, scores candidates, muxes audio when the site forgets it.
- **Stack:** Node 20+, CloakBrowser (stealth Chromium via Puppeteer), Express, `ffmpeg` for HLS/DASH.
- **UIs:** `index.html` app UI at `/`, `scan-saved.html` scanner, marketing site in `website/`.

> Website tagline status: 100% SCHLORP CERTIFIED™. Goofy but works™.

## From zero to yoink in 2 mins

Pick your fighter. Both end with terminal yoinking.

### Method A · docker (recommended)

The lazy way — one command and the whole circus moves in: API + UI + stealth browser + VNC.

```bash
# grab the repo, then start the machine
git clone https://github.com/your/schlorp-machine.git
cd schlorp-machine && docker compose up --build -d
# → API + UI at http://localhost:6767
```

```bash
# container is named schlorp — single or many
docker exec schlorp node scan-videos.js https://example.com/video-page

# smol file pls
docker exec schlorp node scan-videos.js --max-quality 720 https://...
```

- App: `http://localhost:6767`
- Health: `http://localhost:6767/health`
- VNC desktop: `http://localhost:6778/vnc.html` (raw VNC on `6777`)
- Logs: `docker logs -f schlorp`
- Downloads land in `./media` on the host (mount `MEDIA_DIR` to change it).

### Method B · node

Raw & manual. For tinkerers who like touching the worm directly.

```bash
# clone & install — that's it
git clone https://github.com/your/schlorp-machine.git
cd schlorp-machine && npm install
# ffmpeg check (for HLS/DASH)
ffmpeg -version | head -n 1

# start API + UI → http://localhost:6767
npm start
```

```bash
# single or many — saves to ./media
node scan-videos.js https://example.com/video-page

# just print links, don't download
node scan-videos.js --link-only https://...

# cap non-Instagram media selection to 720p
node scan-videos.js --max-quality 720 https://...

# open a browser so you can log in and manually interact with a page
node scan-videos.js open-browser

# open the configured profile for a named account
node scan-videos.js open-browser --account work
```

Prerequisites: Node.js 20+, `ffmpeg` in PATH for HLS/DASH (direct MP4s work without it).

## What the worm does

Four tricks, full dignity — plus one classified bonus.

- **Yoinks videos, yeah** — paste literally any link. Sniffs DOM + network, scores candidates, schlorps the best one. Supports Instagram, xHamster, xVideos, Pornhub + generic sites. Respects `--max-quality`.
- **Certified collector** — scan an Instagram saved collection, vacuum posts into tidy folders. The sync daemon (`sync-saved-downloads.js`) polls lists on its own schedule with rate-limiting and retries.
- **Single-hand screening room** — full video controls, one hand on snacks: `space` play/pause, `WASD` seek, `M` mute, `<>` speed.
- **Your hoard, your rules** — playlists, per-folder routing, per-account profiles. Your `/media`, your beautiful mess.
- **Bonus · paranoid-grade stealth** — password lock turns the app into a boring todo list. `ctrl+shift+L` is the secret knock, `esc` + `` ` `` is the panic button. Definitely not a *redacted* machine. The worm was never here. 🫡

How the schlorp happens (`scan-videos/index.js`):

1. Open CloakBrowser (or reuse the shared API instance), set mobile UA/viewport for Instagram.
2. Navigate with Instagram 429 retry + cooldown, poll DOM + network until media signals settle.
3. Collect + score candidates (`scan-videos/media-utils.js`), apply quality cap.
4. Download with browser cookies/headers; for silent Instagram video (`dash_lna`) fetch companion audio and `ffmpeg`-mux into one file.

## UI map

Served by `api-server.js` (port `6767` by default, `PORT` env):

- `/` — Memo app: Dashboard (download queue), Media library, Saved & Lists, Sync Queue, Profiles, Console.
- `/scan-saved` — saved-collection scanner page.
- `/website` — the marketing site (`website/index.html`).
- `/health` — `{ ok, shuttingDown, busy, browserReady }`.

Key API routes: `POST /download`, `POST /scan-saved`, `POST /queue/*` (web queue), `POST /sync-queue/pending/*`, `GET /api/media`, `GET/PUT /api/mediaorder`, `GET/POST/DELETE /api/playlists*`, `GET/POST /accounts*`, `POST /open-browser`, `POST /close-browser`, `GET /sync-config`, `POST /sync-config`, `GET /vnc/status`.

## Multi-account? Worm gotchu.

Each named account = isolated Chrome profile. Configure accounts + saved lists in `.saved-sync-state.json`:

```json
{
  "config": {
    "accounts": [
      { "name": "personal", "userDataDir": "/data/browser/personal", "profileDir": "Default" },
      { "name": "work", "userDataDir": "/data/browser/work", "profileDir": "Default" }
    ],
    "savedLists": [
      { "url": "https://www.instagram.com/username/saved/list/123/", "folder": "favorites", "account": "personal" }
    ]
  },
  "lists": {}
}
```

Log in with `node scan-videos.js open-browser --account personal`. `/scan-saved` takes an `account` param and keeps one CloakBrowser instance per active account; `/download` uses the default profile.

For interactive login in Docker, enable VNC (`ENABLE_VNC=1`, on by default in compose) and open `http://localhost:6778/vnc.html`. Profile data persists in the `browser-data` volume; CloakBrowser binary persists in `cloakbrowser-cache` (`CLOAKBROWSER_CACHE_DIR`, override with `CLOAKBROWSER_BINARY_PATH`).

## Timeouts & env vars

Safety timeouts so one long job can't wedge the API:

- `PORT` (6767), `HEADLESS` / `API_HEADLESS`, `BROWSER_USER_DATA_DIR`, `BROWSER_PROFILE_DIR`, `BROWSER_PATH`
- `API_JOB_TIMEOUT_MS` (1800000), `DOWNLOAD_FETCH_TIMEOUT_MS` (300000), `FFMPEG_TIMEOUT_MS` (900000), `FFPROBE_TIMEOUT_MS` (120000)
- `INSTAGRAM_429_COOLDOWN_MS` (300000) — sync daemon exits on 429 so it can be retried later
- `SAVED_SYNC_DOWNLOAD_DELAY_MS` (20000), `AUTO_CAPTURE_TIMEOUT_MS` (30000), `AUTO_CAPTURE_QUIET_MS` (1800)
- `ENABLE_VNC` (0), `VNC_PORT` (6777), `NOVNC_PORT` (6778)

## Tests

```bash
npm test        # backend/API tests (node --test, no live browser needed)
npm run test:ui # web UI tests (Vitest)
npm run test:all
```

## Enjoyyy zone

Queue it & forget it: paste 20 URLs, set a gap (e.g. 5m–12m), go touch grass. Worm works. If it breaks, the worm wiggles apologetically. Crafted with wiggles & ffmpeg ✨ — yoink responsibly.
