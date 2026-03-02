# SCrawler Media Downloader

Use `SCrawler` to surface media assets from a website, pick one (or all) interactively, and download it into a local `media/` folder.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Usage

```bash
python scrawler_media_cli.py https://example.com
```

### Flags

- `--max-urls`: limit how many pages SCrawler visits (default `15`).
- `--parallel`: number of concurrent workers (default `4`).
- `--timeout`: timeout in seconds for each download (default `30`).
- `--dest`: directory to store downloads (default `media`).
- `--verbose`: print SCrawler progress and download errors.

Once the crawl finishes the CLI prints every media URL it found and waits for your input. You can type an index to download that item, `all` to grab everything, or `q` to exit without downloading.
