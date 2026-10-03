// Called every minute by pg_cron (see migrations release_gate / release_reminders_via_webhook) through the
// Telegram webhook function (?job=release-reminders) — a separate api/ file would push the project past
// Vercel Hobby's 12-function cap and fail the whole deployment. Sends the "15 minutes to go —
// publish?" prompt, with the actual pictures/videos, for every approved item whose slot is near,
// and closes items whose slot passed without a tap. Auth: shared secret in service_credentials.
import { supabaseAdmin } from './supabaseAdmin.js'
import { sendMessage, sendMediaFromUrl, sendAlbumFromUrls } from './telegramClient.js'
import { fetchPost, describePost, heSlot, releaseRows, checkPublished } from './releaseGate.js'
import { collectMetrics, weeklyReport } from './performance.js'

const LEAD_MIN = 16 // fire a little early so the prompt lands ~15 minutes before the slot
const MISSED_AFTER_MIN = 30

async function topicTarget(db, mode) {
  const { data } = await db.from('telegram_chats').select('chat_id, thread_id').eq('mode', mode).like('chat_id', '-%').limit(1)
  return data?.[0] || null
}

// 08:00 Israel, once a day: refresh the performance numbers; on Sundays also send the weekly digest to Scout.
async function performanceTask(db) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date()))
  if (hour !== 8) return null
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())
  const { data: done } = await db.from('service_credentials').select('value').eq('name', 'metrics_collected_date').maybeSingle()
  if (done?.value === today) return null
  await db.from('service_credentials').upsert({ name: 'metrics_collected_date', value: today, updated_at: new Date().toISOString() }, { onConflict: 'name' })
  const n = await collectMetrics()
  const isSunday = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).getDay() === 0
  if (isSunday) {
    const text = await weeklyReport()
    const scout = await topicTarget(db, 'scout')
    if (text && scout) await sendMessage(scout.chat_id, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...(scout.thread_id ? { message_thread_id: Number(scout.thread_id) } : {}) })
  }
  return n
}

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

// Auto-release: the owner pre-approved this item, so it goes into Buffer at its slot now and he gets a
// heads-up with a way out (cancel / postpone) instead of a "publish?" question.
async function sendAutoRelease(db, target, group) {
  const posts = []
  for (const row of group) posts.push({ row, post: await fetchPost(row.buffer_post_id) })
  const threadId = target.thread_id || ''
  const slot = new Date(group[0].scheduled_for)
  const r = await releaseRows(group)
  const mins = Math.max(0, Math.round((slot.getTime() - Date.now()) / 60000))
  const list = posts.map(({ post }) => `• ${describePost(post)}`).join('\n')
  const id = group[0].id
  const text = r.scheduled
    ? `⏰ <b>${mins > 0 ? `בעוד ${mins} דקות` : 'עכשיו'} עולה — פרסום אוטומטי</b>\n${list}\n• 🕘 ${heSlot(slot)}\n\nאישרת מראש. עדיין אפשר לעצור:`
    : `⚠️ <b>הפרסום האוטומטי לא הצליח</b>\n${r.failures.slice(0, 3).map(f => `• ${f}`).join('\n')}`
  await sendMessage(target.chat_id, text, {
    parse_mode: 'HTML',
    ...(threadId ? { message_thread_id: Number(threadId) } : {}),
    ...(r.scheduled ? { reply_markup: { inline_keyboard: [[
      { text: '🛑 בטל פרסום', callback_data: `rel:cancel:${id}` }, { text: '⏭ דחה ליום הבא', callback_data: `rel:slater:${id}` },
    ]] } } : {}),
  })
  const now = new Date().toISOString()
  await db.from('scheduled_dispatches').update({ reminder_sent_at: now, updated_at: now }).in('id', group.map(g => g.id))
}

async function notifyPublished(target, changes) {
  const byRun = new Map()
  for (const c of changes) byRun.set(c.row.run_id || c.row.id, [...(byRun.get(c.row.run_id || c.row.id) || []), c])
  for (const group of byRun.values()) {
    const ok = group.filter(g => g.ok)
    const bad = group.filter(g => !g.ok)
    const lines = [
      ...ok.map(g => `• ✅ ${g.row.platform === 'tiktok' ? 'טיקטוק' : 'אינסטגרם'}${g.link ? ` — <a href="${g.link}">לצפייה</a>` : ''}`),
      ...bad.map(g => `• ❌ ${g.row.platform === 'tiktok' ? 'טיקטוק' : 'אינסטגרם'}: ${String(g.error).replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 200)}`),
    ]
    await sendMessage(target.chat_id, `${bad.length ? '⚠️ <b>בעיה בפרסום</b>' : '🎉 <b>עלה לאוויר</b>'}\n${lines.join('\n')}`, {
      parse_mode: 'HTML', disable_web_page_preview: true, ...(target.thread_id ? { message_thread_id: Number(target.thread_id) } : {}),
    })
  }
}

