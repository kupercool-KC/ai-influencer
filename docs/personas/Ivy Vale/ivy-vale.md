# Persona: Ivy Vale

Status: **built and live** in the app (Influencers tab) as of 2026-09-13. Main image,
character sheet, and close-up headshot generated via the official `@higgsfield/cli`
(the in-app wizard's own generation is currently broken — see Known issues below).
Feature sheet slot still empty. Reference photos live alongside this file in
`references/` (9 images, real people used for type/style guidance only — not
identity-locked, per the same convention used for the Mila draft).

## Known issues
- The app's in-browser "Generate" flow (Create wizard step 5, and Influencers page
  Regenerate buttons) fails with `Higgsfield API error 403: {"error":"Forbidden origin"}`.
  Root cause: Higgsfield's MCP endpoint (`mcp.higgsfield.ai`) rejects the dynamically
  self-registered OAuth client our app creates per-origin (the "custom_mcp" surface) —
  confirmed by testing the same endpoint with the official CLI's pre-approved OAuth
  client, which works with no origin error. This is not fixable in our proxy code
  (`api/hfproxy.js`, already audited and hardened to strip Origin/Referer headers).
- Workaround in use: generate via `higgsfield` CLI directly (`npm i -g @higgsfield/cli`,
  `higgsfield auth login`), then write the resulting media URLs into the influencer
  record (localStorage `hf_influencer_<id>` + `influencer_ids`, and Supabase via
  `POST /api/db/influencers`).
- Planned fix: a GitHub Actions workflow using the CLI with credentials restored from a
  repo secret (`HIGGSFIELD_CREDENTIALS_B64`, base64 of `~/.config/higgsfield/credentials.json`),
  so generation runs in a durable environment instead of an interactive session.

## Basics
- Name: Ivy Vale
- Age / Gender: 28 / Female
- Origin: Byron Bay, Australia
- Occupation: Yoga & Movement Instructor
- Niches: Wellness, Fitness, Lifestyle/Travel
- Lifestyle: Coastal, wellness-focused, nomadic

## Backstory
Born and raised in Byron Bay, Ivy moved to Sydney in her early 20s and worked a corporate
job before experiencing burnout. She returned to Byron Bay, discovered yoga seriously,
completed her yoga teacher training, and eventually began traveling between Australia and
beautiful coastal destinations around the world.

Core concept: an Australian coastal girl who happens to teach yoga — not a generic yoga
influencer.

## Personality
Warm, calm, feminine, grounded, playful, and subtly rebellious. Promotes wellness without
being preachy or "guru-like." Yoga is part of her lifestyle, not her entire personality.

## Physical appearance
- Body: Lean, athletic, toned feminine build
- Skin: Warm golden-olive, naturally textured
- Hair: Sun-kissed brunette / dark honey-blonde, naturally wavy
- Face: Soft oval face, defined cheekbones, natural lips, subtle freckles
- Eyes: Hazel-green with a subtle golden ring — signature feature
- Signature accessory: delicate gold moon necklace, appears consistently across content

## Aesthetic
Australian coastal wellness x feminine minimalism. Palette: sand, cream, sage, terracotta,
chocolate, faded blue. Natural textures — linen, sunlight, ocean, plants, yoga, coffee,
books, golden-hour light.

## Content world
Byron Bay, Sydney, Bali, Lisbon, Mallorca, Greece, and other coastal destinations.

## References used (not identity-locked)
9 photos in `references/` — blonde/honey-toned hair, wellness-luxury styling (matcha,
designer bag, garden/balcony settings). Used for coloring, styling, and aesthetic
guidance only, consistent with how prior persona references were used (see
`mila-berlin-draft.md`) — not locking generation to the identity of the people pictured.

## Next step
Build via the `/create` wizard: niches Wellness/Fitness/Lifestyle, appearance fields above,
Dark & Moody is NOT the vibe here — closer to a warm/sunlit vibe option, personality slider
leaning warm/grounded rather than high-extrovert. Upload reference photos from this folder
for face/style guidance during Step 2/3 of the wizard.
