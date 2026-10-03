# Plain-Hebrew reason for the CURRENT workflow run's failure (source this file; needs gh + jq, GH_TOKEN, and the
# GITHUB_* variables). Says which step failed and, from the job log, WHY when it matches a known cause — a failure
# message must never be just "failed". Best effort: if the log can't be read it still names the step.
failure_reason_he() {
  local jobs step job_id logs what why=""
  jobs=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs" 2>/dev/null) || { echo "לא הצלחתי לקרוא את פרטי הכישלון"; return 0; }
  step=$(jq -r '[.jobs[].steps[] | select(.conclusion=="failure") | .name][0] // empty' <<< "$jobs")
  job_id=$(jq -r '[.jobs[] | select(any(.steps[]?; .conclusion=="failure")) | .id][0] // empty' <<< "$jobs")
  logs=""
  [ -n "$job_id" ] && logs=$(gh api "repos/$GITHUB_REPOSITORY/actions/jobs/$job_id/logs" 2>/dev/null | tail -n 500 || true)

  case "$step" in
    *Higgsfield*login*|*Install\ Higgsfield*) what="ההתחברות ל-Higgsfield" ;;
    *Scout*discover*|*Scout\ —\ discover*) what="סריקת ההשראות" ;;
    *Inspire*) what="ניתוח הקישור" ;;
    *Analyze*) what="ניתוח הסרטונים" ;;
    *Plan*) what="כתיבת התוכנית" ;;
    *Generate*) what="יצירת התמונות/הסרטון והטיוטות ב-Buffer" ;;
    *Regenerate*|*Plan\ the\ change*) what="יצירת התמונה המתוקנת" ;;
    *Send\ the\ picture*) what="שליחת התמונה לטלגרם" ;;
    *) what="${step:-שלב לא ידוע}" ;;
  esac

  if grep -qiE "Session expired" <<< "$logs"; then why="ההתחברות ל-Higgsfield פגה — צריך להריץ שוב את פקודת ה-seed"
  elif grep -qiE "isn't enough for this run|billing cycle|upgrading to a paid plan" <<< "$logs"; then why="נגמר התקציב החודשי של Apify (סריקת טיקטוק)"
  elif grep -qiE "Too many requests|HTTP 429|\b429\b" <<< "$logs"; then why="מכסת הקריאות של שירות חיצוני נגמרה (Buffer — כ-250 ביום). זה חוזר לבד"
  elif grep -qiE "insufficient.*credit|not enough credits|out of credits" <<< "$logs"; then why="אין מספיק קרדיטים ב-Higgsfield"
  elif grep -qiE "pixel count" <<< "$logs"; then why="התמונה גדולה מדי עבור טיקטוק"
  elif grep -qiE "Image could not be read" <<< "$logs"; then why="Buffer לא הצליח לקרוא את התמונה מהכתובת שלה"
  elif grep -qiE "Invalid post" <<< "$logs"; then why="Buffer דחה את הפוסט: $(grep -oiE 'Invalid post[^"]{0,120}' <<< "$logs" | head -1)"
  elif grep -qiE "HTTP 5[0-9][0-9]|503|502|timed? ?out|ETIMEDOUT" <<< "$logs"; then why="שירות חיצוני (Higgsfield/Buffer) לא היה זמין — כדאי לנסות שוב בעוד כמה דקות"
  elif grep -qiE "login wall|couldn't open that post|INSPIRE_ERROR" <<< "$logs"; then why="לא הצלחתי לפתוח את הפוסט (פרטי, נמחק, או שאינסטגרם ביקשה התחברות)"
  else
    why="לא זיהיתי סיבה מוכרת. השורה האחרונה בלוג: $(grep -iE 'error|failed|exception' <<< "$logs" | tail -1 | sed -E 's/^[0-9T:.Z-]+ //' | cut -c1-160)"
  fi
  echo "השלב שנכשל: $what"
  echo "הסיבה: $why"
}
