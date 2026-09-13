"""Transcript acquisition: prefer a platform's native captions when available (YouTube auto-
captions via yt-dlp), else fall back to faster-whisper on the extracted audio. TikTok/Instagram
go straight to whisper in v1 — native TikTok subtitle links exist in the Apify actor's output
but aren't wired up yet (noted as a future optimization in platforms/tiktok.py).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

_VTT_CUE_RE = re.compile(
    r"(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})"
)
_TAG_RE = re.compile(r"<[^>]+>")


def _vtt_timestamp_to_sec(ts: str) -> float:
    parts = ts.split(":")
    if len(parts) == 3:
        h, m, s = parts
    else:
        h, m, s = "0", parts[0], parts[1]
    return int(h) * 3600 + int(m) * 60 + float(s)


def _parse_vtt(vtt_text: str) -> list[dict[str, Any]]:
    lines = vtt_text.splitlines()
    segments: list[dict[str, Any]] = []
    i = 0
    while i < len(lines):
        m = _VTT_CUE_RE.search(lines[i])
        if m:
            start, end = _vtt_timestamp_to_sec(m.group(1)), _vtt_timestamp_to_sec(m.group(2))
            i += 1
            text_lines = []
            while i < len(lines) and lines[i].strip() and not _VTT_CUE_RE.search(lines[i]):
                text_lines.append(_TAG_RE.sub("", lines[i]).strip())
                i += 1
            text = " ".join(t for t in text_lines if t)
            if text and (not segments or segments[-1]["text"] != text):
                segments.append({"start": round(start, 2), "end": round(end, 2), "text": text})
        else:
            i += 1
    return segments


def try_native_captions(platform: str, page_url: str, work_dir: Path, lang: str = "en") -> dict[str, Any] | None:
    """Only implemented for YouTube (yt-dlp auto-subs). Returns None if unavailable."""
    if platform != "youtube":
        return None
    import yt_dlp

    work_dir.mkdir(parents=True, exist_ok=True)
    outtmpl = str(work_dir / "captions.%(ext)s")
    ydl_opts = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": [lang],
        "subtitlesformat": "vtt",
        "outtmpl": outtmpl,
        "quiet": True,
        "no_warnings": True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([page_url])
    except Exception:
        return None

    vtt_files = list(work_dir.glob("captions*.vtt"))
    if not vtt_files:
        return None
    segments = _parse_vtt(vtt_files[0].read_text(encoding="utf-8", errors="ignore"))
    if not segments:
        return None
    full_text = " ".join(s["text"] for s in segments)
    return {"source": "native_captions", "language": lang, "full_text": full_text, "segments": segments}


_whisper_model_cache: dict[str, Any] = {}


def _get_whisper_model(model_size: str = "small"):
    if model_size not in _whisper_model_cache:
        from faster_whisper import WhisperModel

        _whisper_model_cache[model_size] = WhisperModel(model_size, device="cpu", compute_type="int8")
    return _whisper_model_cache[model_size]


def transcribe_with_whisper(audio_path: Path, model_size: str = "small") -> dict[str, Any]:
    model = _get_whisper_model(model_size)
    segments_iter, info = model.transcribe(str(audio_path), beam_size=5, vad_filter=True)
    segments = [
        {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments_iter
    ]
    full_text = " ".join(s["text"] for s in segments)
    return {
        "source": "whisper",
        "language": info.language,
        "full_text": full_text,
        "segments": segments,
    }


def get_transcript(
    *, platform: str, page_url: str, audio_path: Path, work_dir: Path, model_size: str = "small"
) -> dict[str, Any]:
    native = try_native_captions(platform, page_url, work_dir)
    if native:
        return native
    return transcribe_with_whisper(audio_path, model_size=model_size)
