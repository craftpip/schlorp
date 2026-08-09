# scan‑videos

A small command‑line utility that opens a browser, visits the supplied URLs and downloads video media found on those pages.

## Prerequisites

* Node.js 20 or newer.
* `ffmpeg` must be in the path if you want to download HLS/DASH streams. If `ffmpeg` is missing, the script still works for direct MP4/MP3 files.

## Install

```bash
npm install
```

## Usage

```bash
# Scan a list of URLs and download found media
node scan-videos.js https://example.com/video-page https://another.com

# Scan URLs and only print downloadable media links (no file download)
node scan-videos.js --link-only https://example.com/video-page

# Cap non-Instagram media selection to 720p
node scan-videos.js --max-quality 720 https://example.com/video-page

# Open a browser so you can log in and manually interact with a page
node scan-videos.js open-browser

# Open the configured profile for a named account
node scan-videos.js open-browser --account work
```

All downloaded files are saved to the `media/` folder in the current working directory.

---

The script is intentionally lightweight – only the command line is documented here.

## Multiple account profiles

Each named account uses a separate persistent browser user-data directory, so its website logins stay separate. Configure accounts and saved lists in `.saved-sync-state.json`:

```json
{
  "config": {
    "accounts": [
      {
        "name": "personal",
        "userDataDir": "/data/browser/personal",
        "profileDir": "Default"
      },
      {
        "name": "work",
        "userDataDir": "/data/browser/work",
        "profileDir": "Default"
      }
    ],
    "savedLists": [
      {
        "url": "https://www.instagram.com/username/saved/list/123/",
        "folder": "favorites",
        "account": "personal"
      }
    ]
  },
  "lists": {}
}
```

Log in to each profile with `node scan-videos.js open-browser --account personal`. Use the same `--account` option for a CLI scan. API `/download` requests always use the default profile; only `/scan-saved` selects the named account from its request. The saved-download sync daemon sends each list's `account` to `/scan-saved`, which keeps one CloakBrowser instance per active account.

## Run in Docker (API server + frontend)

This repo includes a Docker setup that runs the API server and serves `index.html` at `/`.

```bash
docker compose up --build
```

Then open:

- `http://localhost:3001` for the frontend UI
- `http://localhost:3001/health` for health checks

Downloads are saved to `./media` on your host.

## Timeout and stuck-job safety

To reduce the chance of the API becoming stuck on one long-running job, the server and downloader use safety timeouts.

- `API_JOB_TIMEOUT_MS` (default: `1800000`) - max API job runtime before the browser used by that job is recycled.
- `DOWNLOAD_FETCH_TIMEOUT_MS` (default: `300000`) - max duration for direct media/manifest HTTP fetch requests.
- `FFMPEG_TIMEOUT_MS` (default: `900000`) - max runtime for ffmpeg download/mux commands.
- `FFPROBE_TIMEOUT_MS` (default: `120000`) - max runtime for ffprobe audio detection.
- `INSTAGRAM_429_COOLDOWN_MS` (default: `300000`) - cooldown wait after Instagram 429 before suspending the current run.
- `SAVED_SYNC_DOWNLOAD_DELAY_MS` (default: `20000`) - delay between `/download` requests in `sync-saved-downloads.js`.
- `sync-saved-downloads.js` now exits immediately on 429 so the sync container stops and can be retried later.

If a job times out, the current request fails and the browser is restarted automatically so new requests can run.

## CloakBrowser inside Docker

CloakBrowser provides the stealth Chromium binary used by the CLI and API. It is a Puppeteer-compatible replacement, so the scanner keeps its existing page, network-capture, and cookie-transfer flow.

- API mode runs the browser headless by default.
- On its first launch, CloakBrowser downloads its binary to `CLOAKBROWSER_CACHE_DIR` (default: `~/.cloakbrowser`). Docker sets this to `/data/cloakbrowser` and persists it in the `cloakbrowser-cache` volume, so recreating the app container does not download the binary again.
- Set `CLOAKBROWSER_BINARY_PATH` to use a preinstalled binary. `BROWSER_PATH` is still accepted as a deprecated alias.
- For interactive browser login (`open-browser`), enable VNC/noVNC and run the command in an interactive container:

```bash
npm run docker-open-browser
```

While it runs, open `http://localhost:7901/vnc.html` to see and control the browser. The normal Compose service is available at `http://localhost:7906/vnc.html`, and its API is at `http://localhost:7866`.
You can log in to websites there, and session/profile data is kept in the named volume `browser-data`.
