// Learning from Ivy's own results: pull Buffer's metrics for published posts into post_metrics every day, and
// send a short Hebrew weekly digest. The plan prompts read the same table (content_scout/prefs.py learning_block),
// so what worked/flopped shapes the next plans. Server-only; called from the every-minute cron.
import { supabaseAdmin } from './supabaseAdmin.js'
import { bufferQuery } from './bufferClient.js'

const ORG = '6a8b3e872cd60e6a351a87c6'
const CHANNELS = ['6aaff65cea19ca0bde976b01', '6aaff5bdea19ca0bde975a46']

const flat = (metrics) => Object.fromEntries((metrics || []).map(m => [m.type, m.value]))

export async function collectMetrics(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const d = await bufferQuery(
    `query($since: DateTime!) { posts(input: {organizationId: "${ORG}", filter: {channelIds: ${JSON.stringify(CHANNELS)}, status: [sent], dueAt: {start: $since}}, sort: [{field: dueAt, direction: desc}]}, first: 100) {
       edges { node { id channelService sentAt externalLink text metadata { ... on InstagramPostMetadata { type } } metrics { type value } } } } }`,
    { since },
  )
  const rows = (d.posts?.edges || []).map(({ node: n }) => ({
    buffer_post_id: n.id,
    platform: n.channelService,
    kind: n.channelService === 'tiktok' ? 'tiktok' : (n.metadata?.type || 'post'),
    text: n.text || null,
    posted_at: n.sentAt,
    external_link: n.externalLink,
    metrics: flat(n.metrics),
    updated_at: new Date().toISOString(),
  }))
  if (rows.length) {
    const { error } = await supabaseAdmin().from('post_metrics').upsert(rows, { onConflict: 'buffer_post_id' })
    if (error) throw new Error(`post_metrics: ${error.message}`)
  }
  return rows.length
}

const KIND_HE = { post: 'פוסט פיד', story: 'סטורי', reel: 'ריל', tiktok: 'טיקטוק' }
const num = (v) => Number(v || 0)

// Plain statistics, no LLM: best/worst by views, average views per kind.
export async function weeklyReport() {
  const since = new Date(Date.now() - 14 * 86400000).toISOString()
  const { data } = await supabaseAdmin().from('post_metrics').select('*').gte('posted_at', since).order('posted_at', { ascending: false })
  const rows = (data || []).filter(r => r.kind !== 'story' || num(r.metrics.views) > 0 || true)
  if (rows.length < 2) return null
  const ranked = [...rows].sort((a, b) => num(b.metrics.views) - num(a.metrics.views))
  const label = (r) => `${KIND_HE[r.kind] || r.kind} · ${num(r.metrics.views)} צפיות · ${num(r.metrics.reactions)} לייקים${r.external_link ? ` — <a href="${r.external_link}">קישור</a>` : ''}`
  const byKind = {}
  for (const r of rows) (byKind[r.kind] ||= []).push(num(r.metrics.views))
  const avg = Object.entries(byKind).map(([k, v]) => `${KIND_HE[k] || k}: ${Math.round(v.reduce((a, b) => a + b, 0) / v.length)} (${v.length} פוסטים)`)
  return [
    '📈 <b>סיכום שבועי — מה עבד ל-Ivy</b>',
    `• הכי טוב: ${label(ranked[0])}`,
    `• הכי חלש: ${label(ranked[ranked.length - 1])}`,
    `• ממוצע צפיות לפי סוג — ${avg.join(' · ')}`,
    `• סה"כ ${rows.length} פוסטים ב-14 הימים האחרונים`,
  ].join('\n')
}
