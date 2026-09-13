// Server-only Telegram Bot API client. Never import from src/.

const API = 'https://api.telegram.org/bot'

function token() {
  const t = process.env.TELEGRAM_BOT_TOKEN
  if (!t) throw new Error('Missing TELEGRAM_BOT_TOKEN env var')
  return t
}

async function call(method, payload) {
  const r = await fetch(`${API}${token()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await r.json()
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || 'unknown error'}`)
  return data.result
}

export async function sendMessage(chatId, text, extra = {}) {
  try {
    return await call('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra })
  } catch (e) {
    // Telegram's legacy Markdown parser rejects the WHOLE message if it finds
    // an unmatched *_`[ character — easy to hit with free-form Claude replies
    // or code output. Rather than silently dropping the message, retry as
    // plain text (still with any keyboard/reply_markup intact).
    if (/can't parse entities/i.test(e.message)) {
      return call('sendMessage', { chat_id: chatId, text, ...extra })
    }
    throw e
  }
}

export function answerCallbackQuery(callbackQueryId, text) {
  return call('answerCallbackQuery', { callback_query_id: callbackQueryId, text })
}

export function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔍 Content Scout', callback_data: 'menu:scout' }],
      [{ text: '🎨 Generation', callback_data: 'menu:generate' }],
      [{ text: '📤 Dispatch', callback_data: 'menu:dispatch' }],
      [{ text: '💬 Chat', callback_data: 'menu:chat' }],
    ],
  }
}

// A persistent keyboard (always visible under the text box, unlike the
// inline one above) — tapping a tab switches which agent free-text
// messages go to, each with its own separate conversation memory.
export const TAB_LABELS = {
  scout: '🔍 Scout',
  generate: '🎨 Generate',
  dispatch: '📤 Dispatch',
  chat: '💬 Chat',
}

export function tabsKeyboard() {
  return {
    keyboard: [
      [{ text: TAB_LABELS.scout }, { text: TAB_LABELS.generate }],
      [{ text: TAB_LABELS.dispatch }, { text: TAB_LABELS.chat }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  }
}
