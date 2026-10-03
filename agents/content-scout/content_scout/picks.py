"""Scout's push of the best fresh inspiration: from a finished scan, pick the posts that over-performed THEIR OWN
creator's usual (so a mega-account's baseline does not drown everything) and write them with a short Hebrew
"why it works" for the Telegram push.

  python -m content_scout.picks --run-id <id> --top 8 --out picks.json
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path

from content_scout import storage
from content_scout.config import load_settings
from content_scout.digest_he import hebrew_digest


def _engagement(b: dict) -> float:
    s = b["metadata"]["stats"]
    return float((s.get("likes") or 0) + (s.get("comments") or 0))


def pick(run_id: str, top: int, api_key: str) -> list[dict]:
    settings = load_settings()
    paths = storage.RunPaths(settings.data_dir, run_id)
    briefs = [(bp, storage.read_brief(bp)) for bp in paths.iter_briefs()]
    done = [(bp, b) for bp, b in briefs if b.get("visual_analysis", {}).get("status") == "done"]
    by_author: dict[str, list[float]] = {}
    for _, b in done:
        by_author.setdefault(b["metadata"]["author_handle"], []).append(_engagement(b))
    scored = []
    for bp, b in done:
        author = b["metadata"]["author_handle"]
        peers = by_author[author]
        if len(peers) >= 3 and statistics.median(peers) > 0:
            score = _engagement(b) / statistics.median(peers)  # x-times the creator's usual
        else:
            score = 1.0 + float(b.get("ranking", {}).get("composite_score", 0))  # not enough peers: pool-relative rank
        scored.append((score, bp, b))
    scored.sort(key=lambda t: t[0], reverse=True)
    out = []
    for score, bp, b in scored[:top]:
        va = b["visual_analysis"]
        text = (f"@{b['metadata']['author_handle']} ({b['platform']}). {va.get('title', '')}. {va.get('what_its_about', '')} "
                f"Format: {va.get('format_archetype', '')}. Hook: {va.get('hook_first_3_sec', '')}. Read: {va.get('read', '')}")
        try:
            digest = hebrew_digest(api_key, "link", text)
        except Exception:  # noqa: BLE001
            digest = {"title": "השראה חדשה", "bullets": []}
        frames = sorted((bp.parent / "frames").glob("keyframe_*.jpg"))
        out.append({
            "url": b["url"], "platform": b["platform"], "author": b["metadata"]["author_handle"],
            "score": round(score, 2), "title": digest["title"], "bullets": digest["bullets"],
            "thumb": str(frames[0]) if frames else None,
        })
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    Path(args.out).write_text(json.dumps(pick(args.run_id, args.top, os.environ["ANTHROPIC_API_KEY"]), ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
