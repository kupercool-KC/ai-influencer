"""Instagram discovery via a real headless browser (Playwright), not the Apify actor.

HISTORY: this originally used Apify's "Instagram Scraper" actor (automation-lab/instagram-
scraper), first via its no-login hashtag-search mode, then (2026-09-14) via its no-login
profile/posts mode after hashtag search started requiring a session cookie. On the same day,
even the no-login `posts` mode started failing outright — the actor logged "Instagram now
requires authentication for most API endpoints" and every fallback strategy it tried failed.
That's a platform-side lockdown on Apify's specific scraping approach, not something our
integration code could route around.

A real browser (headless Chromium via Playwright) still sees these public pages fine, because
it renders exactly like a logged-out visitor would — same posture as the Apify integration's
original design goal (public, logged-out access only; no `sessionCookie` / login, since that
trades this into the higher account-ban-exposed tier per the scraper research). `niche` is a
comma-separated list of Instagram usernames (or full profile URLs) to pull recent posts from —
account-based, not a hashtag/keyword search (Instagram's hashtag search itself now requires
login regardless of tool).

Known limits of this approach:
- No view count without login — Instagram's public post page shows Like/Comment/Share action
  buttons with counts next to them, but no play-count badge on this page layout (that only
  shows in the app's own Reels feed UI). `data_completeness` is "partial" for that reason.
- Like/comment counts are read from the same UI text that renders next to the (login-gated)
  Like/Comment icons — e.g. "Like42KComment328Share" — parsed via those icons' aria-labels
  since Instagram's own CSS classes are auto-generated and carry no stable meaning. If
  Instagram relabels those icons (unlikely, but possible), `_extract_counts` below is where
  to fix it.
- The captured video URL is the last `video/mp4` network response seen while the post page
  loads, which in practice is the rendition the page actually chose to play — not guaranteed
  to always be the single highest-quality URL if Instagram's page behavior changes.
- Public IG pages are template A/B tested; if profile/post markup changes enough that link or
  meta-tag selectors below stop matching, update the CSS selectors here rather than the rest
  of the pipeline (same "isolate drift in this file" pattern as tiktok.py's `_first_present`).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from content_scout.config import Settings
from content_scout.models import RawVideo
from content_scout.platforms.base import register

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"
)
POST_LINK_SELECTOR = "a[href*='/reel/'], a[href*='/p/']"
VIDEO_ID_RE = re.compile(r"/(?:p|reel)/([^/]+)/?")
HASHTAG_RE = re.compile(r"#(\w+)")


def _parse_accounts(niche: str) -> tuple[list[str], list[str]]:
    """Split the comma-separated `niche` value into usernames and full profile URLs."""
    usernames: list[str] = []
    urls: list[str] = []
    for token in niche.split(","):
        token = token.strip()
        if not token:
            continue
        if token.startswith("http://") or token.startswith("https://"):
            urls.append(token.rstrip("/"))
        else:
            usernames.append(token.lstrip("@"))
    return usernames, urls


def _clean_caption(og_description: str | None, og_title: str | None) -> str:
    """og:description looks like `noonoouri on August 30, 2026: "caption text".` — strip the
    prefix and surrounding quotes to get just the caption."""
    text = og_description or og_title or ""
    match = re.search(r':\s*"(.*)"\.?\s*$', text)
    return match.group(1) if match else text


def _parse_count(text: str | None) -> int:
    """Turn Instagram's abbreviated counts ("42K", "1.2M", "328") into an int."""
    if not text:
        return 0
    text = text.strip().replace(",", "")
    multiplier = 1
    if text[-1] in ("K", "M"):
        multiplier = 1_000 if text[-1] == "K" else 1_000_000
        text = text[:-1]
    try:
        return int(float(text) * multiplier)
    except ValueError:
        return 0


def _extract_counts(page: Any) -> tuple[int, int]:
    """Read like/comment counts from the action-bar text next to the Like/Comment/Share
    icons (present on the public page even though clicking them requires login)."""
    container_text = page.evaluate(
        """
        () => {
          const shareSvg = document.querySelector('svg[aria-label="Share"]');
          const container = shareSvg?.closest('div')?.parentElement;
          return container ? container.textContent : null;
        }
        """
    )
    if not container_text:
        return 0, 0
    match = re.search(r"Like([\d.,]+[KM]?)Comment([\d.,]+[KM]?)Share", container_text)
    if not match:
        return 0, 0
    return _parse_count(match.group(1)), _parse_count(match.group(2))


