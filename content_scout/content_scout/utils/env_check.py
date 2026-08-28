"""Stage 0 preflight: check env vars, ffmpeg, disk space, and that requested platforms'
credentials are present, *before* spending any Apify/YouTube quota or CPU time.
"""
from __future__ import annotations

import shutil
from dataclasses import dataclass

from content_scout.config import Settings


@dataclass
class PreflightIssue:
    level: str  # "error" | "warning"
    message: str


def run_preflight(settings: Settings, platforms: list[str]) -> list[PreflightIssue]:
    issues: list[PreflightIssue] = []

    if shutil.which("ffmpeg") is None:
        issues.append(PreflightIssue("error", "ffmpeg not found on PATH — required for audio/frame extraction."))

    free_bytes = shutil.disk_usage(settings.data_dir.parent if settings.data_dir.exists() else ".").free
    free_gb = free_bytes / (1024**3)
    if free_gb < 2:
        issues.append(PreflightIssue("warning", f"Only {free_gb:.1f} GB free disk — media downloads may fail on a large run."))

    needs_apify = any(p in ("tiktok", "instagram") for p in platforms)
    if needs_apify and not settings.apify_token:
        issues.append(
            PreflightIssue(
                "error",
                "APIFY_TOKEN not set, but tiktok/instagram were requested. "
                "See .env.example and the setup walkthrough for how to get one.",
            )
        )
    if "youtube" in platforms and not settings.youtube_api_key:
        issues.append(
            PreflightIssue(
                "error",
                "YOUTUBE_API_KEY not set, but youtube was requested. "
                "See .env.example and the setup walkthrough for how to get one.",
            )
        )

    for pkg in ("yt_dlp", "faster_whisper", "paddleocr", "cv2", "skimage", "apify_client", "googleapiclient"):
        try:
            __import__(pkg)
        except ImportError:
            issues.append(PreflightIssue("error", f"Python package '{pkg}' not importable — run: pip install --break-system-packages -r requirements.txt"))

    return issues


def has_blocking_errors(issues: list[PreflightIssue]) -> bool:
    return any(i.level == "error" for i in issues)
