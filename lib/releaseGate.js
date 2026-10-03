// Release gate: nothing the pipeline makes is published without the owner's tap shortly before
// its slot. Flow: pipeline -> Buffer DRAFTs + scheduled_dispatches rows (status 'pending') ->
// owner taps Approve once (rows become 'approved', Buffer posts stay drafts) -> 15 minutes before
// each slot the cron (api/cron/release-reminders.js) sends the actual pictures/videos with
// [publish on time / postpone a day / cancel] -> only "publish" schedules the post in Buffer.
//
// Server-only. Used by api/telegram/webhook.js (button taps) and api/cron/release-reminders.js.

import { supabaseAdmin } from './supabaseAdmin.js'
import { bufferQuery } from './bufferClient.js'
import { setStatus } from './contentItems.js'

const PROXY = 'https://ai-influencer-lovat.vercel.app/api/img-proxy'
const HF_CDN = 'd8j0ntlcm91z4.cloudfront.net'
const MIN_LEAD_MS = 2 * 60 * 1000 // Buffer needs a due time comfortably in the future

const POST_QUERY = `query($input: PostInput!) { post(input: $input) { text status dueAt channelService
  assets { type source }
  metadata { ... on InstagramPostMetadata { type shouldShareToFeed isAiGenerated stickerFields { text music } } } } }`

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

