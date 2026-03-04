# scan‑videos

A small command‑line utility that opens a browser, visits the supplied URLs and downloads video media found on those pages.

## Prerequisites

* Node.js 18 or newer.
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
```

All downloaded files are saved to the `media/` folder in the current working directory.

---

The script is intentionally lightweight – only the command line is documented here.

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

- `API_JOB_TIMEOUT_MS` (default: `1800000`) - max API job runtime before the shared browser is recycled.
- `DOWNLOAD_FETCH_TIMEOUT_MS` (default: `300000`) - max duration for direct media/manifest HTTP fetch requests.
- `FFMPEG_TIMEOUT_MS` (default: `900000`) - max runtime for ffmpeg download/mux commands.
- `FFPROBE_TIMEOUT_MS` (default: `120000`) - max runtime for ffprobe audio detection.
- `INSTAGRAM_DOWNLOAD_DELAY_MS` (default: `20000`) - delay between Instagram media download requests.

If a job times out, the current request fails and the browser is restarted automatically so new requests can run.

## Chrome inside Docker

Yes — Chrome (Chromium) is installed in the container.

- API mode runs Chrome headless by default.
- For interactive browser login (`open-browser`), enable VNC/noVNC and run the command in an interactive container:

```bash
npm run docker-open-browser
```

While it runs, open `http://localhost:7901/vnc.html` to see and control the browser.
You can log in to websites there, and session/profile data is kept in the named volume `chrome-data`.
