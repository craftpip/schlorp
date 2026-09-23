<p align="center">
  <img src="schlorp_logo.png" alt="schlorp logo" width="160" />
</p>

# schlorp machine — feed it links. enjoyyy.

Self-hosted video hoarding with a friendly face: you paste links into a dashboard, a stealth browser sneaks off to grab the video, and your library fills itself. Instagram, xHamster, xVideos, Pornhub, random pages — if it plays there, it lands in your folder.

## Get it running

Clone the repo, or download the zip and unzip it (unzipped folder is called `schlorp-main`).

**Docker (recommended)** — app, stealth browser, and VNC in one container:

```bash
git clone https://github.com/craftpip/schlorp
cd schlorp && docker compose up --build -d
# → http://localhost:6767
```

**Bare metal** — same worm, no container (needs Node 20+ and `ffmpeg` for HLS/DASH):

```bash
git clone https://github.com/craftpip/schlorp
cd schlorp && npm install   # postinstall fetches the CloakBrowser binary
npm start
# → http://localhost:6767
```

Downloads land in `./media` (`MEDIA_DIR` overrides it). Browser profiles survive restarts in the `browser-data` volume.

## The dashboard — where you live

Open `http://localhost:6767`. Five tabs, everything happens here:

**Dashboard — the feeding trough.** Paste one link or twenty (one per line), pick which folder they land in, optionally cap the quality. Everything queues up and downloads itself with a breather between items — set a fixed gap or a random range like `5m`–`15m` (`90s`/`5m` format). Watch the logs stream, click a finished row to play it right there. Clearing entries never deletes the files.

**Media — the hoard.** Your `/media` folder as a browsable library: grid or list, flatten subfolders into one view, stacks for series, playlists, rename/move/delete. The built-in player is keyboard-first — `space` plays, `←/→` or `a/d` seeks, `w/s` hops files, `m` mutes, `c/v` changes speed, `f` + a letter files things into a list, `y y` deletes, `/` shows every shortcut.

**Collections — the trap.** Paste an Instagram saved-collection link and scan it for new posts, optionally stopping when it reaches one you've already seen. Send what it finds straight to the download queue or into the background sync queue. The same tab manages your auto-sync lists (collection URL + folder + account) and shows the sync queue's pending and finished items.

**Profiles — the disguises.** Each account is an isolated Chrome profile with its own logins. Add one, log into sites through it (pop a browser window, or peek via VNC in Docker), and the machine keeps a separate stealth browser per active account. Scans and downloads can each ride a different profile.

**Settings — the engine room.** Server knobs, the VNC switch, and the console log when you want to watch the worm think.

Set `UI_PANEL_PASSWORD` and the app hides behind a fake todo list until `ctrl+shift+L` summons the login — `esc` + `` ` `` slams the door shut instantly, and idle sessions time out after 10 minutes.

## Prefer the terminal?

```bash
# one link or twenty — saves to ./media
node schlorp-cli https://example.com/video-page

# only show what it found, download nothing
node schlorp-cli --link-only https://...

# quality ceiling (also: --max-quality=720)
node schlorp-cli --max-quality 720 https://...

# same through docker (the container is called schlorp)
docker exec schlorp node schlorp-cli --max-quality 720 https://...

# pop a real browser for logging in / poking around (add --account work for a profile)
node schlorp-cli open-browser [--account work]
```

## Knobs & environment

- `PORT` (6767), `HEADLESS` / `API_HEADLESS`, `BROWSER_USER_DATA_DIR`, `BROWSER_PROFILE_DIR`, `BROWSER_PATH`
- `UI_PANEL_PASSWORD` / `ADMIN_PASSWORD` (empty = no lock)
- `MEDIA_DIR` (host download dir in compose, default `./media`), `MEDIA_RANGE_SIZE` (100)
- `API_JOB_TIMEOUT_MS` (1800000), `DOWNLOAD_FETCH_TIMEOUT_MS` (300000), `FFMPEG_TIMEOUT_MS` (900000), `FFPROBE_TIMEOUT_MS` (120000)
- `AUTO_CAPTURE_TIMEOUT_MS` (30000), `AUTO_CAPTURE_QUIET_MS` (1800), `AUTO_CAPTURE_POLL_MS` (250)
- `INSTAGRAM_429_COOLDOWN_MS` (300000), `SAVED_SYNC_DOWNLOAD_DELAY_MS` (20000), `API_BASE` (daemon target, default `http://localhost:6767`)
- `ENABLE_VNC` (0), `VNC_PORT` (6777), `NOVNC_PORT` (6778)

## Tests

```bash
npm test         # backend/API tests (node --test, no live browser needed)
npm run test:cov # same, with coverage
```

That's the whole machine. Go hoard something.
