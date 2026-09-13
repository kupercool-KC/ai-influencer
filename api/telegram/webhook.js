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
// Security: only responds to TELEGRAM_OWNER_CHAT_ID, and only accepts
// requests carrying the secret token Telegram was configured to send
// (X-Telegram-Bot-Api-Secret-Token) — anyone else's message is silently
// ignored, since this bot can spend real money (Higgsfield credits, API
// calls, GitHub Actions minutes).

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed')

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (expectedSecret && req.headers['x-telegram-bot-api-secret-token'] !== expectedSecret) {
    return res.status(401).send('Unauthorized')
  }

  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  const update = req.body || {}

  try {
    if (update.callback_query) {
      const cq = update.callback_query
      const chatId = cq.message.chat.id
      if (ownerChatId && String(chatId) !== String(ownerChatId)) return res.status(200).end()

      const key = cq.data.replace('menu:', '')
      await answerCallbackQuery(cq.id, '')
      await sendMessage(chatId, MENU_TEXT[key] || 'Unknown option')
      return res.status(200).end()
    }

    const msg = update.message
    if (!msg || !msg.text) return res.status(200).end()
    const chatId = msg.chat.id

    if (ownerChatId && String(chatId) !== String(ownerChatId)) {
      // Not the owner — never trigger anything, never spend money, don't even reply.
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
    try { await sendMessage(update.message?.chat?.id || ownerChatId, `Error: ${e.message}`) } catch { /* best effort */ }
    return res.status(200).end()
  }
}
