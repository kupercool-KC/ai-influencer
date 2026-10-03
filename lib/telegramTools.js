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
import { bufferQuery } from './bufferClient.js'
import { sendMediaFromUrl, sendAlbumFromUrls } from './telegramClient.js'
import { deleteRun, deleteOnePost, approveRun, publishRunNow, updateRunCaptions } from './releaseGate.js'
import { getItem, listItems, addNote } from './contentItems.js'

const INSPIRATION_URL_RE = /https?:\/\/(?:[\w-]+\.)*(?:instagram\.com|tiktok\.com)\/[^\s<>"')]+/i
const VIDEO_WORD_RE = /\b(video|reel|reels|clip)\b|ריל|רילס|סרטון|וידאו|וידיאו/i
const SINGLE_WORD_RE = /\b(single|one photo|one image)\b|תמונה אחת|תמונה בודדת/i
const CAROUSEL_WORD_RE = /\b(carousel|album|slideshow|multiple photos|several photos)\b|קרוסלה|אלבום|כמה תמונות|מספר תמונות|סליידשו/i

// Pulls the first Instagram/TikTok link out of a message and works out what the owner wants made
// from it: kind=video if they said so (video/reel/סרטון/…), else an image; whatever they wrote
// besides the link becomes the steering note. Returns null when there is no such link.
// What the owner wants done with a pasted link — decided from the words around it, because a question about
// a post ("מה אתה מזהה בסרטון הזה?") must NOT start (and pay for) a generation just because it mentions "סרטון":
//   create  — only the link, or creation words (תעשה/תיצור/כמו זה/make/like this)
//   analyze — a question / "tell me what you see" and no creation words -> look at it and report, create nothing
//   ask     — anything else: leave it to the agent to work out (it has analyze_link / create_from_link)
const ANALYZE_RE = /תגיד|תסביר|תנתח|נתח|תתאר|מה אתה (מזהה|רואה|חושב)|מה (זה|יש|קורה)|למה|איך|\b(what|why|how|explain|analy[sz]e|describe|tell me)\b|\?/i
const CREATE_RE = /תעשה|תיצור|צור|תייצר|תכין|בהשראת|כמו זה|דומה|\b(make|create|generate|like this|similar|inspired)\b/i

export function parseInspirationRequest(text) {
  const m = (text || '').match(INSPIRATION_URL_RE)
  if (!m) return null
  const url = m[0].replace(/[.,;!?]+$/, '')
  const rest = text.replace(m[0], ' ').replace(/\s+/g, ' ').trim()
  const intent = !rest ? 'create' : CREATE_RE.test(rest) ? 'create' : ANALYZE_RE.test(rest) ? 'analyze' : 'ask'
  return { url, intent, kind: VIDEO_WORD_RE.test(rest) ? 'video' : SINGLE_WORD_RE.test(rest) ? 'image' : 'carousel', note: rest }
}

// Kicks off the same pipeline as the daily cron (ivy-daily-content.yml) but seeded by one link:
// Scout reads it, Generator makes the image/video, Dispatcher queues Buffer drafts + Approve.
export async function startInspiration({ url, kind = 'carousel', note = '', analyzeOnly = false }) {
  if (!INSPIRATION_URL_RE.test(url || '')) throw new Error('That is not an Instagram or TikTok link.')
  if (!['image', 'carousel', 'video'].includes(kind)) throw new Error('kind must be "image", "carousel" or "video"')
  await dispatchWorkflow('ivy-daily-content.yml', {
    num_days: '1', inspiration_url: url, inspiration_kind: kind, inspiration_note: note || '', analyze_only: analyzeOnly ? 'true' : 'false',
  })
}

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
  {
    name: 'rerun_content_pipeline',
    description: `Re-run the daily Ivy Vale content pipeline (scout -> analyze -> plan ->
generate images -> queue Buffer drafts) right now instead of waiting for tomorrow's cron —
e.g. "regenerate today's content", "make a new image for today", "run it again, I didn't like
that one". Queues ivy-daily-content.yml; the normal 4-stage Telegram trace (Scout/Analysis/
Generator/Dispatcher, with the same Approve button) arrives in the Scout/Generator/Dispatch
topics a few minutes later — this call itself just confirms it was queued. num_days > 1 is
for a deliberate multi-day backfill, not the normal daily case — confirm with the user before
using more than 1.`,
    input_schema: {
      type: 'object',
      properties: {
        num_days: { type: 'number', description: 'How many days of content to generate (default 1).' },
        kind: { type: 'string', enum: ['image', 'carousel', 'video'], description: 'Format: image (single feed photo + stories), carousel (multi-photo post), video (Reel + TikTok video). Default image.' },
      },
    },
  },
  {
    name: 'analyze_link',
    description: `LOOK at ONE Instagram/TikTok link (reel, video or photo post) and tell the owner what is in it — what it is,
why it works, what Ivy could take from it — WITHOUT creating anything or spending credits on generation. Use this
whenever he sends a link and asks you to tell/explain/analyze/"what do you see" (you cannot open links yourself, this
is how you do it). The Hebrew summary arrives in the Scout topic in ~3-5 minutes with buttons to create from it if he
wants; this call only confirms it was queued.`,
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'create_from_link',
    description: `Make new Ivy Vale content inspired by ONE Instagram or TikTok link the owner pasted —
a reel, video or photo post. Scout reads and analyzes the post, Generator writes the prompt and makes
an image (kind "image") or a short vertical video (kind "video"), and Dispatcher queues Buffer drafts
with the usual Approve button. Everything arrives in the Scout / Generator / Dispatch topics in
~5-12 minutes (video takes longer); this call only confirms it was queued. Use kind "video" only
when they asked for a video/reel, "carousel" when they want a multi-photo post/album. Put any extra direction they gave ("cozier", "at sunset",
"without the coffee") in note, in their own words.`,
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The Instagram or TikTok post/reel link.' },
        kind: { type: 'string', enum: ['image', 'carousel', 'video'], description: 'What to make: image (single feed photo + stories), carousel (multi-photo post), video (Reel + TikTok video). Default image.' },
        note: { type: 'string', description: 'Extra direction from the owner, verbatim.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'show_media',
    description: `Show the owner a picture or video right here in this Telegram chat/topic — use whenever
they ask to SEE something ("show me the image", "send me the video", "what does it look like").
Pass a direct image/video URL (e.g. from get_buffer_post, list_media_assets, or a generation result).`,
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Direct URL of the image or video.' },
        type: { type: 'string', enum: ['photo', 'video'], description: 'Default photo.' },
        caption: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'show_buffer_post',
    description: `Show a Buffer post/draft to the owner in this chat: sends its actual image or video with
its caption, platform, type, status and scheduled time as the caption. Use list_scheduled_dispatches
first to find post ids ("show me what's scheduled" = list the scheduled ones, then show each).`,
    input_schema: {
      type: 'object',
      properties: { post_id: { type: 'string', description: 'The Buffer post id (scheduled_dispatches.buffer_post_id).' } },
      required: ['post_id'],
    },
  },
  {
    name: 'delete_content',
    description: `Delete content the owner does NOT want to go out — a bad video/photo/carousel. Pass run_id to
delete EVERY Buffer draft/scheduled post of that generation run (feed, TikTok, stories, reel — the whole
set), or post_id to delete one single Buffer post. The owner explicitly allows this: when they say
"delete it / תמחק" about a picture or video, do it (find the run first: when they reply to a bot message
the reply context gives its send time — pick the run in list_scheduled_dispatches whose created_at is the
closest BEFORE that time; if it is genuinely ambiguous, name the candidates and ask). Already-published
posts cannot be deleted from here. The generated files on Higgsfield's servers can't be erased, but
nothing will reference them any more.`,
    input_schema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'scheduled_dispatches.run_id — deletes the whole set.' },
        post_id: { type: 'string', description: 'A single Buffer post id.' },
      },
    },
  },
  {
    name: 'approve_run',
    description: `Approve a generation run for release (same as the owner tapping "אשר לתור"): its Buffer drafts
stay drafts, and 15 minutes before each planned slot the owner is asked to tap publish. Use when they
say "approve / אשר" about a run.`,
    input_schema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
  },
  {
    name: 'publish_run_now',
    description: `Publish a run RIGHT NOW (goes out in ~2 minutes) — the owner's explicit "upload it now / תעלה את זה
עכשיו" IS the approval, so do NOT ask for a URL, caption or time: the content is already a Buffer draft.
Find the run_id in the OPEN QUEUE in your context (the most recent run, or the one they replied to / just
discussed); pass platforms (["instagram"] / ["tiktok"]) only if they named one — default is every platform
in the run. After it succeeds say exactly what is going out and when.`,
    input_schema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        platforms: { type: 'array', items: { type: 'string', enum: ['instagram', 'tiktok'] } },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'revise_content',
    description: `Tweak ("twiking") a piece of content the owner has not published yet. scope "caption": pass the new
Instagram text and/or TikTok text (full text incl. hashtags) — applied immediately to the drafts. scope "image":
pass the owner's instruction in plain words (e.g. "slide 2 with more sun", "different outfit") — a short
Generator run re-plans and regenerates ONLY the affected picture (~2 credits), swaps it into the drafts and
sends a fresh preview with the approve buttons to Dispatch (a few minutes). Use the run_id from the OPEN QUEUE
or the item the owner is talking about; never regenerate everything for a small tweak.`,
    input_schema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        scope: { type: 'string', enum: ['caption', 'image'] },
        instruction: { type: 'string', description: 'For scope image: the change, in the owner\'s words.' },
        instagram_caption: { type: 'string' },
        tiktok_caption: { type: 'string' },
      },
      required: ['run_id', 'scope'],
    },
  },
  {
    name: 'get_content_item',
    description: 'The shared record of one piece of content by run_id: source link, plan (prompts + captions), pictures, status, owner notes. With no run_id, lists the most recent items.',
    input_schema: { type: 'object', properties: { run_id: { type: 'string' } } },
  },
  {
    name: 'list_inspiration_accounts',
    description: 'The Instagram/TikTok accounts Scout watches for inspiration (and whether each is active).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'add_inspiration_account',
    description: 'Start watching an Instagram or TikTok account for inspiration (takes effect on the next scan). Handle without @.',
    input_schema: {
      type: 'object',
      properties: { platform: { type: 'string', enum: ['instagram', 'tiktok'] }, handle: { type: 'string' } },
      required: ['platform', 'handle'],
    },
  },
  {
    name: 'remove_inspiration_account',
    description: 'Stop watching an account (kept in the list as inactive).',
    input_schema: {
      type: 'object',
      properties: { platform: { type: 'string', enum: ['instagram', 'tiktok'] }, handle: { type: 'string' } },
      required: ['platform', 'handle'],
    },
  },
  {
    name: 'set_preference',
    description: `Remember a standing instruction from the owner ("from now on ...", "always ...", "never ...") so EVERY agent
and every content plan follows it. key = short snake_case name (re-using a key replaces it), value = the rule in a
clear sentence. Call it whenever the owner states a lasting rule about content, tone, timing or workflow.`,
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value'],
    },
  },
  {
    name: 'list_preferences',
    description: 'The owner\'s standing instructions currently in force.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_preference',
    description: 'Forget a standing instruction (by key).',
    input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'weekly_overview',
    description: 'Everything lined up: items waiting for approval, approved ones waiting for their slot, and what is scheduled in Buffer, by date — for "what do we have this week".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_buffer_post',
    description: `Look up a Buffer post/draft's current text, image, schedule, and (for
Instagram) its type/story settings and attached music. Use list_scheduled_dispatches first to
find the buffer_post_id if the user doesn't have it handy.`,
    input_schema: {
      type: 'object',
      properties: { post_id: { type: 'string', description: 'The Buffer post id (scheduled_dispatches.buffer_post_id).' } },
      required: ['post_id'],
    },
  },
  {
    name: 'edit_buffer_post',
    description: `Edit an existing Buffer draft or scheduled post — change its caption, swap
the image, reschedule it, or move it back to an unscheduled draft. Only pass the fields the
user actually wants changed; everything else (image, metadata, Instagram Story settings) is
carried forward automatically from the post's current state, so a plain caption edit won't
accidentally drop its Story type or attached music. For a new due time, pass due_at as an ISO
8601 datetime with a UTC offset (e.g. "2026-10-02T21:00:00+00:00"); this also updates the
matching scheduled_dispatches row if one exists for this post_id.`,
    input_schema: {
      type: 'object',
      properties: {
        post_id: { type: 'string' },
        text: { type: 'string', description: 'New caption/text, if changing it.' },
        image_url: { type: 'string', description: 'New image URL, if swapping the asset.' },
        due_at: { type: 'string', description: 'New ISO 8601 scheduled time (ignored if move_to_draft is true).' },
        move_to_draft: { type: 'boolean', description: 'true to pull a scheduled post back to an unscheduled draft.' },
      },
      required: ['post_id'],
    },
  },
]

