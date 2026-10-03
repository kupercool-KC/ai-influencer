#!/usr/bin/env node
// Scout's database helpers for the workflow.
//   accounts                       -> "instagram=a,b;tiktok=c,d" (active accounts from inspiration_accounts)
//   new-picks --file picks.json --max 3   -> JSON of picks not pushed before (recorded in inspiration_candidates)
import { readFileSync } from 'node:fs'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'

const [cmd, ...rest] = process.argv.slice(2)
const arg = (n) => { const i = rest.indexOf(`--${n}`); return i > -1 ? rest[i + 1] : undefined }
const db = supabaseAdmin()

if (cmd === 'accounts') {
  const { data, error } = await db.from('inspiration_accounts').select('platform, handle').eq('active', true).order('added_at')
  if (error) { console.error(error.message); process.exit(1) }
  const by = (p) => data.filter(r => r.platform === p).map(r => r.handle).join(',')
  console.log(`instagram=${by('instagram')};tiktok=${by('tiktok')}`)
} else if (cmd === 'new-picks') {
  const picks = JSON.parse(readFileSync(arg('file'), 'utf8'))
  const max = Number(arg('max') || 3)
  const out = []
  for (const p of picks) {
    if (out.length >= max) break
    const { data: seen } = await db.from('inspiration_candidates').select('id').eq('url', p.url).maybeSingle()
    if (seen) continue
    const { data, error } = await db.from('inspiration_candidates').insert({
      url: p.url, platform: p.platform, author: p.author, score: p.score, summary_he: [p.title, ...(p.bullets || [])].join(' | '),
    }).select('id').maybeSingle()
    if (error || !data) continue
    out.push({ ...p, id: data.id })
  }
  console.log(JSON.stringify(out))
} else if (cmd === 'add-candidate') {
  // One post the owner asked about: record it so the 🎨 buttons under the analysis can find it by id.
  const url = arg('url')
  const { data: seen } = await db.from('inspiration_candidates').select('id').eq('url', url).maybeSingle()
  if (seen) { await db.from('inspiration_candidates').update({ status: 'sent' }).eq('id', seen.id); console.log(seen.id) } else {
    const { data, error } = await db.from('inspiration_candidates').insert({ url, platform: arg('platform') || null, author: arg('author') || null, summary_he: 'asked by owner' }).select('id').maybeSingle()
    if (error || !data) { console.error(error?.message || 'insert failed'); process.exit(1) }
    console.log(data.id)
  }
} else {
  console.error('Usage: inspiration.mjs <accounts|new-picks|add-candidate>')
  process.exit(1)
}
