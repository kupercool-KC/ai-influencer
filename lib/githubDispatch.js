// Server-only GitHub Actions trigger. Never import from src/.
// Fires a workflow_dispatch event on one of our agent workflows so the
// Telegram bot can kick off scout/generate/dispatch runs.

const REPO = 'kupercool-KC/ai-influencer'
const REF = 'main'

export async function dispatchWorkflow(workflowFile, inputs) {
  const token = process.env.GITHUB_PAT
  if (!token) throw new Error('Missing GITHUB_PAT env var')

  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${workflowFile}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: REF, inputs }),
  })
  if (r.status !== 204) {
    const body = await r.text().catch(() => '')
    throw new Error(`GitHub dispatch failed (${r.status}): ${body}`)
  }
}

export function runsUrl() {
  return `https://github.com/${REPO}/actions`
}
