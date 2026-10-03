"""Automatic quality gate for a generated video, run BEFORE it is shown or queued.

Born from a live clip (2026-10-03) that cut between three different "days": different outfit and
room each cut, burned-in "sunday"/"monday" labels, and a first cut that looked undressed. A cheap
Claude vision pass over ~8 frames catches exactly those failures, so the pipeline can regenerate
once instead of handing the owner a broken video."""
from __future__ import annotations

import base64
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from content_scout.visual.auto_analyze import _call_claude, _strip_fences

REVIEW_PROMPT = """You are the quality checker for an AI-generated vertical video of ONE woman (the persona Ivy)
that is about to be posted to Instagram/TikTok. Below are {n} frames from it in chronological order.
The intended outfit for the whole video: {wardrobe}

Check strictly but fairly (a close crop of legs/feet is fine, a different camera angle is fine):
- same_outfit_throughout: she wears the SAME clothes in every frame where clothing is visible.
- same_location_throughout: it is the same room/place and time of day in every frame (no jump to another room or day).
- on_screen_text: ANY visible text, letters, day names, labels, captions or watermarks burned into the video.
- fully_clothed_modest: in EVERY frame she is clearly in everyday clothing — nothing that reads as underwear,
  sleepwear, undressed, or revealing.
- face_visible: her face is clearly visible in at least a third of the frames.
ok = same_outfit_throughout AND same_location_throughout AND NOT on_screen_text AND fully_clothed_modest AND face_visible.

Respond with ONLY a JSON object:
{{"same_outfit_throughout": true, "same_location_throughout": true, "on_screen_text": false, "text_seen": "",
 "fully_clothed_modest": true, "face_visible": true, "ok": true,
 "issues_he": ["short Hebrew description of each problem, empty list if ok"]}}"""


def sample_frames(video_path: Path, out_dir: Path, n: int = 8) -> list[Path]:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video_path)],
        capture_output=True, text=True, check=True,
    )
    duration = max(float(probe.stdout.strip() or 1), 1.0)
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video_path),
         "-vf", f"fps={n / duration:.4f},scale=512:-2", "-q:v", "4", str(out_dir / "f_%02d.jpg")],
        check=True,
    )
    return sorted(out_dir.glob("f_*.jpg"))[:n + 1]


def review_video(api_key: str, video_path: Path, wardrobe: str) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmp:
        frames = sample_frames(video_path, Path(tmp))
        content: list[dict[str, Any]] = [{"type": "text", "text": REVIEW_PROMPT.format(n=len(frames), wardrobe=wardrobe or "(not specified)")}]
        for f in frames:
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                        "data": base64.b64encode(f.read_bytes()).decode("ascii")}})
        raw = _call_claude(api_key, content, max_tokens=700)
    result = json.loads(_strip_fences(raw))
    result["ok"] = bool(
        result.get("same_outfit_throughout") and result.get("same_location_throughout")
        and not result.get("on_screen_text") and result.get("fully_clothed_modest") and result.get("face_visible")
    )
    result.setdefault("issues_he", [])
    return result
