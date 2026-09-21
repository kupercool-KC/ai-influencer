// Runs on a schedule (see .github/workflows/update-telegram-context.yml) with zero dependency
// on anyone's computer being on. Asks Claude to review recent repo activity and refresh
// docs/telegram-bot-context.md — the Telegram bot (api/telegram/webhook.js) fetches this file
// live from raw.githubusercontent.com/main on every message, so this is what keeps the bot's
// architecture/pipeline knowledge from going stale the way a hardcoded prose block would (the
// exact problem this replaced — see the PR that added this script).
//
// Deliberately conservative: Claude is told to preserve the file's existing structure/headings
// and only touch content that reflects real project state. Same pattern as
// update-control-board.mjs, same "only commit on real change" discipline.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is not set — see agents/README.md for setup.')
  process.exit(1)
}

const DOC_PATH = 'docs/telegram-bot-context.md'
const currentDoc = readFileSync(DOC_PATH, 'utf8')

function safeGit(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// Recent activity since the doc's own last commit (falls back to 2 days if that lookup fails,
// since this runs daily and we want a little overlap, not a gap).
const lastDocCommit = safeGit(`git log -1 --format=%H -- ${DOC_PATH}`)
const since = lastDocCommit ? `${lastDocCommit}..HEAD` : '--since=2.days'
const gitLog = safeGit(`git log ${since} --stat --date=short -- . ':(exclude)${DOC_PATH}'`) || '(no commits found in range)'

const prompt = `You maintain a reference doc that a production Telegram bot fetches live and \
injects into its own system prompt on every message (api/telegram/webhook.js, PROJECT_CONTEXT). \
It is written FOR an LLM, not a human — dense, factual, no filler, no marketing tone.

Below is the doc's current content, followed by recent repo activity (git log) since it was last \
updated.

Your job: update it to reflect any *meaningfully changed* project state — which pipeline pieces \
exist and where, the data model, known issues, active/planned work. Infer what changed from the \
git log (commit messages, files touched, new workflows/docs/features, bugs fixed) — don't invent \
progress that isn't evidenced by the log, and don't remove a fact just because it wasn't touched \
recently (silence in the log isn't evidence something stopped being true).

Hard constraints:
- Preserve the file's existing heading structure and the HTML comment at the top exactly.
- Keep it dense — this is a system-prompt injection with a token budget, not documentation for
  humans to read leisurely. Prefer trimming stale detail over letting it grow unbounded.
- If nothing in the git log represents a meaningful change, return the file completely unchanged.
- Output ONLY the complete, raw Markdown file content — no code fences, no commentary before or
  after.

=== CURRENT docs/telegram-bot-context.md ===
${currentDoc}

=== GIT LOG SINCE LAST UPDATE ===
${gitLog}
`

const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  }),
})

if (!response.ok) {
  console.error(`Anthropic API error: ${response.status} ${await response.text()}`)
  process.exit(1)
}

const data = await response.json()
let updated = data.content?.[0]?.text?.trim() || ''

// Defensive strip in case the model wraps the output in a code fence despite instructions.
updated = updated.replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, '')

if (!updated.startsWith('<!--')) {
  // Dump enough of the raw response to actually diagnose this from the Actions log next
  // time — a 2026-09-21 run failed here with an empty `updated` and nothing else logged,
  // which wasn't enough to tell whether the API returned an empty content array, a non-text
  // block, or something else.
  console.error('Model response did not look like the expected doc — leaving it untouched.')
  console.error('stop_reason:', data.stop_reason)
  console.error('content block types:', (data.content || []).map(b => b.type))
  console.error('first 500 chars:', updated.slice(0, 500))
  process.exit(1)
}

if (updated === currentDoc) {
  console.log('No meaningful change detected — doc left as-is.')
} else {
  writeFileSync(DOC_PATH, updated, 'utf8')
  console.log('Telegram bot context doc updated.')
}
