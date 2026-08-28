"""Orchestrates the pure-code pipeline stages (0-6, 8-9). Stages 7 and 10 are interactive
(me, reading images and writing prose) and happen *after* `run_pipeline` returns — see
README.md and the printed checklist for what to do next.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from content_scout import ranking, storage
from content_scout.config import Settings
from content_scout.media import download, frames
from content_scout.models import new_brief
from content_scout.ocr import paddle_ocr
from content_scout.platforms.base import get_platform
from content_scout.report.render import render_stats_report
from content_scout.transcribe import whisper_transcribe
from content_scout.utils.env_check import has_blocking_errors, run_preflight
from content_scout.utils.logging import get_logger
from content_scout.visual import stub as visual_stub

log = get_logger(__name__)


@dataclass
class RunResult:
    run_id: str
    run_dir: Path
    video_count: int
    errors: list[str] = field(default_factory=list)
    pending_visual: list[dict[str, Any]] = field(default_factory=list)


def _discover_and_rank(
    platform: str, niche: str, settings: Settings, since_days: int, per_platform_limit: int, half_life_days: float
) -> list:
    discover_fn = get_platform(platform)
    log.info(f"[{platform}] discovering candidates for '{niche}' (since {since_days}d)...")
    candidates = discover_fn(niche, settings, since_days, per_platform_limit)
    log.info(f"[{platform}] {len(candidates)} candidates found")
    ranked = ranking.rank_candidates(candidates, half_life_days=half_life_days)
    selected = ranking.select_top_n(ranked, per_platform_limit)
    log.info(f"[{platform}] {len(selected)} selected after ranking")
    return selected


def process_video(
    brief_path: Path,
    *,
    keep_media: bool,
    skip_ocr: bool,
    skip_transcribe: bool,
    fps: float,
    num_keyframes: int,
    whisper_model: str,
    force: bool = False,
) -> dict[str, Any]:
    brief = storage.read_brief(brief_path)
    video_dir = brief_path.parent

    if brief["status"] in ("visual_pending", "visual_done", "complete") and not force:
        return brief

    try:
        if force or brief["status"] == "discovered":
            video_path, method = download.download_video(
                direct_media_url=brief.get("media", {}).get("direct_media_url"),
                page_url=brief["url"],
                video_dir=video_dir,
            )
            audio_path = download.extract_audio(video_path)
            brief["media"] = {
                "direct_media_url": brief.get("media", {}).get("direct_media_url"),
                "video_path": str(video_path.relative_to(video_dir)),
                "audio_path": str(audio_path.relative_to(video_dir)),
                "downloaded_via": method,
                "kept_on_disk": True,
            }
            brief["status"] = "downloaded"
            storage.write_brief(brief_path, brief)

        video_path = video_dir / brief["media"]["video_path"]
        audio_path = video_dir / brief["media"]["audio_path"]

        if force or brief["status"] == "downloaded":
            if skip_transcribe:
                brief["transcript"] = {"source": "skipped", "language": None, "full_text": "", "segments": []}
            else:
                brief["transcript"] = whisper_transcribe.get_transcript(
                    platform=brief["platform"],
                    page_url=brief["url"],
                    audio_path=audio_path,
                    work_dir=video_dir / "tmp_captions",
                    model_size=whisper_model,
                )
            brief["status"] = "transcribed"
            storage.write_brief(brief_path, brief)

        if force or brief["status"] == "transcribed":
            raw_dir = video_dir / "tmp_frames"
            raw_frames = frames.sample_frames(video_path, raw_dir, fps=fps)
            deduped = frames.dedup_frames(raw_frames)

            if skip_ocr:
                brief["on_screen_text"] = {"segments": [], "full_text_concat": ""}
            else:
                brief["on_screen_text"] = paddle_ocr.ocr_deduped_frames(deduped, fps=fps)
            brief["status"] = "ocr_done"
            storage.write_brief(brief_path, brief)

            keyframes_dir = video_dir / "frames"
            selected = frames.select_keyframes(deduped, n=num_keyframes)
            persisted = frames.persist_keyframes(selected, keyframes_dir)
            visual_stub.write_stub(brief, persisted, video_dir)
            frames.cleanup_raw_frames(raw_dir)

            if not keep_media:
                download.delete_media(video_dir)
                brief["media"]["kept_on_disk"] = False

            storage.write_brief(brief_path, brief)

    except Exception as exc:  # noqa: BLE001 — record and move on; one bad video shouldn't kill the run
        brief["status"] = "error"
        brief["error"] = str(exc)
        storage.write_brief(brief_path, brief)
        log.error(f"[{brief['platform']}/{brief['video_id']}] failed: {exc}")

    return brief


def run_pipeline(
    settings: Settings,
    *,
    niche: str,
    platforms: list[str],
    per_platform_limit: int = 20,
    since_days: int = 14,
    recency_half_life_days: float = 30.0,
    run_id: str | None = None,
    force: bool = False,
    keep_media: bool = False,
    skip_ocr: bool = False,
    skip_transcribe: bool = False,
    dry_run: bool = False,
    fps: float = 2.0,
    num_keyframes: int = 6,
    whisper_model: str = "small",
) -> RunResult:
    issues = run_preflight(settings, platforms)
    for issue in issues:
        (log.error if issue.level == "error" else log.warning)(issue.message)
    if has_blocking_errors(issues):
        raise RuntimeError("Preflight failed — fix the errors above before running.")

    resolved_run_id = storage.make_run_id(niche, run_id)
    paths = storage.RunPaths(settings.data_dir, resolved_run_id)
    paths.ensure_dirs()

    storage.write_manifest(
        paths,
        {
            "run_id": resolved_run_id,
            "niche": niche,
            "platforms": platforms,
            "per_platform_limit": per_platform_limit,
            "since_days": since_days,
            "recency_half_life_days": recency_half_life_days,
            "dry_run": dry_run,
        },
    )

    errors: list[str] = []
    total_selected = 0
    for platform in platforms:
        try:
            selected = _discover_and_rank(platform, niche, settings, since_days, per_platform_limit, recency_half_life_days)
        except Exception as exc:  # noqa: BLE001
            msg = f"[{platform}] discovery failed: {exc}"
            log.error(msg)
            errors.append(msg)
            continue

        for video in selected:
            brief_path = paths.brief_path(platform, video.raw.video_id)
            if not brief_path.exists():
                storage.write_brief(brief_path, new_brief(video, resolved_run_id))
            total_selected += 1

    if dry_run:
        log.info(f"Dry run complete: {total_selected} videos selected across {len(platforms)} platform(s). No downloads performed.")
        return RunResult(run_id=resolved_run_id, run_dir=paths.run_dir, video_count=total_selected, errors=errors)

    for brief_path in list(paths.iter_briefs()):
        process_video(
            brief_path,
            keep_media=keep_media,
            skip_ocr=skip_ocr,
            skip_transcribe=skip_transcribe,
            fps=fps,
            num_keyframes=num_keyframes,
            whisper_model=whisper_model,
            force=force,
        )

    render_stats_report(paths, niche, platforms)

    pending = visual_stub.pending_videos(paths)
    return RunResult(run_id=resolved_run_id, run_dir=paths.run_dir, video_count=total_selected, errors=errors, pending_visual=pending)


def resume_pipeline(
    settings: Settings,
    *,
    run_id: str,
    force: bool = False,
    keep_media: bool = False,
    skip_ocr: bool = False,
    skip_transcribe: bool = False,
    fps: float = 2.0,
    num_keyframes: int = 6,
    whisper_model: str = "small",
) -> RunResult:
    paths = storage.RunPaths(settings.data_dir, run_id)
    if not paths.run_dir.exists():
        raise FileNotFoundError(f"No such run: {run_id} (looked in {paths.run_dir})")
    manifest = storage.read_manifest(paths)

    for brief_path in list(paths.iter_briefs()):
        process_video(
            brief_path,
            keep_media=keep_media,
            skip_ocr=skip_ocr,
            skip_transcribe=skip_transcribe,
            fps=fps,
            num_keyframes=num_keyframes,
            whisper_model=whisper_model,
            force=force,
        )

    render_stats_report(paths, manifest["niche"], manifest["platforms"])
    pending = visual_stub.pending_videos(paths)
    video_count = sum(1 for _ in paths.iter_briefs())
    return RunResult(run_id=run_id, run_dir=paths.run_dir, video_count=video_count, pending_visual=pending)
