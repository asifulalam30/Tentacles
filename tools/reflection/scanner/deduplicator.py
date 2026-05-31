"""
deduplicator.py - Remove redundant findings before output.

Deduplication key:
    (target, injection_point, parameter_name, status_code,
     tuple(sorted(reflection_locations)))

Rationale:
  - The same input surface reflecting back through the same response
    locations on the same target is a single logical finding, even if
    tested multiple times with different payload strings.
  - Different parameters, injection points, or reflection locations are
    genuinely distinct and are kept separately.
  - Error findings (no status code) are never deduplicated — each error
    is a distinct network event worth keeping in the audit trail.
  - When duplicates are found, the first occurrence is kept as canonical;
    subsequent ones are marked with deduplicated=True and retained in
    combined.json for traceability, but are omitted from reflected/ files.

Returns (unique_findings, duplicate_count) where unique_findings is the
full list with deduplicated flags set correctly.
"""

from scanner.models import Finding


def _dedup_key(f: Finding) -> tuple:
    """Stable key that groups logically identical findings."""
    return (
        f.target,
        f.injection_point,
        f.parameter_name,
        f.status_code,
        tuple(sorted(f.reflection_locations)),
    )


def deduplicate(findings: list[Finding]) -> tuple[list[Finding], int]:
    """
    Mark duplicate findings and return (all_findings_with_flags, dup_count).

    The returned list contains ALL findings. Duplicates have deduplicated=True.
    Callers decide what to do with duplicates (e.g. skip saving to reflected/).
    Baseline findings and error findings are never deduplicated.
    """
    seen: set[tuple] = set()
    dup_count = 0

    for f in findings:
        # Never deduplicate baselines or error records
        if f.injection_point == "baseline" or f.error:
            continue
        # Only deduplicate reflected findings — non-reflected misses are cheap
        if not f.reflected:
            continue

        key = _dedup_key(f)
        if key in seen:
            f.deduplicated = True
            dup_count += 1
        else:
            seen.add(key)

    return findings, dup_count
