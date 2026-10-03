"""Short Hebrew digests for the Telegram notifications — the owner reads Telegram on a phone, so
every agent's update must be a few bullets, not a wall of English. One cheap Claude call turns a
bulky English artifact (analysis report, link analysis, content plan) into {title, bullets}; the
workflow adds the bold title and bullet glyphs itself. Captions and prompts that actually go to
the platforms stay in English (Ivy posts in English) and are shown separately."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from content_scout.visual.auto_analyze import _call_claude, _strip_fences

KINDS = {
    "scan": (
        "דו\"ח ניתוח של סרטונים מהשוק שנסרקו היום",
        "3-4 נקודות: מה הסרטון/הפורמט שהצליח הכי הרבה, תבנית בולטת אחת, ומה כדאי לקחת מזה לאייבי.",
    ),
    "link": (
        "ניתוח של פוסט/ריל בודד שהבעלים שלח כהשראה",
        "3-4 נקודות: מה זה (משפט אחד), למה זה עובד, ומה נקח ממנו לאייבי.",
    ),
    "plan": (
        "תוכנית תוכן שנכתבה לאייבי (אחד או יותר ימים)",
        "נקודה אחת לכל יום (\"יום N: ...\") שמסבירה מה נצלם/נעלה, בפורמט ובאווירה; אם יש סרטון ציין את אורכו. "
        "אל תעתיק פרומפטים או כיתובים — הם מוצגים בנפרד.",
    ),
}

PROMPT = """אתה מסכם הודעת עדכון לטלגרם עבור בעל הפרויקט (לא טכני, קורא מהטלפון).
החומר: {what}

כללים:
- עברית פשוטה וקצרה. {shape}
- כל נקודה עד 14 מילים. בלי מונחים טכניים, בלי שמות מודלים, בלי הקדמות.
- שמות חשבונות/מותגים נשארים באנגלית.
- החזר רק JSON: {{"title": "כותרת של 2-4 מילים", "bullets": ["...", "..."]}}

=== החומר ===
{source}"""


def hebrew_digest(api_key: str, kind: str, source_text: str) -> dict[str, Any]:
    what, shape = KINDS[kind]
    raw = _call_claude(
        api_key,
        [{"type": "text", "text": PROMPT.format(what=what, shape=shape, source=source_text[:12000])}],
        max_tokens=700,
    )
    data = json.loads(_strip_fences(raw))
    bullets = [str(b).strip() for b in data.get("bullets", []) if str(b).strip()][:5]
    return {"title": str(data.get("title", "")).strip(), "bullets": bullets}


def digest_file(api_key: str, kind: str, path: Path) -> dict[str, Any]:
    return hebrew_digest(api_key, kind, path.read_text(encoding="utf-8"))
