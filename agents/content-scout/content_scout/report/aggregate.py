"""Stage 9 (pure code): cross-video statistics — hashtag frequency, posting-time patterns,
rankings tables, and verbatim hook excerpts. No LLM judgment here; the qualitative synthesis
(stage 10) is a separate, interactive step (see report/render.py + pipeline.py).
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Any

from content_scout import storage


def load_all_briefs(paths: storage.RunPaths) -> list[dict[str, Any]]:
    return [storage.read_brief(p) for p in paths.iter_briefs()]


def briefs_by_platform(briefs: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    by_platform: dict[str, list[dict[str, Any]]] = {}
    for b in briefs:
        by_platform.setdefault(b["platform"], []).append(b)
    return by_platform


def top_ranked_table(briefs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for b in sorted(briefs, key=lambda x: x.get("ranking", {}).get("rank_within_platform", 999)):
        stats = b["metadata"]["stats"]
        hook = (b.get("transcript", {}).get("full_text") or "")[:80]
        rows.append(
            {
                "rank": b["ranking"]["rank_within_platform"],
                "composite_score": round(b["ranking"]["composite_score"], 3),
                "views": stats["views"],
                "engagement_rate": round(b["ranking"]["engagement_rate"], 4),
                "url": b["url"],
                "hook": hook,
            }
        )
    return rows


def hashtag_frequency(briefs: list[dict[str, Any]], top_n: int = 20) -> list[tuple[str, int]]:
    counter: Counter[str] = Counter()
    for b in briefs:
        for tag in b["metadata"].get("hashtags", []):
            counter[tag.lower()] += 1
    return counter.most_common(top_n)


def posting_pattern(briefs: list[dict[str, Any]]) -> dict[str, Any]:
    day_counter: Counter[str] = Counter()
    hour_counter: Counter[int] = Counter()
    durations = []
    for b in briefs:
        posted_raw = b["metadata"].get("posted_at")
        if posted_raw:
            dt = datetime.fromisoformat(posted_raw)
            day_counter[dt.strftime("%A")] += 1
            hour_counter[dt.hour] += 1
        duration = b["metadata"].get("duration_sec")
        if duration:
            durations.append(duration)
    avg_duration = sum(durations) / len(durations) if durations else None
    return {
        "by_day": day_counter.most_common(),
        "by_hour": sorted(hour_counter.items()),
        "avg_duration_sec": round(avg_duration, 1) if avg_duration else None,
    }


def hook_excerpts(briefs: list[dict[str, Any]], limit: int = 10) -> list[dict[str, Any]]:
    ranked = sorted(briefs, key=lambda x: x.get("ranking", {}).get("composite_score", 0), reverse=True)
    excerpts = []
    for b in ranked[:limit]:
        transcript_segments = b.get("transcript", {}).get("segments", [])
        spoken_hook = " ".join(s["text"] for s in transcript_segments if s["start"] < 3.0).strip()
        onscreen_segments = b.get("on_screen_text", {}).get("segments", [])
        onscreen_hook = " / ".join(
            s["text"] for s in onscreen_segments if s["start_sec"] < 3.0
        ).strip()
        excerpts.append(
            {
                "platform": b["platform"],
                "url": b["url"],
                "composite_score": round(b["ranking"]["composite_score"], 3),
                "spoken_hook": spoken_hook or "(no speech in first 3s)",
                "onscreen_hook": onscreen_hook or "(no on-screen text in first 3s)",
            }
        )
    return excerpts


def compute_stats(paths: storage.RunPaths) -> dict[str, Any]:
    briefs = load_all_briefs(paths)
    by_platform = briefs_by_platform(briefs)

    platform_stats = {}
    for platform, plist in by_platform.items():
        platform_stats[platform] = {
            "count": len(plist),
            "top_ranked": top_ranked_table(plist),
            "hashtags": hashtag_frequency(plist),
            "posting_pattern": posting_pattern(plist),
            "hook_excerpts": hook_excerpts(plist, limit=10),
        }

    return {
        "total_videos": len(briefs),
        "platforms": platform_stats,
        "overall_hashtags": hashtag_frequency(briefs, top_n=30),
    }
