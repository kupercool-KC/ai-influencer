import { supabaseAdmin } from '../../lib/supabaseAdmin.js'

// Append-only event log (persona created, image generated, draft dispatched,
// etc.) — the audit trail behind the Telegram bot's "what happened" answers
// and any future dashboard.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const db = supabaseAdmin()

  if (req.method === 'GET') {
    const { influencer_id, limit } = req.query
    let q = db.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(Number(limit) || 50)
    if (influencer_id) q = q.eq('influencer_id', influencer_id)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ activity_logs: data })
  }

  if (req.method === 'POST') {
    const { event_type, influencer_id, details } = req.body || {}
    if (!event_type) return res.status(400).json({ error: 'event_type is required' })
    const { data, error } = await db
      .from('activity_logs')
      .insert({ event_type, influencer_id: influencer_id || null, details: details || {} })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ activity_log: data })
  }

  return res.status(405).send('Method not allowed')
}
