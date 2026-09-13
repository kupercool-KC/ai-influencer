"""content-scout CLI.

    python -m content_scout.cli run --niche "..." --platforms tiktok,instagram,youtube ...
    python -m content_scout.cli resume --run-id RUN_ID [--force]
    python -m content_scout.cli report --run-id RUN_ID [--finalize]
    python -m content_scout.cli list-runs
"""
from __future__ import annotations

import argparse
import sys

from content_scout import pipeline, storage
from content_scout.config import load_settings
from content_scout.platforms.base import KNOWN_PLATFORMS
from content_scout.report.render import assemble_final_report
from content_scout.utils.logging import get_logger

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
    p_run.add_argument("--niche", required=True, help="Keyword/hashtag/niche to search, e.g. 'fashion model reels'")
    p_run.add_argument("--platforms", required=True, help="Comma-separated: tiktok,instagram,youtube")
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

    p_list = sub.add_parser("list-runs", help="List all runs.")
    p_list.set_defaults(func=cmd_list_runs)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
