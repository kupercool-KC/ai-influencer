"""Video plan -> Seedance-ready prompt, per docs/video-prompt-spec.md (§4 plan, §5 assembly,
§7 validator). The LLM writes only the parts that change per video; every identity-related
clause is a fixed constant here, byte-identical on every run (paraphrasing it is a known
drift trigger — spec §9), and the validator fails the run before any credits are spent."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from content_scout.persona_content import _load_persona, content_direction
from content_scout.prefs import preferences_block
from content_scout.visual.auto_analyze import _call_claude, _strip_fences

IDENTITY_OPENER = (
    "Faithfully recreate the reference person's face and identity exactly as shown across the "
    "reference images — same person, no alterations. New scene: "
)

RECIPES = {
    "lifestyle_plandid": {"min": 8, "max": 12, "max_beats": 1, "label": "single continuous shot"},
    "day_in_life": {"min": 12, "max": 15, "max_beats": 4, "label": None},  # label = "{n}-cut"
}

STYLE_ANCHOR = (
    "Reels Native — handheld vertical phone footage, natural unedited look, slight organic "
    "camera sway, real-world imperfections"
)

# The spec says ~220 words; the fixed identity/continuity/negative/closing clauses alone are ~230, so the
# LLM-written part has only a few dozen words of room.
MAX_PROMPT_WORDS = 300

MOVEMENT_WORDS = {"pan", "tilt", "dolly", "push", "pull", "track", "orbit", "zoom", "handheld", "static", "locked"}
FACE_DESCRIPTOR_RE = re.compile(
    r"\b(blue|green|brown|hazel|grey|gray)\s+eyes\b|\bblonde\b|\bbrunette\b|\bfreckles?\b|"
    r"\bskin\s+tone\b|\bjawline\b|\bcheekbones?\b|\bcomplexion\b",
    re.IGNORECASE,
)

# Learned 2026-10-03 from a live clip: a source reel built as a "three mornings" montage made Seedance
# stage each cut as a different day — different outfit, different room, burned-in "sunday"/"monday"
# labels, and a first cut that looked undressed. Only the MECHANIC of a source may be reused, never
# a multi-day / multi-outfit / multi-location structure, so the plan is validated against it here.
MULTI_STORY_RE = re.compile(
    r"\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\bday\s*(one|two|three|\d)\b|"
    r"\b(two|three|four|five|several|different|multiple|many)\s+(?:\w+\s+){0,2}(mornings|days|outfits|looks|locations|places|rooms)\b|"
    r"\bmontage\b|\bnext\s+(day|morning)\b|\bchang(e|es|ed|ing)\s+(into|outfits?|clothes)\b|"
    r"\bgets?\s+dressed\b|\boutfit\s+change\b|\bhours?\s+later\b",
    re.IGNORECASE,
)
UNDRESSED_RE = re.compile(
    r"\b(pyjamas?|pajamas?|lingerie|underwear|nightwear|sleepwear|nightgown|bikini|topless|undress\w*|"
    r"bare[- ]legs?|bare[- ]chested|nude)\b",
    re.IGNORECASE,
)
CONTINUITY_RULES = (
    "ONE MOMENT, ONE PLACE, ONE OUTFIT: every beat continues the same scene — same room, same clothes, "
    "same light, same props, no time jumps. The wardrobe is full everyday clothing (top + bottoms, or a "
    "dress), never sleepwear or anything revealing, and never changes. If the source reel jumps between "
    "days/outfits/places, keep only its hook idea and film it as one continuous moment."
)

PLAN_SCHEMA = """Respond with ONLY a JSON object (no markdown fences, no commentary), exactly:
{
  "recipe": "lifestyle_plandid | day_in_life",
  "duration_s": integer (lifestyle_plandid: 8-12, one beat; day_in_life: 12-15, 3-4 beats),
  "hook_type": "visual surprise | motion into frame | direct address | object reveal | one line",
  "concept": "one line, <= 12 words",
  "still_prompt": "scene ONLY for the vertical 9:16 first frame (pose, framing, light, setting) — \
a quick candid phone-snap look with her FACE clearly visible (at least head and shoulders, turned partly \
toward the camera) and her whole outfit in frame. Never describe her face, skin, hair or eyes.",
  "wardrobe": "<= 12 words, full everyday clothes (top + bottoms or a dress) from her palette: sand, sage, cream, terracotta, minimal jewellery",
  "props": "<= 12 words, or 'none'",
  "environment": "<= 12 words: place + light source + one sensory detail (Australia unless told otherwise)",
  "beats": [{"start": 0, "end": 2, "camera": "framing + exactly ONE movement word, e.g. 'MCU, handheld'", \
"action": "ONE action, <= 14 words, no 'and then'"}],
  "caption": "INSTAGRAM caption: ONE short sentence at most, in her voice",
  "hashtags": ["2-4 short Instagram hashtags, no # symbol"],
  "tiktok_caption": "TIKTOK caption: long, natural, unfiltered, many sentences (see platform voice rules)",
  "tiktok_hashtags": ["10-20 TikTok hashtags, no # symbol"],
  "caption_overlay": "optional short on-screen text suggestion, or null"
}
Rules: beats must cover 0..duration_s exactly with no gaps; the first beat ends by 2s; every beat is at
least 2s; at most 4 beats. Keep the MECHANIC that made the source work (its hook/pacing idea),
rebuild everything else in Ivy's world — never reuse the source's scene, script, music or text.
""" + CONTINUITY_RULES


def validate_plan(plan: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    recipe = RECIPES.get(plan.get("recipe", ""))
    if not recipe:
        return [f"unknown recipe {plan.get('recipe')!r}"]
    dur = plan.get("duration_s")
    if not isinstance(dur, int) or not (recipe["min"] <= dur <= recipe["max"]):
        errs.append(f"duration_s {dur!r} outside {recipe['min']}-{recipe['max']} for {plan['recipe']}")
    beats = plan.get("beats") or []
    if not beats or len(beats) > recipe["max_beats"]:
        errs.append(f"{len(beats)} beats, allowed 1-{recipe['max_beats']} for {plan['recipe']}")
    t = 0
    for i, b in enumerate(beats):
        if b.get("start") != t:
            errs.append(f"beat {i} starts at {b.get('start')} but previous ended at {t}")
        t = b.get("end", t)
        if (b.get("end", 0) - b.get("start", 0)) < 2 and len(beats) > 1:
            errs.append(f"beat {i} shorter than 2s")
        if len(str(b.get("action", "")).split()) > 20 or re.search(r"\band then\b", str(b.get("action", "")), re.I):
            errs.append(f"beat {i} action is not a single short action")
        words = {w for w in re.findall(r"[a-z]+", str(b.get("camera", "")).lower()) if w in MOVEMENT_WORDS}
        if len(words) != 1:
            errs.append(f"beat {i} camera must contain exactly one movement word, found {sorted(words)}")
    if beats and t != dur:
        errs.append(f"beats end at {t}s but duration_s is {dur}")
    if beats and beats[0].get("end", 99) > 2 and len(beats) > 1:
        errs.append("first beat must end by 2s")
    written = " ".join(str(plan.get(k, "")) for k in ("still_prompt", "wardrobe", "props", "environment", "concept"))
    written += " " + " ".join(str(b.get("action", "")) for b in beats)
    if FACE_DESCRIPTOR_RE.search(written):
        errs.append("face/skin/hair/eye descriptor in an LLM-written field")
    story = written + " " + " ".join(str(plan.get(k, "")) for k in ("hook_type", "caption_overlay"))
    if MULTI_STORY_RE.search(story):
        errs.append("the plan jumps between days/outfits/places — film ONE continuous moment in one place, "
                    "one outfit (no weekday names, no 'three mornings', no outfit changes)")
    if UNDRESSED_RE.search(written):
        errs.append("wardrobe/scene must be full everyday clothing — no sleepwear, underwear, bare-legs or revealing wording")
    return errs


def assemble_prompt(plan: dict[str, Any]) -> str:
    recipe = RECIPES[plan["recipe"]]
    n = len(plan["beats"])
    shots = recipe["label"] or f"{n}-cut"
    action = "\n".join(
        f"0:{b['start']:02d} to 0:{b['end']:02d} — {b['camera']}. {b['action']}" for b in plan["beats"]
    )
    return (
        f"FORMAT: {plan['duration_s']}s / {shots} / {plan['hook_type']} — {plan['concept']}, GOLDEN HOUR\n"
        "SUBJECT: @image_1.\n"
        f"WARDROBE: As shown in @image_1 — {plan['wardrobe']}, consistent throughout.\n"
        f"PROPS: {plan.get('props') or 'none'}\n"
        f"ENVIRONMENT: {plan['environment']}\n"
        f"STYLE ANCHOR: {STYLE_ANCHOR}. @image_2 informs identity only — never scene, wardrobe or lighting.\n"
        "DELIVERY: No dialogue.\n"
        "LOGIC RULE: One continuous take per beat, no unmotivated cuts. Face of @image_1 is fixed and "
        "consistent throughout — same bone structure, eye color, skin tone, jawline, nose. Zero drift. "
        "Only one @image_1 in frame. Lighting warm and golden throughout, never cool. Hand gestures "
        "evolve organically — no looping. Real-time playback speed throughout — never slow motion; "
        "motion reads like a handheld phone recording, not a slowed-down cinematic clip.\n"
        "CONTINUITY: one single moment in one place. Every cut keeps the SAME outfit exactly as WARDROBE "
        "(fully clothed in everyday clothing the whole time), the SAME room, time of day and props. "
        "No time jumps, day changes, outfit changes or new locations.\n"
        "NEGATIVE PROMPT: No music, no captions, no on-screen text of any kind (no day names, labels or "
        "watermarks), no outfit change, no scene change, no slow motion, no ramped/slowed playback speed.\n\n"
        f"ACTION:\n{action}\n"
        "End cleanly with the character holding a final pose, no talking or lip movement."
    )


def generate_video_plan(
    brief: dict[str, Any], persona_dir: Path, api_key: str, extra_direction: str | None = None
) -> dict[str, Any]:
    """Returns one content-plan 'day' dict that includes the assembled Seedance `video_prompt`."""
    persona = _load_persona(persona_dir)
    va = brief.get("visual_analysis", {})
    meta = brief["metadata"]
    source = (
        f"@{meta['author_handle']} | format: {va.get('format_archetype')} | hook: {va.get('hook_first_3_sec')} | "
        f"pacing: {va.get('pacing_editing_style')} | composition: {va.get('shot_composition')} | "
        f"what it is: {va.get('what_its_about')} | read: {va.get('read')} | caption: {meta['caption'][:200]!r}"
    )
    direction = f"\n=== DIRECTION FROM THE OWNER ===\n{extra_direction.strip()}\n" if extra_direction else ""
    base_prompt = f"""You are planning ONE short vertical video (Reel/TikTok) for an AI persona, rebuilt from the
