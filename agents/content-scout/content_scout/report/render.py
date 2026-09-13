"""Stage 9: render the deterministic stats report from a Jinja2 template.
Stage 11: stitch that stats report together with my (interactive) synthesis.md into the
final report.md. Both are always safely re-generatable from brief.json files on disk.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

from content_scout import storage
from content_scout.report.aggregate import compute_stats

TEMPLATES_DIR = Path(__file__).parent / "templates"

SYNTHESIS_PLACEHOLDER = """_Visual synthesis not written yet._

Run stage 7 (visual analysis) and stage 10 (synthesis) — ask Claude to read each video's
keyframes and write `synthesis.md` in this run's folder — then re-run:

    python -m content_scout.cli report --run-id {run_id} --finalize
"""


def render_stats_report(paths: storage.RunPaths, niche: str, platforms: list[str]) -> Path:
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=select_autoescape(disabled_extensions=("j2",)),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    template = env.get_template("report_stats.md.j2")
    stats = compute_stats(paths)
    rendered = template.render(
        run_id=paths.run_id,
        niche=niche,
        platforms=platforms,
        stats=stats,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )
    paths.report_stats_path.write_text(rendered, encoding="utf-8")
    return paths.report_stats_path


def assemble_final_report(paths: storage.RunPaths) -> Path:
    stats_md = paths.report_stats_path.read_text(encoding="utf-8") if paths.report_stats_path.exists() else ""
    if paths.synthesis_path.exists():
        synthesis_md = paths.synthesis_path.read_text(encoding="utf-8")
    else:
        synthesis_md = SYNTHESIS_PLACEHOLDER.format(run_id=paths.run_id)

    final = (
        stats_md
        + "\n---\n\n## Visual & Style Synthesis + Ready-to-Use Prompt Starters\n\n"
        + synthesis_md
    )
    paths.report_path.write_text(final, encoding="utf-8")
    return paths.report_path
