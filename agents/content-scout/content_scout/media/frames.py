"""Frame sampling + SSIM-based dedup + keyframe selection.

Pattern borrowed from the open-source burned-in-subtitle extractors researched earlier
(e.g. timminator/VideOCR): sample a few frames per second, drop near-duplicate consecutive
frames (SSIM against the last *kept* frame, not simply the previous frame), then OCR only
what's left. A small, evenly-spaced subset of the deduped frames becomes the "keyframes"
used for the interactive visual-analysis step (stage 7) — kept small on purpose so that step
stays a quick, focused read rather than dozens of near-identical images per video.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


class FrameExtractionError(RuntimeError):
    pass


def sample_frames(video_path: Path, work_dir: Path, fps: float = 2.0) -> list[Path]:
    """Extract frames at `fps` frames/sec into work_dir/raw_XXXX.jpg. Requires ffmpeg."""
    work_dir.mkdir(parents=True, exist_ok=True)
    pattern = work_dir / "raw_%04d.jpg"
    cmd = ["ffmpeg", "-y", "-i", str(video_path), "-vf", f"fps={fps}", "-q:v", "3", str(pattern)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise FrameExtractionError(f"ffmpeg frame sampling failed for {video_path}: {result.stderr[-2000:]}")
    return sorted(work_dir.glob("raw_*.jpg"))


def dedup_frames(frame_paths: list[Path], ssim_threshold: float = 0.90) -> list[Path]:
    """Keep a frame only if it differs enough (SSIM below threshold) from the last kept frame."""
    if not frame_paths:
        return []
    import cv2
    from skimage.metrics import structural_similarity as ssim

    kept: list[Path] = []
    prev_gray = None
    for path in frame_paths:
        img = cv2.imread(str(path))
        if img is None:
            continue
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        if prev_gray is None or ssim(prev_gray, gray) < ssim_threshold:
            kept.append(path)
            prev_gray = gray
    return kept


def select_keyframes(deduped_paths: list[Path], n: int = 6) -> list[Path]:
    """Evenly-spaced subset of deduped frames, capped at n, always including the first frame
    (the hook) and the last frame (the payoff/CTA) when n >= 2."""
    if len(deduped_paths) <= n:
        return deduped_paths
    if n <= 1:
        return deduped_paths[:1]
    step = (len(deduped_paths) - 1) / (n - 1)
    indices = sorted({round(i * step) for i in range(n)})
    return [deduped_paths[i] for i in indices]


def persist_keyframes(selected: list[Path], frames_dir: Path) -> list[Path]:
    """Copy selected frames into the video's persistent frames/ dir as keyframe_01.jpg, ..."""
    frames_dir.mkdir(parents=True, exist_ok=True)
    persisted: list[Path] = []
    for i, src in enumerate(selected, start=1):
        dest = frames_dir / f"keyframe_{i:02d}.jpg"
        shutil.copy2(src, dest)
        persisted.append(dest)
    return persisted


def cleanup_raw_frames(work_dir: Path) -> None:
    if work_dir.exists():
        shutil.rmtree(work_dir, ignore_errors=True)
