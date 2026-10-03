"""`inspire`: take ONE pasted Instagram/TikTok link (reel, video or photo post), look at it the
way a human strategist would, and turn it into a content plan for the persona.

This is the on-demand sibling of the account scan: same analysis + plan modules, but the
source is a specific link someone sent from Telegram ("make something like this"), and photo
posts are supported (the account scan only ever wanted video). Writes a normal run directory
so the rest of ivy-daily-content.yml (generate -> Buffer drafts -> Telegram approval) runs
unchanged on top of it."""
from __future__ import annotations

import json
import re
import sys
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import requests

from content_scout import storage
from content_scout.media.download import with_apify_token
from content_scout.config import Settings
from content_scout.models import RawVideo, ScoredVideo, new_brief
from content_scout.persona_content import generate_daily_plan, write_content_plan
from content_scout.video_plan import generate_video_plan
from content_scout.visual.auto_analyze import analyze_video
from content_scout.visual.stub import write_stub

MAX_IMAGE_SIDE = 1568  # Anthropic's own recommended max for image inputs


class InspirationError(RuntimeError):
    """Raised with a message that is safe and useful to show the user in Telegram."""


def detect_platform(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    if host.endswith("instagram.com"):
        return "instagram"
    if host.endswith("tiktok.com"):
        return "tiktok"
    raise InspirationError("אני יודע ללמוד רק מקישורים של אינסטגרם או טיקטוק.")


def _resolve_short_link(url: str) -> str:
    """vm.tiktok.com / vt.tiktok.com / tiktok.com/t/... redirect to the canonical post URL."""
    host = (urlsplit(url).hostname or "").lower()
    if host in ("vm.tiktok.com", "vt.tiktok.com") or "/t/" in urlsplit(url).path:
        try:
            return requests.get(url, allow_redirects=True, timeout=20, headers={"User-Agent": "Mozilla/5.0"}).url
        except requests.RequestException:
            return url
    return url


def _save_image(src: bytes, dest: Path) -> None:
    from PIL import Image

    img = Image.open(BytesIO(src)).convert("RGB")
    img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest, "JPEG", quality=90)


def _fetch_images(urls: list[str], frames_dir: Path) -> list[Path]:
    saved: list[Path] = []
    for i, u in enumerate(urls, start=1):
        try:
            r = requests.get(with_apify_token(u), timeout=30, headers={"User-Agent": "Mozilla/5.0"})
            r.raise_for_status()
            dest = frames_dir / f"keyframe_{i:02d}.jpg"
            _save_image(r.content, dest)
            saved.append(dest)
        except Exception as exc:  # noqa: BLE001 — one bad slide shouldn't sink the others
            print(f"[inspire] could not fetch image {u[:80]}: {type(exc).__name__}: {exc}", file=sys.stderr)
            continue
    return saved


def _discover(url: str, platform: str, settings: Settings) -> RawVideo:
    if platform == "instagram":
        from content_scout.platforms.instagram import discover_single_url
        raw = discover_single_url(url)
    else:
        from content_scout.platforms.tiktok import discover_single_url
        raw = discover_single_url(url, settings)
    if raw is None:
        raise InspirationError(
            "לא הצלחתי לפתוח את הפוסט — ייתכן שהוא פרטי, נמחק, או שאינסטגרם ביקשה התחברות. "
            "נסה קישור אחר."
        )
    return raw


