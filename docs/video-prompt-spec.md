# Video prompt spec — from a Scout report to a Seedance-ready prompt

Status: **spec, not yet implemented** (2026-09-30). Implementation lands in
`agents/content-scout/content_scout/persona_content.py` + a validator + a second
generation stage in `.github/workflows/ivy-daily-content.yml`.

Sources this spec is built on:
- `docs/seedance-influencer-guide.md` — field structure, shot families, identity lock,
  bug inventory (the house rules; this spec does not restate them, it wires them in).
- Our own spec — `AI_Influencer_Portfolio.docx`, Character A (Ivy): short movement/ritual
  reels, hook in 1–2 s, optimise for saves and rewatches, daily posting, warm first-person
  voice, AI disclosure in bio.
- Live findings from this repo (2026-09-29): single-reference generation copies the
  reference's *scene*; multi-angle references (`nano_banana_pro`) vary the scene while
  identity holds.
- Market + community research (2026-09-29/30), summarised in §9.

---

## 1. Principle: adapt the mechanic, never copy the video

The Scout report tells us **why** a reel worked (hook mechanic, format, pacing). The prompt
takes that mechanic and rebuilds it inside Ivy's world — her locations, wardrobe palette,
voice. It never reuses the source creator's script, scene, music, or on-screen text.

## 2. Pipeline

```
Scout (instagram.py / discover_single_url)
  → Analyze (auto_analyze.py → visual_analysis per video)
  → Plan    (persona_content.py → video plan JSON, §4)
  → Validate (§7 — deterministic, fails the run before any credits are spent)
  → Stage A: anchor still   — nano_banana_pro, 3 angle refs (already live)
  → Stage B: video          — Seedance 2.0 image-to-video, anchor still = @image_1
  → Stage C (optional): voice — ElevenLabs TTS → @audio_1 (§8)
  → Buffer DRAFT (video + anchor still as cover) → human approval
```

Why two stages: identity and scene are solved once, in the still (proven live). The
video model then only has to animate an image that is already correct — which is also
the community-standard "anchor frame / golden image" workflow (§9). The still doubles as
the post's cover frame.

## 3. Scout report → prompt field mapping

| `visual_analysis` field | Used for | Rule |
|---|---|---|
| `format_archetype` | Recipe choice (§5) | day-in-the-life / routine → **Day-in-Life multi-cut**; stretch/flow/moment → **Lifestyle Plandid oner**; talking/storytime → **Talking Head** (only once a voice exists) |
| `hook_first_3_sec` | FORMAT hook type + the 0:00–0:02 beat | Keep the *mechanic* (e.g. "relatable failure", "motion into frame"); rebuild the content in Ivy's world |
| `pacing_editing_style` | Shot family + cut count | Fast-cut source → 3–4 cuts max. Never more; one generation can't hold a 10-cut montage |
| `shot_composition` | STYLE ANCHOR preset | selfie/handheld → Reels Native or Vlog Selfie; locked → Static Observational |
| `lighting` | Inspiration only | Always resolved to Ivy's palette (warm, golden, natural) — see lighting stack in the guide |
| `wardrobe_style_setting` | Inspiration only | Resolved to her wardrobe bible: sand, sage, cream, terracotta, minimal jewellery |
| `on_screen_graphics_style` | **Not generated** | Becomes a `caption_overlay` suggestion for post-production; generation is always "no captions" |
| `read` | Which element to keep | The one thing that made it work is the one thing the prompt must preserve |
| transcript / OCR | Dialogue seed (voice only) | Rewritten in Ivy's voice, never copied; within the word budget (§6) |
| engagement stats | Source selection | The top-ranked analyzed video of the run is the day's source |

## 4. Plan output (what the LLM returns)

The LLM writes only the parts that change per video. Everything identity-related is a
fixed constant in code, **byte-identical on every run** — paraphrasing an identity block
is a known drift trigger (§9).

```json
{
  "recipe": "day_in_life | lifestyle_plandid | talking_head",
  "duration_s": 12,
  "hook_type": "visual surprise | motion into frame | direct address | object reveal | one line",
  "concept": "one line",
  "still_prompt": "scene for Stage A (existing rules: scene only, no face description)",
  "wardrobe": "...", "props": "...", "environment": "place + light source + one sensory detail",
  "beats": [
    {"start": 0, "end": 2, "camera": "MCU, handheld", "action": "one action"},
    {"start": 2, "end": 5, "camera": "MS, handheld",  "action": "one action"}
  ],
  "dialogue": null,
  "caption": "...", "hashtags": ["..."], "caption_overlay": "optional on-screen text for post"
}
```

Code then assembles the final prompt from this JSON + the fixed constants (§5).

## 5. Assembled prompt (Seedance 2.0)

Fixed by code (never LLM-written): `SUBJECT`, the identity lock clause, the STYLE ANCHOR
preset text, the reference scope lock, `NEGATIVE PROMPT`, the closing-tail sentence.

