// Runs on a schedule (see .github/workflows/update-control-board.yml) with zero dependency
// on anyone's computer being on. Asks Claude to review recent repo activity and refresh
// docs/control-board.html — the source file behind both the GitHub Pages mirror and the
// claude.ai artifact (the artifact itself can only be republished from an interactive Claude
// Code session, so this keeps the *content* current; a live session re-syncs the artifact
// link opportunistically — see the `reference-ai-influencer-control-board` memory note).
//
// Deliberately conservative: Claude is told to preserve the existing design system (CSS,
// structure, tokens) byte-for-byte and only touch the content that reflects real project
// state — tallies, phase status, decisions, dates. The workflow only commits if the output
// actually differs from what's already there, so a no-op day produces no commit/no PR noise.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is not set — see agents/README.md for setup.')
  process.exit(1)
}

const BOARD_PATH = 'docs/control-board.html'
const currentBoard = readFileSync(BOARD_PATH, 'utf8')

function safeGit(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// Recent activity since the board's own last commit (falls back to 4 days if that lookup
// fails, since this runs roughly every 2 days and we want a little overlap, not a gap).
const lastBoardCommit = safeGit(`git log -1 --format=%H -- ${BOARD_PATH}`)
const since = lastBoardCommit ? `${lastBoardCommit}..HEAD` : '--since=4.days'
const gitLog = safeGit(`git log ${since} --stat --date=short -- . ':(exclude)${BOARD_PATH}'`) || '(no commits found in range)'

const readmeExcerpt = safeGit('git show HEAD:agents/README.md') || ''

const prompt = `You maintain a project status page for "AI Influencer Studio". Below is the \
current live HTML of that page, followed by recent repo activity (git log) since the page was \
last updated, and the project's own README for context.

Your job: update the HTML to reflect any *meaningfully changed* project state — phase status \
(done/active/queued/blocked), the summary tallies, "Decisions made" entries, and dates. Infer \
what changed from the git log (commit messages, files touched, new workflows/docs added, \
migrations, etc.) — don't invent progress that isn't evidenced by the log.

Hard constraints:
- Preserve the page's existing design system exactly: same CSS, same structure, same fonts, \
same color tokens, same overall layout. Do not redesign anything.
- If nothing in the git log represents a meaningful status change, return the HTML completely \
unchanged.
- Output ONLY the complete, raw HTML file content — no markdown fences, no commentary, no \
explanation before or after.

=== CURRENT docs/control-board.html ===
${currentBoard}

=== GIT LOG SINCE LAST BOARD UPDATE ===
${gitLog}

=== agents/README.md (for project context) ===
${readmeExcerpt.slice(0, 8000)}
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
    max_tokens: 16000,
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
updated = updated.replace(/^```(?:html)?\n/, '').replace(/\n```$/, '')

if (!updated.startsWith('<')) {
  console.error('Model response did not look like HTML — leaving the board untouched.')
  console.error(updated.slice(0, 500))
  process.exit(1)
}

if (updated === currentBoard) {
  console.log('No meaningful change detected — board left as-is.')
} else {
  writeFileSync(BOARD_PATH, updated, 'utf8')
  console.log('Control board updated.')
}
