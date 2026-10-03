// Turns a raw technical error into a plain Hebrew reason for Telegram — a failure message must always say WHY
// (the owner should never see only "failed" or an English stack line). Unknown errors fall back to the raw text.
const RULES = [
  [/Too many requests|\b429\b|rate.?limit/i, 'מכסת הקריאות של השירות נגמרה (בדרך כלל Buffer — כ-250 קריאות ביום). זה חוזר לבד, בלי שתצטרך לעשות כלום'],
  [/Session expired/i, 'ההתחברות ל-Higgsfield פגה — צריך להתחבר מחדש (הפקודה seed)'],
  [/isn't enough for this run|billing cycle|upgrading to a paid plan|usage .*\$/i, 'נגמר התקציב החודשי של Apify (סריקת טיקטוק)'],
  [/pixel count/i, 'התמונה גדולה מדי עבור טיקטוק'],
  [/Image could not be read|could not be read from its URL/i, 'Buffer לא הצליח לקרוא את התמונה מהכתובת שלה'],
  [/Instagram posts require|Post must have either text or media/i, 'Buffer דחה את הפוסט: חסר סוג פוסט או מדיה'],
  [/Invalid post/i, 'Buffer דחה את הפוסט כלא תקין'],
  [/insufficient.*credit|not enough credits|out of credits/i, 'אין מספיק קרדיטים ב-Higgsfield'],
  [/GitHub dispatch failed/i, 'לא הצלחתי להפעיל את הריצה ב-GitHub'],
  [/Missing .*(KEY|TOKEN|SECRET|SUPABASE)/i, 'חסר מפתח או הגדרה בשרת'],
  [/HTTP 5\d\d|\b50[234]\b|timed? ?out|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up/i, 'שירות חיצוני לא זמין כרגע — כדאי לנסות שוב בעוד כמה דקות'],
  [/No (content item|plan|pending)|not found/i, 'הפריט לא נמצא (ייתכן שכבר טופל או נמחק)'],
  [/already (planned|published|deleted|in_production)/i, 'הפריט כבר טופל'],
]

export function explainError(message) {
  const raw = String(message ?? 'unknown error').replace(/\s+/g, ' ').trim()
  const hit = RULES.find(([re]) => re.test(raw))
  if (!hit) return `${raw.slice(0, 180)}`
  const detail = raw.length > 140 ? `${raw.slice(0, 137)}…` : raw
  return `${hit[1]} (פירוט טכני: ${detail})`
}
