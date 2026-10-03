#!/usr/bin/env node
// Glue between the GitHub Actions pipeline and the shared content_items record.
//   upsert --run-id X --run-dir D [--status in_review]   record plan/media/source for a finished generation
//   get --run-id X                                       print the item as JSON
//   apply-revision --run-id X --slide N --url U --prompt P   swap picture N in every draft + update the item
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (+ BUFFER_API_KEY for apply-revision).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addNote, getItem, upsertItem } from '../lib/contentItems.js'
import { replaceRunAsset } from '../lib/releaseGate.js'

const [cmd, ...rest] = process.argv.slice(2)
const arg = (n) => { const i = rest.indexOf(`--${n}`); return i > -1 ? rest[i + 1] : undefined }
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)

if (cmd === 'upsert') {
  const runId = arg('run-id'), dir = arg('run-dir')
  const plan = readJson(join(dir, 'content_plan.json'))?.days?.[0] || null
  const media0 = readJson(join(dir, 'media.json'))?.[0] || {}
  const inspire = readJson(join(dir, 'inspire.json'))
  const summaryPath = join(dir, 'telegram_summary.txt')
  const images = media0.images || (media0.image ? [media0.image] : [])
  await upsertItem(runId, {
    kind: media0.kind || (plan?.video_prompt ? 'video' : 'image'),
    source_url: inspire?.url || null,
    source_summary: existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8').slice(0, 3000) : null,
    plan,
    media: { ...media0, images },
    status: arg('status') || 'in_review',
  })
  console.log(`content item ${runId} recorded`)
} else if (cmd === 'get') {
  const item = await getItem(arg('run-id'))
  if (!item) { console.error('not found'); process.exit(1) }
  console.log(JSON.stringify(item))
} else if (cmd === 'apply-revision') {
  const runId = arg('run-id'), slide = Number(arg('slide')), url = arg('url'), prompt = arg('prompt')
  const item = await getItem(runId)
  if (!item) throw new Error(`no content item ${runId}`)
  const images = [...(item.media?.images || [])]
  const old = images[slide]
  if (!old) throw new Error(`no picture ${slide} in this item`)
  const changed = await replaceRunAsset(runId, old, url)
  images[slide] = url
  const plan = { ...(item.plan || {}) }
  if (plan.carousel_prompts?.length) plan.carousel_prompts = plan.carousel_prompts.map((p, i) => (i === slide ? prompt : p))
  if (slide === 0) plan.generation_prompt = prompt
  await upsertItem(runId, { media: { ...item.media, images, image: images[0] }, plan, status: 'in_review' })
  await addNote(runId, `picture ${slide + 1} regenerated (${changed} posts updated)`, 'generator')
  console.log(`replaced picture ${slide + 1} in ${changed} posts`)
} else {
  console.error('Usage: content-item.mjs <upsert|get|apply-revision> ...')
  process.exit(1)
}