def _strip_byte_range(video_url: str) -> str:
    """Instagram serves reel video as chunked byte-range requests (a page load captures many
    overlapping `bytestart`/`byteend` fragments of the same asset, not separate qualities).
    Dropping those params gets the full file from a plain GET instead of one small chunk."""
    parts = urlsplit(video_url)
    query = [(k, v) for k, v in parse_qsl(parts.query) if k not in ("bytestart", "byteend")]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


def _extract_post(page: Any, url: str, cutoff_ts: float) -> RawVideo | None:
    video_urls: list[str] = []

    def on_response(response: Any) -> None:
        ct = response.headers.get("content-type", "")
        if "video/mp4" in ct or response.url.endswith(".mp4"):
            video_urls.append(response.url)

    page.on("response", on_response)
    try:
        page.goto(url, wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(1500)
    finally:
        page.remove_listener("response", on_response)

    if not video_urls:
        return None  # image-only post — this pipeline is about video content specifically

    def meta(prop: str) -> str | None:
        el = page.query_selector(f"meta[property='{prop}']")
        return el.get_attribute("content") if el else None

    time_el = page.query_selector("time")
    posted_iso = time_el.get_attribute("datetime") if time_el else None
    posted_at = (
        datetime.fromisoformat(posted_iso.replace("Z", "+00:00"))
        if posted_iso
        else datetime.now(timezone.utc)
    )
    if posted_at.timestamp() < cutoff_ts:
        return None

    match = VIDEO_ID_RE.search(url)
    video_id = match.group(1) if match else url

    og_title = meta("og:title")
    caption = _clean_caption(meta("og:description"), og_title)
    author_handle = (og_title or "").split(" on Instagram")[0].strip() or (og_title or "")
    likes, comments = _extract_counts(page)

    return RawVideo(
        platform="instagram",
        video_id=video_id,
        url=url,
        author_handle=author_handle,
        author_name=author_handle,
        caption=caption,
        hashtags=sorted(set(h.lower() for h in HASHTAG_RE.findall(caption))),
        posted_at=posted_at,
        duration_sec=None,  # not exposed on the logged-out post page
        thumbnail_url=meta("og:image"),
        music_track=None,  # not exposed on the logged-out post page
        views=0,  # no play-count badge on this page layout, even logged out
        likes=likes,
        comments=comments,
        shares=0,  # never exposed publicly by Instagram
        data_completeness="partial",  # views/shares missing
        direct_media_url=_strip_byte_range(video_urls[-1]),
        raw={"post_url": url, "captured_video_urls": video_urls},
    )


def discover(niche: str, settings: Settings, since_days: int, limit: int) -> list[RawVideo]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover
        raise ImportError(
            "playwright is required for Instagram discovery. Install it with: "
            "pip install playwright && python -m playwright install chromium"
        ) from exc

    usernames, direct_urls = _parse_accounts(niche)
    if not usernames and not direct_urls:
        raise ValueError(
            "Instagram discovery needs account handles or profile URLs, not a free-text "
            "niche (Instagram's own hashtag search now requires a login we deliberately don't "
            "use). Pass --niche as a comma-separated list, e.g. --niche 'lilmiquela,noonoouri'."
        )

    cutoff = datetime.now(timezone.utc).timestamp() - since_days * 86400
    accounts = usernames + direct_urls
    per_account_limit = max(1, -(-limit // len(accounts)))  # ceil division

    results: list[RawVideo] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(user_agent=USER_AGENT)
        page = context.new_page()
        try:
            for account in accounts:
                profile_url = account if account.startswith("http") else f"https://www.instagram.com/{account}/"
                page.goto(profile_url, wait_until="networkidle", timeout=30000)
                page.wait_for_timeout(1500)
                hrefs: list[str] = page.eval_on_selector_all(
                    POST_LINK_SELECTOR, "els => [...new Set(els.map(e => e.href))]"
                )
                for href in hrefs[:per_account_limit]:
                    try:
                        video = _extract_post(page, href, cutoff)
                    except Exception:
                        continue  # one bad post shouldn't sink the whole account/run
                    if video:
                        results.append(video)
                    if len(results) >= limit:
                        break
                if len(results) >= limit:
                    break
        finally:
            browser.close()
    return results


register("instagram", discover)
