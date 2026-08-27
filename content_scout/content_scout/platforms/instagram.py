"""Instagram discovery via Apify's "Instagram Scraper" actor (automation-lab/instagram-scraper).

Uses public hashtag-post routes (no login/session cookie), which is both the cheaper and the
lower-legal-risk path per the research (Meta v. Bright Data: logged-out public scraping does
not breach Meta's contract-based ToS the way an authenticated session would). We deliberately
do NOT set `sessionCookie` here — that trades this into the higher-risk, account-ban-exposed
tier, which isn't needed for a hashtag/keyword discovery use case.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from content_scout.config import Settings
from content_scout.models import RawVideo
from content_scout.platforms.base import register

ACTOR_ID = "automation-lab/instagram-scraper"


def _tag_niche(niche: str) -> str:
    """Turn a free-text niche into a single hashtag-search-friendly token."""
    return "".join(ch for ch in niche if ch.isalnum())


def discover(niche: str, settings: Settings, since_days: int, limit: int) -> list[RawVideo]:
    try:
        from apify_client import ApifyClient
    except ImportError as exc:  # pragma: no cover
        raise ImportError(
            "apify-client is required for Instagram discovery. "
            "Install it with: pip install --break-system-packages -r requirements.txt"
        ) from exc

    token = settings.require_apify()
    client = ApifyClient(token)

    run_input = {
        "mode": "hashtagPosts",
        "hashtags": [_tag_niche(niche)],
        "maxPosts": max(limit, 1),
    }
    run = client.actor(ACTOR_ID).call(run_input=run_input)
    dataset_id = run["defaultDatasetId"]

    cutoff = datetime.now(timezone.utc).timestamp() - since_days * 86400
    results: list[RawVideo] = []
    for item in client.dataset(dataset_id).iterate_items():
        video_id = str(item.get("id") or item.get("shortCode") or "")
        if not video_id:
            continue
        # Skip static image posts — this pipeline is about video content specifically.
        video_url = item.get("videoUrl")
        if not video_url:
            continue

        timestamp_raw = item.get("timestamp")
        posted_at = (
            datetime.fromisoformat(timestamp_raw.replace("Z", "+00:00"))
            if timestamp_raw
            else datetime.now(timezone.utc)
        )
        if posted_at.timestamp() < cutoff:
            continue

        music_info = item.get("musicInfo") or {}
        music_track = None
        if music_info:
            music_track = f"{music_info.get('songName', '')} — {music_info.get('artistName', '')}".strip(" —") or None

        views = item.get("videoViewCount") or item.get("videoPlayCount") or 0

        results.append(
            RawVideo(
                platform="instagram",
                video_id=video_id,
                url=item.get("url") or f"https://www.instagram.com/reel/{item.get('shortCode', video_id)}/",
                author_handle=item.get("ownerUsername", ""),
                author_name=item.get("ownerFullName", item.get("ownerUsername", "")),
                caption=item.get("caption", "") or "",
                hashtags=sorted(set((item.get("hashtags") or []))),
                posted_at=posted_at,
                duration_sec=item.get("videoDuration"),
                thumbnail_url=item.get("displayUrl"),
                music_track=music_track,
                views=int(views or 0),
                likes=int(item.get("likesCount", 0) or 0),
                comments=int(item.get("commentsCount", 0) or 0),
                shares=0,  # not exposed by this actor
                data_completeness="partial",  # no shares field
                direct_media_url=video_url,
                raw=item,
            )
        )
    return results


register("instagram", discover)
