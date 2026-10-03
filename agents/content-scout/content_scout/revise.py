"""Twiking: turn the owner's plain-words change ("slide 2 with more sun", "different outfit") into ONE new
generation prompt for ONE picture of an existing content item, so only that picture is regenerated.

  python -m content_scout.revise --item item.json --instruction "..." --persona-dir "docs/personas/Ivy Vale"
prints {"slide": 0, "new_prompt": "...", "summary_he": "..."}  (or {"unsupported": "..."}).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from content_scout.persona_content import PROMPT_RULES, _load_persona, content_direction
from content_scout.prefs import preferences_block
from content_scout.visual.auto_analyze import _call_claude, _strip_fences

PROMPT = """You are revising ONE picture of an AI persona's post, following the owner's change request.

=== PERSONA ===
{persona}

=== THE POST NOW ===
kind: {kind}
pictures (index: the prompt that made it):
{pictures}
Instagram caption: {caption}
TikTok caption: {tiktok_caption}

=== OWNER'S CHANGE REQUEST ===
{instruction}

{rules}

{direction}

{prefs}

Decide which single picture the request is about (0-based index; if he did not say, pick the one that fits best,
or 0) and write the new full generation prompt for THAT picture only: keep everything he did not ask to change
(same outfit/location/mood as the other pictures so the set still belongs together) and apply his change.
Respond with ONLY JSON: {{"slide": 0, "new_prompt": "...", "summary_he": "one short Hebrew sentence of what changed"}}"""


def revise(item: dict, instruction: str, persona_dir: Path, api_key: str) -> dict:
    kind = item.get("kind") or "image"
    if kind == "video":
        return {"unsupported": "video"}
    plan = item.get("plan") or {}
    prompts = plan.get("carousel_prompts") or [plan.get("generation_prompt", "")]
    images = (item.get("media") or {}).get("images") or [(item.get("media") or {}).get("image")]
    n = max(len(images), 1)
    pictures = "\n".join(f"{i}: {prompts[i] if i < len(prompts) else '(no prompt recorded)'}" for i in range(n))
    persona = _load_persona(persona_dir)
    prompt = PROMPT.format(
        persona=persona["md"], kind=kind, pictures=pictures, caption=plan.get("caption", ""),
        tiktok_caption=(plan.get("tiktok_caption") or "")[:600], instruction=instruction,
        rules=PROMPT_RULES, direction=content_direction(), prefs=preferences_block(),
    )
    result = json.loads(_strip_fences(_call_claude(api_key, [{"type": "text", "text": prompt}], max_tokens=1200)))
    slide = int(result.get("slide", 0))
    if not 0 <= slide < n:
        slide = 0
    return {"slide": slide, "new_prompt": result["new_prompt"], "summary_he": result.get("summary_he", "")}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--item", required=True)
    ap.add_argument("--instruction", required=True)
    ap.add_argument("--persona-dir", required=True)
    args = ap.parse_args()
    item = json.loads(Path(args.item).read_text(encoding="utf-8"))
    print(json.dumps(revise(item, args.instruction, Path(args.persona_dir), os.environ["ANTHROPIC_API_KEY"]), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