export async function runTool(name, input, ctx = {}) {
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
    case 'show_media': {
      if (!ctx.chatId) throw new Error('No chat to send to')
      await sendMediaFromUrl(ctx.chatId, ctx.threadId, { type: input.type || 'photo', url: input.url, caption: input.caption || '' })
      return { ok: true, note: 'Shown in the chat.' }
    }
    case 'show_buffer_post': {
      if (!ctx.chatId) throw new Error('No chat to send to')
      const { post } = await bufferQuery(
        `query($input: PostInput!) { post(input: $input) { text status dueAt channelService assets { type source } metadata { ... on InstagramPostMetadata { type } } } }`,
        { input: { id: input.post_id } },
      )
      if (!post) throw new Error('Post not found')
      const assets = post.assets || []
      if (!assets.length) throw new Error('That post has no image or video')
      const kind = [post.channelService, post.metadata?.type].filter(Boolean).join(' ')
      const when = post.dueAt ? `scheduled ${post.dueAt}` : post.status
      const caption = `${kind} · ${when}\n\n${post.text || ''}`
      const images = assets.filter(a => String(a.type).toLowerCase() !== 'video').map(a => a.source)
      const videos = assets.filter(a => String(a.type).toLowerCase() === 'video').map(a => a.source)
      if (images.length > 1) await sendAlbumFromUrls(ctx.chatId, ctx.threadId, images.slice(0, 10), caption)
      else if (images.length === 1) await sendMediaFromUrl(ctx.chatId, ctx.threadId, { type: 'photo', url: images[0], caption })
      for (const v of videos) await sendMediaFromUrl(ctx.chatId, ctx.threadId, { type: 'video', url: v, caption })
      return { ok: true, note: 'Shown in the chat.', status: post.status, dueAt: post.dueAt, pictures: images.length }
    }
    case 'revise_content': {
      const item = await getItem(input.run_id)
      if (!item) throw new Error(`No content item for run ${input.run_id}`)
      if (ctx.chatId) await db.from('owner_preferences').delete().eq('key', `pending_revision:${ctx.chatId}:${ctx.threadId || ''}`)
      if (input.scope === 'caption') {
        if (!input.instagram_caption && !input.tiktok_caption) throw new Error('Pass instagram_caption and/or tiktok_caption')
        const n = await updateRunCaptions(input.run_id, { instagram: input.instagram_caption, tiktok: input.tiktok_caption })
        await addNote(input.run_id, `caption edit: ${[input.instagram_caption, input.tiktok_caption].filter(Boolean).join(' | ').slice(0, 300)}`)
        return { ok: n > 0, posts_updated: n }
      }
      if (!input.instruction) throw new Error('instruction is required for an image revision')
      await addNote(input.run_id, `image revision requested: ${input.instruction}`)
      await dispatchWorkflow('ivy-revise.yml', { run_id: input.run_id, instruction: input.instruction })
      return { ok: true, queued: true, note: 'Regenerating just that picture — a fresh preview with the approve buttons arrives in Dispatch in a few minutes.' }
    }
    case 'get_content_item': {
      if (!input.run_id) return (await listItems(8)).map(i => ({ run_id: i.run_id, kind: i.kind, status: i.status, source_url: i.source_url, created_at: i.created_at }))
      return (await getItem(input.run_id)) || { error: 'not found' }
    }
    case 'list_inspiration_accounts': {
      const { data, error } = await db.from('inspiration_accounts').select('platform, handle, active').order('platform')
      if (error) throw new Error(error.message)
      return data
    }
    case 'add_inspiration_account': {
      const handle = String(input.handle).replace(/^@/, '').trim().toLowerCase()
      if (!/^[a-z0-9_.]+$/.test(handle)) throw new Error('Invalid handle')
      const { error } = await db.from('inspiration_accounts').upsert({ platform: input.platform, handle, active: true }, { onConflict: 'platform,handle' })
      if (error) throw new Error(error.message)
      return { ok: true, note: 'Will be included from the next scan.' }
    }
    case 'remove_inspiration_account': {
      const handle = String(input.handle).replace(/^@/, '').trim().toLowerCase()
      const { error } = await db.from('inspiration_accounts').update({ active: false }).eq('platform', input.platform).eq('handle', handle)
      if (error) throw new Error(error.message)
      return { ok: true }
    }
    case 'set_preference': {
      const { error } = await db.from('owner_preferences').upsert({ key: input.key, value: input.value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (error) throw new Error(error.message)
      return { ok: true, note: 'Saved — every agent and every content plan will follow it from now on.' }
    }
    case 'list_preferences': {
      const { data, error } = await db.from('owner_preferences').select('key, value, updated_at').order('updated_at')
      if (error) throw new Error(error.message)
      return data
    }
    case 'delete_preference': {
      const { error } = await db.from('owner_preferences').delete().eq('key', input.key)
      if (error) throw new Error(error.message)
      return { ok: true }
    }
    case 'weekly_overview': {
      const { data, error } = await db.from('scheduled_dispatches').select('run_id, platform, status, scheduled_for')
        .in('status', ['pending', 'approved', 'scheduled']).order('scheduled_for').limit(80)
      if (error) throw new Error(error.message)
      const groups = {}
      for (const r of data || []) {
        const key = `${r.status} · ${r.scheduled_for ? new Date(r.scheduled_for).toISOString().slice(0, 16) : '-'} · ${r.run_id || ''}`
        groups[key] = [...(groups[key] || []), r.platform]
      }
      return Object.entries(groups).map(([k, v]) => `${k} · ${v.join('+')}`)
    }
    case 'analyze_link': {
      await startInspiration({ url: input.url, analyzeOnly: true })
      return { ok: true, queued: true, note: 'Analyzing — the summary arrives in the Scout topic in a few minutes, with buttons to create from it.' }
    }
    case 'create_from_link': {
      await startInspiration({ url: input.url, kind: input.kind || 'carousel', note: input.note || '' })
      return { ok: true, queued: true, note: `Queued — results will appear in the Scout, Generator and Dispatch topics in a few minutes. Track it: ${runsUrl()}` }
    }
    case 'rerun_content_pipeline': {
      const numDays = input.num_days && input.num_days > 0 ? String(Math.floor(input.num_days)) : '1'
      const kind = ['image', 'carousel', 'video'].includes(input.kind) ? input.kind : 'carousel'
      await dispatchWorkflow('ivy-daily-content.yml', { num_days: numDays, inspiration_kind: kind })
      return {
        ok: true,
        queued: true,
        num_days: numDays,
        note: `Queued — the Scout/Generator/Dispatch topics will get the usual 4-stage trace in a few minutes, ending with the same Approve button. Track it: ${runsUrl()}`,
      }
    }
    case 'get_buffer_post': {
      const { post } = await bufferQuery(
        `query($input: PostInput!) { post(input: $input) { id status text dueAt channelService schedulingType shareMode assets { type source } metadata { ... on InstagramPostMetadata { type shouldShareToFeed isAiGenerated stickerFields { text music } } } } }`,
        { input: { id: input.post_id } },
      )
      return post
    }
    case 'edit_buffer_post': {
      const { post: current } = await bufferQuery(
        `query($input: PostInput!) { post(input: $input) { text channelService assets { type source } metadata { ... on InstagramPostMetadata { type shouldShareToFeed isAiGenerated stickerFields { text music } } } } }`,
        { input: { id: input.post_id } },
      )
      if (!current) throw new Error('Post not found')
      const assetsIn = (current.assets || []).map(a => String(a.type).toLowerCase() === 'video' ? { video: { url: a.source } } : { image: { url: a.source } })
      // image_url swaps the first picture; every other picture/video is carried forward untouched.
      if (input.image_url) assetsIn.splice(0, 1, { image: { url: input.image_url } })
      const sf = current.metadata?.stickerFields
      const metadata = current.metadata?.type
        ? { instagram: { type: current.metadata.type, shouldShareToFeed: current.metadata.shouldShareToFeed, isAiGenerated: true,
            ...((sf?.text || sf?.music) ? { stickerFields: { ...(sf.text ? { text: sf.text } : {}), ...(sf.music ? { music: sf.music } : {}) } } : {}) } }
        : undefined
      const editInput = {
        id: input.post_id,
        text: input.text ?? current.text,
        assets: assetsIn,
        ...(metadata ? { metadata } : {}),
      }
      if (input.move_to_draft) {
        editInput.saveToDraft = true
      } else if (input.due_at) {
        editInput.mode = 'customScheduled'
        editInput.dueAt = input.due_at
        editInput.schedulingType = 'automatic'
        editInput.saveToDraft = false
      }
      const result = await bufferQuery(
        `mutation($input: EditPostInput!) { editPost(input: $input) { ... on PostActionSuccess { post { id status dueAt text } } ... on MutationError { message } } }`,
        { input: editInput },
      )
      if (result.editPost?.message) throw new Error(result.editPost.message)
      if (input.due_at && !input.move_to_draft) {
        await db.from('scheduled_dispatches').update({ scheduled_for: input.due_at, updated_at: new Date().toISOString() }).eq('buffer_post_id', input.post_id)
      }
      return result.editPost.post
    }
    case 'approve_run': {
      const n = await approveRun(input.run_id)
      return { ok: n > 0, approved: n, note: n ? 'Queued for release — the owner gets the usual prompt 15 minutes before each slot and must tap publish.' : 'Nothing pending for that run.' }
    }
    case 'publish_run_now': {
      const r = await publishRunNow(input.run_id, input.platforms)
      return { ok: r.scheduled > 0, scheduled: r.scheduled, due_at: r.dueAt, failures: r.failures, note: r.scheduled ? 'Scheduled to go out in about 2 minutes.' : undefined }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
