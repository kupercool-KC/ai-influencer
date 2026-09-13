// Telegram bot webhook — the single entry point for the "control everything
// from Telegram" agent. Handles:
//   - /start, /menu        -> inline-keyboard menu, one button per agent
//   - /scout <niche>       -> triggers content-scout.yml
//   - /generate <prompt>   -> triggers higgsfield-generate.yml
//   - /dispatch <channel> | <image_url> | <caption> -> triggers buffer-dispatch.yml
//   - anything else (free text) -> "Chat" mode: forwarded to Claude, with
//     conversation history kept per chat_id in Supabase so it holds context
//     across messages. This is a fresh Claude call each time, not literally
//     this coding session — it has no memory of anything done outside this
//     bot's own conversation history.
//
// Security: only responds to chat IDs listed in TELEGRAM_ALLOWED_CHAT_IDS
// (comma-separated — TELEGRAM_OWNER_CHAT_ID alone still works for a single
// user), and only accepts requests carrying the secret token Telegram was
// configured to send (X-Telegram-Bot-Api-Secret-Token) — anyone else's
// message is silently ignored, since this bot can spend real money
// (Higgsfield credits, API calls, GitHub Actions minutes).

import { supabaseAdmin } from '../../lib/supabaseAdmin.js'
import { sendMessage, answerCallbackQuery, mainMenuKeyboard } from '../../lib/telegramClient.js'
import { dispatchWorkflow, runsUrl } from '../../lib/githubDispatch.js'

const MENU_TEXT = {
  scout: '*Content Scout*\nSend:\n`/scout <niche> | <platforms> | <limit> | <days>`\ne.g. `/scout coastal wellness yoga | tiktok,instagram | 15 | 90`\n(platforms/limit/days optional — default tiktok,instagram,youtube / 15 / 90)',
  generate: '*Generation*\nSend:\n`/generate <prompt>`\nUses gpt_image_2, 9:16, high, 2k by default.',
  dispatch: '*Dispatch*\nSend:\n`/dispatch <channel_id> | <image_url> | <caption>`\nCreates a Buffer DRAFT (never auto-publishes).',
  chat: '*Chat*\nJust type — no command needed. I\'ll remember this conversation.',
}

async function getHistory(chatId) {
  const db = supabaseAdmin()
  const { data } = await db.from('telegram_chats').select('messages').eq('chat_id', String(chatId)).maybeSingle()
  return data?.messages || []
}

async function saveHistory(chatId, messages) {
  const db = supabaseAdmin()
  await db.from('telegram_chats').upsert({ chat_id: String(chatId), messages, updated_at: new Date().toISOString() })
}

const PROJECT_CONTEXT = `You are the project assistant for "AI Influencer Studio" — a React+Vite app
(repo: kupercool-KC/ai-influencer) for building and running AI influencer personas end to end.

Current personas: Kayla, Camila, Olivia (established), and Ivy Vale (newest — a Byron Bay
coastal-wellness yoga instructor persona, Character A "The Wellness Aesthetic" from the
project's 3-persona portfolio strategy: Wellness / Luxury Traveler / Niche).

Pipeline (all in this one repo):
- Content Scout (agents/content-scout/, .github/workflows/content-scout.yml) — researches
  competing TikTok/Instagram/YouTube content for a niche.
- Generation (.github/workflows/higgsfield-generate.yml) — runs the official Higgsfield CLI
  server-side. The in-app browser "Generate" button is currently broken (Higgsfield's MCP
  endpoint rejects the app's dynamically-registered OAuth client with "Forbidden origin" —
  not fixable in our code, confirmed by testing the same endpoint with the CLI's own
  pre-approved OAuth client, which works). The CLI/workflow path is the working substitute.
- Dispatch (agents/dispatch/, .github/workflows/buffer-dispatch.yml) — creates Buffer DRAFT
  posts (never auto-publishes — content is still reviewed and published by hand).
- You (this Telegram bot) — one menu button per agent, plus this Chat mode.

Data model: Supabase tables influencers, expenses, media_assets (source of truth for
generated media, with version history via is_current), scheduled_dispatches, activity_logs,
fan_interactions, telegram_chats. Full reference: docs/db-schema.md in the repo.

Answer as a knowledgeable collaborator on this specific project — concise, direct, no filler.
If asked to do something that requires code changes or terminal access you don't have here,
say so plainly rather than pretending to have done it.`

