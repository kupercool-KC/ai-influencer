"""On-screen burned-in text extraction: PaddleOCR over the deduped frame set produced by
media/frames.py, merging consecutive frames with matching text into a single segment
(the same "sample + dedupe + OCR + merge" pattern the VideOCR-style tools use).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

_INDEX_RE = re.compile(r"(\d+)")

_ocr_model_cache: dict[str, Any] = {}


def _get_ocr(lang: str = "en"):
    if lang not in _ocr_model_cache:
        from paddleocr import PaddleOCR

        _ocr_model_cache[lang] = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
    return _ocr_model_cache[lang]


def _frame_index(path: Path) -> int:
    m = _INDEX_RE.search(path.stem)
    return int(m.group(1)) if m else 0


def _frame_text(ocr, path: Path) -> tuple[str, float]:
    result = ocr.ocr(str(path), cls=True)
    if not result or not result[0]:
        return "", 0.0
    # Sort boxes into rough reading order: top-to-bottom, then left-to-right.
    lines = sorted(result[0], key=lambda box: (box[0][0][1], box[0][0][0]))
    texts = [line[1][0].strip() for line in lines if line[1][0].strip()]
    confidences = [line[1][1] for line in lines]
    text = " ".join(texts)
    avg_conf = sum(confidences) / len(confidences) if confidences else 0.0
    return text, avg_conf


def ocr_deduped_frames(frame_paths: list[Path], fps: float, lang: str = "en") -> dict[str, Any]:
    """Run OCR on each (already-deduped) frame and merge consecutive identical-text frames
    into segments with start_sec/end_sec. Returns {"segments": [...], "full_text_concat": str}.
    """
    if not frame_paths:
        return {"segments": [], "full_text_concat": ""}

    ocr = _get_ocr(lang)
    frame_dt = 1.0 / fps if fps > 0 else 0.5

    segments: list[dict[str, Any]] = []
    for path in frame_paths:
        idx = _frame_index(path)
        t = max(idx - 1, 0) * frame_dt
        text, conf = _frame_text(ocr, path)
        if not text:
            continue
        if segments and segments[-1]["text"] == text:
            segments[-1]["end_sec"] = round(t + frame_dt, 2)
        else:
            segments.append(
                {"start_sec": round(t, 2), "end_sec": round(t + frame_dt, 2), "text": text, "confidence": round(conf, 3)}
            )

    full_text_concat = "\n".join(s["text"] for s in segments)
    return {"segments": segments, "full_text_concat": full_text_concat}
