"""Core data model: the platform-agnostic RawVideo, the ranked ScoredVideo, and the
per-video `brief.json` schema (plain dicts — kept schema-light and JSON-native on purpose
so it's trivial to inspect/edit by hand while iterating).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

SCHEMA_VERSION = "1.0"

# Video lifecycle. Each stage of the pipeline checks brief["status"] (plus file
# existence) before doing work, so re-running a pipeline is cheap and idempotent.
STATUS_ORDER = [
    "discovered",
    "downloaded",
    "transcribed",
    "ocr_done",
    "visual_pending",
    "visual_done",
    "complete",
    "error",
]


@dataclass
class RawVideo:
    """What a platform module returns from discovery, before ranking/scoring."""

    platform: str
    video_id: str
    url: str
    author_handle: str
    author_name: str
    caption: str
    hashtags: list[str]
    posted_at: datetime  # timezone-aware UTC
    duration_sec: float | None
    thumbnail_url: str | None
    music_track: str | None
    views: int
    likes: int
    comments: int
    shares: int
    data_completeness: str  # "full" | "partial" — set to "partial" if a platform can't expose a field (e.g. no shares)
    direct_media_url: str | None = None  # if the platform actor already hands back a downloadable URL
    top_comments: list[str] = field(default_factory=list)  # a few verbatim top comments, when available —
    # engagement *texture* (relatable/funny vs. questions vs. confused) that a raw count can't tell you
    raw: dict[str, Any] = field(default_factory=dict)  # original API payload, kept for debugging


@dataclass
class ScoredVideo:
    raw: RawVideo
    engagement_rate: float
    views_per_day: float
    recency_weight: float
    raw_score: float
    composite_score: float  # normalized within the platform's candidate pool, [0, 1]
    rank_within_platform: int


def new_brief(video: ScoredVideo, run_id: str) -> dict[str, Any]:
    """Build the initial brief.json content for a freshly-selected video."""
    r = video.raw
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "platform": r.platform,
        "video_id": r.video_id,
        "url": r.url,
        "status": "discovered",
        "error": None,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "metadata": {
            "author_handle": r.author_handle,
            "author_name": r.author_name,
            "caption": r.caption,
            "hashtags": r.hashtags,
            "posted_at": r.posted_at.isoformat(),
            "duration_sec": r.duration_sec,
            "thumbnail_url": r.thumbnail_url,
            "music_track": r.music_track,
            "stats": {
                "views": r.views,
                "likes": r.likes,
                "comments": r.comments,
                "shares": r.shares,
                "data_completeness": r.data_completeness,
            },
            "top_comments": r.top_comments,
        },
        "ranking": {
            "raw_score": video.raw_score,
            "composite_score": video.composite_score,
            "engagement_rate": video.engagement_rate,
            "views_per_day": video.views_per_day,
            "recency_weight": video.recency_weight,
            "rank_within_platform": video.rank_within_platform,
        },
        "media": {
            "direct_media_url": r.direct_media_url,
            "video_path": None,
            "audio_path": None,
            "downloaded_via": None,
            "kept_on_disk": False,
        },
        "transcript": {
            "source": None,
            "language": None,
            "full_text": None,
            "segments": [],
        },
        "on_screen_text": {
            "segments": [],
            "full_text_concat": None,
        },
        "visual_analysis": {
            "status": "pending",
            "keyframe_paths": [],
            "title": None,  # short quotable title capturing the hook/theme, e.g. "USA reveal"
            "what_its_about": None,  # 1-3 plain sentences describing what the video shows
            "format_archetype": None,  # short categorical tag, e.g. "styling tutorial",
            # "outfit reveal", "day-in-the-life" — lets a report group "which formats work" instead
            # of burying the pattern in free-text notes
            "hook_first_3_sec": None,
            "shot_composition": None,
            "lighting": None,
            "pacing_editing_style": None,
            "wardrobe_style_setting": None,
            "on_screen_graphics_style": None,
            "overall_notes": None,
            "read": None,  # 1-2 sentence actionable takeaway: why it performed the way it did
            "filled_by": None,
            "filled_at": None,
        },
    }
