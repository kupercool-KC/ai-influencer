// Health check: confirms the Vercel function can actually reach Supabase
// with the configured credentials. Visit /api/db/ping after setting the
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars to verify the connection.

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'

export default async function handler(req, res) {
  const debug = {
    hasUrl: !!process.env.SUPABASE_URL,
    hasKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    urlPrefix: (process.env.SUPABASE_URL || '').slice(0, 20),
  }
  try {
    const { count, error } = await supabaseAdmin()
      .from('influencers')
      .select('*', { count: 'exact', head: true })

    if (error) throw error
    return res.status(200).json({ ok: true, influencerCount: count, debug })
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message || String(e),
      name: e.name,
      debug,
    })
  }
}
