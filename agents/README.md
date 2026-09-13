# Agents — background pipeline

All three pieces of the automation pipeline live in this one repo, as GitHub Actions
workflows under `.github/workflows/`. Each runs on GitHub's own servers — not on
anyone's laptop, not tied to any chat session. Trigger any of them from the repo's
**Actions** tab → pick the workflow → "Run workflow" → fill in the fields.

## 1. Content Scout — `content-scout.yml`
Researches competing content (TikTok/Instagram/YouTube) for a niche: captions, hooks,
hashtags, posting patterns. Code lives in `agents/content-scout/` (a Python package).
Output is a report, downloadable from the workflow run's **Artifacts**.

**Needs these repo secrets:** `APIFY_TOKEN`, `YOUTUBE_API_KEY`.

## 2. Generation — `higgsfield-generate.yml`
Generates an image via the official Higgsfield CLI (the in-app "Generate" button is
currently broken — see `docs/personas/Ivy Vale/ivy-vale.md` for why). Can optionally
write the result straight into an influencer's profile in the database.

**Needs:** `HIGGSFIELD_CREDENTIALS_B64` repo secret (and, for the optional DB write,
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — same values already in Vercel).

## 3. Dispatch — `buffer-dispatch.yml`
Creates a **draft** post in Buffer for one image + caption on one channel. It never
auto-publishes — someone still reviews and hits "Publish" inside Buffer by hand. Code
lives in `agents/dispatch/`. Change this only once the manual-review phase is done.

**Needs:** `BUFFER_API_KEY` repo secret (same value as Vercel).

## Adding the secrets
Repo → Settings → Secrets and variables → Actions → "New repository secret". Never
paste a secret value into chat or a committed file — only into that GitHub field.

## Chaining them into one pipeline later
Right now each workflow is triggered separately by hand. Once comfortable with each
one individually, they can be chained (scout → generate → dispatch) either by having
one workflow call the others (`workflow_call`), or by a small script that triggers each
via the GitHub API in sequence.
