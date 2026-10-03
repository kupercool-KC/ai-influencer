#!/usr/bin/env node
// Sends the actual images/videos a pipeline produced into a Telegram chat/topic.
//
// Why uploads instead of handing Telegram a URL: Telegram only accepts URL photos up to 5MB and
// our 2k PNGs are bigger, so each image is downloaded here and downscaled with ffmpeg (already on
// the Actions runner) before being uploaded; videos are uploaded as-is.
//
//   node scripts/telegram-send.mjs --chat <id> [--thread <id>] --media '<json>' [--keyboard '<json>']
//
// <json> = [{"type":"photo"|"video","url":"https://…" (or "path":"local file"),"caption":"plain text","captionHtml":"<b>html</b>"}]
// `caption` is escaped for you; `captionHtml` is sent as-is (caller escapes). Two or more photos go
// as one album. An inline --keyboard is attached when there is exactly one item (that is how the
// Dispatch message carries both the picture and its Approve button).
// Needs TELEGRAM_BOT_TOKEN.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

const token = process.env.TELEGRAM_BOT_TOKEN
const chat = arg('chat')
const thread = arg('thread')
const media = JSON.parse(arg('media') || '[]')
const keyboard = arg('keyboard') ? JSON.parse(arg('keyboard')) : null
if (!token || !chat || !media.length) {
  console.error('Usage: telegram-send.mjs --chat <id> [--thread <id>] --media <json> [--keyboard <json>]  (+ TELEGRAM_BOT_TOKEN)')
  process.exit(1)
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const work = mkdtempSync(join(tmpdir(), 'tg-send-'))

function captionFields(item) {
  if (item.captionHtml) return { caption: item.captionHtml, parse_mode: 'HTML' }
  if (item.caption) {
    const t = item.caption.length > 1000 ? item.caption.slice(0, 999) + '…' : item.caption
    return { caption: esc(t), parse_mode: 'HTML' }
  }
  return {}
}

async function load(item, idx) {
  let bytes
  if (item.path) {
    bytes = readFileSync(item.path)
  } else {
    const r = await fetch(item.url)
    if (!r.ok) throw new Error(`Could not download ${item.url}: ${r.status}`)
    bytes = Buffer.from(await r.arrayBuffer())
  }
  let name = `${item.type}${idx}.${item.type === 'video' ? 'mp4' : 'jpg'}`
  if (item.type === 'photo') {
    const src = join(work, `in${idx}`)
    const out = join(work, `out${idx}.jpg`)
    writeFileSync(src, bytes)
    const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', out])
    if (ff.status === 0) bytes = readFileSync(out)
    else console.error(`ffmpeg resize failed for ${item.url}, sending original`)
  }
  return { name, blob: new Blob([bytes], { type: item.type === 'video' ? 'video/mp4' : 'image/jpeg' }) }
}

async function call(method, form) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form })
  const j = await r.json()
  if (!j.ok) throw new Error(`${method} failed: ${j.description}`)
  return j
}

function base(form) {
  form.set('chat_id', chat)
  if (thread) form.set('message_thread_id', thread)
  return form
}

try {
  const files = await Promise.all(media.map(load))
  const photos = media.map((m, i) => ({ m, f: files[i] })).filter(x => x.m.type === 'photo')
  const videos = media.map((m, i) => ({ m, f: files[i] })).filter(x => x.m.type === 'video')

  if (photos.length > 1) {
    const form = base(new FormData())
    form.set('media', JSON.stringify(photos.map((x, i) => ({ type: 'photo', media: `attach://p${i}`, ...captionFields(x.m) }))))
    photos.forEach((x, i) => form.set(`p${i}`, x.f.blob, x.f.name))
    await call('sendMediaGroup', form)
  } else if (photos.length === 1) {
    const form = base(new FormData())
    form.set('photo', photos[0].f.blob, photos[0].f.name)
    for (const [k, v] of Object.entries(captionFields(photos[0].m))) form.set(k, v)
    if (keyboard && media.length === 1) form.set('reply_markup', JSON.stringify(keyboard))
    await call('sendPhoto', form)
  }
  for (const v of videos) {
    const form = base(new FormData())
    form.set('video', v.f.blob, v.f.name)
    form.set('supports_streaming', 'true')
    for (const [k, val] of Object.entries(captionFields(v.m))) form.set(k, val)
    if (keyboard && media.length === 1) form.set('reply_markup', JSON.stringify(keyboard))
    await call('sendVideo', form)
  }
  console.log(`Sent ${media.length} item(s) to Telegram.`)
} catch (e) {
  console.error(e.message)
  process.exit(1)
} finally {
  rmSync(work, { recursive: true, force: true })
}
