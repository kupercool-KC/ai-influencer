"""Filesystem layout + brief.json read/write + the resume/idempotency helpers.

Layout:
  data/runs/<run_id>/
    manifest.json
    report_stats.md
    synthesis.md
    report.md
    videos/<platform>_<video_id>/
      brief.json
      media/video.mp4, media/audio.wav   (deleted after processing unless --keep-media)
      frames/keyframe_01.jpg ...
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


def slugify(text: str, max_len: int = 40) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower()).strip("-")
    return slug[:max_len] or "run"


def make_run_id(niche: str, run_id: str | None = None) -> str:
    if run_id:
        return slugify(run_id, max_len=80)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{ts}_{slugify(niche)}"


class RunPaths:
    def __init__(self, data_dir: Path, run_id: str):
        self.run_id = run_id
        self.run_dir = data_dir / "runs" / run_id
        self.videos_dir = self.run_dir / "videos"
        self.manifest_path = self.run_dir / "manifest.json"
        self.report_stats_path = self.run_dir / "report_stats.md"
        self.synthesis_path = self.run_dir / "synthesis.md"
        self.report_path = self.run_dir / "report.md"

    def ensure_dirs(self) -> None:
        self.videos_dir.mkdir(parents=True, exist_ok=True)

    def video_dir(self, platform: str, video_id: str) -> Path:
        return self.videos_dir / f"{platform}_{slugify(video_id, max_len=60)}"

    def brief_path(self, platform: str, video_id: str) -> Path:
        return self.video_dir(platform, video_id) / "brief.json"

    def iter_briefs(self) -> Iterator[Path]:
        if not self.videos_dir.exists():
            return
        for video_dir in sorted(self.videos_dir.iterdir()):
            brief = video_dir / "brief.json"
            if brief.exists():
                yield brief


def _default(obj: Any) -> Any:
    if is_dataclass(obj):
        return asdict(obj)
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, Path):
        return str(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def write_brief(path: Path, brief: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(brief, indent=2, default=_default, ensure_ascii=False), encoding="utf-8")


def read_brief(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_manifest(paths: RunPaths, manifest: dict[str, Any]) -> None:
    paths.run_dir.mkdir(parents=True, exist_ok=True)
    paths.manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")


def read_manifest(paths: RunPaths) -> dict[str, Any]:
    return json.loads(paths.manifest_path.read_text(encoding="utf-8"))


def list_runs(data_dir: Path) -> list[str]:
    runs_dir = data_dir / "runs"
    if not runs_dir.exists():
        return []
    return sorted((p.name for p in runs_dir.iterdir() if p.is_dir()), reverse=True)
