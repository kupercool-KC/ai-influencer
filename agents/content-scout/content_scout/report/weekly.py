"""Builds the cross-video synthesis (patterns + prompt-agent recommendations) and a
condensed, Telegram-ready weekly summary — the automated equivalent of stage 10. Calls
Claude once more (text-only, no images needed — the per-video analyses already describe
what's in each video) with every video's analysis plus, when available, the actual
generation-prompt source from the sibling app (so recommendations are grounded in what the
prompt builder does or doesn't already support, not guessed).
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

from content_scout.report.video_report import render_video_report
from content_scout.visual.auto_analyze import _call_claude, _strip_fences

# Relative to the content_scout package's repo checkout: agents/content-scout/../../src/...
APP_PROMPT_FILE_CANDIDATES = [
    "../../src/pages/Influencers.jsx",
]

SYNTHESIS_SCHEMA_HINT = """Respond with ONLY a JSON object (no markdown fences), with these keys:
{
  "format_pattern_notes": "1-3 sentences on what patterns are visible across this run's videos \
— or, if there are too few videos for a real pattern (say, under 5), say so honestly instead of \
inventing a trend from noise",
  "prompt_agent_recommendations": ["a list of 1-4 short, concrete, actionable bullet points — \
things to add or change in the AI generation prompts based specifically on what performed well \
or badly in this run. Ground each one in an actual video from this run, not generic advice. \
If the current generation prompt source was provided below, check whether it already supports \
what's recommended before suggesting it."]
}"""


def _find_app_prompt_source(paths_run_dir: Path) -> str | None:
    for rel in APP_PROMPT_FILE_CANDIDATES:
        candidate = (paths_run_dir / rel).resolve()
        if candidate.exists():
            return candidate.read_text(encoding="utf-8")
    return None


def build_weekly_summary(
    run_dir: Path, briefs: list[dict[str, Any]], niche: str, run_id: str, api_key: str
) -> tuple[str, str]:
    """Returns (synthesis_md, telegram_summary_text)."""
    analyzed = [b for b in briefs if b.get("visual_analysis", {}).get("status") == "done"]
    if not analyzed:
        empty = "_No videos with completed visual analysis in this run — nothing to synthesize._"
        return empty, empty

    per_video_reports = [render_video_report(b) for b in analyzed]
    format_counts = Counter(b["visual_analysis"].get("format_archetype", "unknown") for b in analyzed)

    ranked = sorted(analyzed, key=lambda b: b.get("ranking", {}).get("composite_score", 0), reverse=True)
    top = ranked[0]
    bottom = ranked[-1] if len(ranked) > 1 else None

    app_prompt_source = _find_app_prompt_source(run_dir)
    prompt_context = (
        f"\n\nCurrent AI video-generation prompt builder source (for grounding recommendations "
        f"— check what it already does before suggesting something it already handles):\n"
        f"{app_prompt_source[:12000]}"
        if app_prompt_source
        else "\n\n(No generation prompt source available to cross-check against.)"
    )

    videos_summary = "\n\n".join(
        f"- {b['metadata']['author_handle']} | format: {b['visual_analysis'].get('format_archetype')} "
        f"| likes: {b['metadata']['stats']['likes']} | comments: {b['metadata']['stats']['comments']} "
        f"| read: {b['visual_analysis'].get('read')}"
        for b in analyzed
    )

    prompt = (
        f"You're building a weekly content-strategy report from {len(analyzed)} scraped social "
        f"videos in the '{niche}' niche.\n\nPer-video summaries:\n{videos_summary}\n"
        f"\nFormat archetype counts: {dict(format_counts)}"
        f"{prompt_context}\n\n{SYNTHESIS_SCHEMA_HINT}"
    )
    raw = _call_claude(api_key, [{"type": "text", "text": prompt}], max_tokens=1200)
    synthesis = json.loads(_strip_fences(raw))

    synthesis_md = (
        f"# Synthesis — run {run_id}\n\n"
        f"## Format patterns\n{synthesis['format_pattern_notes']}\n\n"
        f"## Prompt-agent recommendations\n"
        + "\n".join(f"- {r}" for r in synthesis["prompt_agent_recommendations"])
        + "\n\n## Per-video reports\n\n"
        + "\n\n---\n\n".join(per_video_reports)
    )

    format_lines = "\n".join(f"• {fmt}: {n} video{'s' if n != 1 else ''}" for fmt, n in format_counts.most_common())
    top_stats = top["metadata"]["stats"]
    bottom_stats = bottom["metadata"]["stats"] if bottom else None

    telegram_lines = [
        f"📊 Content Scout — Weekly Report",
        f"{niche} · {len(analyzed)} video{'s' if len(analyzed) != 1 else ''} analyzed",
        "",
        f"🏆 TOP PERFORMER",
        f"\"{top['visual_analysis'].get('title', top['video_id'])}\" — @{top['metadata']['author_handle']}",
        f"❤️ {top_stats['likes']:,}  💬 {top_stats['comments']:,}",
        f"Format: {top['visual_analysis'].get('format_archetype')}",
        f"{top['visual_analysis'].get('read', '')}",
    ]
    if bottom and bottom is not top:
        telegram_lines += [
            "",
            f"📉 UNDERPERFORMED",
            f"\"{bottom['visual_analysis'].get('title', bottom['video_id'])}\" — @{bottom['metadata']['author_handle']}",
            f"❤️ {bottom_stats['likes']:,}  💬 {bottom_stats['comments']:,}",
            f"{bottom['visual_analysis'].get('read', '')}",
        ]
    telegram_lines += [
        "",
        "📐 FORMAT PATTERNS",
        format_lines,
        synthesis["format_pattern_notes"],
        "",
        "🎯 PROMPT-AGENT RECOMMENDATIONS",
        *[f"• {r}" for r in synthesis["prompt_agent_recommendations"]],
        "",
        f"📂 Full run: {run_id}",
    ]
    telegram_summary = "\n".join(telegram_lines)

    return synthesis_md, telegram_summary
