// Called every minute by pg_cron (see migration release_gate). Sends the "15 minutes to go —
// publish?" prompt, with the actual pictures/videos, for every approved item whose slot is near,
// and closes items whose slot passed without a tap. Auth: shared secret in service_credentials.
import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { sendMessage, sendMediaFromUrl, sendAlbumFromUrls } from '../../lib/telegramClient.js'
import { fetchPost, describePost, heSlot } from '../../lib/releaseGate.js'

const LEAD_MIN = 16 // fire a little early so the prompt lands ~15 minutes before the slot
const MISSED_AFTER_MIN = 30

async function dispatchTarget(db) {
  const { data } = await db.from('telegram_chats').select('chat_id, thread_id').eq('mode', 'dispatch').like('chat_id', '-%').limit(1)
  return data?.[0] || null
}

async function sendPrompt(db, target, group) {
  const posts = []
  for (const row of group) posts.push({ row, post: await fetchPost(row.buffer_post_id) })
  const threadId = target.thread_id || ''

  // Show each distinct picture/video once: images as one album, videos separately.
  const seen = new Set()
  const images = []
  const videos = []
  for (const { post } of posts) {
    for (const a of post.assets || []) {
      if (seen.has(a.source)) continue
      seen.add(a.source)
      ;(String(a.type).toLowerCase() === 'video' ? videos : images).push(a.source)
    }
  }
  try {
    if (images.length === 1) await sendMediaFromUrl(target.chat_id, threadId, { type: 'photo', url: images[0] })
    else if (images.length > 1) await sendAlbumFromUrls(target.chat_id, threadId, images.slice(0, 10))
    for (const v of videos) await sendMediaFromUrl(target.chat_id, threadId, { type: 'video', url: v })
  } catch (e) {
    console.error('media preview failed:', e.message)
  }

  const slot = new Date(group[0].scheduled_for)
  const mins = Math.max(0, Math.round((slot.getTime() - Date.now()) / 60000))
  const list = posts.map(({ post }) => `• ${describePost(post)}`).join('\n')
  const text = `⏰ <b>${mins > 0 ? `בעוד ${mins} דקות` : 'הגיע הזמן'} — לפרסם?</b>\n${list}\n• 🕘 ${heSlot(slot)}\n\nבלי הלחיצה שלך שום דבר לא יעלה.`
  const id = group[0].id
  await sendMessage(target.chat_id, text, {
    parse_mode: 'HTML',
    ...(threadId ? { message_thread_id: Number(threadId) } : {}),
    reply_markup: { inline_keyboard: [
      [{ text: '✅ פרסם בזמן', callback_data: `rel:go:${id}` }],
      [{ text: '⏭ דחה ליום הבא', callback_data: `rel:later:${id}` }, { text: '🗑 בטל', callback_data: `rel:skip:${id}` }],
    ] },
  })
  const now = new Date().toISOString()
  await db.from('scheduled_dispatches').update({ reminder_sent_at: now, updated_at: now }).in('id', group.map(g => g.id))
}

export default async function handler(req, res) {
  try {
    const db = supabaseAdmin()
    const { data: sec } = await db.from('service_credentials').select('value').eq('name', 'cron_secret').maybeSingle()
    if (!sec?.value || req.headers['x-cron-secret'] !== sec.value) return res.status(401).send('Unauthorized')

    const target = await dispatchTarget(db)
    if (!target) return res.status(200).json({ ok: true, note: 'no dispatch topic wired' })

    const horizon = new Date(Date.now() + LEAD_MIN * 60000).toISOString()
    const { data: due } = await db.from('scheduled_dispatches').select('*')
      .eq('status', 'approved').is('reminder_sent_at', null).lte('scheduled_for', horizon).order('scheduled_for')
    const groups = new Map()
    for (const row of due || []) {
      const key = row.run_id ? `${row.run_id}|${row.scheduled_for}` : row.id
      groups.set(key, [...(groups.get(key) || []), row])
    }
    let sent = 0
    for (const group of groups.values()) {
      try { await sendPrompt(db, target, group); sent++ } catch (e) { console.error('prompt failed:', e.message) }
    }

    // Prompted but never tapped, and the slot is long gone -> close it (it stays a Buffer draft).
    const stale = new Date(Date.now() - MISSED_AFTER_MIN * 60000).toISOString()
    const { data: missed } = await db.from('scheduled_dispatches').select('id, platform, scheduled_for')
      .eq('status', 'approved').not('reminder_sent_at', 'is', null).lt('scheduled_for', stale)
    if (missed?.length) {
      await db.from('scheduled_dispatches').update({ status: 'missed', updated_at: new Date().toISOString() }).in('id', missed.map(m => m.id))
      await sendMessage(target.chat_id, `⌛ <b>פוספס</b>\n• ${missed.length} פריטים לא אושרו בזמן ולא פורסמו\n• הם נשארו טיוטות ב-Buffer`, {
        parse_mode: 'HTML', ...(target.thread_id ? { message_thread_id: Number(target.thread_id) } : {}),
      })
    }
    return res.status(200).json({ ok: true, sent, missed: missed?.length || 0 })
  } catch (e) {
    console.error('release-reminders failed:', e)
    return res.status(500).json({ ok: false, error: e.message })
  }
}
