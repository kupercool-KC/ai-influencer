// Server-only Buffer GraphQL client. Never import from src/ -- the API key
// stays server-side, same rule as lib/supabaseAdmin.js.

export async function bufferQuery(query, variables = {}) {
  const apiKey = process.env.BUFFER_API_KEY
  if (!apiKey) throw new Error('Missing BUFFER_API_KEY env var')

  const r = await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  })

  const data = await r.json()
  if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '))
  return data.data
}
