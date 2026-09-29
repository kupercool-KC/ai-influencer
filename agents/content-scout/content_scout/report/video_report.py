"""Renders a single video's brief.json into the concise per-video report block format —
same shape whether visual_analysis was filled by an interactive Claude Code session or by
the automated `content_scout.visual.auto_analyze` pass. Both paths write the same fields
(see visual/stub.py's VISUAL_FIELDS), so this renderer doesn't care which one ran.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any


def render_video_report(brief: dict[str, Any]) -> str:
    va = brief.get("visual_analysis", {})
    meta = brief["metadata"]
    stats = meta["stats"]

    title = va.get("title") or meta.get("caption", "")[:40] or "(untitled)"
    posted_at = meta.get("posted_at")
    posted_label = datetime.fromisoformat(posted_at).strftime("%b %-d, %Y") if posted_at else "(unknown)"
    hashtags = ", ".join(f"#{h}" for h in meta.get("hashtags", [])) or "(none)"

    format_line = va.get("format_archetype") or "(not yet analyzed)"
    hook = va.get("hook_first_3_sec")
    if hook:
        format_line += f" — {hook}"

    rows = [
        ("Likes", f"{stats['likes']:,}"),
        ("Comments", f"{stats['comments']:,}"),
        ("Posted", posted_label),
        ("Hashtags", hashtags),
    ]
    if stats.get("views"):
        rows.insert(0, ("Views", f"{stats['views']:,}"))
    table = "| Metric | Value |\n|---|---|\n" + "\n".join(f"| {k} | {v} |" for k, v in rows)

    lines = [
        f"**Report — @{meta['author_handle']}, \"{title}\" ({brief['video_id']})**",
        "",
        f"**What it's about:** {va.get('what_its_about') or '(not yet analyzed)'}",
        "",
        f"**Format:** {format_line}",
        "",
        "**Exposure:**",
        "",
        table,
        "",
        f"**Read:** {va.get('read') or '(not yet analyzed)'}",
        "",
        f"🔗 {brief['url']}",
    ]
    if meta.get("top_comments"):
        lines.insert(-2, f"_Top comments: {' · '.join(meta['top_comments'])}_\n")
    return "\n".join(lines)
