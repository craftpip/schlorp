#!/usr/bin/env python3
"""Crawl a website for media and offer download choices."""

from __future__ import annotations

import argparse
import logging
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, List, Mapping, Optional
from urllib.parse import urljoin, urlparse

import requests
from scrawler import Crawler
from scrawler.attributes import CrawlingAttributes, SearchAttributes
from scrawler.data_extractors import BaseExtractor
from scrawler.utils.web_utils import is_media_file
from scrawler.website import Website
from bs4 import Tag

MEDIA_TAGS = ("img", "video", "audio", "source", "a")
MEDIA_ATTRIBUTES = ("src", "data-src", "data-original", "data-video", "data-srcset", "srcset", "href")


@dataclass
class MediaCandidate:
    """Represent a media asset discovered while crawling."""

    media_url: str
    page_url: str
    tag: str
    attribute: str
    context: Optional[str]


def _coerce_to_string(value: Any) -> str:
    if isinstance(value, (list, tuple, set)):
        return " ".join(str(item) for item in value)
    return str(value)


def _render_context(tag: Tag) -> Optional[str]:
    for field in ("alt", "title"):
        raw = tag.get(field)
        if raw is not None:
            text = _coerce_to_string(raw).strip()
            if text:
                return text

    text = tag.get_text(strip=True)
    if isinstance(text, str) and text:
        return text
    return None


class MediaExtractor(BaseExtractor):
    """Collect every media URL that appears inside a discovered page."""

    def __init__(self, *, tag_names: Iterable[str] = MEDIA_TAGS,
                 attr_candidates: Iterable[str] = MEDIA_ATTRIBUTES, **kwargs) -> None:
        super().__init__(**kwargs)
        self.tag_names = tuple(tag_names)
        self.attr_candidates = tuple(attr_candidates)

    def run(self, website: Website, index: int | None = None) -> List[MediaCandidate]:
        seen: set[str] = set()
        entries: List[MediaCandidate] = []

        for tag_name in self.tag_names:
            for tag in website.find_all(tag_name):
                for attr in self.attr_candidates:
                    value = tag.get(attr)
                    if value is None:
                        continue

                    for excerpt in self._extract_urls(value, attr):
                        normalized = excerpt.strip()
                        if not normalized:
                            continue

                        if normalized.startswith("data:"):
                            continue

                        resolved = urljoin(website.url, normalized)
                        parsed = urlparse(resolved)
                        if parsed.scheme not in {"http", "https"}:
                            continue

                        if resolved in seen:
                            continue

                        if tag_name not in {"img", "video", "audio", "source"}:
                            if not is_media_file(resolved):
                                continue

                        context = _render_context(tag)
                        seen.add(resolved)
                        entries.append(MediaCandidate(media_url=resolved,
                                                       page_url=website.url,
                                                       tag=tag_name,
                                                       attribute=attr,
                                                       context=context))

        return entries

    def _extract_urls(self, raw_value: Any, attr_name: str) -> List[str]:
        chunk = _coerce_to_string(raw_value)
        if attr_name == "srcset":
            segments = [part.strip() for part in chunk.split(",")]
            return [segment.split()[0] for segment in segments if segment]
        return [chunk]


def gather_media(url: str, max_urls: int, parallel: int, timeout: int,
                 respect_robots_txt: bool) -> List[MediaCandidate]:
    """Run SCrawler on ``url`` and return every media candidate it discovers."""

    logging.info("Starting crawl of %s (limit %s URLs).", url, max_urls)
    extractor = MediaExtractor()
    search_attrs = SearchAttributes(extractor)
    crawling_attrs = CrawlingAttributes(filter_media_files=False,
                                        max_no_urls=max_urls,
                                        respect_robots_txt=respect_robots_txt)
    crawler = Crawler(urls=url,
                      search_attributes=search_attrs,
                      crawling_attributes=crawling_attrs,
                      parallel_processes=parallel)

    try:
        data = crawler.run()
    except Exception as exc:  # pragma: no cover - best effort
        logging.error("Crawl failed: %s", exc)
        return []
    found: List[MediaCandidate] = []

    if not data:
        return found

    for domain in data:
        if not domain:
            continue
        for page in domain:
            if not page or not page[0]:
                continue
            page_candidates = page[0]
            for candidate in page_candidates:
                found.append(candidate)

    logging.info("Crawl finished and %s media candidates collected.", len(found))
    return found


