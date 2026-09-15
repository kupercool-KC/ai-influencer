// Tool-use surface for the Telegram bot's Claude "Chat" tabs — lets Claude
// read and write app DATA directly (Supabase rows), plus (via
// propose_code_change) ask for real code/doc changes through a PR-gated
// agent run. Direct schema/migration changes are still never allowed from
// here — see rule 4 in telegram-code-agent.yml's prompt.
//
// Code changes are never applied straight to main: propose_code_change always
// opens a pull request for the owner to review and merge by hand (see
// .github/workflows/telegram-code-agent.yml) — a phone conversation has no
// code review or CI of its own, so that human gate stays in place regardless
// of what's requested.
//
// Only wired in for the bot owner (see isOwner() in api/telegram/webhook.js)
// — a second authorized user can chat, but never gets tool access.

import { supabaseAdmin } from './supabaseAdmin.js'
import { dispatchWorkflow, runsUrl } from './githubDispatch.js'

export const TOOLS = [
  {
    name: 'run_code',
    description: `Run a bash or Node script on a throwaway GitHub Actions runner and get the
output back as a follow-up Telegram message (takes ~10-30s to arrive, this call itself just
queues it). The runner has NO access to this app's secrets (Supabase, Buffer, Higgsfield, GitHub) —
it's isolated compute, not a way to touch production data or third-party accounts. Only use this
when the user explicitly asks you to run/execute/test some code — never on your own initiative.`,
    input_schema: {
      type: 'object',
      properties: {
        language: { type: 'string', description: '"bash" or "node"' },
        code: { type: 'string', description: 'The script source' },
        label: { type: 'string', description: 'Short description of what this run does' },
      },
      required: ['language', 'code'],
    },
  },
  {
    name: 'propose_code_change',
    description: `Ask for a real code change, documentation update, or a whole new system to be
built in this repo (kupercool-KC/ai-influencer) — the same kind of work done in an interactive
Claude Code session. Queues a GitHub Actions run where Claude works on a fresh branch, commits,
and opens a pull request. It NEVER pushes to main and NEVER merges — you (the owner) still review
the diff and merge it yourself, in Telegram ("merge that") or on GitHub. Takes a few minutes; the
result (PR link, or why it stopped) arrives as a follow-up Telegram message. Only use this when the
user is explicitly asking for something to be built/changed/fixed in the codebase or its docs —
never for database data changes (use update_influencer_data etc. for those).`,
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: "The request in plain language — as much detail/context as the user gave" },
        label: { type: 'string', description: 'Short (few words) label for tracking, e.g. "add dark mode toggle"' },
      },
      required: ['task'],
    },
  },
  {
    name: 'list_influencers',
    description: 'List all influencer personas (id, name, gender, niche).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_influencer',
    description: 'Get one influencer\'s full profile, including the data JSON blob (bio, images, content pillars, etc).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Influencer id, e.g. "ivy-vale"' } },
      required: ['id'],
    },
  },
  {
    name: 'update_influencer_data',
    description: 'Merge fields into an influencer\'s data JSON blob (e.g. update contentPillars, audience, voice, bio fields). Only sets the fields you pass — does not touch anything else.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: { type: 'object', description: 'Fields to merge into the influencer\'s data blob' },
      },
      required: ['id', 'patch'],
    },
  },
  {
    name: 'list_media_assets',
    description: 'List generated media (images/videos) for an influencer, optionally filtered by slot.',
    input_schema: {
      type: 'object',
      properties: {
        influencer_id: { type: 'string' },
        slot: { type: 'string', description: 'mainImage | characterSheetImage | closeUpImage1 | closeUpImage2 | video | other' },
      },
    },
  },
  {
    name: 'list_expenses',
    description: 'List tracked expenses, optionally filtered by influencer.',
    input_schema: {
      type: 'object',
      properties: { influencer_id: { type: 'string' } },
    },
  },
  {
    name: 'add_expense',
    description: 'Record a new expense.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'recurring | one_time | per_use' },
        provider: { type: 'string' },
        label: { type: 'string' },
        amount_usd: { type: 'number' },
        billing_period: { type: 'string' },
        influencer_id: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['kind', 'provider', 'label', 'amount_usd'],
    },
  },
  {
    name: 'list_activity_logs',
    description: 'List recent activity log events, optionally filtered by influencer.',
    input_schema: {
      type: 'object',
      properties: {
        influencer_id: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'add_activity_log',
    description: 'Record an activity log event.',
    input_schema: {
      type: 'object',
      properties: {
        event_type: { type: 'string' },
        influencer_id: { type: 'string' },
        details: { type: 'object' },
      },
      required: ['event_type'],
    },
  },
  {
    name: 'list_scheduled_dispatches',
    description: 'List Buffer draft/post dispatch records, optionally filtered by influencer or status.',
    input_schema: {
      type: 'object',
      properties: {
        influencer_id: { type: 'string' },
        status: { type: 'string', description: 'pending | scheduled | posted | failed' },
      },
    },
  },
  {
    name: 'update_scheduled_dispatch',
    description: 'Update a dispatch record\'s status, buffer_post_id, or scheduled_for.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: { type: 'object' },
      },
      required: ['id', 'patch'],
    },
  },
]