def _keyframes(raw: RawVideo, platform: str, video_dir: Path) -> tuple[list[Path], str]:
    """Returns (keyframe paths, media_kind). Videos are downloaded and sampled; photo posts
    contribute their images directly."""
    frames_dir = video_dir / "frames"
    if raw.direct_media_url:
        try:
            from content_scout.media.download import download_video
            from content_scout.media.frames import (
                cleanup_raw_frames, dedup_frames, persist_keyframes, sample_frames, select_keyframes,
            )

            video_path, _ = download_video(direct_media_url=raw.direct_media_url, page_url=raw.url, video_dir=video_dir)
            raw_frames = sample_frames(video_path, work_dir=video_dir / "raw_frames")
            selected = select_keyframes(dedup_frames(raw_frames), n=6)
            frames = persist_keyframes(selected, frames_dir=frames_dir)
            cleanup_raw_frames(video_dir / "raw_frames")
            if frames:
                return frames, "video"
        except Exception as exc:  # noqa: BLE001 — fall through to the still-image path
            print(f"[inspire] video download/sampling failed ({type(exc).__name__}: {exc}); trying stills", file=sys.stderr)
    urls: list[str] = list(raw.raw.get("image_urls") or [])
    if not urls and platform == "tiktok":
        # photo-mode posts: Apify lists the slides under imagePost.images[].imageURL.urlList
        for img in ((raw.raw.get("imagePost") or {}).get("images") or [])[:4]:
            u = ((img.get("imageURL") or {}).get("urlList") or [None])[0]
            if u:
                urls.append(u)
    if not urls and raw.thumbnail_url:
        urls = [raw.thumbnail_url]
    print(f"[inspire] still-image candidates: {urls[:3]} (direct_media_url={raw.direct_media_url!r}, "
          f"raw keys={sorted(raw.raw)[:25]})", file=sys.stderr)
    frames = _fetch_images(urls, frames_dir)
    if not frames:
        raise InspirationError("הפוסט נפתח אבל לא הצלחתי להוריד ממנו תמונה או סרטון.")
    return frames, "image"


def _summary_text(url: str, raw: RawVideo, media_kind: str, analysis: dict[str, Any]) -> str:
    kind = {"video": "video", "image": "photo post"}[media_kind]
    return "\n".join([
        f"Looked at @{raw.author_handle}'s {kind}: {analysis.get('title', '')}",
        f"• What it is: {analysis.get('what_its_about', '')}",
        f"• Format: {analysis.get('format_archetype', '')}",
        f"• Hook: {analysis.get('hook_first_3_sec', '')}",
        f"• Look & setting: {analysis.get('lighting', '')}; {analysis.get('wardrobe_style_setting', '')}",
        f"• Why it works: {analysis.get('read', '')}",
        f"• Likes/comments: {raw.likes:,} / {raw.comments:,}" if (raw.likes or raw.comments) else "",
        f"• Source: {url}",
    ]).replace("\n\n", "\n").strip()


def run_inspire(
    url: str, note: str | None, kind: str, persona_dir: Path, settings: Settings, api_key: str
) -> tuple[str, Path]:
    """Returns (run_id, run_dir). Raises InspirationError for user-facing failures."""
    url = _resolve_short_link(url.strip())
    platform = detect_platform(url)
    raw = _discover(url, platform, settings)

    run_id = storage.make_run_id(f"inspire-{platform}-{raw.video_id}")
    paths = storage.RunPaths(settings.data_dir, run_id)
    paths.ensure_dirs()
    video_dir = paths.video_dir(platform, raw.video_id)
    video_dir.mkdir(parents=True, exist_ok=True)

    keyframes, media_kind = _keyframes(raw, platform, video_dir)
    scored = ScoredVideo(
        raw=raw, engagement_rate=0.0, views_per_day=0.0, recency_weight=1.0,
        raw_score=0.0, composite_score=1.0, rank_within_platform=1,
    )
    brief = new_brief(scored, run_id=run_id)
    brief["media_kind"] = media_kind
    write_stub(brief, keyframes, video_dir)
    analysis = analyze_video(brief, video_dir, api_key)
    brief["visual_analysis"].update(analysis)
    brief["visual_analysis"]["status"] = "done"
    storage.write_brief(video_dir / "brief.json", brief)
    storage.write_manifest(paths, {"run_id": run_id, "kind": "inspire", "url": url, "note": note, "media_kind": media_kind})

    (paths.run_dir / "telegram_summary.txt").write_text(_summary_text(url, raw, media_kind, analysis), encoding="utf-8")

    direction = (
        f"Make something genuinely INSPIRED by this one post ({url}): keep the mechanic and vibe that made it work, "
        "and rebuild it inside Ivy's world (Australia, her wardrobe palette, her voice). Never copy its scene, "
        "script, caption or the person in it."
        + (f"\nThe owner added: {note.strip()}" if note and note.strip() else "")
    )
    if kind == "video":
        days = [generate_video_plan(brief, persona_dir, api_key, extra_direction=direction)]
    else:
        days = generate_daily_plan([brief], persona_dir, 1, api_key, extra_direction=direction)
    write_content_plan(paths.run_dir, days)
    (paths.run_dir / "inspire.json").write_text(
        json.dumps({"url": url, "platform": platform, "author": raw.author_handle, "media_kind": media_kind, "kind": kind}),
        encoding="utf-8",
    )
    return run_id, paths.run_dir
