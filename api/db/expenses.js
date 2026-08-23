import { supabaseAdmin } from '../../lib/supabaseAdmin.js'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const db = supabaseAdmin()

  if (req.method === 'GET') {
    const { data, error } = await db.from('expenses').select('*').order('occurred_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ expenses: data })
  }

  if (req.method === 'POST') {
    const { kind, provider, label, amount_usd, billing_period, occurred_at, notes } = req.body || {}
    if (!kind || !provider || !label || amount_usd == null) {
      return res.status(400).json({ error: 'kind, provider, label, and amount_usd are required' })
    }
    const { data, error } = await db
      .from('expenses')
      .insert({ kind, provider, label, amount_usd, billing_period, occurred_at, notes })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ expense: data })
  }

  if (req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id is required' })
    const { error } = await db.from('expenses').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).send('Method not allowed')
}
