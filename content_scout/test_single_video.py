"""One-off validation script: run the full content_scout pipeline (download, transcribe,
OCR, frame extraction) on a single YouTube video given by URL, bypassing discovery entirely.

Needs no API keys — yt-dlp pulls the video's own metadata directly, same as it pulls the
video file itself. Use this to sanity-check the pipeline before spending anything on Apify.

Usage:
    ./.venv/bin/python test_single_video.py "https://www.youtube.com/watch?v=..."
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone

import yt_dlp

from content_scout import pipeline, ranking, storage
from content_scout.config import load_settings
from content_scout.models import RawVideo


def fetch_metadata(url: str) -> RawVideo:
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
        info = ydl.extract_info(url, download=False)

    upload_date = info.get("upload_date")  # "YYYYMMDD"
    posted_at = (
        datetime.strptime(upload_date, "%Y%m%d").replace(tzinfo=timezone.utc)
        if upload_date
        else datetime.now(timezone.utc)
    )

    return RawVideo(
        platform="youtube",
        video_id=info["id"],
        url=url,
        author_handle=info.get("uploader_id") or info.get("channel", ""),
        author_name=info.get("uploader") or info.get("channel", ""),
        caption=(info.get("title") or "") + ("\n\n" + info.get("description", "") if info.get("description") else ""),
        hashtags=sorted(set(t.lower() for t in (info.get("tags") or []) if t.startswith("#"))) or [],
        posted_at=posted_at,
        duration_sec=info.get("duration"),
        thumbnail_url=info.get("thumbnail"),
        music_track=None,
        views=info.get("view_count") or 0,
        likes=info.get("like_count") or 0,
        comments=info.get("comment_count") or 0,
        shares=0,
        data_completeness="partial",
        direct_media_url=None,
        raw={},
    )


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: test_single_video.py <youtube-url>", file=sys.stderr)
        return 2
    url = sys.argv[1]

    settings = load_settings()
    print(f"Fetching metadata for {url} ...")
    raw = fetch_metadata(url)
    print(f"  title: {raw.caption.splitlines()[0][:80]}")
    print(f"  views: {raw.views:,}  likes: {raw.likes:,}  comments: {raw.comments:,}  duration: {raw.duration_sec}s")

    scored = ranking.rank_candidates([raw])[0]

    run_id = storage.make_run_id("single-video-test")
    paths = storage.RunPaths(settings.data_dir, run_id)
    paths.ensure_dirs()
    storage.write_manifest(paths, {
        "run_id": run_id, "niche": "single-video-test", "platforms": ["youtube"],
        "per_platform_limit": 1, "since_days": 9999, "recency_half_life_days": 30.0, "dry_run": False,
    })

    from content_scout.models import new_brief
    brief_path = paths.brief_path("youtube", raw.video_id)
    storage.write_brief(brief_path, new_brief(scored, run_id))

    print(f"\nProcessing (download -> transcribe -> OCR -> keyframes) ...")
    brief = pipeline.process_video(
        brief_path,
        keep_media=True,  # keep video/audio so we can spot-check them
        skip_ocr=False,
        skip_transcribe=False,
        fps=2.0,
        num_keyframes=6,
        whisper_model="small",
    )

    print(f"\nFinal status: {brief['status']}")
    if brief.get("error"):
        print(f"Error: {brief['error']}")
    print(f"Run dir: {paths.run_dir}")
    print(f"Brief: {brief_path}")
    return 0 if brief["status"] != "error" else 1


if __name__ == "__main__":
    raise SystemExit(main())
