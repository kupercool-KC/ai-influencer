# content_scout

An on-demand content inspiration scout for TikTok, Instagram, and YouTube. Given a niche
(keyword/hashtag), it finds currently high-performing videos, downloads them, transcribes
spoken audio, OCRs on-screen burned-in text, and — with an AI coding agent (e.g. Claude Code)
doing the qualitative reading step — produces a synthesized report with ready-to-use prompts
for generating similar AI videos.

## Why two of the steps need an AI agent, not just this code

Everything here is deterministic Python **except** two steps that are genuinely a matter of
visual/creative judgment, not extraction:

- **Stage 7 — visual analysis.** For each video, the pipeline picks 4-8 representative frames
  (`data/runs/<run_id>/videos/<platform>_<id>/frames/keyframe_*.jpg`) and writes a
  `visual_analysis` stub into that video's `brief.json`. An agent (Claude Code, or any
  vision-capable assistant) should look at those frames and fill in the stub's fields: hook
  quality, shot composition, lighting, pacing, wardrobe/style, on-screen graphics style. See
  `content_scout/visual/stub.py:fill_visual_analysis`.
- **Stage 10 — synthesis.** After all videos in a run have their `visual_analysis` filled in,
  the agent reads every `brief.json` and writes `data/runs/<run_id>/synthesis.md`: a
  cross-video pattern narrative plus 3-5 ready-to-use "prompt starter" per platform for an AI
  video generation tool.

Nothing here calls a paid vision/LLM API — this design deliberately avoids needing a second
API key. Run `content-scout run`, then hand the run to your agent for stages 7 and 10, then
run `content-scout report --finalize`.

## Setup

### 1. Python environment

```bash
cd content_scout
pip install --break-system-packages -r requirements.txt   # or use a venv
```

Requires `ffmpeg` on PATH (used for audio extraction and frame sampling).

### 2. Apify account + API token (free) — needed for TikTok and Instagram

1. Sign up at **https://console.apify.com** (free, no card required — $5/month platform
   credit, which comfortably covers 50-300 videos/week at this project's scale).
