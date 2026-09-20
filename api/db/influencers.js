import { supabaseAdmin } from '../../lib/supabaseAdmin.js'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const db = supabaseAdmin()

  if (req.method === 'GET') {
    const { data, error } = await db.from('influencers').select('*').order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ influencers: data })
  }

  // Fields the CLI/generation pipeline owns, not the (currently broken —
  // Higgsfield's in-app OAuth is rejected as "Forbidden origin") in-app
  // wizard. The app's own autosave pushes the browser's FULL local copy of
  // every influencer on every page load (src/store.jsx:160), so a stale
  // browser — one that never pulled a pipeline update — silently overwrote
  // these fields back to old values on nearly every visit. If the DB
  // already has a value here, an incoming push can't blank it out or swap
  // it for something different; the DB stays the source of truth for these
  // specific fields until a direct pipeline write (CLI/SQL) changes them.
  const PIPELINE_OWNED_FIELDS = [
    'mainImage', 'anchorImage', 'closeUpImage1', 'closeUpImage2', 'characterSheetImage',
    'soulId', 'soulModel', 'soulJobType', 'soulTrainedAt',
  ]

  // Upsert — the app generates the id client-side (generateId() in store.jsx)
  // and calls this on every create/edit, so conflicts on id are expected, not errors.
  if (req.method === 'POST') {
    const { id, name, gender, niche, data } = req.body || {}
    if (!id || !name) {
      return res.status(400).json({ error: 'id and name are required' })
    }

    const { data: existing } = await db.from('influencers').select('data').eq('id', id).maybeSingle()
    const incoming = { ...(data || {}) }
    const protectedFields = []
    if (existing?.data) {
      for (const field of PIPELINE_OWNED_FIELDS) {
        const existingValue = existing.data[field]
        if (existingValue != null && existingValue !== '' && incoming[field] !== existingValue) {
          incoming[field] = existingValue
          protectedFields.push(field)
        }
      }
    }

    const { data: row, error } = await db
      .from('influencers')
      .upsert({ id, name, gender, niche, data: incoming })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ influencer: row, protectedFields })
  }

  if (req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id is required' })
    const { error } = await db.from('influencers').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).send('Method not allowed')
}
