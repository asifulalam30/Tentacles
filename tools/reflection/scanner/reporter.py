"""
reporter.py - Markdown summary report. Writes to disk only, never logs.
"""

from pathlib import Path
from collections import defaultdict

from scanner.models import Finding, SEVERITY_ORDER


def generate_report(
    findings: list[Finding],
    output_dir: str,
    scan_started_at: str,
    scan_finished_at: str,
) -> Path:
    report_path = Path(output_dir) / "report.md"
    lines = _build_lines(findings, scan_started_at, scan_finished_at)
    report_path.write_text("\n".join(lines), encoding="utf-8")
    return report_path


def _build_lines(
    findings: list[Finding],
    scan_started_at: str,
    scan_finished_at: str,
) -> list[str]:
    injection  = [f for f in findings if f.injection_point != "baseline"]
    baselines  = [f for f in findings if f.injection_point == "baseline"]
    reflected  = [f for f in injection if f.reflected and not f.deduplicated]
    deduped    = [f for f in injection if f.deduplicated]
    errors     = [f for f in injection if f.error]
    truncated  = [f for f in injection if f.response_truncated]
    redirected = [f for f in injection if f.redirect_chain]
    targets    = sorted({f.target for f in findings})

    L: list[str] = [
        "# SPINEL Scan Report",
        "",
        f"**Started:**  {scan_started_at}",
        f"**Finished:** {scan_finished_at}",
        "",
        "---",
        "## Summary",
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Targets tested | {len(targets)} |",
        f"| Injection requests | {len(injection)} |",
        f"| Unique reflections | {len(reflected)} |",
        f"| Deduplicated (suppressed) | {len(deduped)} |",
        f"| Errors | {len(errors)} |",
        f"| Truncated responses | {len(truncated)} |",
        f"| Requests with redirects | {len(redirected)} |",
        "",
        "---",
        "",
    ]

    # ── Baseline summary ───────────────────────────────────────────────────────
    if baselines:
        L += [
            "## Baseline Responses",
            "",
            "| Target | Status | Content-Type | Length |",
            "|--------|--------|-------------|--------|",
        ]
        for f in sorted(baselines, key=lambda x: x.target):
            status = f.status_code or "ERR"
            ct     = (f.content_type or "—")[:40]
            L.append(f"| `{f.target}` | {status} | `{ct}` | {f.response_length} |")
        L += ["", "---", ""]

    # ── Reflected findings ─────────────────────────────────────────────────────
    if reflected:
        L += [
            "## Reflected Findings",
            "",
            "> Exact payload found in response. Manual review required.",
            "",
        ]
        by_target: dict[str, list[Finding]] = defaultdict(list)
        for f in reflected:
            by_target[f.target].append(f)

        for target, tfs in sorted(by_target.items()):
            L += [f"### {target}", ""]
            for f in tfs:
                flags = []
                if f.response_truncated:
                    flags.append("⚠️ truncated")
                if f.redirect_chain:
                    flags.append(f"↪ {len(f.redirect_chain)} redirect(s)")
                flag_str = ("  " + "  ".join(flags)) if flags else ""

                L += [
                    f"- **request_id:** `{f.request_id}`  ",
                    f"  **Method:** `{f.method}`  "
                    f"  **Point:** `{f.injection_point}` → `{f.parameter_name}`  ",
                    f"  **Payload:** `{f.payload}`  ",
                    f"  **Status:** `{f.status_code}`  "
                    f"  **Final URL:** `{f.final_url or f.request_url}`{flag_str}  ",
                    f"  **Severity:** `{f.severity.upper()}`  ",
                    f"  **Locations:** {', '.join(f.reflection_locations)}  "
                    f"  **Matches:** {f.matches}",
                ]
                # Baseline diff callout
                if f.baseline_diff:
                    d = f.baseline_diff
                    diff_parts = []
                    if d.status_changed:
                        diff_parts.append(f"status {d.status_baseline}→{d.status_injected}")
                    if d.content_type_changed:
                        diff_parts.append("content-type changed")
                    if abs(d.length_delta) > 50:
                        diff_parts.append(f"length Δ{d.length_delta:+d}")
                    if diff_parts:
                        L.append(f"  **⚡ Baseline diff:** {', '.join(diff_parts)}")
                # Redirect chain
                if f.redirect_chain:
                    L.append("  **Redirect chain:**")
                    for hop in f.redirect_chain:
                        L.append(f"    - `{hop.status_code}` → `{hop.url}`")
                # Snippets
                if f.snippets:
                    L.append("  **Snippets:**")
                    for snippet in f.snippets[:3]:
                        L += ["  ```", f"  ...{snippet}...", "  ```"]
                L.append("")
    else:
        L += ["## Reflected Findings", "", "No reflections detected.", "", "---", ""]


    # ── Severity breakdown ─────────────────────────────────────────────────────
    sev_counts: dict[str, int] = {s: 0 for s in SEVERITY_ORDER}
    for f in reflected:
        sev_counts[f.severity] = sev_counts.get(f.severity, 0) + 1

    L += [
        "## Severity Breakdown",
        "",
        "| Severity | Count |",
        "|----------|-------|",
    ]
    for sev in SEVERITY_ORDER:
        count = sev_counts.get(sev, 0)
        if count or sev != "none":
            label = f"**{sev.upper()}**" if count and sev not in ("none", "info") else sev
            L.append(f"| {label} | {count} |")
    L += ["", "---", ""]

    # ── Per-injection-point breakdown ──────────────────────────────────────────
    L += [
        "## Requests by Injection Point",
        "",
        "| Point | Total | Reflected | Deduped | Errors |",
        "|-------|-------|-----------|---------|--------|",
    ]
    stats: dict[str, dict] = defaultdict(
        lambda: {"total": 0, "reflected": 0, "deduped": 0, "errors": 0}
    )
    for f in injection:
        s = stats[f.injection_point]
        s["total"]    += 1
        s["reflected"] += int(f.reflected and not f.deduplicated)
        s["deduped"]   += int(f.deduplicated)
        s["errors"]    += int(bool(f.error))
    for point, s in sorted(stats.items()):
        L.append(
            f"| `{point}` | {s['total']} | {s['reflected']} "
            f"| {s['deduped']} | {s['errors']} |"
        )
    L += ["", "---", ""]

    # ── Per-target breakdown ───────────────────────────────────────────────────
    L += [
        "## Requests by Target",
        "",
        "| Target | Requests | Reflected | Errors | Redirects |",
        "|--------|----------|-----------|--------|-----------|",
    ]
    tstats: dict[str, dict] = defaultdict(
        lambda: {"reqs": 0, "reflected": 0, "errors": 0, "redirects": 0}
    )
    for f in injection:
        ts = tstats[f.target]
        ts["reqs"]      += 1
        ts["reflected"] += int(f.reflected and not f.deduplicated)
        ts["errors"]    += int(bool(f.error))
        ts["redirects"] += len(f.redirect_chain)
    for target, ts in sorted(tstats.items()):
        L.append(
            f"| `{target}` | {ts['reqs']} | {ts['reflected']} "
            f"| {ts['errors']} | {ts['redirects']} |"
        )
    L += ["", "---", ""]

    # ── Errors ─────────────────────────────────────────────────────────────────
    if errors:
        L += [
            "## Errors",
            "",
            "| request_id | Target | Point | Error |",
            "|------------|--------|-------|-------|",
        ]
        for f in errors[:50]:
            err = (f.error or "unknown").replace("|", "\\|")
            L.append(
                f"| `{f.request_id[:12]}…` | `{f.target}` "
                f"| `{f.injection_point}:{f.parameter_name}` | {err} |"
            )
        if len(errors) > 50:
            L.append(f"\n_…and {len(errors) - 50} more. See combined.json._")
        L.append("")

    L += ["---", "", "_Report generated by SPINEL. Authorized use only._", ""]
    return L
