"""TikTok discovery via Apify's Clockworks "TikTok Scraper" actor (clockworks/tiktok-scraper).

Managed/hosted scraping — not the official TikTok API (no commercial-use official option
exists for this use case; see the scraper research report). Free tier: $5/month Apify
platform credit, which comfortably covers 50-300 videos/week at this actor's per-result rate.

NOTE: Apify actor input/output schemas do drift over time (as our research found -
yt-dlp's own TikTok extractor broke in Aug 2026 from a platform-side change). This module
resolves several possible output field names defensively rather than assuming one exact
shape; if Apify changes the actor again, update `_first_present` lookups here rather than
touching the rest of the pipeline.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from content_scout.config import Settings
from content_scout.models import RawVideo
from content_scout.platforms.base import register

ACTOR_ID = "clockworks/tiktok-scraper"


def _first_present(item: dict[str, Any], *dotted_paths: str) -> Any:
    """Return the first non-None value found by walking dotted paths like 'videoMeta.downloadAddr'."""
    for path in dotted_paths:
        node: Any = item
        for key in path.split("."):
            if isinstance(node, dict):
                node = node.get(key)
            else:
                node = None
                break
        if node not in (None, ""):
            return node
    return None


def discover(niche: str, settings: Settings, since_days: int, limit: int) -> list[RawVideo]:
    try:
        from apify_client import ApifyClient
    except ImportError as exc:  # pragma: no cover
        raise ImportError(
            "apify-client is required for TikTok discovery. "
            "Install it with: pip install --break-system-packages -r requirements.txt"
        ) from exc

    token = settings.require_apify()
    client = ApifyClient(token)

    run_input = {
        "searchQueries": [niche],
        "resultsPerPage": max(limit, 1),
        "shouldDownloadVideos": True,
        "shouldDownloadSubtitles": True,
        "shouldDownloadCovers": False,
        "shouldDownloadAvatars": False,
        "shouldDownloadMusicCovers": False,
        "excludePinnedPosts": True,
        "proxyCountryCode": "None",
    }
    run = client.actor(ACTOR_ID).call(run_input=run_input)
    dataset_id = run["defaultDatasetId"]

    cutoff = datetime.now(timezone.utc).timestamp() - since_days * 86400
    results: list[RawVideo] = []
    for item in client.dataset(dataset_id).iterate_items():
        video_id = str(_first_present(item, "id", "videoId") or "")
        if not video_id:
            continue

        created_iso = item.get("createTimeISO")
        if created_iso:
            posted_at = datetime.fromisoformat(created_iso.replace("Z", "+00:00"))
        else:
            create_time = item.get("createTime")
            posted_at = (
                datetime.fromtimestamp(int(create_time), tz=timezone.utc)
                if create_time
                else datetime.now(timezone.utc)
            )
        if posted_at.timestamp() < cutoff:
            continue

        author_meta = item.get("authorMeta", {}) or {}
        music_meta = item.get("musicMeta", {}) or {}
        hashtags_raw = item.get("hashtags", []) or []
        hashtags = [
            (h["name"] if isinstance(h, dict) else str(h)).lstrip("#").lower() for h in hashtags_raw
        ]

        direct_url = _first_present(
            item, "videoMeta.downloadAddr", "downloadAddr", "videoUrl", "mediaUrls.0"
        )
        page_url = _first_present(item, "webVideoUrl") or f"https://www.tiktok.com/@{author_meta.get('name', '')}/video/{video_id}"

        results.append(
            RawVideo(
                platform="tiktok",
                video_id=video_id,
                url=page_url,
                author_handle=author_meta.get("name", ""),
                author_name=author_meta.get("nickName", author_meta.get("name", "")),
                caption=item.get("text", "") or "",
                hashtags=sorted(set(hashtags)),
                posted_at=posted_at,
                duration_sec=(item.get("videoMeta", {}) or {}).get("duration"),
                thumbnail_url=_first_present(item, "videoMeta.coverUrl", "covers.0"),
                music_track=(
                    f"{music_meta.get('musicName', '')} — {music_meta.get('musicAuthor', '')}".strip(" —")
                    or None
                ),
                views=int(item.get("playCount", 0) or 0),
                likes=int(item.get("diggCount", 0) or 0),
                comments=int(item.get("commentCount", 0) or 0),
                shares=int(item.get("shareCount", 0) or 0),
                data_completeness="full",
                direct_media_url=direct_url,
                raw=item,
            )
        )
    return results


register("tiktok", discover)