```
FORMAT: {duration}s / {single continuous shot | N-cut} / {hook_type} — {concept}, GOLDEN HOUR
SUBJECT: @image_1.
WARDROBE: As shown in @image_1 — {wardrobe}, consistent throughout.
PROPS: {props}
ENVIRONMENT: {environment}
STYLE ANCHOR: {preset}. @image_2 informs identity only — never scene, wardrobe or lighting.
DELIVERY: {"No dialogue." | "Lip-sync driven by @audio_1."}
LOGIC RULE: {shot-family rule}. Face of @image_1 is fixed and consistent throughout — same
bone structure, eye color, skin tone, jawline, nose. Zero drift. Only one @image_1 in frame.
Lighting warm and golden throughout, never cool. Hand gestures evolve organically — no looping.
Real-time playback speed throughout — never slow motion; motion reads like a handheld phone
recording, not a slowed-down cinematic clip.
NEGATIVE PROMPT: No music, no captions, no slow motion, no ramped/slowed playback speed.

ACTION:
{beats as "0:00 to 0:02 — {camera}." + action}
End cleanly with the character holding a final pose, no talking or lip movement.
```

References: `@image_1` = today's anchor still (Stage A output); `@image_2` =
`docs/personas/Ivy Vale/production/character-sheet.jpg`; `@audio_1` = ElevenLabs clip when
voice is used.

Recipes (v1): **Lifestyle Plandid** (oner, no dialogue), **Day-in-Life** (3–4 cuts, no
dialogue). v2: **Talking Head / Storytime** (needs §8). Recipe details: guide, "Influencer
content recipes".

## 6. Length

Our spec doesn't give a number — it says *short* reels, hook in 1–2 s, optimise for
rewatches. Combined with market data and model limits:

| | |
|---|---|
| **Target** | **12 s** |
| Allowed | 8–15 s |
| Lifestyle Plandid | 8–12 s, one continuous shot |
| Day-in-Life | 12–15 s, 3–4 cuts, every cut ≥ 2 s |
| Talking Head (v2) | 8–12 s; spoken words ≤ the guide's budget (8 s ≈ 22–28, 12 s ≈ 38–46) |
| Hook | complete by 0:02, works muted |

Why: 7–15 s has the highest completion rate on Reels; rewatches (a key signal in our spec)
favour short loops; Seedance 2.0 caps at 15 s per generation; creator data shows a split
between 4 s hooks and ~12 s narratives; video cost scales with length. Longer (24–60 s)
formats need 2–4 stitched generations — out of scope for v1.

## 7. Validator (runs before any generation; fails the run on any violation)

- `duration_s` within the recipe's allowed range; beats sum exactly to `duration_s`
- first beat ends at ≤ 2 s; no beat shorter than 2 s; max 4 beats
- each beat's `action` is one action (≤ ~20 words, no "and then")
- `camera` contains exactly one movement word
- no face/skin/hair/eye descriptors anywhere in LLM-written fields
- the word "cinematic" absent when the preset is locked/static
- dialogue word count ≤ budget for the duration (v2)
- assembled prompt contains the identity lock, "No music, no captions", and the closing tail
- assembled prompt ≤ ~220 words

## 8. Voice (ElevenLabs) — v2

- Ivy's voice is **designed, not cloned** (ElevenLabs Voice Design from a text
  description — no real person's voice). Voice ID stored in `persona.json` under `voice`.
- Per video: `dialogue` (≤ word budget) → ElevenLabs TTS → audio file → `@audio_1`.
  Video duration = audio length + a 1–2 s held closing beat.
- `DELIVERY` stays exactly `Lip-sync driven by @audio_1.` — describing the audio's
  character muffles it (guide, bug inventory).
- Secrets: `ELEVENLABS_API_KEY` (repo secret). Voice ID is not secret.
- AI disclosure already required by our spec (bio); a synthetic voice falls under it.

## 9. Model routing + learning loop

### 9.1 Cost reality (measured 2026-09-30 via `higgsfield generate cost`, 9:16)

| Model | Setting | Credits / clip |
|---|---|---|
| Seedance 2.0 Mini | 12 s, 720p | 12 |
| Kling 3.0 Turbo | 10 s, 720p / 1080p | 15 / 20 |
| Kling 3.0 | 10 s std / pro · 15 s std | 20 / 25 · 30 |
| Seedance 2.0 | 12 s 720p fast / 720p / 1080p | 30 / 54 / 108 |
| Seedance 2.5 (omni_reference) | 12 s draft / 720p / 1080p | 36 / 84 / 144 |
| Anchor still (nano_banana_pro 2k) | — | 2 |

Budget: Plus plan, 1,000 subscription credits per billing cycle (renews ~13th), no
rollover. A daily post must average ≤ ~30 credits all-in.

Capability constraint: only the Seedance family accepts extra image references (identity
reinforcement) and `audio_references` (lip-sync). Kling 3.0 on Higgsfield accepts a start
image only. Seedance's `generate_audio` defaults to **true** — set it to `false` for
no-dialogue recipes (music is added on-platform, never generated).

### 9.2 Layer 1 — rules (from day one)

Evaluated in order; first match wins.