mechanic of a real source post (below) — adapting, never copying.

=== PERSONA ===
{persona['md']}

=== SOURCE POST (analyzed) ===
{source}
{direction}
=== STANDING CONTENT DIRECTION ===
{content_direction()}
{preferences_block()}

{PLAN_SCHEMA}"""

    feedback = ""
    for attempt in range(3):
        raw = _call_claude(api_key, [{"type": "text", "text": base_prompt + feedback}], max_tokens=3500)
        plan = json.loads(_strip_fences(raw))
        errs = validate_plan(plan)
        if not errs:
            words = len(assemble_prompt(plan).split())
            if words > MAX_PROMPT_WORDS:
                errs = [f"assembled prompt is {words} words, max {MAX_PROMPT_WORDS} — shorten concept/wardrobe/props/"
                        "environment (<= 12 words each) and every beat action (<= 14 words)"]
        if not errs:
            break
        feedback = "\n\nYour previous answer broke these rules, fix them and answer again:\n- " + "\n- ".join(errs)
    else:
        raise ValueError(f"Video plan failed validation after 3 tries: {errs}")

    prompt = assemble_prompt(plan)
    return {
        "generation_prompt": (
            IDENTITY_OPENER + plan["still_prompt"].rstrip(". ")
            + f". She wears {plan['wardrobe'].rstrip('. ')}, fully clothed in everyday clothing; her face is clearly visible."
        ),
        "wardrobe": plan["wardrobe"],
        "caption": plan["caption"],
        "hashtags": plan.get("hashtags", []),
        "tiktok_caption": plan.get("tiktok_caption", ""),
        "tiktok_hashtags": plan.get("tiktok_hashtags", []),
        "video_prompt": prompt,
        "video_duration_s": plan["duration_s"],
        "caption_overlay": plan.get("caption_overlay"),
        "recipe": plan["recipe"],
        "concept": plan["concept"],
    }