// One short Hebrew overview each morning (07:00 Israel): what is waiting and what goes out next.
async function morningSummary(db, target) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date()))
  if (hour !== 7) return false
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())
  const { data: done } = await db.from('service_credentials').select('value').eq('name', 'morning_summary_date').maybeSingle()
  if (done?.value === today) return false
  await db.from('service_credentials').upsert({ name: 'morning_summary_date', value: today, updated_at: new Date().toISOString() }, { onConflict: 'name' })
  const { data: rows } = await db.from('scheduled_dispatches').select('platform, status, scheduled_for, run_id')
    .in('status', ['pending', 'approved', 'scheduled']).order('scheduled_for').limit(60)
  const count = (st) => (rows || []).filter(r => r.status === st).length
  const next = (rows || []).filter(r => r.status !== 'pending').slice(0, 3)
  const lines = [
    `• ממתינים לאישור שלך: ${count('pending')} פריטים`,
    `• באישור ומחכים לשעה: ${count('approved')}`,
    `• מתוזמנים ב-Buffer: ${count('scheduled')}`,
    ...(next.length ? [`• הקרוב: ${heSlot(next[0].scheduled_for)}`] : []),
  ]
  await sendMessage(target.chat_id, `☀️ <b>בוקר טוב — מצב התוכן</b>\n${lines.join('\n')}`, {
    parse_mode: 'HTML', ...(target.thread_id ? { message_thread_id: Number(target.thread_id) } : {}),
  })
  return true
}

export async function runReleaseReminders(req, res) {
  const db = supabaseAdmin()
  try {
    const { data: sec } = await db.from('service_credentials').select('value').eq('name', 'cron_secret').maybeSingle()
    if (!sec?.value || req.headers['x-cron-secret'] !== sec.value) return res.status(401).send('Unauthorized')

    const target = await dispatchTarget(db)
    if (!target) return res.status(200).json({ ok: true, note: 'no dispatch topic wired' })

    const out = { sent: 0, auto: 0, missed: 0, published: 0, summary: false, metrics: null, errors: [] }
    const attempt = async (name, fn) => { try { return await fn() } catch (e) { console.error(`${name} failed:`, e); out.errors.push(`${name}: ${e.message}`) } }

    await attempt('reminders', async () => {
      const horizon = new Date(Date.now() + LEAD_MIN * 60000).toISOString()
      const { data: due } = await db.from('scheduled_dispatches').select('*')
        .eq('status', 'approved').is('reminder_sent_at', null).lte('scheduled_for', horizon).order('scheduled_for')
      const groups = new Map()
      for (const row of due || []) {
        const key = `${row.auto_release ? 'auto' : 'ask'}|${row.run_id ? `${row.run_id}|${row.scheduled_for}` : row.id}`
        groups.set(key, [...(groups.get(key) || []), row])
      }
      for (const [key, group] of groups) {
        try {
          if (key.startsWith('auto')) { await sendAutoRelease(db, target, group); out.auto++ } else { await sendPrompt(db, target, group); out.sent++ }
        } catch (e) { console.error('prompt failed:', e.message); out.errors.push(e.message) }
      }
    })

    await attempt('missed', async () => {
      // Prompted but never tapped, and the slot is long gone -> close it (it stays a Buffer draft).
      const stale = new Date(Date.now() - MISSED_AFTER_MIN * 60000).toISOString()
      const { data: missed } = await db.from('scheduled_dispatches').select('id, platform, scheduled_for')
        .eq('status', 'approved').not('reminder_sent_at', 'is', null).lt('scheduled_for', stale)
      if (missed?.length) {
        await db.from('scheduled_dispatches').update({ status: 'missed', updated_at: new Date().toISOString() }).in('id', missed.map(m => m.id))
        await sendMessage(target.chat_id, `⌛ <b>פוספס</b>\n• ${missed.length} פריטים לא אושרו בזמן ולא פורסמו\n• הם נשארו טיוטות ב-Buffer`, {
          parse_mode: 'HTML', ...(target.thread_id ? { message_thread_id: Number(target.thread_id) } : {}),
        })
        out.missed = missed.length
      }
    })

    await attempt('published', async () => {
      const changes = await checkPublished()
      if (changes.length) { await notifyPublished(target, changes); out.published = changes.length }
    })

    out.summary = Boolean(await attempt('summary', () => morningSummary(db, target)))
    out.metrics = await attempt('metrics', () => performanceTask(db))

    // A broken cron must not fail silently: tell the owner, at most once an hour.
    if (out.errors.length) {
      const { data: last } = await db.from('service_credentials').select('value').eq('name', 'cron_last_alert').maybeSingle()
      if (!last?.value || Date.now() - Number(last.value) > 3600 * 1000) {
        await db.from('service_credentials').upsert({ name: 'cron_last_alert', value: String(Date.now()), updated_at: new Date().toISOString() }, { onConflict: 'name' })
        await sendMessage(target.chat_id, `❌ <b>תקלה בבדיקה האוטומטית</b>\n• ${out.errors[0].replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 200)}`, {
          parse_mode: 'HTML', ...(target.thread_id ? { message_thread_id: Number(target.thread_id) } : {}),
        }).catch(() => {})
      }
    }
    return res.status(200).json({ ok: out.errors.length === 0, ...out })
  } catch (e) {
    console.error('release-reminders failed:', e)
    return res.status(500).json({ ok: false, error: e.message })
  }
}
