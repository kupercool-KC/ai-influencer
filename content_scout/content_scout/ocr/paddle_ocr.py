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

        # PaddleOCR 3.x renamed use_angle_cls -> use_textline_orientation and dropped show_log.
        _ocr_model_cache[lang] = PaddleOCR(use_textline_orientation=True, lang=lang)
    return _ocr_model_cache[lang]


def _frame_index(path: Path) -> int:
    m = _INDEX_RE.search(path.stem)
    return int(m.group(1)) if m else 0


def _frame_text(ocr, path: Path) -> tuple[str, float]:
    # PaddleOCR 3.x: .predict() returns a list of OCRResult dicts with parallel
    # rec_texts/rec_scores/rec_boxes arrays (rec_boxes: [x1, y1, x2, y2] per line),
    # replacing the old .ocr()'s [[box, (text, conf)], ...] shape.
    result = ocr.predict(str(path))
    if not result or not result[0].get("rec_texts"):
        return "", 0.0
    r = result[0]
    lines = sorted(
        zip(r["rec_texts"], r["rec_scores"], r["rec_boxes"]),
        key=lambda item: (item[2][1], item[2][0]),  # top-to-bottom, then left-to-right
    )
    texts = [text.strip() for text, _, _ in lines if text.strip()]
    confidences = [score for _, score, _ in lines]
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
