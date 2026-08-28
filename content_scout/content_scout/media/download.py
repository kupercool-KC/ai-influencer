"""Media download: try the platform's own direct media URL first (fast, no extra tool),
fall back to yt-dlp against the page URL (handles auth/signing quirks yt-dlp already solves).
Then extract a 16kHz mono WAV for faster-whisper.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import requests

CHUNK_SIZE = 1 << 16  # 64 KiB


class DownloadError(RuntimeError):
    pass


def _download_direct(url: str, dest: Path) -> None:
    with requests.get(url, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=CHUNK_SIZE):
                if chunk:
                    f.write(chunk)


def _download_via_ytdlp(page_url: str, dest: Path) -> None:
    import yt_dlp

    dest.parent.mkdir(parents=True, exist_ok=True)
    ydl_opts = {
        "outtmpl": str(dest.with_suffix("")) + ".%(ext)s",
        # "mp4/best" alone can match a video-only stream on platforms (YouTube included)
        # that serve audio as a separate DASH track — explicitly ask for both and let
        # yt-dlp mux them via ffmpeg so the output always has an audio stream.
        "format": "bestvideo+bestaudio/best",
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([page_url])

    # yt-dlp names the output by its own extension guess; normalize to dest's exact name.
    if not dest.exists():
        candidates = list(dest.parent.glob(dest.stem + ".*"))
        if not candidates:
            raise DownloadError(f"yt-dlp reported success but no output file found for {page_url}")
        candidates[0].rename(dest)


def download_video(
    *, direct_media_url: str | None, page_url: str, video_dir: Path
) -> tuple[Path, str]:
    """Download a video into `video_dir/media/video.mp4`. Returns (path, method)."""
    dest = video_dir / "media" / "video.mp4"
    if direct_media_url:
        try:
            _download_direct(direct_media_url, dest)
            return dest, "direct_url"
        except Exception:
            # Direct CDN URLs on these platforms can expire/require specific headers —
            # fall through to yt-dlp against the page URL rather than failing the video.
            pass
    _download_via_ytdlp(page_url, dest)
    return dest, "yt-dlp"


def extract_audio(video_path: Path) -> Path:
    """Extract 16kHz mono WAV audio for whisper. Requires ffmpeg on PATH."""
    audio_path = video_path.with_name("audio.wav")
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-ac", "1", "-ar", "16000", "-vn",
        str(audio_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise DownloadError(f"ffmpeg audio extraction failed for {video_path}: {result.stderr[-2000:]}")
    return audio_path


def delete_media(video_dir: Path) -> None:
    media_dir = video_dir / "media"
    if not media_dir.exists():
        return
    for f in media_dir.iterdir():
        f.unlink(missing_ok=True)
