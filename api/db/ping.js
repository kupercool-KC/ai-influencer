// Health check: confirms the Vercel function can actually reach Supabase
// with the configured credentials. Visit /api/db/ping after setting the
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars to verify the connection.

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  try {
    const r = await fetch(`${url}/rest/v1/influencers?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    const body = await r.text()
    return res.status(200).json({ httpStatus: r.status, body })
  } catch (e) {
    return res.status(500).json({ fetchThrew: true, message: e.message, name: e.name })
  }
}
