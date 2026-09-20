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

// A Forum-group topic's replies must carry message_thread_id or they land in
// "General" instead of the topic the user is actually looking at. threadId is
// '' for DMs and for a group's own General topic — both mean "no thread param".
export function threadOpts(threadId) {
  return threadId ? { message_thread_id: Number(threadId) } : {}
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

// Removes the inline keyboard from a choice prompt once it's been answered,
// replacing it with plain text showing which option was picked — so the
// chat reads as a normal conversation instead of leaving live buttons behind
// that still look tappable after the fact.
export function editMessageText(chatId, messageId, text, extra = {}) {
  return call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra })
}

export function sendChatAction(chatId, action = 'typing', threadId = '') {
  return call('sendChatAction', { chat_id: chatId, action, ...threadOpts(threadId) }).catch(() => {}) // best-effort, never worth failing the request over
}

// Telegram's "typing…" indicator only lasts ~5s, so a slower call (Claude
// with tool use can take longer) needs it refreshed periodically to stay
// visible for the whole wait. Wrap any such call in this. threadId scopes
// the indicator to a Forum topic — without it, the "typing…" shows on the
// General topic instead of the one the user is actually looking at.
export async function withTyping(chatId, work, threadId = '') {
  sendChatAction(chatId, 'typing', threadId)
  const interval = setInterval(() => sendChatAction(chatId, 'typing', threadId), 4000)
  try {
    return await work()
  } finally {
    clearInterval(interval)
  }
}

export function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔍 Content Scout', callback_data: 'menu:scout' }],
      [{ text: '🎨 Generation', callback_data: 'menu:generate' }],
      [{ text: '📤 Dispatch', callback_data: 'menu:dispatch' }],
      [{ text: '👨‍💻 Code', callback_data: 'menu:code' }],
      [{ text: '💬 Chat', callback_data: 'menu:chat' }],
    ],
  }
}

// A persistent keyboard (always visible under the text box, unlike the
// inline one above) — tapping a tab switches which agent free-text
// messages go to, each with its own separate conversation memory. This is
// the DM equivalent of a Forum group's Topics (see api/telegram/webhook.js) —
// same 5 agents, same per-agent history, different UI surface.
export const TAB_LABELS = {
  scout: '🔍 Scout',
  generate: '🎨 Generate',
  dispatch: '📤 Dispatch',
  code: '👨‍💻 Code',
  chat: '💬 Chat',
}

export function tabsKeyboard() {
  return {
    keyboard: [
      [{ text: TAB_LABELS.scout }, { text: TAB_LABELS.generate }],
      [{ text: TAB_LABELS.dispatch }, { text: TAB_LABELS.code }],
      [{ text: TAB_LABELS.chat }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  }
}
