<!--
This file is read live by api/telegram/webhook.js on every Telegram message
(fetched from raw.githubusercontent.com/main, not bundled into the deploy) and
kept fresh automatically by .github/workflows/update-telegram-context.yml —
same pattern as docs/control-board.html. Don't hand-edit unless you also want
to fight the next scheduled run; if something here is wrong, it'll self-correct
within a day, or trigger the workflow manually (Actions tab) to force it sooner.

Written for an LLM system prompt, not a human — dense, factual, no filler.
-->

# AI Influencer Studio — pipeline reference for the Telegram bot

## Pipeline (all in repo kupercool-KC/ai-influencer)
- **Content Scout** (`agents/content-scout/`, `.github/workflows/content-scout.yml`) — researches
  competing TikTok/Instagram/YouTube content for a niche. Produces a per-run report and (newer)
  an automated weekly synthesis with prompt-agent recommendations grounded in the actual generation
  prompt source.
- **Generation** (`.github/workflows/higgsfield-generate.yml`) — runs the official Higgsfield CLI
  server-side. The in-app browser "Generate" button is broken (Higgsfield's MCP endpoint rejects the
  app's dynamically-registered OAuth client with "Forbidden origin" — not fixable in this codebase,
  confirmed against the CLI's own pre-approved OAuth client, which works). The CLI/workflow path is
  the working substitute.
- **Dispatch** (`agents/dispatch/`, `.github/workflows/buffer-dispatch.yml`) — creates Buffer DRAFT
  posts only, never auto-publishes; a human reviews and posts by hand.
- **This Telegram bot** (`api/telegram/webhook.js`) — one Forum topic (or DM tab) per agent: Scout,
  Generate, Dispatch, Code, Chat. Each topic is auto-wired to its agent by name and gets only the
  tools that agent's job needs (see TOOLS_BY_MODE in the webhook). `propose_code_change` (Code agent)
  opens a PR-gated code-change run — never pushes to main or merges on its own.

## Data model
Supabase tables: `influencers`, `expenses`, `media_assets` (source of truth for generated media,
version history via `is_current`), `scheduled_dispatches`, `activity_logs`, `fan_interactions`,
`telegram_chats` (chat_id + thread_id keyed — DM tabs and Forum topics share this mechanism).
Full reference: `docs/db-schema.md`.

## Known issues / active work
- The in-app browser "Generate" button's 403 is a Higgsfield-side OAuth limitation, not planned to
  be fixed in-app — the CLI/workflow path is the intended route going forward.
- A `Generate` agent (turns Scout's weekly recommendations into a week-ahead content calendar for
  Ivy Vale, approval-gated before spending generation credits) is planned but not built yet.
