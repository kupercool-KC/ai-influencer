// Health check: confirms the Vercel function can actually reach Supabase
// with the configured credentials. Visit /api/db/ping to verify the
// connection.

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'

export default async function handler(req, res) {
  try {
    const { count, error } = await supabaseAdmin()
      .from('influencers')
      .select('*', { count: 'exact', head: true })

    if (error) throw error
    return res.status(200).json({ ok: true, influencerCount: count })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
}
