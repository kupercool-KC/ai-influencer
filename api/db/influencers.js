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

  // Upsert — the app generates the id client-side (generateId() in store.jsx)
  // and calls this on every create/edit, so conflicts on id are expected, not errors.
  if (req.method === 'POST') {
    const { id, name, gender, niche, data } = req.body || {}
    if (!id || !name) {
      return res.status(400).json({ error: 'id and name are required' })
    }
    const { data: row, error } = await db
      .from('influencers')
      .upsert({ id, name, gender, niche, data: data || {} })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ influencer: row })
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
