// Content items: one shared record per piece of content (run_id), so Scout, Generator and Dispatch all
// talk about the same thing and a Telegram button/reply can carry just the run_id.
// Server-only.
import { supabaseAdmin } from './supabaseAdmin.js'

export async function upsertItem(runId, patch) {
  const { data, error } = await supabaseAdmin().from('content_items')
    .upsert({ run_id: runId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'run_id' }).select().maybeSingle()
  if (error) throw new Error(`content_items: ${error.message}`)
  return data
}

export async function getItem(runId) {
  const { data, error } = await supabaseAdmin().from('content_items').select('*').eq('run_id', runId).maybeSingle()
  if (error) throw new Error(`content_items: ${error.message}`)
  return data
}

export async function listItems(limit = 10) {
  const { data, error } = await supabaseAdmin().from('content_items')
    .select('run_id, kind, status, source_url, plan, media, created_at').order('created_at', { ascending: false }).limit(limit)
  if (error) throw new Error(`content_items: ${error.message}`)
  return data || []
}

export async function addNote(runId, text, by = 'owner') {
  const item = await getItem(runId)
  if (!item) return null
  const notes = [...(item.notes || []), { at: new Date().toISOString(), by, text }]
  return upsertItem(runId, { notes })
}

// Best-effort status mirror — never let tracking break a release/delete.
export async function setStatus(runId, status) {
  if (!runId) return
  try { await supabaseAdmin().from('content_items').update({ status, updated_at: new Date().toISOString() }).eq('run_id', runId) } catch { /* ignore */ }
}
