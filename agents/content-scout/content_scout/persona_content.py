"""Turns a finished content-scout run's findings into new on-brand posts for a persona —
the piece that turns "here's what's trending in this niche" into "here's what Ivy should
post today": one Higgsfield generation prompt + one caption per day requested.

Calls the Anthropic API directly, the same pattern as visual/auto_analyze.py and
report/weekly.py, so this runs unattended in the same GitHub Actions job as `analyze`.

Hard rule baked into the prompt below, not left to chance: identity is held by the image
reference(s) passed at generation time (a Soul id + single reference, or — as of 2026-09-29,
after live testing showed the Soul+single-reference combo just reproduces the reference's
scene regardless of the prompt — multiple angle references via nano_banana_pro, see
ivy-daily-content.yml) — the *text* prompt this module writes must describe
scene/pose/wardrobe/lighting only, and must NOT redescribe the person's face/skin/hair/eyes.
Doing that (a "physicalDesc") is exactly the bug that caused Ivy's face-drift earlier in
this project (see higgsfieldGenerate.js's buildFaceInstruction history) — this module
exists to produce new content, not to reopen that bug.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from content_scout.visual.auto_analyze import _call_claude, _strip_fences

PLAN_SCHEMA_HINT = """Respond with ONLY a JSON object (no markdown fences, no commentary), \
with exactly this shape:
{
  "days": [
    {
      "generation_prompt": "the full Higgsfield generation prompt text for one image",
      "caption": "the social caption to post alongside it, in the persona's voice",
      "hashtags": ["3-6 short hashtags, no # symbol"],
      "story_text": "a short (<=15 words), casual, in-the-moment line for an Instagram Story \
overlay on the SAME image — different tone from the feed caption: like a quick aside to a \
friend, not a polished post. Can be a question, a one-liner, or a mini poll prompt. No hashtags."
    }
  ]
}
"days" must have exactly NUM_DAYS entries, each one a genuinely different scene/pose/
outfit/setting from the others — no two days should read like the same photo."""

PROMPT_RULES = """Hard rules for every "generation_prompt" you write:
- Describe ONLY scene, pose, camera framing, lighting, wardrobe, and setting.
- Do NOT describe the person's face, skin, hair color, eye color, or any physical trait —
  those are locked by separately-supplied identity reference image(s) and restating them in
  text is what causes visual drift (a documented, already-fixed bug in this project).
- Open with an instruction to faithfully recreate the reference person's face/identity
  exactly as shown across the reference images, then move straight to the new scene — never
  "reimagine" or "reinterpret" the person.
- Keep it to one clear scene per image; avoid multi-panel or composite instructions.
- AUTHENTICITY (feedback from Iddo, 2026-09-30 — a too-perfect/empty background reads as
  fake): the setting must look like a real candid moment, not a staged photoshoot. Include at
  least one grounding imperfection — a person or two faintly visible in the background (out of
  focus, going about their day), natural background clutter/imperfection, or a shallow-depth-
  of-field blur on the background — and avoid describing picture-perfect, deserted, magazine-
  cover framing.
- LOCATION CONTINUITY (feedback from Iddo, 2026-09-30): Ivy is based in Australia (Byron Bay /
  Sydney — see the persona's "Content world"). Default every day's setting to Australia unless
  you were explicitly told this batch is a specific travel arc (e.g. "5-day Bali trip") — in
  that case ALL days in the batch must stay consistent with that one destination, framed as a
  real trip (arrival/exploring/local-life beats), not a different country each day with no
  narrative. Never invent a new country for a single unrelated day.
"""


def _load_persona(persona_dir: Path) -> dict[str, Any]:
    persona_json = json.loads((persona_dir / "persona.json").read_text(encoding="utf-8"))
    md_candidates = list(persona_dir.glob("*.md"))
    persona_md = md_candidates[0].read_text(encoding="utf-8") if md_candidates else ""
    return {"json": persona_json, "md": persona_md}


def _collect_inspiration(briefs: list[dict[str, Any]]) -> str:
    lines = []
    for b in briefs:
        va = b.get("visual_analysis", {})
        if va.get("status") != "done":
            continue
        meta = b["metadata"]
        lines.append(
            f"- @{meta['author_handle']} | format: {va.get('format_archetype')} | "
            f"hook: {va.get('hook_first_3_sec')} | wardrobe/setting: {va.get('wardrobe_style_setting')} | "
            f"lighting: {va.get('lighting')} | caption style: {meta['caption'][:140]!r} | "
            f"engagement read: {va.get('read')}"
        )
    return "\n".join(lines) or "(no analyzed inspiration posts in this run — write from the persona profile alone)"


def generate_daily_plan(
    briefs: list[dict[str, Any]], persona_dir: Path, num_days: int, api_key: str
) -> list[dict[str, Any]]:
    """Returns a list of {generation_prompt, caption, hashtags} dicts, length num_days."""
    persona = _load_persona(persona_dir)
    inspiration = _collect_inspiration(briefs)

    prompt = f"""You are writing {num_days} day(s) of social content for an AI persona, grounded in \
real recent posts from accounts in her niche (below) — not generic ideas.

=== PERSONA ===
{persona['md']}

=== RECENT INSPIRATION FROM THE NICHE (real accounts, analyzed this run) ===
{inspiration}

=== YOUR TASK ===
Write {num_days} day(s) of content. Each day needs a Higgsfield generation prompt (a new \
scene/pose/outfit for this persona) and a caption in her voice — draw on what's actually \
working in the inspiration above (format, hook style, setting) without copying any single \
post, and vary each day from the others.

{PROMPT_RULES}

{PLAN_SCHEMA_HINT.replace("NUM_DAYS", str(num_days))}
"""
    raw = _call_claude(api_key, [{"type": "text", "text": prompt}], max_tokens=800 * max(num_days, 1) + 500)
    data = json.loads(_strip_fences(raw))
    days = data["days"]
    if len(days) != num_days:
        raise ValueError(f"Expected {num_days} day(s), Claude returned {len(days)}")
    return days


def write_content_plan(run_dir: Path, days: list[dict[str, Any]]) -> Path:
    out_path = run_dir / "content_plan.json"
    out_path.write_text(json.dumps({"days": days}, indent=2), encoding="utf-8")
    return out_path
