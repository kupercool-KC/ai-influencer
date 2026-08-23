// Server-only Supabase client. Uses the service-role key, which bypasses
// row-level security — that's intentional (there's no end-user auth system
// yet, and the browser never sees this key). Only import this from files
// under api/, never from src/.

import { createClient } from '@supabase/supabase-js'

let client = null

export function supabaseAdmin() {
  if (client) return client

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars')
  }

  client = createClient(url, key, { auth: { persistSession: false } })
  return client
}
