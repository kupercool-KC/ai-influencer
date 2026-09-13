import { supabaseAdmin } from '../../lib/supabaseAdmin.js'

// Tracks every Buffer draft/post created by the dispatch agent, linking it
// back to the influencer and media asset it came from.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const db = supabaseAdmin()

  if (req.method === 'GET') {
    const { influencer_id, status } = req.query
    let q = db.from('scheduled_dispatches').select('*').order('created_at', { ascending: false })
    if (influencer_id) q = q.eq('influencer_id', influencer_id)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ scheduled_dispatches: data })
  }

  if (req.method === 'POST') {
    const { influencer_id, media_asset_id, platform, buffer_post_id, status, scheduled_for } = req.body || {}
    if (!platform) return res.status(400).json({ error: 'platform is required' })
    const { data, error } = await db
      .from('scheduled_dispatches')
      .insert({
        influencer_id: influencer_id || null,
        media_asset_id: media_asset_id || null,
        platform,
        buffer_post_id: buffer_post_id || null,
        status: status || 'pending',
        scheduled_for: scheduled_for || null,
      })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ scheduled_dispatch: data })
  }

  if (req.method === 'PATCH') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id is required' })
    const { status, buffer_post_id, scheduled_for } = req.body || {}
    const patch = { updated_at: new Date().toISOString() }
    if (status) patch.status = status
    if (buffer_post_id) patch.buffer_post_id = buffer_post_id
    if (scheduled_for) patch.scheduled_for = scheduled_for
    const { data, error } = await db.from('scheduled_dispatches').update(patch).eq('id', id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ scheduled_dispatch: data })
  }

  return res.status(405).send('Method not allowed')
}
