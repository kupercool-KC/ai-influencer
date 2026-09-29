"""Automated stage 7 (visual analysis) + per-video report generation — no interactive
Claude Code session required. Calls the Anthropic API directly with each video's keyframes
plus its transcript/OCR/engagement data, so the whole pipeline can run unattended (e.g. the
weekly GitHub Actions job). The interactive path (README's `fill_visual_analysis`, a live
session reading frames by hand) still works and is untouched — this is the always-available
fallback that makes a scheduled run possible without anyone at a keyboard.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import requests

from content_scout.visual.stub import fill_visual_analysis

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-sonnet-5"

SCHEMA_HINT = """Respond with ONLY a JSON object (no markdown fences, no commentary before or \
after), with exactly these keys:
{
  "title": "short quotable title capturing the hook/theme, e.g. 'USA reveal' (a few words, in quotes-worthy form, no actual quote marks needed here)",
  "what_its_about": "1-3 plain sentences describing what the video actually shows/depicts, based on the keyframes",
  "format_archetype": "a short category tag, e.g. 'styling tutorial', 'outfit reveal', 'day-in-the-life', 'direct-to-camera hook'",
  "hook_first_3_sec": "what happens/is said/shown in the first 3 seconds and why it does or doesn't grab attention",
  "shot_composition": "camera framing, angle, movement, based on the keyframes",
  "lighting": "lighting description",
  "pacing_editing_style": "cut frequency, transitions, overall rhythm — infer from keyframe variety and duration",
  "wardrobe_style_setting": "wardrobe + location/setting description",
  "on_screen_graphics_style": "on-screen text style if present — font weight, placement, timing; say 'none' if absent",
  "overall_notes": "anything else a content strategist would flag",
  "read": "1-2 sentences: the actionable takeaway — why this performed the way it did, given the engagement numbers provided. Be honest if engagement was weak."
}"""


def _image_block(path: Path) -> dict[str, Any]:
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    media_type = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}


def _call_claude(api_key: str, content: list[dict[str, Any]], max_tokens: int = 1500) -> str:
    response = requests.post(
        ANTHROPIC_API_URL,
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        json={"model": MODEL, "max_tokens": max_tokens, "messages": [{"role": "user", "content": content}]},
        timeout=120,
    )
    response.raise_for_status()
    return response.json()["content"][0]["text"].strip()


def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        text = text.rsplit("```", 1)[0]
    return text.strip()


def analyze_video(brief: dict[str, Any], video_dir: Path, api_key: str) -> dict[str, Any]:
    """Returns the parsed analysis dict (VISUAL_FIELDS keys). Does not write to disk."""
    keyframe_paths = [video_dir / p for p in brief["visual_analysis"].get("keyframe_paths", [])]
    existing = [p for p in keyframe_paths if p.exists()]
    if not existing:
        raise ValueError(f"No keyframes found on disk for {brief['video_id']} — run the pipeline (not --dry-run) first.")

    meta = brief["metadata"]
    stats = meta["stats"]
    context = f"""Platform: {brief['platform']}
URL: {brief['url']}
Author: {meta['author_handle']}
Caption: {meta['caption']}
Hashtags: {', '.join(meta.get('hashtags', []))}
Posted: {meta['posted_at']}
Stats: {stats['views']} views, {stats['likes']} likes, {stats['comments']} comments, \
{stats['shares']} shares (completeness: {stats['data_completeness']})
Top comments: {json.dumps(meta.get('top_comments', []))}
Spoken transcript: {brief.get('transcript', {}).get('full_text') or '(none)'}
On-screen text (OCR): {brief.get('on_screen_text', {}).get('full_text_concat') or '(none)'}
"""

    content = [
        {"type": "text", "text": "Analyze this short-form video for a content strategy report. "
         "Here are its representative keyframes, in chronological order:"},
        *[_image_block(p) for p in existing],
        {"type": "text", "text": context + "\n" + SCHEMA_HINT},
    ]
    raw = _call_claude(api_key, content)
    return json.loads(_strip_fences(raw))


def analyze_and_fill(brief_path: Path, brief: dict[str, Any], api_key: str) -> dict[str, Any]:
    """Analyzes one video and writes the result to its brief.json — the automated
    equivalent of the interactive `fill_visual_analysis` call."""
    analysis = analyze_video(brief, brief_path.parent, api_key)
    return fill_visual_analysis(brief_path, analysis, filled_by="claude-auto")
