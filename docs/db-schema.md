# Data model reference

Every entity the platform uses, where it lives, and how in-sync the app code
actually is with the database. Written 2026-09-13 after discovering the
Supabase project already had four tables (`media_assets`, `scheduled_dispatches`,
`activity_logs`, `fan_interactions`) that no code referenced yet — this doc is
the fix for that: one place that says what exists and what uses it.

## Supabase tables

### `influencers`
| column | type | notes |
|---|---|---|
| id | text (PK) | app-generated |
| name | text | |
| gender | text | |
| niche | text | |
| data | jsonb | the *entire* influencer object (see below) — loose schema by design |
| created_at | timestamptz | |

API: `api/db/influencers.js` (GET/POST upsert/DELETE). Written by `src/store.jsx`'s `syncInfluencerToDB`.

**The `data` blob contains** (all optional except id/name/gender):
`type, createdAt, age, niche, niches[], nicheCustom, backstory, introExtrovert/personality, physicalDesc, vibeWords[], mainImage, characterSheetImage, closeUpImage1, closeUpImage2, prompt, audience, clothingStyle, hobbies, location, dreamBrands, voice, contentPillars[], palette[], videoUrls[], scripts[], homeImages[], brandDealImages[], wardrobeSlots[{id,name,image}], brandDeals[{id,brand,category,image,images,characterSheet}], generationHistory[{id,type,label,url,date}]`.

Only `mainImage`/`characterSheetImage`/`closeUpImage1`/`closeUpImage2` are read by the profile UI directly — everything else is display/editing convenience.

### `expenses`
| column | type | notes |
|---|---|---|
| id | uuid (PK) | |
| kind | text | recurring \| one_time \| per_use |
| provider | text | |
| label | text | |
| amount_usd | numeric | |
| billing_period | text | nullable |
| influencer_id | text, FK → influencers | **column exists, not yet set by the app** |
| media_asset_id | uuid, FK → media_assets | **column exists, not yet set by the app** |
| occurred_at | date | defaults to today; UI never sends it explicitly |
| notes | text | |
| created_at | timestamptz | |

API: `api/db/expenses.js`. **Gap:** nothing today links an expense to the influencer or media asset it was for — the columns are there, the UI just doesn't populate them yet.

### `media_assets` — source of truth for generated media
| column | type | notes |
|---|---|---|
| id | uuid (PK) | |
| influencer_id | text, FK → influencers | |
| slot | text | mainImage \| characterSheetImage \| closeUpImage1 \| closeUpImage2 \| video \| other |
| type | text | image \| video |
| url | text | |
| prompt, model, aspect_ratio | text | generation params, for reproducibility |
| source | text | 'app' (browser wizard) \| 'cli' (manual/GitHub Actions) |
| is_current | boolean | true = what's shown on the profile now; false = superseded version, kept for history |
| label | text | |
| created_at | timestamptz | |

API: `api/db/media-assets.js` (new). Written by `higgsfield-generate.yml` (CLI path) and should be written by the in-app wizard too once its generation flow is fixed. **This is what finally answers "what did version 2 look like" — every version generated from here on is kept, not overwritten.**

### `scheduled_dispatches` — Buffer draft/post tracking
| column | type | notes |
|---|---|---|
| id | uuid (PK) | |
| influencer_id, media_asset_id | FK | |
| platform | text | tiktok \| instagram \| youtube \| facebook (**no pinterest yet** — add to the check constraint if that channel gets connected) |
| buffer_post_id | text | |
| status | text | pending \| scheduled \| posted \| failed |
| scheduled_for | timestamptz | |
| created_at, updated_at | timestamptz | |

API: `api/db/scheduled-dispatches.js` (new). Written by `agents/dispatch/create-draft.mjs` when `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are present.

### `activity_logs` — event audit trail
| column | type | notes |
|---|---|---|
| id | uuid (PK) | |
| event_type | text | free-form, e.g. `persona_created`, `image_generated`, `draft_dispatched` |
| influencer_id | text, FK | nullable |
| details | jsonb | whatever's relevant to that event |
| created_at | timestamptz | |

API: `api/db/activity-logs.js` (new). Nothing writes to it yet — intended as the backbone for the Telegram bot's "what happened" answers and any future dashboard.

### `fan_interactions`
| column | type | notes |
|---|---|---|
| id | uuid (PK) | |
| influencer_id | text, FK, required | |
| fan_identifier | text, required | |
| message | text | nullable |
| created_at | timestamptz | |

API: `api/db/fan-interactions.js` (new). **No UI consumes this yet** — exists ahead of a future fan-messaging feature.

### `telegram_chats`
| column | type | notes |
|---|---|---|
| chat_id | text (PK, composite w/ thread_id) | a DM's chat_id, or a Forum group's chat_id |
| thread_id | text (PK, composite w/ chat_id) | `''` for a DM / a group's own General topic; a Forum topic's `message_thread_id` otherwise |
| mode | text | which agent this row is wired to: scout \| generate \| dispatch \| code \| chat |
| topic_name | text, nullable | the Topic's name as Telegram reported it (DM rows leave this null) |
| histories | jsonb | `{mode: Anthropic-format message array}`, last 40 kept per mode |
| messages | jsonb | legacy, unused since the mode/histories split — left in place, not written to |
| updated_at | timestamptz | |

Written directly by `api/telegram/webhook.js`. A DM's 4-then-5 "tabs" (button keyboard) and a
Forum group's Topics are the same mechanism underneath — each (chat_id, thread_id) pair is an
independent conversation with its own mode and history. A Topic's mode is auto-detected from its
name when created (`forum_topic_created`); `/mode <name>` inside a topic overrides it.

## localStorage-only (never synced to Supabase)

These are real entities but live only in the browser today — flagged here so
"align everything with the DB" has an honest todo list, not a silent gap:

- `photo_studio_history` — `{influencerId, url, createdAt, location, timeOfDay, aspectRatio, settings}[]`. Overlaps conceptually with `media_assets` — candidate to migrate.
- `inspiration_boards` — board objects seeded from `seeds.json`.
- `brand_deals` (global list) — `{id, image, characterSheet, ...}[]`.
- `hf_gen_params` — `${influencerId}::${slot}` → last-used generation params, for "Regenerate".
- `hf_creation_params` — per-influencer wizard state (face/style refs, model, aspect ratio).
- `hf_video_history_<...>` — per-entity video history.

None of these have an API route today. Not touched in this pass — flagging
rather than guessing at a schema nobody's asked for yet.

## Legacy / dead
- `influencers` (plain, no prefix) localStorage key — pre-`hf_influencer_<id>` fallback, kept only for migration/recovery.
