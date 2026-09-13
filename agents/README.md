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

**Needs:** `BUFFER_API_KEY` repo secret (same value as Vercel). Also records the
draft in the `scheduled_dispatches` table when `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
are set and a `platform` is given.

## 4. Telegram control bot — `api/telegram/webhook.js`
The only piece that does **not** live in GitHub Actions — it's a Vercel serverless
function (deploys with the rest of the app), because it needs to respond to Telegram
in real time, not on a manual trigger. One bot, one menu button per agent
(🔍 Scout, 🎨 Generate, 📤 Dispatch), plus a 💬 Chat mode that talks to Claude directly
with its own conversation memory (stored in `telegram_chats` — a fresh Claude call per
message, not literally this coding session, but it remembers the Telegram conversation).

**Setup:**
1. Message **@BotFather** on Telegram → `/newbot` → get a bot token.
2. Message your new bot once, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
   and read `message.chat.id` — that's your `TELEGRAM_OWNER_CHAT_ID` (the bot ignores
   everyone else, since it can spend real money).
3. Add these to **Vercel** (Project → Settings → Environment Variables — not GitHub
   secrets, since this runs on Vercel): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`,
   `TELEGRAM_WEBHOOK_SECRET` (any random string you make up), `GITHUB_PAT` (a GitHub
   personal access token with `repo` + `workflow` scope, so the bot can trigger the
   workflows above), `ANTHROPIC_API_KEY` (for Chat mode).
4. After deploying, register the webhook once (run yourself, not something to paste
   into chat since it contains your bot token):
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-vercel-domain>/api/telegram/webhook&secret_token=<same value as TELEGRAM_WEBHOOK_SECRET>"
   ```
5. Message the bot `/start` — you should get the menu.

## Data model
Every table these agents read/write, and which fields are still app-only (not yet
in Supabase), is documented in [`docs/db-schema.md`](../docs/db-schema.md).

## Adding the secrets
Repo → Settings → Secrets and variables → Actions → "New repository secret" (for
GitHub Actions) or Vercel → Project → Settings → Environment Variables (for the
Telegram bot). Never paste a secret value into chat or a committed file.

## Chaining them into one pipeline later
Right now each workflow is triggered separately (by hand, or via the Telegram bot).
Once comfortable with each one individually, they can be chained (scout → generate →
dispatch) either by having one workflow call the others (`workflow_call`), or by
extending the Telegram bot to run a saved sequence.