1. Plan has `dialogue` → Seedance family (only one that lip-syncs `@audio_1`).
2. Hero slot (1–2 per week, the Scout's top-ranked format of the week) → premium tier
   (Seedance 2.0 1080p), only if the cycle's remaining budget allows.
3. Multi-cut or large-motion recipe → **Seedance 2.0 Mini** — decided 2026-09-30 by Iddo's
   own-eye comparison (Kling 3.0 std, Seedance 2.0 Mini, Seedance 2.0 fast 720p, Seedance 2.5
   draft, same anchor + motion prompt, 93 credits total): Mini held Ivy's identity most
   convincingly and looked most natural, at the lowest cost of the four (12 cr/clip).
4. Everything else (the daily default) → **Seedance 2.0 Mini** (same result as rule 3 —
   cheapest model that passed the comparison test and the one that won on quality too).
5. Budget guard: projected spend to cycle end > remaining credits → drop one tier.
   Credits left over near renewal (they expire) → allow an extra hero slot.

Each generation stores its routing decision (model, reason, recipe, hook type, credits).

### 9.3 Layer 2 — learning

Two signals, recorded per generated video:

**Owner review (fast signal, available immediately).** Iddo reviews outputs — here in a
Claude session, and later via rating buttons on the Telegram draft preview. Each review is
stored as: rating 1–5, zero or more tags, free text. Tags are the guide's iteration
diagnoses so every complaint maps to a known fix:
`identity_drift`, `plastic_skin`, `frozen`, `looping_gesture`, `camera_drift`,
`wrong_lighting`, `uncanny_walk`, `too_busy`, `too_dramatic`, `not_real_enough`,
`off_brand`, `great`. Free text is classified into tags by Claude and confirmed back to
Iddo in one line ("logged as: plastic_skin, too_busy").

**Audience performance (slow signal, only for posted drafts).** A weekly job pulls post
metrics (Buffer analytics — the Buffer connector exposes aggregated post metrics) and joins
them to the stored routing decision.

What the signals change:
- **Routing weights** per (model × recipe): owner rating dominates for the first ~3 weeks;
  audience metrics gain weight as posts accumulate (≥ ~15 posted videos).
- **Prompt learnings**: a tag recurring ≥ 2 times for the same model/recipe becomes an
  active learning — the guide's fix for that diagnosis, injected into future plan prompts
  for that model/recipe (e.g. `plastic_skin` → force MCU on face beats + skin-detail cue in
  STYLE ANCHOR). Max ~8 active learnings; each keeps links to the reviews that created it
  and can be retired by Iddo. Learnings never touch the fixed identity block (§4).
- **A `great` video** becomes a positive example for its recipe (plan + prompt kept as a
  few-shot reference).

Storage: Supabase tables `generations` (routing decision, prompt, output URL, credits),
`video_reviews`, `generation_learnings` — added via a committed migration file (never an
ad-hoc MCP migration; see the 2026-09-21 migration-drift incident). The workflow reads
active learnings at plan time; nothing lives only in chat memory.

Cadence: routing/learnings recomputed **weekly**; a single review takes effect on the next
generation only if it creates or retires a learning.

## 10. Research notes feeding this spec

- Image-to-video: prompt only motion + camera; everything visible already comes from the image.
- Longer prompts produce worse output; "cinematic" pulls toward camera movement.
- Complex motion (head turns, walking, big gestures) measurably increases identity drift —
  prefer small motions and MCU framing for face-priority beats.
- Keep the identity lock block byte-identical between generations.
- State who holds the camera, where, and how it moves; prefer real camera imperfection to
  "cinematic handheld".
- Seedance 2.5 exists (30 s native, more references) — check availability/cost on
  Higgsfield before choosing it over 2.0.
- Reddit threads could only be read as search excerpts (full pages blocked to our tools).

## 11. Open items

- ~~Model comparison test~~ — done 2026-09-30 (see §9.2 rules 3–4). Seedance 2.0 Mini wins.
- First owner review from the test (2026-09-30, informal, in chat, on the 4 test clips —
  not yet stored per §9.3, no Supabase tables exist yet to log it into): all 4 candidate
  clips rendered with visible slow-motion / ramped playback rather than real-time speed —
  tag `not_real_enough`, applies across models, not one model's flaw. Fixed at the prompt
  level in §5's LOGIC RULE / NEGATIVE PROMPT above; re-verify on the next real generation
  that this actually removes the slow-motion look before trusting it fixed.
- Voice: Higgsfield preset voice vs unique ElevenLabs Voice Design ($6/mo, commercial
  rights) — still deferred; Iddo has not started ElevenLabs setup as of 2026-09-30.
- Higgsfield session: CI and local use **separate** logins (done 2026-09-30) — confirm the
  next scheduled CI run still authenticates.
- Supabase `generations`/`video_reviews`/`generation_learnings` tables (§9.3) not yet
  created — until they exist, reviews are tracked here in the spec/memory only, not queryable.
- Stage B (image-to-video) itself is not yet wired into `ivy-daily-content.yml` — the daily
  cron still only produces the still image; today's test was a standalone model comparison,
  not a live run of the video stage.
