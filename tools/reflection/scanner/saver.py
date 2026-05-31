"""
saver.py - Write findings to disk as deterministic, schema-stable JSON.

Reflected file naming:
    output/reflected/<hostname>__<point>__<param>__<request_id>.json

request_id in the filename guarantees no collisions even when the same
host/point/param combination appears multiple times. Deduplicated findings
are NOT written to reflected/ (the canonical copy is already there).
"""

import json
from pathlib import Path

from scanner.models import Finding
from scanner.logger import finding_to_dict
from scanner.utils import safe_filename, extract_hostname


def ensure_output_dirs(output_dir: str) -> tuple[Path, Path]:
    base      = Path(output_dir)
    reflected = base / "reflected"
    base.mkdir(parents=True, exist_ok=True)
    reflected.mkdir(parents=True, exist_ok=True)
    return base, reflected


def save_combined(
    findings: list[Finding],
    output_dir: str,
    scan_started_at: str,
    scan_finished_at: str,
    extra_stats: dict | None = None,
) -> Path:
    """Write all findings to output/combined.json with top-level metadata."""
    base, _ = ensure_output_dirs(output_dir)
    output_path = base / "combined.json"

    injection = [f for f in findings if f.injection_point != "baseline"]
    sorted_f  = sorted(findings, key=lambda f: (f.timestamp, f.request_id))

    from scanner.models import SEVERITY_ORDER
    sev_counts = {s: sum(1 for f in injection if f.severity == s and not f.deduplicated)
                  for s in SEVERITY_ORDER}

    doc: dict = {
        "schema_version":     "3",
        "scan_started_at":    scan_started_at,
        "scan_finished_at":   scan_finished_at,
        "targets_total":      len({f.target for f in findings}),
        "requests_total":     len(injection),
        "reflections_total":  sum(1 for f in injection if f.reflected and not f.deduplicated),
        "duplicates_total":   sum(1 for f in injection if f.deduplicated),
        "errors_total":       sum(1 for f in injection if f.error),
        "redirects_total":    sum(len(f.redirect_chain) for f in injection),
        "severity_counts":    sev_counts,
        "results":            [finding_to_dict(f) for f in sorted_f],
    }
    if extra_stats:
        doc["scan_stats"] = extra_stats

    output_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
    return output_path


def save_reflected_finding(finding: Finding, output_dir: str) -> Path:
    """
    Save one (non-deduplicated) reflected finding to output/reflected/.
    Returns the written path.
    """
    _, reflected_dir = ensure_output_dirs(output_dir)

    hostname = safe_filename(extract_hostname(finding.target))
    point    = safe_filename(finding.injection_point)
    param    = safe_filename(finding.parameter_name)
    rid      = safe_filename(finding.request_id, max_length=32)

    filename  = f"{hostname}__{point}__{param}__{rid}.json"
    file_path = reflected_dir / filename

    file_path.write_text(
        json.dumps(finding_to_dict(finding), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return file_path