export async function approveRun(runId, { auto = false } = {}) {
  const { data, error } = await supabaseAdmin().from('scheduled_dispatches')
    .update({ status: 'approved', auto_release: auto, updated_at: new Date().toISOString() })
    .eq('run_id', runId).eq('status', 'pending').select('id')
  if (error) throw new Error(`Supabase: ${error.message}`)
  if (data?.length) await setStatus(runId, 'approved')
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

// AI disclosure (owner approved 2026-10-03): every Instagram post is flagged as AI-generated, and so is
// every TikTok video (Buffer only supports the TikTok flag on video posts).
function metadataFor(post) {
  const sf = post.metadata?.stickerFields
  if (post.channelService === 'instagram' && post.metadata?.type) {
    return { instagram: { type: post.metadata.type, shouldShareToFeed: post.metadata.shouldShareToFeed, isAiGenerated: true,
      ...((sf?.text || sf?.music) ? { stickerFields: { ...(sf.text ? { text: sf.text } : {}), ...(sf.music ? { music: sf.music } : {}) } } : {}) } }
  }
  if (post.channelService === 'tiktok' && String(post.assets?.[0]?.type).toLowerCase() === 'video') return { tiktok: { isAiGenerated: true } }
  return undefined
}

// Schedules the given rows in Buffer. `immediate` = the owner said "publish now": due in 2 minutes
// instead of the planned slot.
export async function releaseRows(rows, { immediate = false } = {}) {
  const db = supabaseAdmin()
  let scheduled = 0
  const failures = []
  let dueAt = null
  for (const row of rows) {
    try {
      const post = await fetchPost(row.buffer_post_id)
      const planned = immediate ? 0 : new Date(row.scheduled_for).getTime()
      const due = new Date(Math.max(planned, Date.now() + MIN_LEAD_MS)).toISOString()
      dueAt = due
      const metadata = metadataFor(post)
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
  if (scheduled && rows[0]?.run_id) await setStatus(rows[0].run_id, 'scheduled')
  return { scheduled, failures, dueAt }
}

export async function releaseGroup(rowId) {
  const rows = await groupOf(rowId)
  if (!rows.length) return { scheduled: 0, failures: ['אין כאן מה לפרסם — כבר טופל'], dueAt: null }
  return releaseRows(rows)
}

// "Publish this now" from the owner: approval and release in one step, for a whole run (optionally
// only one platform).
export async function publishRunNow(runId, platforms) {
  const { data: rows, error } = await supabaseAdmin().from('scheduled_dispatches').select('*')
    .eq('run_id', runId).in('status', ['pending', 'approved'])
  if (error) throw new Error(`Supabase: ${error.message}`)
  const chosen = (rows || []).filter(r => !platforms?.length || platforms.includes(r.platform))
  if (!chosen.length) return { scheduled: 0, failures: ['אין פריטים ממתינים להרצה הזו'], dueAt: null }
  return releaseRows(chosen, { immediate: true })
}

// A compact view of everything not yet published, for the agents' system prompt.
export async function openQueueSummary() {
  const { data } = await supabaseAdmin().from('scheduled_dispatches').select('run_id, platform, status, scheduled_for, created_at')
    .in('status', ['pending', 'approved']).order('created_at', { ascending: false }).limit(40)
  const runs = new Map()
  for (const r of data || []) {
    const key = r.run_id || r.created_at
    const cur = runs.get(key) || { run_id: r.run_id, created: r.created_at, status: r.status, slot: r.scheduled_for, items: [] }
    cur.items.push(r.platform)
    runs.set(key, cur)
  }
  const lines = [...runs.values()].slice(0, 8).map(r => `- run_id=${r.run_id} · created ${new Date(r.created).toISOString()} · ${r.status} · slot ${r.slot ? new Date(r.slot).toISOString() : '-'} · items: ${r.items.join(', ')}`)
  return lines.length ? lines.join('\n') : '(nothing waiting — every draft has been released or deleted)'
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

// Deleting is the owner's call for content that came out badly (2026-10-03): removes the Buffer
// post(s) so it can never go out, and closes the tracking rows. Generated files on Higgsfield's CDN
// can't be erased from here, but nothing will reference them any more.
async function deleteBufferPost(bufferPostId) {
  const r = await bufferQuery(
    `mutation($input: DeletePostInput!) { deletePost(input: $input) { __typename ... on MutationError { message } } }`,
    { input: { id: bufferPostId } },
  )
  if (r.deletePost?.message) throw new Error(r.deletePost.message)
}

export async function deleteRun(runId) {
  const db = supabaseAdmin()
  const { data: rows, error } = await db.from('scheduled_dispatches').select('*')
    .eq('run_id', runId).in('status', ['pending', 'approved', 'scheduled', 'skipped', 'missed'])
  if (error) throw new Error(`Supabase: ${error.message}`)
  let deleted = 0
  const failures = []
  for (const row of rows || []) {
    try {
      await deleteBufferPost(row.buffer_post_id)
      await db.from('scheduled_dispatches').update({ status: 'skipped', updated_at: new Date().toISOString() }).eq('id', row.id)
      deleted++
    } catch (e) {
      failures.push(`${row.platform}: ${e.message}`)
    }
  }
  if (deleted) await setStatus(runId, 'deleted')
  return { deleted, failures, total: rows?.length || 0 }
}

export async function deleteOnePost(bufferPostId) {
  await deleteBufferPost(bufferPostId)
  await supabaseAdmin().from('scheduled_dispatches').update({ status: 'skipped', updated_at: new Date().toISOString() }).eq('buffer_post_id', bufferPostId)
}

// ---- auto-release support: the owner pre-approved ("אשר ופרסם אוטומטית"), so the item is scheduled in Buffer at
// its slot when the 15-minutes-before notice goes out; these let him still cancel or postpone it afterwards.
async function resubmit(row, overrides) {
  const post = await fetchPost(row.buffer_post_id)
  const metadata = metadataFor(post)
  const result = await bufferQuery(
    `mutation($input: EditPostInput!) { editPost(input: $input) { ... on PostActionSuccess { post { id status dueAt } } ... on MutationError { message } } }`,
    { input: { id: row.buffer_post_id, text: post.text, assets: post.assets.map(a => assetInput(post, a)), schedulingType: 'automatic', ...(metadata ? { metadata } : {}), ...overrides } },
  )
  if (result.editPost?.message) throw new Error(result.editPost.message)
}

export async function cancelScheduledGroup(rowId) {
  const db = supabaseAdmin()
  const rows = await groupOf(rowId, ['scheduled'])
  let cancelled = 0
  for (const row of rows) {
    try {
      await resubmit(row, { mode: 'addToQueue', saveToDraft: true })
      await db.from('scheduled_dispatches').update({ status: 'skipped', updated_at: new Date().toISOString() }).eq('id', row.id)
      cancelled++
    } catch { /* leave it scheduled; the caller reports the shortfall */ }
  }
  return { cancelled, total: rows.length }
}

export async function postponeScheduledGroup(rowId, hours = 24) {
  const db = supabaseAdmin()
  const rows = await groupOf(rowId, ['scheduled'])
  let moved = 0
  let next = null
  for (const row of rows) {
    try {
      next = new Date(Math.max(new Date(row.scheduled_for).getTime(), Date.now()) + hours * 3600 * 1000)
      await resubmit(row, { mode: 'customScheduled', dueAt: next.toISOString(), saveToDraft: false })
      await db.from('scheduled_dispatches').update({ scheduled_for: next.toISOString(), updated_at: new Date().toISOString() }).eq('id', row.id)
      moved++
    } catch { /* ignore */ }
  }
  return { moved, total: rows.length, next }
}

// What actually happened to released posts: 'sent' -> posted, 'error' -> failed. Returns the changes so the
// caller can tell the owner once.
export async function checkPublished() {
  const db = supabaseAdmin()
  const cutoff = new Date(Date.now() - 4 * 60 * 1000).toISOString()
  const { data: rows } = await db.from('scheduled_dispatches').select('*').eq('status', 'scheduled').lt('scheduled_for', cutoff).limit(20)
  const changes = []
  for (const row of rows || []) {
    try {
      const { post } = await bufferQuery(`query($input: PostInput!) { post(input: $input) { status error externalLink channelService } }`, { input: { id: row.buffer_post_id } })
      if (post?.status === 'sent') {
        await db.from('scheduled_dispatches').update({ status: 'posted', updated_at: new Date().toISOString() }).eq('id', row.id)
        changes.push({ row, ok: true, link: post.externalLink })
      } else if (post?.status === 'error') {
        await db.from('scheduled_dispatches').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', row.id)
        changes.push({ row, ok: false, error: post.error || 'unknown error' })
      }
    } catch { /* try again next minute */ }
  }
  for (const c of changes) {
    if (!c.row.run_id) continue
    const { data: left } = await db.from('scheduled_dispatches').select('id').eq('run_id', c.row.run_id).eq('status', 'scheduled').limit(1)
    if (!left?.length) await setStatus(c.row.run_id, changes.some(x => x.row.run_id === c.row.run_id && !x.ok) ? 'failed' : 'published')
  }
  return changes
}

// Caption tweaks for a whole run (Instagram feed post/reel and/or TikTok post), keeping each post exactly
// where it is: drafts stay drafts, scheduled posts keep their time.
export async function updateRunCaptions(runId, { instagram, tiktok }) {
  const { data: rows, error } = await supabaseAdmin().from('scheduled_dispatches').select('*')
    .eq('run_id', runId).in('status', ['pending', 'approved', 'scheduled'])
  if (error) throw new Error(`Supabase: ${error.message}`)
  let changed = 0
  for (const row of rows || []) {
    const post = await fetchPost(row.buffer_post_id)
    const isFeed = post.channelService === 'instagram' && post.metadata?.type !== 'story'
    const text = post.channelService === 'tiktok' ? tiktok : isFeed ? instagram : undefined
    if (!text) continue
    await resubmit(row, { text, ...(post.status === 'scheduled' && post.dueAt ? { mode: 'customScheduled', dueAt: post.dueAt, saveToDraft: false } : { saveToDraft: true }) })
    changed++
  }
  return changed
}

// Swap one picture for another in every post of a run (Instagram post/story/reel and TikTok), keeping each post
// where it is (drafts stay drafts, scheduled posts keep their time). TikTok gets the resized proxy URL.
export async function replaceRunAsset(runId, oldUrl, newUrl) {
  const { data: rows, error } = await supabaseAdmin().from('scheduled_dispatches').select('*')
    .eq('run_id', runId).in('status', ['pending', 'approved', 'scheduled'])
  if (error) throw new Error(`Supabase: ${error.message}`)
  let changed = 0
  for (const row of rows || []) {
    const post = await fetchPost(row.buffer_post_id)
    let hit = false
    const assets = (post.assets || []).map(a => {
      const same = a.source === oldUrl || decodeURIComponent(a.source).includes(oldUrl)
      if (!same) return assetInput(post, a)
      hit = true
      return assetInput(post, { ...a, source: newUrl })
    })
    if (!hit) continue
    const metadata = metadataFor(post)
    const result = await bufferQuery(
      `mutation($input: EditPostInput!) { editPost(input: $input) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }`,
      { input: { id: row.buffer_post_id, text: post.text, assets, schedulingType: 'automatic', ...(metadata ? { metadata } : {}),
          ...(post.status === 'scheduled' && post.dueAt ? { mode: 'customScheduled', dueAt: post.dueAt, saveToDraft: false } : { saveToDraft: true }) } },
    )
    if (result.editPost?.message) throw new Error(`${row.platform}: ${result.editPost.message}`)
    changed++
  }
  return changed
}
