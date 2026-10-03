#!/usr/bin/env node
// Keeps the Higgsfield CLI's OAuth session alive across GitHub Actions runs.
//
// Why this exists: the CLI's access token lasts ~24h and is renewed with a refresh token that
// rotates on use. A static GitHub secret is therefore a one-shot copy — the first CI run that
// refreshes it invalidates the stored copy, and every later run dies with "Session expired"
// (this is what killed the 2026-10-01 and 2026-10-02 scheduled runs). Here the session lives in
// Supabase (service_credentials, service-role only) and each job loads it first and saves the
// refreshed file back last, so the chain never breaks and nobody has to re-login.
//
//   node scripts/higgsfield-creds.mjs load              # DB -> ~/.config/higgsfield/credentials.json (exit 3 if DB empty)
//   node scripts/higgsfield-creds.mjs save              # credentials.json -> DB (only if changed)
//   node scripts/higgsfield-creds.mjs seed              # one-time: browser login in an isolated HOME, then store in DB
//   node scripts/higgsfield-creds.mjs seed --from-file <credentials.json>
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const NAME = 'higgsfield'
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
const credsPath = (home) => join(home, '.config', 'higgsfield', 'credentials.json')

function requireEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    process.exit(1)
  }
}

const headers = () => ({ apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` })

async function fetchStored() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/service_credentials?name=eq.${NAME}&select=value`, { headers: headers() })
  if (!r.ok) throw new Error(`Supabase read failed: ${r.status} ${await r.text()}`)
  const rows = await r.json()
  return rows[0]?.value ?? null
}

async function store(value) {
  JSON.parse(value) // refuse to store anything that isn't a credentials JSON document
  const r = await fetch(`${SUPABASE_URL}/rest/v1/service_credentials?on_conflict=name`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ name: NAME, value, updated_at: new Date().toISOString() }),
  })
  if (!r.ok) throw new Error(`Supabase write failed: ${r.status} ${await r.text()}`)
}

function describe(value) {
  const d = JSON.parse(value)
  return `access token expires ${new Date(d.expires_at * 1000).toISOString()}, refresh token ${d.refresh_token ? 'present' : 'MISSING'}`
}

const [cmd, ...rest] = process.argv.slice(2)
requireEnv()

if (cmd === 'load') {
  const value = await fetchStored()
  if (!value) { console.error('No stored Higgsfield session in Supabase yet.'); process.exit(3) }
  const p = credsPath(homedir())
  mkdirSync(join(homedir(), '.config', 'higgsfield'), { recursive: true })
  writeFileSync(p, value, { mode: 0o600 })
  chmodSync(p, 0o600)
  console.log(`Loaded Higgsfield session from Supabase (${describe(value)}).`)
} else if (cmd === 'save') {
  const p = credsPath(homedir())
  if (!existsSync(p)) { console.error(`No credentials file at ${p} to save.`); process.exit(1) }
  const current = readFileSync(p, 'utf8')
  if (current === (await fetchStored())) { console.log('Higgsfield session unchanged, nothing to save.') }
  else { await store(current); console.log(`Saved refreshed Higgsfield session to Supabase (${describe(current)}).`) }
} else if (cmd === 'seed') {
  const fromFile = rest[0] === '--from-file' ? rest[1] : null
  let value
  if (fromFile) {
    value = readFileSync(fromFile, 'utf8')
  } else {
    // Log in inside a throwaway HOME so this automation gets its own OAuth session, instead of
    // sharing (and fighting over) the refresh-token chain of the one on this laptop.
    const home = mkdtempSync(join(tmpdir(), 'hf-ci-'))
    try {
      console.log('A browser window will open — log in to Higgsfield and approve access.')
      const r = spawnSync('higgsfield', ['auth', 'login'], { stdio: 'inherit', env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') } })
      if (r.status !== 0) { console.error('Higgsfield login did not complete.'); process.exit(1) }
      value = readFileSync(credsPath(home), 'utf8')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
  await store(value)
  console.log(`Stored Higgsfield session in Supabase (${describe(value)}). Automation can now keep it fresh by itself.`)
} else {
  console.error('Usage: higgsfield-creds.mjs <load|save|seed [--from-file path]>')
  process.exit(1)
}
