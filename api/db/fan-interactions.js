import { supabaseAdmin } from '../../lib/supabaseAdmin.js'

// Fan messages/DMs per influencer. No UI reads this yet — the table exists
// ahead of the feature that will consume it (a future fan-messaging tab).

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const db = supabaseAdmin()

  if (req.method === 'GET') {
    const { influencer_id } = req.query
    let q = db.from('fan_interactions').select('*').order('created_at', { ascending: false })
    if (influencer_id) q = q.eq('influencer_id', influencer_id)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ fan_interactions: data })
  }

  if (req.method === 'POST') {
    const { influencer_id, fan_identifier, message } = req.body || {}
    if (!influencer_id || !fan_identifier) return res.status(400).json({ error: 'influencer_id and fan_identifier are required' })
    const { data, error } = await db
      .from('fan_interactions')
      .insert({ influencer_id, fan_identifier, message: message || null })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ fan_interaction: data })
  }

  return res.status(405).send('Method not allowed')
}