def derive_filename(url: str, headers: Mapping[str, str]) -> str:
    """Derive a safe filename from the URL and HTTP headers."""

    parsed = urlparse(url)
    name = Path(parsed.path).name
    if not name:
        name = "media"

    content_type = headers.get("content-type")
    if "." not in name and content_type:
        extension = mimetypes.guess_extension(content_type.split(";", 1)[0].strip())
        if extension:
            name = f"{name}{extension}"

    return name


def download(candidate: MediaCandidate, dest_dir: Path, session: requests.Session, timeout: int) -> Path:
    """Download one media file into ``dest_dir``."""

    response = session.get(candidate.media_url, timeout=timeout, stream=True)
    response.raise_for_status()

    dest_dir.mkdir(parents=True, exist_ok=True)
    filename = derive_filename(candidate.media_url, response.headers)
    output_path = dest_dir / filename
    counter = 1
    while output_path.exists():
        stem = output_path.stem
        suffix = output_path.suffix
        output_path = dest_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    with output_path.open("wb") as handle:
        for chunk in response.iter_content(chunk_size=8192):
            if chunk:
                handle.write(chunk)

    logging.info("Saved %s", output_path)
    return output_path


def prompt_choice(media: List[MediaCandidate]) -> List[MediaCandidate]:
    """Print discovered media and ask the user which ones to download."""

    for index, candidate in enumerate(media, start=1):
        label = f"[{index}] {candidate.media_url}"
        context = f" (from {candidate.page_url})" if candidate.page_url else ""
        detail = f" tag={candidate.tag} attr={candidate.attribute}"
        print(f"{label}{context}{detail}")

    if not media:
        return []

    prompt = "Enter number to download, 'all' to grab every item, or 'q' to quit: "
    while True:
        response = input(prompt).strip().lower()
        if not response:
            continue
        if response in {"q", "quit", "exit"}:
            return []
        if response == "all":
            return media

        try:
            index = int(response)
        except ValueError:
            print("Pick a valid number or 'all'.")
            continue

        if 1 <= index <= len(media):
            return [media[index - 1]]

        print("Index out of range.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Crawl a website for media assets and download them.")
    parser.add_argument("url", help="Start URL to crawl.")
    parser.add_argument("--max-urls", type=int, default=15, help="Maximum number of URLs to visit.")
    parser.add_argument("--parallel", type=int, default=4, help="SCrawler parallelism level.")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout for downloads in seconds.")
    parser.add_argument("--dest", type=Path, default=Path("media"), help="Directory to store downloads.")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging.")
    parser.add_argument("--ignore-robots", action="store_true",
                        help="Ignore robots.txt when crawling (use cautiously).")

    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                        format="[%(levelname)s] %(message)s")

    candidates = gather_media(args.url, args.max_urls, args.parallel, args.timeout,
                               respect_robots_txt=not args.ignore_robots)
    if not candidates:
        print("No media was discovered during the crawl.")
        return

    selection = prompt_choice(candidates)
    if not selection:
        print("No download selected.")
        return

    session = requests.Session()
    successes: List[Path] = []
    for candidate in selection:
        try:
            successes.append(download(candidate, args.dest, session, args.timeout))
        except requests.RequestException as exc:
            logging.error("Failed to download %s: %s", candidate.media_url, exc)

    if successes:
        print("Downloaded:")
        for path in successes:
            print(path)
    else:
        print("No files were downloaded.")


if __name__ == "__main__":
    main()
