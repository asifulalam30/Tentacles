"""
resume.py - Resume a scan from an existing combined.json output file.

When --resume is passed, this module:
  1. Reads the existing combined.json.
  2. Extracts all request_ids that were already completed.
  3. Filters the new test-case list to remove already-seen request_ids.
  4. Returns the completed Finding objects so they can be merged into the
     final output, giving a single coherent combined.json at the end.

Design decisions
────────────────
- Matching is by request_id, not by URL or payload.  request_id is a
  uuid4 generated fresh each run, so re-running from scratch always
  produces new IDs.  This means --resume only works when the test cases
  were generated from the same targets file and config *in the same
  original run* (i.e. the scan was interrupted, not started from scratch).

- The resume file is read-only.  If it cannot be parsed the scan starts
  fresh and a warning is emitted — never crashes.

- Resumed findings are tagged with resumed=True in the output so reviewers
  can distinguish old results from new ones.
"""

import json
from pathlib import Path
from typing import Optional

from scanner.models import (
    Finding, BaselineResponse, BaselineDiff, RedirectHop,
)
from scanner.utils import log


def load_completed(combined_path: str) -> tuple[list[Finding], set[str]]:
    """
    Read an existing combined.json and return:
        (list_of_Finding_objects, set_of_completed_request_ids)

    Returns ([], set()) if the file does not exist or cannot be parsed.
    """
    path = Path(combined_path)
    if not path.exists():
        log.warning("Resume file not found: %s — starting fresh.", combined_path)
        return [], set()

    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        log.warning("Could not parse resume file %s: %s — starting fresh.", combined_path, exc)
        return [], set()

    results = doc.get("results", [])
    findings: list[Finding] = []
    ids: set[str] = set()

    for r in results:
        try:
            f = _dict_to_finding(r)
            f.resumed = True
            findings.append(f)
            ids.add(f.request_id)
        except Exception as exc:
            log.debug("Skipping malformed resume record: %s", exc)

    log.info("Resume: loaded %d completed findings (%d unique IDs).", len(findings), len(ids))
    return findings, ids


def filter_cases(all_cases, completed_ids: set[str]):
    """Remove test cases whose request_id already appears in completed_ids."""
    remaining = [tc for tc in all_cases if tc.request_id not in completed_ids]
    skipped   = len(all_cases) - len(remaining)
    if skipped:
        log.info("Resume: skipping %d already-completed test cases.", skipped)
    return remaining


# ── Internal deserialiser ──────────────────────────────────────────────────────

def _dict_to_finding(r: dict) -> Finding:
    """Reconstruct a Finding from a finding_to_dict() record."""

    def _baseline(d: Optional[dict]) -> Optional[BaselineResponse]:
        if not d:
            return None
        return BaselineResponse(
            status_code=d.get("status_code"),
            content_type=d.get("content_type", ""),
            content_length=d.get("content_length", 0),
            error=d.get("error"),
        )

    def _diff(d: Optional[dict]) -> Optional[BaselineDiff]:
        if not d:
            return None
        return BaselineDiff(
            status_changed=d.get("status_changed", False),
            status_baseline=d.get("status_baseline"),
            status_injected=d.get("status_injected"),
            length_delta=d.get("length_delta", 0),
            content_type_changed=d.get("content_type_changed", False),
        )

    def _chain(lst: list) -> list[RedirectHop]:
        return [RedirectHop(url=h["url"], status_code=h["status_code"]) for h in (lst or [])]

    return Finding(
        request_id         = r["request_id"],
        timestamp          = r.get("timestamp", ""),
        target             = r.get("target", ""),
        method             = r.get("method", "GET"),
        request_url        = r.get("request_url", ""),
        injection_point    = r.get("injection_point", ""),
        parameter_name     = r.get("parameter_name", ""),
        payload            = r.get("payload", ""),
        proxy_used         = r.get("proxy_used", ""),
        request_headers    = r.get("request_headers", {}),
        request_cookies    = r.get("request_cookies", {}),
        request_body       = r.get("request_body"),
        status_code        = r.get("status_code"),
        response_headers   = r.get("response_headers", {}),
        content_type       = r.get("content_type", ""),
        response_length    = r.get("response_length", 0),
        response_truncated = r.get("response_truncated", False),
        redirect_chain     = _chain(r.get("redirect_chain", [])),
        final_url          = r.get("final_url", ""),
        reflected          = r.get("reflected", False),
        matches            = r.get("matches", 0),
        reflection_locations = r.get("reflection_locations", []),
        snippets           = r.get("snippets", []),
        error              = r.get("error"),
        severity           = r.get("severity", "none"),
        baseline           = _baseline(r.get("baseline")),
        baseline_diff      = _diff(r.get("baseline_diff")),
        deduplicated       = r.get("deduplicated", False),
        resumed            = True,
    )
