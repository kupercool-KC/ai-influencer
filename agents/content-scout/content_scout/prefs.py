"""The owner's standing instructions ("from now on ...") live in Supabase (owner_preferences) so a Telegram
message can change how every plan is written. Plan prompts call preferences_block() at run time; any failure
just means "no extra preferences" — a missing database must never stop content from being made."""
from __future__ import annotations

import os

import requests


def fetch_owner_preferences() -> list[str]:
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return []
    try:
        r = requests.get(
            f"{url}/rest/v1/owner_preferences?select=key,value&order=updated_at",
            headers={"apikey": key, "Authorization": f"Bearer {key}"}, timeout=15,
        )
        r.raise_for_status()
        return [row["value"] for row in r.json() if not row["key"].startswith("pending_revision:")]
    except Exception:  # noqa: BLE001
        return []


def preferences_block() -> str:
    prefs = fetch_owner_preferences()
    if not prefs:
        return ""
    return "=== OWNER'S STANDING INSTRUCTIONS (follow these on top of everything above) ===\n" + "\n".join(f"- {p}" for p in prefs)


def learning_block() -> str:
    """What worked / flopped for Ivy herself (from post_metrics, refreshed daily from Buffer) — shapes the next plan.
    Needs at least 3 published posts with views, otherwise it stays silent (noise is not a lesson)."""
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return ""
    try:
        r = requests.get(
            f"{url}/rest/v1/post_metrics?select=kind,text,metrics&order=posted_at.desc&limit=40",
            headers={"apikey": key, "Authorization": f"Bearer {key}"}, timeout=15,
        )
        r.raise_for_status()
        rows = [x for x in r.json() if x["kind"] != "story" and (x["metrics"] or {}).get("views", 0) > 0]
        if len(rows) < 3:
            return ""
        rows.sort(key=lambda x: x["metrics"].get("views", 0), reverse=True)

        def line(x: dict) -> str:
            m = x["metrics"]
            return f'[{x["kind"]}] {m.get("views", 0)} views, {m.get("reactions", 0)} likes, {m.get("comments", 0)} comments: "{(x["text"] or "")[:110]}"'

        return ("=== WHAT HAS WORKED FOR IVY HERSELF (her real results — lean toward the style of the top ones, away from the "
                "bottom ones, without copying) ===\nTop:\n" + "\n".join(f"- {line(x)}" for x in rows[:3])
                + "\nBottom:\n" + "\n".join(f"- {line(x)}" for x in rows[-2:]))
    except Exception:  # noqa: BLE001
        return ""
