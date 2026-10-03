// Post by message: the owner sends photos/videos with a caption in Telegram and this turns them into
// Buffer posts — "עכשיו" in the caption publishes right away (the explicit instruction is the approval),
// otherwise they are queued for the next evening slot with the usual 15-minutes-before prompt.
//
// Server-only. Used by api/telegram/webhook.js.

import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from './supabaseAdmin.js'
import { bufferQuery } from './bufferClient.js'
import { releaseRows } from './releaseGate.js'

const IG_CHANNEL = '6aaff65cea19ca0bde976b01'
const TT_CHANNEL = '6aaff5bdea19ca0bde975a46'
const PROXY = 'https://ai-influencer-lovat.vercel.app/api/img-proxy'
const CONTENT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime' }

export const NOW_RE = /עכשיו|\bnow\b|מיד/i
const HE_PREFIX = '(?<![\u0590-\u05FF])(?:ול|וב|ל|ב|ו)?'
const IG_RE = new RegExp(`${HE_PREFIX}(?:אינסטגרם|אינסטה)|\\binstagram\\b|\\big\\b`, 'i')
const TT_RE = new RegExp(`${HE_PREFIX}טיקטוק|\\btiktok\\b`, 'i')
const STORY_RE = new RegExp(`${HE_PREFIX}סטורי|\\bstory\\b`, 'i')
const COMMAND_RE = /(פרסם|תעלה|העלה|שגר|publish|post)(?=\s|$|[:,.!])/gi
export const TRIGGER_RE = /פרסם|תעלה|העלה|שגר|\bpublish\b|\bpost\b/i

export function parseIntent(caption) {
  const text = caption || ''
  const story = STORY_RE.test(text)
  const ig = IG_RE.test(text)
  const tt = TT_RE.test(text)
  const platforms = story ? ['instagram'] : ig && !tt ? ['instagram'] : tt && !ig ? ['tiktok'] : ['instagram', 'tiktok']
  const clean = text.replace(COMMAND_RE, ' ').replace(new RegExp(NOW_RE.source, 'gi'), ' ').replace(new RegExp(IG_RE.source, 'gi'), ' ').replace(new RegExp(TT_RE.source, 'gi'), ' ').replace(new RegExp(STORY_RE.source, 'gi'), ' ')
    .replace(/\s+/g, ' ').replace(/^[\s:,.\-–—]+|[\s:,]+$/g, '').trim()
  return { now: NOW_RE.test(text), story, platforms, caption: clean }
}

export async function uploadToStorage(bytes, ext) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: key } = process.env
  const name = `${Date.now()}-${randomUUID()}.${ext}`
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/post-media/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream', 'x-upsert': 'true' },
    body: bytes,
  })
  if (!r.ok) throw new Error(`Storage upload failed: ${r.status} ${await r.text()}`)
  return `${SUPABASE_URL}/storage/v1/object/public/post-media/${name}`
}

function nextSlot() {
  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21, 0, 0))
  return now < today ? today : new Date(today.getTime() + 24 * 3600 * 1000)
}

const CREATE = `mutation($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }`

async function createDraft(channelId, text, assets, metadata) {
  const r = await bufferQuery(CREATE, { input: { text, channelId, schedulingType: 'automatic', mode: 'addToQueue', saveToDraft: true, assets, ...(metadata ? { metadata } : {}) } })
  if (r.createPost.message) throw new Error(r.createPost.message)
  return r.createPost.post.id
}

// items: [{ kind: 'photo' | 'video', url }]; returns a Hebrew summary + counts.
export async function createManualPost(items, rawCaption) {
  const intent = parseIntent(rawCaption)
  const photos = items.filter(i => i.kind === 'photo').map(i => i.url)
  const videos = items.filter(i => i.kind === 'video').map(i => i.url)
  if (!photos.length && !videos.length) throw new Error('לא התקבלה מדיה')
  const text = intent.caption || '✨'
  const runId = `manual-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`
  const slot = nextSlot().toISOString()
  const created = []
  const lines = []

  if (intent.platforms.includes('instagram')) {
    if (intent.story) {
      const id = await createDraft(IG_CHANNEL, text, [photos.length ? { image: { url: photos[0] } } : { video: { url: videos[0] } }],
        { instagram: { type: 'story', shouldShareToFeed: false, isAiGenerated: true, ...(intent.caption ? { stickerFields: { text: intent.caption } } : {}) } })
      created.push({ id, platform: 'instagram' }); lines.push('סטורי באינסטגרם')
    } else if (videos.length) {
      const id = await createDraft(IG_CHANNEL, text, [{ video: { url: videos[0] } }], { instagram: { type: 'reel', shouldShareToFeed: true, isAiGenerated: true } })
      created.push({ id, platform: 'instagram' }); lines.push('ריל באינסטגרם')
    } else {
      const pics = photos.slice(0, 10)
      const id = await createDraft(IG_CHANNEL, text, pics.map(u => ({ image: { url: u } })), { instagram: { type: 'post', shouldShareToFeed: true, isAiGenerated: true } })
      created.push({ id, platform: 'instagram' }); lines.push(pics.length > 1 ? `פוסט קרוסלה באינסטגרם (${pics.length} תמונות)` : 'פוסט תמונה באינסטגרם')
    }
  }
  if (intent.platforms.includes('tiktok')) {
    if (videos.length) {
      const id = await createDraft(TT_CHANNEL, text, [{ video: { url: videos[0] } }], { tiktok: { isAiGenerated: true } })
      created.push({ id, platform: 'tiktok' }); lines.push('סרטון בטיקטוק')
    } else {
      const pics = photos.slice(0, 35).map(u => ({ image: { url: `${PROXY}?fit=tiktok&url=${encodeURIComponent(u)}` } }))
      const id = await createDraft(TT_CHANNEL, text, pics)
      created.push({ id, platform: 'tiktok' }); lines.push(pics.length > 1 ? `פוסט תמונות בטיקטוק (${pics.length})` : 'פוסט תמונה בטיקטוק')
    }
  }

  const db = supabaseAdmin()
  const { data: rows, error } = await db.from('scheduled_dispatches').insert(created.map(c => ({
    influencer_id: 'ivy-vale', platform: c.platform, buffer_post_id: c.id, status: 'approved', scheduled_for: slot, run_id: runId,
  }))).select('*')
  if (error) throw new Error(`Supabase: ${error.message}`)

  if (intent.now) {
    const r = await releaseRows(rows, { immediate: true })
    return { lines, scheduled: r.scheduled, failures: r.failures, dueAt: r.dueAt, runId, now: true }
  }
  return { lines, scheduled: 0, failures: [], dueAt: slot, runId, now: false }
}
