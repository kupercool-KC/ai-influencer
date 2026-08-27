"""Composite traffic/engagement ranking.

Computed *within a single platform's candidate pool only* — raw scores are not meant to be
compared across platforms, since each platform's algorithm and audience size behave too
differently for that to be meaningful. What IS comparable across platforms is each video's
`rank_within_platform` and `composite_score` (both pool-relative).

Formula (see plan for rationale):
    engagement_points = likes + 3*comments + 5*shares
    engagement_rate    = engagement_points / max(views, 1)
    views_per_day       = views / max(days_since_posted, 0.5)
    recency_weight      = 0.5 ** (days_since_posted / half_life_days)
    raw_score            = log10(views_per_day + 1) * (1 + engagement_rate) * recency_weight
    composite_score     = min-max normalized raw_score within the pool, in [0, 1]
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

from content_scout.models import RawVideo, ScoredVideo

DEFAULT_HALF_LIFE_DAYS = 30.0


def _days_since(posted_at: datetime, now: datetime | None = None) -> float:
    now = now or datetime.now(timezone.utc)
    delta = now - posted_at
    return max(delta.total_seconds() / 86400.0, 0.0)


def score_video(video: RawVideo, half_life_days: float, now: datetime | None = None) -> ScoredVideo:
    days = max(_days_since(video.posted_at, now), 0.5)
    engagement_points = video.likes + 3 * video.comments + 5 * video.shares
    engagement_rate = engagement_points / max(video.views, 1)
    views_per_day = video.views / days
    recency_weight = 0.5 ** (days / half_life_days) if half_life_days > 0 else 1.0
    raw_score = math.log10(views_per_day + 1) * (1 + engagement_rate) * recency_weight

    return ScoredVideo(
        raw=video,
        engagement_rate=engagement_rate,
        views_per_day=views_per_day,
        recency_weight=recency_weight,
        raw_score=raw_score,
        composite_score=0.0,  # filled in by normalize_pool
        rank_within_platform=0,  # filled in by normalize_pool
    )


def normalize_pool(scored: list[ScoredVideo]) -> list[ScoredVideo]:
    """Min-max normalize raw_score to [0,1] within this pool, and assign ranks (1 = best)."""
    if not scored:
        return []
    raw_scores = [v.raw_score for v in scored]
    lo, hi = min(raw_scores), max(raw_scores)
    span = hi - lo

    ordered = sorted(scored, key=lambda v: v.raw_score, reverse=True)
    for rank, video in enumerate(ordered, start=1):
        video.composite_score = (video.raw_score - lo) / span if span > 0 else 1.0
        video.rank_within_platform = rank
    return ordered


def rank_candidates(
    videos: list[RawVideo], half_life_days: float = DEFAULT_HALF_LIFE_DAYS, now: datetime | None = None
) -> list[ScoredVideo]:
    """Score and rank a single platform's candidate pool, best first."""
    scored = [score_video(v, half_life_days, now) for v in videos]
    return normalize_pool(scored)


def select_top_n(scored: list[ScoredVideo], limit: int) -> list[ScoredVideo]:
    return scored[:limit]
