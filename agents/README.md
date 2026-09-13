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
in real time, not on a manual trigger. Runs entirely server-side: nobody's laptop
needs to be on for it to work.

**Tabs.** A persistent keyboard under the text box (🔍 Scout, 🎨 Generate, 📤 Dispatch,
💬 Chat) — tapping one switches which agent free-text messages go to. Each tab is a
*separate* Claude conversation with its own memory (`telegram_chats.histories`, keyed
by tab) and its own agent-focused system prompt, so switching tabs never bleeds
context between them. Slash commands (`/scout`, `/generate`, `/dispatch`) work from
any tab regardless of which one is active.

**Data tools (owner only).** In the bot owner's chat (`TELEGRAM_OWNER_CHAT_ID`), Claude
can read and write the app's live Supabase data — influencers, media_assets, expenses,
activity_logs, scheduled_dispatches — via `lib/telegramTools.js`, so you can ask things
like "what's Ivy Vale's audience?" or "update Ivy's voice to X" in plain language. It
cannot change database schema, run migrations, or edit this repo's code. A second
authorized user (`TELEGRAM_ALLOWED_CHAT_IDS`) can chat in every tab but gets none of
these tools — only the owner's exact `chat_id` does.

**Code execution (owner only, explicitly requested — higher risk).** Also owner-only:
`run_code`, which runs a bash/Node script on a throwaway GitHub Actions runner
(`.github/workflows/run-code.yml`) and reports the output back as a follow-up message.
Deliberately contained even though it's real code execution reachable from a phone
conversation: no access to this app's secrets (Supabase/Buffer/Higgsfield/GitHub PAT
are not passed to that job), read-only checkout (can't push commits back), 5-minute
timeout. Treat the bot token and `TELEGRAM_WEBHOOK_SECRET` with production-credential
care — anyone who obtains either (or control of the owner's Telegram account) can run
arbitrary code here.

**Security notes:**
- The webhook fails closed: if `TELEGRAM_WEBHOOK_SECRET` isn't set, every request is
  rejected rather than silently accepted.
- The three agent workflows (content-scout, higgsfield-generate, buffer-dispatch) pass
  every `workflow_dispatch` input through `env:` rather than interpolating it directly
  into `run:` scripts — the latter is vulnerable to GitHub Actions "script injection"
  (a value with shell metacharacters could otherwise run arbitrary commands with that
  job's secrets in scope).
- The app's `api/db/*.js` read/write endpoints have no auth yet (no end-user auth
  system exists), so in principle anyone could plant text in a data field. The owner's
  Chat-mode system prompt explicitly tells Claude to treat tool-result data as
  untrusted content, never as instructions, as a defense against that.

**Setup:**
1. Message **@BotFather** on Telegram → `/newbot` → get a bot token.
2. Message your new bot once, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
   and read `message.chat.id` — that's your `TELEGRAM_OWNER_CHAT_ID` (the bot ignores
   everyone else, since it can spend real money and, now, run code).
3. Add these to **Vercel** (Project → Settings → Environment Variables — not GitHub
   secrets, since this runs on Vercel): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`,
   `TELEGRAM_ALLOWED_CHAT_IDS` (optional, comma-separated, for a second user),
   `TELEGRAM_WEBHOOK_SECRET` (any random string you make up), `GITHUB_PAT` (a GitHub
   personal access token with `repo` + `workflow` scope, so the bot can trigger the
   workflows above), `ANTHROPIC_API_KEY` (for Chat mode).
4. Also add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID` as **GitHub repo secrets**
   (Settings → Secrets and variables → Actions) — separate from the Vercel env vars
   above — so `run-code.yml` can post results back to Telegram.
5. After deploying, register the webhook once (run yourself, not something to paste
   into chat since it contains your bot token):
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-vercel-domain>/api/telegram/webhook&secret_token=<same value as TELEGRAM_WEBHOOK_SECRET>"
   ```
6. Message the bot `/start` — you should get the tab keyboard.

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
