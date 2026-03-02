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

# Open a browser so you can log in and manually interact with a page
node scan-videos.js open-browser
```

All downloaded files are saved to the `media/` folder in the current working directory.

---

The script is intentionally lightweight – only the command line is documented here.

