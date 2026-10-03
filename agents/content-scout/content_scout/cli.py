"""content-scout CLI.

    python -m content_scout.cli run --niche "..." --platforms tiktok,instagram,youtube ...
    python -m content_scout.cli resume --run-id RUN_ID [--force]
    python -m content_scout.cli report --run-id RUN_ID [--finalize]
    python -m content_scout.cli list-runs
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from content_scout import pipeline, storage
from content_scout.config import load_settings
from content_scout.media.download import download_video
from content_scout.media.frames import cleanup_raw_frames, dedup_frames, persist_keyframes, sample_frames, select_keyframes
from content_scout.models import ScoredVideo, new_brief
from content_scout.persona_content import generate_daily_plan, write_content_plan
from content_scout.platforms.base import KNOWN_PLATFORMS
from content_scout.platforms.instagram import discover_single_url
from content_scout.report.render import assemble_final_report
from content_scout.report.weekly import build_weekly_summary
from content_scout.utils.logging import get_logger
from content_scout.visual.auto_analyze import analyze_video
from content_scout.visual.stub import write_stub
from content_scout.visual import stub as visual_stub
from content_scout.visual.auto_analyze import analyze_and_fill

log = get_logger("content_scout.cli")


def _print_pending_checklist(pending: list[dict]) -> None:
    if not pending:
        print("\nAll videos have visual analysis filled in already — you can finalize the report.")
        return
    print(f"\n{len(pending)} video(s) need visual analysis (stage 7) before the report can be finalized:")
    for p in pending:
        print(f"  - [{p['platform']}] {p['video_id']}  ({p['url']})")
        for kf in p["keyframe_paths"]:
            print(f"      {kf}")
    print(
        "\nNext: ask Claude to read each video's keyframes above and fill in visual_analysis "
        "(content_scout.visual.stub.fill_visual_analysis), then write synthesis.md for the run, "
        "then run:\n    python -m content_scout.cli report --run-id <RUN_ID> --finalize"
    )


def cmd_run(args: argparse.Namespace) -> int:
    settings = load_settings()
    platforms = [p.strip() for p in args.platforms.split(",") if p.strip()]
    for p in platforms:
        if p not in KNOWN_PLATFORMS:
            print(f"Unknown platform '{p}'. Available: {', '.join(KNOWN_PLATFORMS)}", file=sys.stderr)
            return 2

    try:
        result = pipeline.run_pipeline(
            settings,
            niche=args.niche,
            platforms=platforms,
            instagram_accounts=args.instagram_accounts,
            tiktok_accounts=args.tiktok_accounts,
            per_platform_limit=args.per_platform_limit,
            since_days=args.since_days,
            recency_half_life_days=args.recency_half_life_days,
            run_id=args.run_id,
            force=args.force,
            keep_media=args.keep_media,
            skip_ocr=args.skip_ocr,
            skip_transcribe=args.skip_transcribe,
            dry_run=args.dry_run,
        )
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"\nRun '{result.run_id}' — {result.video_count} video(s) selected. Data: {result.run_dir}")
    if result.errors:
        print(f"{len(result.errors)} platform error(s):")
        for e in result.errors:
            print(f"  - {e}")
    if not args.dry_run:
        _print_pending_checklist(result.pending_visual)
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    settings = load_settings()
    try:
        result = pipeline.resume_pipeline(
            settings,
            run_id=args.run_id,
            force=args.force,
            keep_media=args.keep_media,
            skip_ocr=args.skip_ocr,
            skip_transcribe=args.skip_transcribe,
        )
    except FileNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"\nRun '{result.run_id}' resumed — {result.video_count} video(s) total. Data: {result.run_dir}")
    _print_pending_checklist(result.pending_visual)
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    settings = load_settings()
    paths = storage.RunPaths(settings.data_dir, args.run_id)
    if not paths.run_dir.exists():
        print(f"Error: no such run: {args.run_id}", file=sys.stderr)
        return 1

    if args.finalize:
        report_path = assemble_final_report(paths)
        print(f"Final report written: {report_path}")
    else:
        print(f"Stats report: {paths.report_stats_path}")
        print(f"Synthesis (write this yourself / ask Claude): {paths.synthesis_path}")
        print(f"Run --finalize once both exist to produce: {paths.report_path}")
    return 0


def cmd_analyze(args: argparse.Namespace) -> int:
    """Automated stage 7 + 10 — no interactive session needed. Fills visual_analysis for
    every pending video via the Anthropic API, writes synthesis.md + telegram_summary.txt,
    and finalizes report.md. This is what the scheduled weekly job runs."""
    settings = load_settings()
    paths = storage.RunPaths(settings.data_dir, args.run_id)
    if not paths.run_dir.exists():
        print(f"Error: no such run: {args.run_id}", file=sys.stderr)
        return 1

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY is not set.", file=sys.stderr)
        return 1

    pending = visual_stub.pending_videos(paths)
    print(f"Analyzing {len(pending)} video(s)...")
    for p in pending:
        brief_path = Path(p["brief_path"])
        brief = storage.read_brief(brief_path)
        try:
            analyze_and_fill(brief_path, brief, api_key)
            print(f"  done: [{p['platform']}] {p['video_id']}")
        except Exception as exc:  # noqa: BLE001 — one bad video shouldn't kill the whole analyze pass
            print(f"  failed: [{p['platform']}] {p['video_id']} — {exc}", file=sys.stderr)

    manifest = storage.read_manifest(paths)
    briefs = [storage.read_brief(bp) for bp in paths.iter_briefs()]
    synthesis_md, telegram_summary = build_weekly_summary(
        paths.run_dir, briefs, manifest["niche"], paths.run_id, api_key
    )
    paths.synthesis_path.write_text(synthesis_md, encoding="utf-8")
    telegram_path = paths.run_dir / "telegram_summary.txt"
    telegram_path.write_text(telegram_summary, encoding="utf-8")

    report_path = assemble_final_report(paths)
    print(f"\nSynthesis: {paths.synthesis_path}")
    print(f"Telegram summary: {telegram_path}")
    print(f"Final report: {report_path}")
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    """Turns an analyzed run's findings into num-days worth of persona content
    (generation prompt + caption + hashtags each), written to content_plan.json in the
    run directory. Run `analyze` first so briefs actually have visual_analysis filled in."""
    settings = load_settings()
    paths = storage.RunPaths(settings.data_dir, args.run_id)
    if not paths.run_dir.exists():
        print(f"Error: no such run: {args.run_id}", file=sys.stderr)
        return 1

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY is not set.", file=sys.stderr)
        return 1

    persona_dir = Path(args.persona_dir)
    if not (persona_dir / "persona.json").exists():
        print(f"Error: no persona.json found under {persona_dir}", file=sys.stderr)
        return 1

    briefs = [storage.read_brief(bp) for bp in paths.iter_briefs()]
    days = generate_daily_plan(briefs, persona_dir, args.num_days, api_key)
    out_path = write_content_plan(paths.run_dir, days)
    print(f"Wrote {len(days)} day(s) of content to {out_path}")
    return 0


def cmd_test_video(args: argparse.Namespace) -> int:
    """One-off diagnostic: run scout -> analyze -> plan on a single, explicitly-given
    Instagram post/reel URL (not an account) and print every intermediate result —
    the scraped metadata, the visual analysis, and the final generation prompt +
    caption. Deliberately stops there: no Higgsfield call, no Buffer draft. For
    verifying the pipeline against one specific video before trusting it unattended."""
    settings = load_settings()
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY is not set.", file=sys.stderr)
        return 1

    persona_dir = Path(args.persona_dir)
    if not (persona_dir / "persona.json").exists():
        print(f"Error: no persona.json found under {persona_dir}", file=sys.stderr)
        return 1

    print(f"--- Fetching {args.url} ---")
    raw = discover_single_url(args.url)
    if raw is None:
        print("Error: no video found at that URL (image-only post, or the page didn't load — "
              "check for an Instagram login wall).", file=sys.stderr)
        return 1
    print(f"Author: @{raw.author_handle}")
    print(f"Caption: {raw.caption!r}")
    print(f"Hashtags: {raw.hashtags}")
    print(f"Posted: {raw.posted_at.isoformat()}")
    print(f"Likes: {raw.likes}  Comments: {raw.comments}  (completeness: {raw.data_completeness})")

    video_dir = settings.data_dir / "adhoc" / raw.video_id
    scored = ScoredVideo(
        raw=raw, engagement_rate=0.0, views_per_day=0.0, recency_weight=1.0,
        raw_score=0.0, composite_score=0.0, rank_within_platform=1,
    )
    brief = new_brief(scored, run_id="adhoc")

    print("\n--- Downloading video ---")
    video_path, method = download_video(direct_media_url=raw.direct_media_url, page_url=raw.url, video_dir=video_dir)
    print(f"Downloaded via {method}: {video_path}")

    print("\n--- Sampling + selecting keyframes ---")
    raw_frames = sample_frames(video_path, work_dir=video_dir / "raw_frames")
    deduped = dedup_frames(raw_frames)
    selected = select_keyframes(deduped, n=6)
    keyframes = persist_keyframes(selected, frames_dir=video_dir / "frames")
    cleanup_raw_frames(video_dir / "raw_frames")
    print(f"{len(raw_frames)} sampled -> {len(deduped)} after dedup -> {len(keyframes)} keyframes kept")

    brief_path = video_dir / "brief.json"
    write_stub(brief, keyframes, video_dir)
    storage.write_brief(brief_path, brief)

    print("\n--- Visual analysis (Claude) ---")
    analysis = analyze_video(brief, video_dir, api_key)
    for k, v in analysis.items():
        print(f"  {k}: {v}")
    brief["visual_analysis"].update(analysis)
    brief["visual_analysis"]["status"] = "done"

    print("\n--- Generation plan (Claude) ---")
    days = generate_daily_plan([brief], persona_dir, num_days=1, api_key=api_key)
    print(json.dumps(days, indent=2))
    print("\nStopped here as requested — no Higgsfield call, no Buffer draft.")
    return 0


def cmd_inspire(args: argparse.Namespace) -> int:
    """Look at ONE pasted Instagram/TikTok link (video or photo post), analyze it, and write a
    content plan inspired by it into a normal run directory (prints `Run '<id>'` like `run`)."""
    from content_scout.inspire import InspirationError, run_inspire

    settings = load_settings()
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY is not set.", file=sys.stderr)
        return 1
    persona_dir = Path(args.persona_dir)
    if not (persona_dir / "persona.json").exists():
        print(f"Error: no persona.json found under {persona_dir}", file=sys.stderr)
        return 1
    try:
        run_id, run_dir = run_inspire(args.url, args.note, args.kind, persona_dir, settings, api_key)
    except InspirationError as exc:
        print(f"INSPIRE_ERROR: {exc}", file=sys.stderr)
        return 2
    print(f"Run '{run_id}' -> {run_dir}")
    return 0


def cmd_digest_he(args: argparse.Namespace) -> int:
    """Print a short Hebrew {title, bullets} JSON digest of a file, for Telegram notifications.
    Never fails the pipeline: on any error prints {"title": "", "bullets": []} and exits 0."""
    from content_scout.digest_he import digest_file

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    try:
        print(json.dumps(digest_file(api_key, args.kind, Path(args.file)), ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001 — a missing digest must not block posting
        print(f"digest-he failed: {exc}", file=sys.stderr)
        print(json.dumps({"title": "", "bullets": []}))
    return 0


def cmd_review_video(args: argparse.Namespace) -> int:
    """Quality-check a generated video (same outfit/place, no on-screen text, modest, face visible).
    Prints a JSON verdict. Never fails the pipeline: if the reviewer itself errors, it passes the
    video through (skipped=true) rather than blocking posting on a flaky check."""
    from content_scout.video_review import review_video

    try:
        result = review_video(os.environ["ANTHROPIC_API_KEY"], Path(args.video), args.wardrobe or "")
    except Exception as exc:  # noqa: BLE001
        print(f"review-video failed: {exc}", file=sys.stderr)
        result = {"ok": True, "skipped": True, "issues_he": []}
    print(json.dumps(result, ensure_ascii=False))
    return 0


def cmd_list_runs(args: argparse.Namespace) -> int:
    settings = load_settings()
    runs = storage.list_runs(settings.data_dir)
    if not runs:
        print("No runs yet.")
        return 0
    for r in runs:
        print(r)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="content-scout")
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="Discover, download, transcribe, and OCR videos for a niche.")
    p_run.add_argument("--niche", required=True, help="Keyword/hashtag/niche to search (TikTok/YouTube), e.g. 'fashion model reels'")
    p_run.add_argument("--platforms", required=True, help="Comma-separated: tiktok,instagram,youtube")
    p_run.add_argument(
        "--instagram-accounts",
        default=None,
        help="Comma-separated Instagram usernames/profile URLs to watch (Instagram needs specific "
        "accounts, not a keyword — see platforms/instagram.py). Falls back to --niche if omitted.",
    )
    p_run.add_argument(
        "--tiktok-accounts",
        default=None,
        help="Comma-separated TikTok usernames to watch via Apify's 'profiles' input (account-based, "
        "like --instagram-accounts) instead of the default --niche keyword/hashtag search.",
    )
    p_run.add_argument("--per-platform-limit", type=int, default=20)
    p_run.add_argument("--since-days", type=int, default=14)
    p_run.add_argument("--recency-half-life-days", type=float, default=30.0)
    p_run.add_argument("--run-id", default=None)
    p_run.add_argument("--force", action="store_true")
    p_run.add_argument("--keep-media", action="store_true")
    p_run.add_argument("--skip-ocr", action="store_true")
    p_run.add_argument("--skip-transcribe", action="store_true")
    p_run.add_argument("--dry-run", action="store_true", help="Discovery + ranking only, no downloads.")
    p_run.set_defaults(func=cmd_run)

    p_resume = sub.add_parser("resume", help="Re-run unfinished stages for an existing run.")
    p_resume.add_argument("--run-id", required=True)
    p_resume.add_argument("--force", action="store_true")
    p_resume.add_argument("--keep-media", action="store_true")
    p_resume.add_argument("--skip-ocr", action="store_true")
    p_resume.add_argument("--skip-transcribe", action="store_true")
    p_resume.set_defaults(func=cmd_resume)

    p_report = sub.add_parser("report", help="Render/finalize the report for a run.")
    p_report.add_argument("--run-id", required=True)
    p_report.add_argument("--finalize", action="store_true")
    p_report.set_defaults(func=cmd_report)

    p_analyze = sub.add_parser(
        "analyze",
        help="Automated stage 7+10 (needs ANTHROPIC_API_KEY) — fills visual analysis, writes "
        "synthesis + Telegram summary, finalizes the report. No interactive session needed.",
    )
    p_analyze.add_argument("--run-id", required=True)
    p_analyze.set_defaults(func=cmd_analyze)

    p_plan = sub.add_parser(
        "plan",
        help="Turn an analyzed run into N days of persona content (needs ANTHROPIC_API_KEY) — "
        "writes content_plan.json (generation prompt + caption + hashtags per day) to the run dir.",
    )
    p_plan.add_argument("--run-id", required=True)
    p_plan.add_argument("--persona-dir", required=True, help="Path to docs/personas/<Name>/")
    p_plan.add_argument("--num-days", type=int, default=1)
    p_plan.set_defaults(func=cmd_plan)

    p_test_video = sub.add_parser(
        "test-video",
        help="Run scout+analyze+plan on ONE specific post/reel URL (needs ANTHROPIC_API_KEY) "
        "and print every intermediate result. Stops before generation — no Higgsfield call, "
        "no Buffer draft.",
    )
    p_test_video.add_argument("--url", required=True, help="Full Instagram post/reel URL")
    p_test_video.add_argument("--persona-dir", required=True, help="Path to docs/personas/<Name>/")
    p_test_video.set_defaults(func=cmd_test_video)

    p_inspire = sub.add_parser(
        "inspire",
        help="Analyze ONE Instagram/TikTok link (video or photo) and plan persona content inspired by it.",
    )
    p_inspire.add_argument("--url", required=True)
    p_inspire.add_argument("--persona-dir", required=True)
    p_inspire.add_argument("--kind", choices=["image", "video"], default="image")
    p_inspire.add_argument("--note", default=None, help="Extra direction from the owner, e.g. 'make it cozier'")
    p_inspire.set_defaults(func=cmd_inspire)

    p_digest = sub.add_parser("digest-he", help="Short Hebrew digest (JSON) of an analysis/plan file, for Telegram.")
    p_digest.add_argument("--kind", choices=["scan", "link", "plan"], required=True)
    p_digest.add_argument("--file", required=True)
    p_digest.set_defaults(func=cmd_digest_he)

    p_review = sub.add_parser("review-video", help="Quality-check a generated video; prints a JSON verdict.")
    p_review.add_argument("--video", required=True)
    p_review.add_argument("--wardrobe", default="")
    p_review.set_defaults(func=cmd_review_video)

    p_list = sub.add_parser("list-runs", help="List all runs.")
    p_list.set_defaults(func=cmd_list_runs)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