export async function runTool(name, input) {
  const db = supabaseAdmin()

  switch (name) {
    case 'propose_code_change': {
      if (!input.task || !input.task.trim()) throw new Error('task is required')
      await dispatchWorkflow('telegram-code-agent.yml', {
        task: input.task,
        label: input.label || '',
      })
      return {
        ok: true,
        queued: true,
        note: `Working on it on a branch — I'll message the PR link (or why I stopped) in a few minutes. Track it: ${runsUrl()}`,
      }
    }
    case 'run_code': {
      if (!['bash', 'node'].includes(input.language)) throw new Error('language must be "bash" or "node"')
      await dispatchWorkflow('run-code.yml', {
        language: input.language,
        code_b64: Buffer.from(input.code, 'utf8').toString('base64'),
        label: input.label || '',
      })
      return { ok: true, queued: true, note: `Result will arrive as a follow-up Telegram message in ~10-30s. Track it: ${runsUrl()}` }
    }
    case 'list_influencers': {
      const { data, error } = await db.from('influencers').select('id, name, gender, niche')
      if (error) throw new Error(error.message)
      return data
    }
    case 'get_influencer': {
      const { data, error } = await db.from('influencers').select('*').eq('id', input.id).maybeSingle()
      if (error) throw new Error(error.message)
      return data || { error: 'not found' }
    }
    case 'update_influencer_data': {
      const { data: row, error: fetchErr } = await db.from('influencers').select('*').eq('id', input.id).maybeSingle()
      if (fetchErr) throw new Error(fetchErr.message)
      if (!row) throw new Error(`Influencer ${input.id} not found`)
      const merged = { ...(row.data || {}), ...input.patch }
      const { error } = await db.from('influencers').update({ data: merged }).eq('id', input.id)
      if (error) throw new Error(error.message)
      return { ok: true, id: input.id, updatedFields: Object.keys(input.patch) }
    }
    case 'list_media_assets': {
      let q = db.from('media_assets').select('*').order('created_at', { ascending: false })
      if (input.influencer_id) q = q.eq('influencer_id', input.influencer_id)
      if (input.slot) q = q.eq('slot', input.slot)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    }
    case 'list_expenses': {
      let q = db.from('expenses').select('*').order('occurred_at', { ascending: false })
      if (input.influencer_id) q = q.eq('influencer_id', input.influencer_id)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    }
    case 'add_expense': {
      const { data, error } = await db.from('expenses').insert({
        kind: input.kind, provider: input.provider, label: input.label, amount_usd: input.amount_usd,
        billing_period: input.billing_period || null, influencer_id: input.influencer_id || null, notes: input.notes || null,
      }).select().maybeSingle()
      if (error) throw new Error(error.message)
      return data
    }
    case 'list_activity_logs': {
      let q = db.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(input.limit || 20)
      if (input.influencer_id) q = q.eq('influencer_id', input.influencer_id)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    }
    case 'add_activity_log': {
      const { data, error } = await db.from('activity_logs').insert({
        event_type: input.event_type, influencer_id: input.influencer_id || null, details: input.details || null,
      }).select().maybeSingle()
      if (error) throw new Error(error.message)
      return data
    }
    case 'list_scheduled_dispatches': {
      let q = db.from('scheduled_dispatches').select('*').order('created_at', { ascending: false })
      if (input.influencer_id) q = q.eq('influencer_id', input.influencer_id)
      if (input.status) q = q.eq('status', input.status)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    }
    case 'update_scheduled_dispatch': {
      const { data, error } = await db.from('scheduled_dispatches').update(input.patch).eq('id', input.id).select().maybeSingle()
      if (error) throw new Error(error.message)
      return data
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
