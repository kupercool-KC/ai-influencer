// Release gate: nothing the pipeline makes is published without the owner's tap shortly before
// its slot. Flow: pipeline -> Buffer DRAFTs + scheduled_dispatches rows (status 'pending') ->
// owner taps Approve once (rows become 'approved', Buffer posts stay drafts) -> 15 minutes before
// each slot the cron (api/cron/release-reminders.js) sends the actual pictures/videos with
// [publish on time / postpone a day / cancel] -> only "publish" schedules the post in Buffer.
//
// Server-only. Used by api/telegram/webhook.js (button taps) and api/cron/release-reminders.js.

import { supabaseAdmin } from './supabaseAdmin.js'
import { bufferQuery } from './bufferClient.js'

const PROXY = 'https://ai-influencer-lovat.vercel.app/api/img-proxy'
const HF_CDN = 'd8j0ntlcm91z4.cloudfront.net'
const MIN_LEAD_MS = 2 * 60 * 1000 // Buffer needs a due time comfortably in the future

const POST_QUERY = `query($input: PostInput!) { post(input: $input) { text status channelService
  assets { type source }
  metadata { ... on InstagramPostMetadata { type shouldShareToFeed stickerFields { text music } } } } }`

export async function fetchPost(bufferPostId) {
  const { post } = await bufferQuery(POST_QUERY, { input: { id: bufferPostId } })
  return post
}

// TikTok rejects images over 2,073,600px; the proxy downsizes (see api/img-proxy.js).
function assetInput(post, a) {
  if (String(a.type).toLowerCase() === 'video') return { video: { url: a.source } }
  let url = a.source
  if (post.channelService === 'tiktok' && !url.includes('img-proxy')) {
    try { if (new URL(url).hostname === HF_CDN) url = `${PROXY}?fit=tiktok&url=${encodeURIComponent(url)}` } catch { /* keep url */ }
  }
  return { image: { url } }
}

export async function approveRun(runId) {
  const { data, error } = await supabaseAdmin().from('scheduled_dispatches')
    .update({ status: 'approved', updated_at: new Date().toISOString() })
    .eq('run_id', runId).eq('status', 'pending').select('id')
  if (error) throw new Error(`Supabase: ${error.message}`)
  return data?.length || 0
}

// All rows that go out together: same run and same slot (a lone row when it has no run_id).
export async function groupOf(rowId, statuses = ['approved']) {
  const db = supabaseAdmin()
  const { data: row, error } = await db.from('scheduled_dispatches').select('*').eq('id', rowId).maybeSingle()
  if (error) throw new Error(`Supabase: ${error.message}`)
  if (!row) return []
  if (!row.run_id) return statuses.includes(row.status) ? [row] : []
  const { data, error: e2 } = await db.from('scheduled_dispatches').select('*')
    .eq('run_id', row.run_id).eq('scheduled_for', row.scheduled_for).in('status', statuses)
  if (e2) throw new Error(`Supabase: ${e2.message}`)
  return data || []
}

export async function releaseGroup(rowId) {
  const db = supabaseAdmin()
  const rows = await groupOf(rowId)
  if (!rows.length) return { scheduled: 0, failures: ['אין כאן מה לפרסם — כבר טופל'], dueAt: null }
  let scheduled = 0
  const failures = []
  let dueAt = null
  for (const row of rows) {
    try {
      const post = await fetchPost(row.buffer_post_id)
      const due = new Date(Math.max(new Date(row.scheduled_for).getTime(), Date.now() + MIN_LEAD_MS)).toISOString()
      dueAt = due
      const sf = post.metadata?.stickerFields
      const metadata = post.metadata?.type
        ? { instagram: { type: post.metadata.type, shouldShareToFeed: post.metadata.shouldShareToFeed,
            ...((sf?.text || sf?.music) ? { stickerFields: { ...(sf.text ? { text: sf.text } : {}), ...(sf.music ? { music: sf.music } : {}) } } : {}) } }
        : undefined
      const result = await bufferQuery(
        `mutation($input: EditPostInput!) { editPost(input: $input) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }`,
        { input: { id: row.buffer_post_id, text: post.text, assets: post.assets.map(a => assetInput(post, a)), mode: 'customScheduled', dueAt: due, schedulingType: 'automatic', saveToDraft: false, ...(metadata ? { metadata } : {}) } },
      )
      if (result.editPost?.message) throw new Error(result.editPost.message)
      await db.from('scheduled_dispatches').update({ status: 'scheduled', released_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', row.id)
      scheduled++
    } catch (e) {
      failures.push(`${row.platform}: ${e.message}`)
    }
  }
  return { scheduled, failures, dueAt }
}

export async function postponeGroup(rowId, hours = 24) {
  const db = supabaseAdmin()
  const rows = await groupOf(rowId)
  for (const row of rows) {
    const next = new Date(new Date(row.scheduled_for).getTime() + hours * 3600 * 1000).toISOString()
    await db.from('scheduled_dispatches').update({ scheduled_for: next, reminder_sent_at: null, updated_at: new Date().toISOString() }).eq('id', row.id)
  }
  return rows.length ? new Date(new Date(rows[0].scheduled_for).getTime() + hours * 3600 * 1000) : null
}

export async function skipGroup(rowId) {
  const rows = await groupOf(rowId)
  for (const row of rows) {
    await supabaseAdmin().from('scheduled_dispatches').update({ status: 'skipped', updated_at: new Date().toISOString() }).eq('id', row.id)
  }
  return rows.length
}

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

// "יום שבת 04/10 · 00:00 ישראל · 08:00 סידני · 17:00 ניו יורק"
export function heSlot(date) {
  const d = new Date(date)
  const part = (tz, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(d)
  const hm = (tz) => part(tz, { hour: '2-digit', minute: '2-digit', hour12: false })
  const dow = DAYS[new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).getDay()]
  return `יום ${dow} ${part('Asia/Jerusalem', { day: '2-digit', month: '2-digit' })} · ${hm('Asia/Jerusalem')} ישראל · ${hm('Australia/Sydney')} סידני · ${hm('America/New_York')} ניו יורק`
}

export function describePost(post) {
  const t = post.metadata?.type
  const n = post.assets?.length || 0
  if (post.channelService === 'instagram') {
    if (t === 'story') return 'סטורי באינסטגרם'
    if (t === 'reel') return 'ריל באינסטגרם'
    return n > 1 ? `פוסט קרוסלה באינסטגרם (${n} תמונות)` : 'פוסט פיד באינסטגרם'
  }
  if (post.channelService === 'tiktok') {
    return String(post.assets?.[0]?.type).toLowerCase() === 'video' ? 'סרטון בטיקטוק' : (n > 1 ? `פוסט תמונות בטיקטוק (${n})` : 'פוסט תמונה בטיקטוק')
  }
  return post.channelService
}