2. Go to **Settings → Integrations** (https://console.apify.com/settings/integrations) and
   copy your **API token**.
3. Put it in `.env` as `APIFY_TOKEN=...` (copy `.env.example` to `.env` first).
4. This project uses two Apify actors — you don't need to configure anything else, but it's
   worth opening each once in the Apify console so you've seen their free-tier limits and
   current pricing before a big run:
   - `clockworks/tiktok-scraper` — https://apify.com/clockworks/tiktok-scraper
   - `automation-lab/instagram-scraper` — https://apify.com/automation-lab/instagram-scraper

   **Note:** Apify actor input/output fields do drift over time as platforms change (this is
   exactly the fragility documented in the original scraper research). If a run's TikTok or
   Instagram discovery returns zero results or errors, the first thing to check is that
   actor's current "Input" tab on the Apify console against `content_scout/platforms/tiktok.py`
   / `instagram.py` — field names may need a small update there.

### 3. YouTube Data API v3 key (free) — needed for YouTube

1. Go to **https://console.cloud.google.com** and create a project (or use an existing one).
2. **APIs & Services → Library** → search "YouTube Data API v3" → **Enable**.
3. **APIs & Services → Credentials** → **Create Credentials → API key**.
4. (Recommended) Restrict the key to "YouTube Data API v3" only.
5. Put it in `.env` as `YOUTUBE_API_KEY=...`.

Free quota is 10,000 units/day; a single discovery run costs well under 1% of that.

### 4. `.env`

```bash
cp .env.example .env
# then edit .env and paste in APIFY_TOKEN and YOUTUBE_API_KEY
```

## Usage

```bash
# Validate the pipeline cheaply first — YouTube only, 5 videos, no downloads yet:
python -m content_scout.cli run --niche "fashion model reels" --platforms youtube --per-platform-limit 5 --dry-run

# Full run on the same small batch:
python -m content_scout.cli run --niche "fashion model reels" --platforms youtube --per-platform-limit 5

# Then: hand the run to your agent for stage 7 (visual analysis) + stage 10 (synthesis) — see below.

# Once synthesis.md exists for the run:
python -m content_scout.cli report --run-id <RUN_ID> --finalize

# Scale up once the loop is validated:
python -m content_scout.cli run --niche "fashion model reels" --platforms tiktok,instagram,youtube --per-platform-limit 20
```

Other commands:

```bash
python -m content_scout.cli resume --run-id <RUN_ID>            # re-run unfinished stages, skips completed work
python -m content_scout.cli list-runs                            # show all past runs
```

### Prompting your agent for stages 7 + 10

Something like:

> Run `python -m content_scout.cli run --niche "..." --platforms ...`. For each video it
> lists as pending visual analysis, read its keyframe images and call
> `content_scout.visual.stub.fill_visual_analysis(brief_path, {...})` with the hook,
> composition, lighting, pacing, wardrobe/style, and on-screen-graphics-style fields filled
> in. Then read every `brief.json` in the run and write `data/runs/<run_id>/synthesis.md` —
> patterns across the videos plus 3-5 ready-to-use prompt starters per platform for an AI
> video generation tool. Then run `content-scout report --run-id <RUN_ID> --finalize` and
> show me `report.md`.

## Architecture

```
content_scout/
├── cli.py                 # run / resume / report / list-runs
├── config.py               # .env-based Settings
├── models.py                # RawVideo, ScoredVideo, brief.json schema
├── pipeline.py               # orchestrates stages 0-6, 8-9 (pure code)
├── storage.py                 # run/video paths, brief.json read/write, resume
├── ranking.py                  # composite traffic/engagement score
├── platforms/{base,youtube,tiktok,instagram}.py   # discovery, one file per platform
├── media/{download,frames}.py                       # video/audio download, frame sampling+dedup
├── transcribe/whisper_transcribe.py                   # native captions or faster-whisper
├── ocr/paddle_ocr.py                                    # on-screen text OCR
├── visual/stub.py                                        # stage 7 stub + fill-in helper
└── report/{aggregate,render}.py + templates/               # stats report + final assembly
```

Every video's `brief.json` has a `status` field
(`discovered → downloaded → transcribed → ocr_done → visual_pending → visual_done → complete`,
or `error`). Each pipeline stage checks this before doing work, so re-running `run` with the
same `--run-id`, or `resume`, only redoes what isn't finished yet.

## Ranking formula

Computed **within each platform's candidate pool only** — not meant to compare raw scores
across platforms, since their algorithms and audience sizes differ too much for that to mean
anything. What's comparable across platforms is each video's `rank_within_platform`.

```
engagement_points = likes + 3*comments + 5*shares
engagement_rate    = engagement_points / max(views, 1)
views_per_day       = views / max(days_since_posted, 0.5)
recency_weight      = 0.5 ** (days_since_posted / half_life_days)   # default 30, tunable
raw_score            = log10(views_per_day + 1) * (1 + engagement_rate) * recency_weight
composite_score     = min-max normalized within the pool, [0, 1]
```

## Known limitations (v1)

- **Facebook is out of scope** — flagged as the unreliable weak link in the original scraper
  research (no free, complete, reliable path found for competitor video content).
- **TikTok's native subtitles aren't wired up yet.** The Apify actor's output includes
  `videoMeta.subtitleLinks`, but v1 always uses whisper for TikTok/Instagram rather than
  trying those first — a reasonable follow-up optimization.
- **No cross-platform score comparison** — composite scores are only meaningful within one
  platform's pool (see Ranking above).
- **Resuming after media deletion re-downloads.** By default, raw video/audio are deleted
  after processing (`--keep-media` to keep them). If a video errors *after* that deletion and
  you `resume --force` it, the pipeline currently can't redo download without re-fetching —
  in practice this only matters for a video that both completed and then needs to be redone,
  which should be rare.
- **Apify actor schemas drift.** See the note in the Setup section above — TikTok/Instagram
  discovery may need small field-name updates in `platforms/tiktok.py` / `instagram.py` if
  Apify changes those actors (this already happened to yt-dlp's own TikTok support once in
  Aug 2026, so it's worth expecting).
- **No cross-run dedup.** Running the same niche twice will re-discover and potentially
  re-process videos seen in a prior run under a different `run_id`; not a bug, just not
  optimized for repeated weekly use yet (a natural next step once this proves out).

## Deps

`apify-client`, `google-api-python-client`, `yt-dlp`, `faster-whisper`, `paddlepaddle` +
`paddleocr`, `opencv-python-headless`, `scikit-image`, `numpy`, `Pillow`, `python-dotenv`,
`Jinja2`, `requests`, `python-dateutil`. Python 3.10+, ffmpeg on PATH.
