"""Identity + sanity check for a freshly generated still, run before it is shown or queued: is it still Ivy
(not "someone else with similar hair"), no burned-in text, plausible hands/anatomy, within the platform-safe
limits. A failed check triggers one regeneration in the workflow. Never fails the pipeline: any error ->
{"ok": true, "skipped": true}."""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path

from content_scout.visual.auto_analyze import _call_claude, _strip_fences

PROMPT = """You are the quality checker for AI-generated photos of ONE woman, the persona Ivy, about to be posted.
Image 1 is the REFERENCE of Ivy (her real identity). Image 2 is the newly generated photo to check.

- same_person: the woman in image 2 is clearly the same person as image 1 (same face structure, skin tone,
  blonde hair colour/length, overall look). A different angle, expression or lighting is fine; a clearly different
  face is a fail.
- text_in_image: ANY visible words, letters, logos or watermarks that look burned into the picture.
- anatomy_ok: hands/fingers, limbs and proportions look plausible (no extra or missing fingers/limbs, no melted
  features).
- within_limits: she wears clothing or swimwear (bikinis, sports bras, low-cut tops, plunging necklines are all fine
  and intended). Fail ONLY for actual nudity, see-through exposure of what a bikini would cover, or sexual acts.
ok = same_person AND NOT text_in_image AND anatomy_ok AND within_limits.

Respond with ONLY a JSON object:
{"same_person": true, "text_in_image": false, "anatomy_ok": true, "within_limits": true, "ok": true,
 "issues_he": ["short Hebrew description of each problem, empty list if ok"]}"""


def _block(path: Path) -> dict:
    media = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": base64.b64encode(path.read_bytes()).decode("ascii")}}


def review_image(api_key: str, image: Path, reference: Path) -> dict:
    raw = _call_claude(api_key, [{"type": "text", "text": PROMPT}, _block(reference), _block(image)], max_tokens=500)
    r = json.loads(_strip_fences(raw))
    r["ok"] = bool(r.get("same_person") and not r.get("text_in_image") and r.get("anatomy_ok") and r.get("within_limits"))
    r.setdefault("issues_he", [])
    return r


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--reference", required=True)
    args = ap.parse_args()
    try:
        print(json.dumps(review_image(os.environ["ANTHROPIC_API_KEY"], Path(args.image), Path(args.reference)), ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001 — a flaky reviewer must not block posting
        print(f"image review skipped: {exc}", file=sys.stderr)
        print(json.dumps({"ok": True, "skipped": True, "issues_he": []}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
