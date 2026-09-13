import { supabaseAdmin } from '../../lib/supabaseAdmin.js'

// Source of truth for every generated image/video (see CLAUDE.md's storage
// convention). GET lists/filters; POST inserts a new asset and — when
// influencer_id + slot are given — marks any prior asset in that same slot
// as no longer current, so history is preserved instead of overwritten.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const db = supabaseAdmin()

  if (req.method === 'GET') {
    const { influencer_id, slot } = req.query
    let q = db.from('media_assets').select('*').order('created_at', { ascending: false })
    if (influencer_id) q = q.eq('influencer_id', influencer_id)
    if (slot) q = q.eq('slot', slot)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ media_assets: data })
  }

  if (req.method === 'POST') {
    const { influencer_id, slot, type, url, prompt, model, aspect_ratio, source, label } = req.body || {}
    if (!url) return res.status(400).json({ error: 'url is required' })

    if (influencer_id && slot) {
      await db.from('media_assets')
        .update({ is_current: false })
        .eq('influencer_id', influencer_id)
        .eq('slot', slot)
        .eq('is_current', true)
    }

    const { data, error } = await db
      .from('media_assets')
      .insert({
        influencer_id: influencer_id || null,
        slot: slot || null,
        type: type || 'image',
        url,
        prompt: prompt || null,
        model: model || null,
        aspect_ratio: aspect_ratio || null,
        source: source || 'app',
        label: label || slot || null,
        is_current: true,
      })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ media_asset: data })
  }

  if (req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id is required' })
    const { error } = await db.from('media_assets').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).send('Method not allowed')
}
