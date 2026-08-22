# Project context for Claude Code

This file gives a new Claude Code session enough context to be useful
immediately. Read this first before making changes.

## What this app is

A React+Vite single-page app for designing and generating AI influencers.
Local-first: every user's data lives in their own browser localStorage.
Image and video generation happens through the user's own Higgsfield
account (OAuth, PKCE).

## Tech stack

- **React 18** + **Vite 5** + **React Router 6**
- **No build-time API keys** — Higgsfield is OAuthed per-user; the optional
  Claude features call through a serverless proxy that expects an
  `x-api-key` header from the browser.
- **Vercel** is the intended host: `api/*.js` are Vercel serverless
  functions, and `vite.config.js` mirrors them as local dev proxies so
  the dev server behaves the same as production.

## Engineering principles — read before writing code

This project optimizes for token economy and surgical execution, not just
working code. Sources: [Karpathy Skills](https://github.com/multica-ai/andrej-karpathy-skills),
[Ponytail](https://github.com/DietrichGebert/ponytail),
[rtk](https://github.com/rtk-ai/rtk).

**Decision ladder — walk this before writing anything new** (Ponytail):
1. Does this need to exist at all? (YAGNI — if the task doesn't require it, skip it)
2. Does this codebase already solve it? (e.g. `generateVideo`/`generateNImages` in
   `src/utils/higgsfieldGenerate.js` already take an `aspectRatio` param — 9:16 for
   TikTok/Reels/Shorts, 16:9/1:1 for YouTube/feed. A future multi-platform export
   feature calls these with different params; it does not get its own generator.)
3. Does a built-in / stdlib / native platform feature solve it?
4. Does an already-installed dependency solve it?
5. Is the fix one line? Write one line.
6. Otherwise, write the minimum that works — nothing speculative.

This never trades away correctness, security, or data-loss handling — the ladder
picks the *simplest sufficient* solution, not the cheapest one.

**Think before coding** (Karpathy): state assumptions or ask, rather than guess,
when a request is ambiguous. Read the relevant file(s) before proposing a plan.

**Surgical changes** (Karpathy): touch only what the task requires. Don't reformat,
refactor, or "clean up" adjacent working code — this applies with extra force to
`Influencers.jsx` (see below). Remove code only when your own change made it
dead, never as a drive-by.

**Goal-driven verification** (Karpathy): before calling a task done, name the exact
command/output that proves it — `npm run lint`, `npm run build`, or a specific
in-browser check — and run it.

**Token-aware command execution** (rtk, installed locally via `brew install rtk`):
for high-volume commands during a session — `git status`/`git diff`, `npm run
build`, `npm run lint`, test runs — prefer the `rtk` wrapper (e.g. `rtk git status`,
`rtk npm run build`, `rtk lint`) when it's available, since it filters/dedupes
output before it reaches context. Falls back silently to the raw command if `rtk`
isn't installed on a given machine — never block work on its absence.

## Key files to know

| Path | What it does |
|---|---|
| `src/App.jsx` | Routes + `<ThemeProvider>` + `<StoreProvider>` |
| `src/store.jsx` | localStorage-backed contexts (`useInfluencers`, etc.) and the `Kayla` seed |
| `src/utils/higgsfieldAuth.js` | OAuth PKCE flow against `mcp.higgsfield.ai` |
| `src/utils/higgsfieldGenerate.js` | MCP-style image/video generation, polling, media uploads |
| `src/utils/systemPrompt.js` | Prompt templates — poses, wardrobe library, vibe palettes, Soul vs GPT Image 2 variants |
| `src/pages/Create.jsx` | Multi-step influencer creation wizard |
| `src/pages/Influencers.jsx` | Influencer profile + Content Studio + Video Studio (very large — known structural debt) |
| `api/hf/[...path].js` | Edge function that proxies all Higgsfield MCP traffic and forwards SSE streams |
| `api/claude.js` | Anthropic API proxy — caller supplies their own `x-api-key` |

## Conventions

- Inline styles with CSS variables (`var(--bg)`, `var(--text-primary)`).
  Theme tokens are set on `<html data-theme="dark|light">` from
  `src/context/theme.jsx`.
- IDs use `generateId()` from `store.jsx` (`Date.now() + random`).
- Higgsfield models supported: `soul_2`, `gpt_image_2`, `nano_banana_2`,
  `nano_banana_flash`, `seedance_2_0`. Soul has its own simplified
  pose set (`POSES_SOUL`) because it struggles with detailed spatial pose
  instructions.

## Things not to do

- **Never kill the Vite dev server** (port 5173). The owner wants it
  running at all times.
- Don't trust the comment in `modelBaseParams` saying resolution and
  quality conflict for `gpt_image_2` — they don't, the working code
  intentionally passes both.
- Don't refactor `Influencers.jsx` casually. It's 4,700+ lines and the
  state is tangled; any split needs its own dedicated session with
  in-browser verification of every flow.

## Dev workflow

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # production build
npm run preview      # preview the production build locally
```

To diagnose Higgsfield issues, flip `HF_DEBUG = true` at the top of
`src/utils/higgsfieldGenerate.js` for verbose request/response logs.
