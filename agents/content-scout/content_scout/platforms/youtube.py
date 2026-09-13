"""YouTube discovery via the official YouTube Data API v3 (search.list + videos.list).

Compliant/official path — no scraping. Free quota: 10,000 units/day; search.list costs
100 units/call, videos.list ~1-7 units per call depending on parts requested, so a single
discovery run (1 search + 1-2 videos.list batch calls) costs well under 1% of the daily quota.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from content_scout.config import Settings
from content_scout.models import RawVideo
from content_scout.platforms.base import register

_ISO8601_DURATION_RE = re.compile(
    r"P(?:(?P<days>\d+)D)?T?(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?"
)


def _parse_iso8601_duration(value: str) -> float | None:
    """Parse an ISO 8601 duration like 'PT1M30S' into seconds. Returns None if unparseable."""
    match = _ISO8601_DURATION_RE.fullmatch(value or "")
    if not match:
        return None
    parts = {k: int(v) for k, v in match.groupdict(default="0").items()}
    return parts["days"] * 86400 + parts["hours"] * 3600 + parts["minutes"] * 60 + parts["seconds"]


def discover(niche: str, settings: Settings, since_days: int, limit: int) -> list[RawVideo]:
    try:
        from googleapiclient.discovery import build
    except ImportError as exc:  # pragma: no cover
        raise ImportError(
            "google-api-python-client is required for YouTube discovery. "
            "Install it with: pip install --break-system-packages -r requirements.txt"
        ) from exc

    api_key = settings.require_youtube()
    youtube = build("youtube", "v3", developerKey=api_key, cache_discovery=False)

    published_after = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )

    # search.list: sorted by viewCount so we're already biased toward high-traffic content
    # within the recency window, then we re-rank precisely with ranking.py using real stats.
    search_resp = (
        youtube.search()
        .list(
            part="id",
            q=niche,
            type="video",
            order="viewCount",
            publishedAfter=published_after,
            maxResults=min(limit, 50),
            safeSearch="moderate",
        )
        .execute()
    )
    video_ids = [item["id"]["videoId"] for item in search_resp.get("items", []) if item.get("id", {}).get("videoId")]
    if not video_ids:
        return []

    videos_resp = (
        youtube.videos()
        .list(part="snippet,statistics,contentDetails", id=",".join(video_ids))
        .execute()
    )

    results: list[RawVideo] = []
    for item in videos_resp.get("items", []):
        snippet = item.get("snippet", {})
        stats = item.get("statistics", {})
        content_details = item.get("contentDetails", {})
        video_id = item["id"]

        posted_at_raw = snippet.get("publishedAt")
        posted_at = (
            datetime.fromisoformat(posted_at_raw.replace("Z", "+00:00"))
            if posted_at_raw
            else datetime.now(timezone.utc)
        )

        description = snippet.get("description", "") or ""
        hashtags = re.findall(r"#(\w+)", description) + re.findall(r"#(\w+)", snippet.get("title", ""))

        # YouTube's public API doesn't expose "shares"; comments may be disabled (missing field).
        has_comments = "commentCount" in stats
        results.append(
            RawVideo(
                platform="youtube",
                video_id=video_id,
                url=f"https://www.youtube.com/watch?v={video_id}",
                author_handle=snippet.get("channelTitle", ""),
                author_name=snippet.get("channelTitle", ""),
                caption=snippet.get("title", "") + ("\n\n" + description if description else ""),
                hashtags=sorted(set(h.lower() for h in hashtags)),
                posted_at=posted_at,
                duration_sec=_parse_iso8601_duration(content_details.get("duration", "")),
                thumbnail_url=(snippet.get("thumbnails", {}).get("high", {}) or {}).get("url"),
                music_track=None,
                views=int(stats.get("viewCount", 0)),
                likes=int(stats.get("likeCount", 0)) if "likeCount" in stats else 0,
                comments=int(stats.get("commentCount", 0)) if has_comments else 0,
                shares=0,
                data_completeness="partial",  # no shares field on YouTube's public API
                direct_media_url=None,  # downloaded via yt-dlp, not a direct URL
                raw=item,
            )
        )
    return results


register("youtube", discover)