async function askClaude(chatId, userText) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return 'ANTHROPIC_API_KEY is not configured on the server.'

  const history = await getHistory(chatId)
  const messages = [...history, { role: 'user', content: userText }].slice(-40)

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: PROJECT_CONTEXT,
      messages,
    }),
  })
  const data = await upstream.json()
  const reply = data?.content?.[0]?.text || `Claude error: ${data?.error?.message || 'unknown'}`

  await saveHistory(chatId, [...messages, { role: 'assistant', content: reply }])
  return reply
}

function parsePipes(text) {
  return text.split('|').map(s => s.trim()).filter(Boolean)
}

function allowedChatIds() {
  const list = [process.env.TELEGRAM_OWNER_CHAT_ID, ...(process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',')]
    .map(s => (s || '').trim())
    .filter(Boolean)
  return new Set(list)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed')

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (expectedSecret && req.headers['x-telegram-bot-api-secret-token'] !== expectedSecret) {
    return res.status(401).send('Unauthorized')
  }

  const allowed = allowedChatIds()
  const update = req.body || {}

  try {
    if (update.callback_query) {
      const cq = update.callback_query
      const chatId = cq.message.chat.id
      if (allowed.size && !allowed.has(String(chatId))) return res.status(200).end()

      const key = cq.data.replace('menu:', '')
      await answerCallbackQuery(cq.id, '')
      await sendMessage(chatId, MENU_TEXT[key] || 'Unknown option')
      return res.status(200).end()
    }

    const msg = update.message
    if (!msg || !msg.text) return res.status(200).end()
    const chatId = msg.chat.id

    if (allowed.size && !allowed.has(String(chatId))) {
      // Not an allowed user — never trigger anything, never spend money, don't even reply.
      return res.status(200).end()
    }

    const text = msg.text.trim()

    if (text === '/start' || text === '/menu') {
      await sendMessage(chatId, 'Pick an agent, or just type to chat:', { reply_markup: mainMenuKeyboard() })
      return res.status(200).end()
    }

    if (text.startsWith('/scout')) {
      const args = parsePipes(text.replace('/scout', ''))
      const [niche, platforms = 'tiktok,instagram,youtube', per_platform_limit = '15', since_days = '90'] = args
      if (!niche) { await sendMessage(chatId, MENU_TEXT.scout); return res.status(200).end() }
      await dispatchWorkflow('content-scout.yml', { niche, platforms, per_platform_limit, since_days })
      await sendMessage(chatId, `Scout run queued for "${niche}". Track it: ${runsUrl()}`)
      return res.status(200).end()
    }

    if (text.startsWith('/generate')) {
      const prompt = text.replace('/generate', '').trim()
      if (!prompt) { await sendMessage(chatId, MENU_TEXT.generate); return res.status(200).end() }
      await dispatchWorkflow('higgsfield-generate.yml', {
        model: 'gpt_image_2', prompt, aspect_ratio: '9:16', quality: 'high', resolution: '2k',
      })
      await sendMessage(chatId, `Generation queued. Track it: ${runsUrl()}`)
      return res.status(200).end()
    }

    if (text.startsWith('/dispatch')) {
      const args = parsePipes(text.replace('/dispatch', ''))
      const [channel_id, image_url, caption] = args
      if (!channel_id || !image_url || !caption) { await sendMessage(chatId, MENU_TEXT.dispatch); return res.status(200).end() }
      await dispatchWorkflow('buffer-dispatch.yml', { channel_id, image_url, caption })
      await sendMessage(chatId, `Draft queued for Buffer channel ${channel_id}. Track it: ${runsUrl()}`)
      return res.status(200).end()
    }

    // Anything else -> chat mode
    const reply = await askClaude(chatId, text)
    await sendMessage(chatId, reply)
    return res.status(200).end()
  } catch (e) {
    try { await sendMessage(update.message?.chat?.id || process.env.TELEGRAM_OWNER_CHAT_ID, `Error: ${e.message}`) } catch { /* best effort */ }
    return res.status(200).end()
  }
}
