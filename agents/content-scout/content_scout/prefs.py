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
