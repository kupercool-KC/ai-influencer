"""Stage 6 (pure code): record which keyframes were selected for a video and mark it
`visual_pending`. Stage 7 (interactive — me, reading the actual images) fills in the
qualitative fields via `fill_visual_analysis` below.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from content_scout import storage

VISUAL_FIELDS = [
    "hook_first_3_sec",
    "shot_composition",
    "lighting",
    "pacing_editing_style",
    "wardrobe_style_setting",
    "on_screen_graphics_style",
    "overall_notes",
]


def write_stub(brief: dict[str, Any], keyframe_paths: list[Path], video_dir: Path) -> dict[str, Any]:
    rel_paths = [str(p.relative_to(video_dir)) for p in keyframe_paths]
    brief["visual_analysis"]["keyframe_paths"] = rel_paths
    brief["visual_analysis"]["status"] = "pending"
    brief["status"] = "visual_pending"
    return brief


def pending_videos(paths: storage.RunPaths) -> list[dict[str, Any]]:
    """List videos whose visual_analysis still needs to be filled in (for the CLI checklist)."""
    pending = []
    for brief_path in paths.iter_briefs():
        brief = storage.read_brief(brief_path)
        if brief.get("visual_analysis", {}).get("status") == "pending":
            pending.append(
                {
                    "brief_path": str(brief_path),
                    "platform": brief["platform"],
                    "video_id": brief["video_id"],
                    "url": brief["url"],
                    "keyframe_paths": [
                        str(brief_path.parent / p) for p in brief["visual_analysis"]["keyframe_paths"]
                    ],
                }
            )
    return pending


def fill_visual_analysis(
    brief_path: Path, analysis: dict[str, str], filled_by: str = "claude"
) -> dict[str, Any]:
    """Called by me (interactively) after reading a video's keyframes, to write the
    qualitative fields. `analysis` should have some/all of VISUAL_FIELDS as keys.
    """
    brief = storage.read_brief(brief_path)
    for field in VISUAL_FIELDS:
        if field in analysis:
            brief["visual_analysis"][field] = analysis[field]
    brief["visual_analysis"]["status"] = "done"
    brief["visual_analysis"]["filled_by"] = filled_by
    brief["visual_analysis"]["filled_at"] = datetime.now(timezone.utc).isoformat()
    brief["status"] = "visual_done"
    storage.write_brief(brief_path, brief)
    return brief
