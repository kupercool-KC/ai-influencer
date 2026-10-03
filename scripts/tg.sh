# Shared helpers for the pipeline's Telegram notifications (source this file; needs jq).
# Needs TELEGRAM_BOT_TOKEN, TELEGRAM_IVY_CHAT_ID in the environment. All messages are Hebrew HTML:
# bold title, a few bullets, long English prompts tucked into an expandable quote.

esc() { sed -e 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' <<< "$1"; }

# tg_send <thread_id> <html> [inline_keyboard_json]
# If Telegram rejects the HTML (e.g. a very long message got cut mid-tag), resend once as plain text.
tg_send() {
  local thread="$1" html="$2" kb="${3:-null}" resp
  [ ${#html} -gt 4000 ] && html="${html:0:3990}…"
  resp=$(jq -n --arg chat "$TELEGRAM_IVY_CHAT_ID" --argjson th "$thread" --arg text "$html" --argjson kb "$kb" \
    '{chat_id:$chat, message_thread_id:$th, text:$text, parse_mode:"HTML", disable_web_page_preview:true}
     + (if $kb then {reply_markup:$kb} else {} end)' \
  | curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -H "Content-Type: application/json" -d @-)
  if [ "$(jq -r '.ok' <<< "$resp")" != "true" ]; then
    echo "tg_send: HTML rejected ($(jq -r '.description' <<< "$resp")), retrying as plain text" >&2
    local plain; plain=$(sed -e 's/<[^>]*>//g; s/&lt;/</g; s/&gt;/>/g; s/&amp;/\&/g' <<< "$html")
    jq -n --arg chat "$TELEGRAM_IVY_CHAT_ID" --argjson th "$thread" --arg text "$plain" --argjson kb "$kb" \
      '{chat_id:$chat, message_thread_id:$th, text:$text, disable_web_page_preview:true}
       + (if $kb then {reply_markup:$kb} else {} end)' \
    | curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -H "Content-Type: application/json" -d @- > /dev/null
  fi
}

# bullets_html: reads bullet lines (plain text) on stdin, prints "• escaped" lines.
bullets_html() { while IFS= read -r l; do [ -n "$l" ] && echo "• $(esc "$l")"; done; }

# digest_html <digest-json> <fallback title>: "<b>title</b>\n• …" from a digest-he result.
digest_html() {
  local j="$1" fallback="$2" title
  title=$(jq -r '.title // ""' <<< "$j"); [ -z "$title" ] && title="$fallback"
  echo "<b>$(esc "$title")</b>"
  jq -r '.bullets[]?' <<< "$j" | bullets_html
}

# he_slot <iso8601>: "יום שבת 04/10 · 00:00 ישראל · 08:00 סידני · 17:00 ניו יורק"
he_slot() {
  local iso="$1" names=(ראשון שני שלישי רביעי חמישי שישי שבת) dow
  dow=$(TZ=Asia/Jerusalem date -d "$iso" +%w)
  echo "יום ${names[$dow]} $(TZ=Asia/Jerusalem date -d "$iso" '+%d/%m') · $(TZ=Asia/Jerusalem date -d "$iso" +%H:%M) ישראל · $(TZ=Australia/Sydney date -d "$iso" +%H:%M) סידני · $(TZ=America/New_York date -d "$iso" +%H:%M) ניו יורק"
}
