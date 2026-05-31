"""
main.py - SPINEL: Authorized Reflection and Input-Surface Testing Tool

IMPORTANT: Only run against systems you are explicitly authorized to test.

Production features
───────────────────
Global runtime limit   --max-runtime N (seconds). 0 = unlimited.
                       When the deadline passes, the pool shuts down and all
                       results collected so far are flushed safely.

Graceful SIGINT        Ctrl-C sets a shutdown event. The collection loop
                       breaks immediately; a finally block always flushes
                       results regardless of how the scan ends.

Severity classification  classifier.classify_all() runs after dedup.
                         Each reflected finding gets critical/high/medium/info.

Resume                 --resume loads completed findings from a previous
                       combined.json and skips their test cases this run.
                       Results are merged into a single final output.

CLI                    --config, --targets, --output-dir, --points,
                       --max-runtime, --resume, --no-report, --verbose.
"""

import signal
import sys
import time
import logging
import threading
import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

from scanner.config import load_config
from scanner.loader import load_targets
from scanner.normalizer import normalize_targets
from scanner.injectors import build_test_cases, build_baseline_case
from scanner.requester import SharedClient, HostThrottleRegistry, HostBlockRegistry, send_test_case
from scanner.reflector import analyze_reflection
from scanner.logger import build_finding
from scanner.classifier import classify_all
from scanner.deduplicator import deduplicate
from scanner.resume import load_completed, filter_cases
from scanner.saver import ensure_output_dirs, save_combined, save_reflected_finding
from scanner.reporter import generate_report
from scanner.models import (
    BaselineResponse, Config, TestCase, Finding,
    ResponseData, ReflectionResult, SEVERITY_ORDER,
)
from scanner.utils import now_iso, extract_hostname, log


BANNER = """
╔══════════════════════════════════════════════════════╗
║       Reflection - Input Surface Testing Tool        ║
║  Author: Asiful  |  Authorized use only              ║
╚══════════════════════════════════════════════════════╝"""

SEV_COLOUR = {
    "critical": "🔴",
    "high":     "🟠",
    "medium":   "🟡",
    "info":     "🔵",
    "none":     "⚪",
}


# ── CLI ────────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="SPINEL: Authorized reflection surface testing tool.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python main.py                              # prompts for targets file\n"
            "  python main.py --targets scope.txt           # use a specific file\n"
            "  python main.py --targets scope.txt --max-runtime 3600\n"
            "  python main.py --proxy http://127.0.0.1:8080  # enable Burp interception\n"
            "  python main.py --resume --output-dir output/run2\n"
            "  python main.py --points query headers --verbose\n"
        ),
    )
    p.add_argument("--config",      default="config.yaml",
                   help="Config YAML path (default: config.yaml)")
    p.add_argument("--targets",     default=None,
                   help="Path to targets file (prompted if not provided)")
    p.add_argument("--output-dir",  default=None,
                   help="Override output directory from config")
    p.add_argument("--points",      nargs="+", default=None,
                   metavar="POINT",
                   help="Override test points (query headers cookies form json)")
    p.add_argument("--max-runtime", type=int, default=None,
                   metavar="SECS",
                   help="Hard wall-clock limit in seconds (0 = unlimited)")
    p.add_argument("--proxy",       default=None,
                   help="Proxy URL e.g. http://127.0.0.1:8080 (overrides config; omit for direct connections)")
    p.add_argument("--resume",      action="store_true",
                   help="Resume from existing combined.json, skipping completed requests")
    p.add_argument("--no-report",   action="store_true",
                   help="Skip generating the Markdown report")
    p.add_argument("--verbose",     action="store_true",
                   help="Debug-level console output")
    return p.parse_args()


def _setup_logging(verbose: bool) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(levelname)s  %(message)s"))
    log.setLevel(logging.DEBUG if verbose else logging.INFO)
    log.addHandler(handler)
    log.propagate = False


# ── Shutdown event ─────────────────────────────────────────────────────────────

_shutdown = threading.Event()


def _install_signal_handler() -> None:
    """Set _shutdown on SIGINT so the collection loop can exit cleanly."""
    def _handler(signum, frame):
        if not _shutdown.is_set():
            print("\n\n[!] Interrupt received — stopping scan and flushing results…",
                  flush=True)
            _shutdown.set()
    signal.signal(signal.SIGINT, _handler)



# ── Targets path resolution ────────────────────────────────────────────────────

def _resolve_targets_path(arg_value: Optional[str]) -> str:
    """
    Return a validated path to a targets file.

    If --targets was given on the CLI, verify it exists and return it.
    If it was not given, prompt the user interactively until they supply
    a path that exists (or until they Ctrl-C to abort).
    """
    # Path was supplied via CLI — just validate it
    if arg_value is not None:
        p = Path(arg_value)
        if not p.exists():
            print(f"\n[ERROR] Targets file not found: {arg_value}")
            sys.exit(1)
        return str(p)

    # No path supplied — check if the default file exists silently
    default = Path("targets.txt")
    if default.exists():
        print(f"  No --targets given, using default: targets.txt")
        return str(default)

    # Neither provided nor default — ask interactively
    print()
    print("  No targets file specified and targets.txt not found.")
    print("  Enter the path to your targets file, or Ctrl-C to abort.")
    print()
    while True:
        try:
            raw = input("  Targets file path: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n[!] Aborted.")
            sys.exit(0)

        if not raw:
            print("  Path cannot be empty — try again.")
            continue

        p = Path(raw)
        if not p.exists():
            print(f"  File not found: {raw} — try again.")
            continue

        return str(p)

# ── Progress bar ───────────────────────────────────────────────────────────────

def _bar(done: int, total: int, hits: int, blocked: int,
         secs_left: Optional[float] = None, width: int = 30) -> str:
    pct    = done / total if total else 0
    filled = int(width * pct)
    bar    = "█" * filled + "░" * (width - filled)
    blk    = f"  blk:{blocked}" if blocked else ""
    trem   = f"  ⏱{int(secs_left)}s" if secs_left is not None else ""
    return f"\r  [{bar}] {done}/{total}  hits:{hits}{blk}{trem} "


# ── Baseline helper ────────────────────────────────────────────────────────────

def _run_baseline(
    target: str,
    config: Config,
    client: SharedClient,
    throttle: HostThrottleRegistry,
    blocker: HostBlockRegistry,
) -> Optional[BaselineResponse]:
    tc   = build_baseline_case(target, config)
    resp = send_test_case(tc, config, client, throttle, blocker)
    return BaselineResponse(
        status_code=resp.status_code,
        content_type=resp.content_type,
        content_length=resp.content_length,
        error=resp.error,
    )


def _baseline_finding(target: str, bl: BaselineResponse, config: Config) -> Finding:
    """Wrap a BaselineResponse as a Finding for the report."""
    tc = build_baseline_case(target, config)
    resp = ResponseData(
        status_code=bl.status_code, headers={}, body_text="",
        final_url=target, content_type=bl.content_type,
        content_length=bl.content_length, error=bl.error,
    )
    refl = ReflectionResult(False, [], 0, [])
    return build_finding(tc, resp, refl, config)


# ── Worker ─────────────────────────────────────────────────────────────────────

def _process(
    tc: TestCase,
    config: Config,
    client: SharedClient,
    throttle: HostThrottleRegistry,
    blocker: HostBlockRegistry,
    baseline: Optional[BaselineResponse],
) -> Finding:
    response   = send_test_case(tc, config, client, throttle, blocker)
    reflection = analyze_reflection(tc.payload, response, config)
    return build_finding(tc, response, reflection, config, baseline)


# ── Flush helper (called from finally) ────────────────────────────────────────

def _flush(
    all_findings: list[Finding],
    baseline_store: list[Finding],
    resumed_findings: list[Finding],
    config: Config,
    scan_started_at: str,
    no_report: bool,
) -> None:
    """Dedup → classify → save. Called whether scan completes or is interrupted."""

    # Deduplication (skips resumed findings — they were already deduped last run)
    new_findings = [f for f in all_findings if not f.resumed]
    new_findings, dup_count = deduplicate(new_findings)

    # Merge resumed findings back in
    merged = resumed_findings + new_findings
    classify_all(merged)

    injection = [f for f in merged if f.injection_point != "baseline"]
    unique_reflected = [f for f in injection if f.reflected and not f.deduplicated]

    # Save reflected files
    for f in unique_reflected:
        try:
            save_reflected_finding(f, config.output_dir)
        except Exception as exc:
            log.warning("Failed to save reflected finding %s: %s", f.request_id, exc)

    # Per-host / per-point stats
    host_stats: dict = defaultdict(lambda: {"requests": 0, "reflected": 0, "errors": 0, "redirects": 0})
    point_stats: dict = defaultdict(lambda: {"requests": 0, "reflected": 0})
    for f in injection:
        h = extract_hostname(f.target)
        host_stats[h]["requests"]  += 1
        host_stats[h]["reflected"] += int(f.reflected and not f.deduplicated)
        host_stats[h]["errors"]    += int(bool(f.error))
        host_stats[h]["redirects"] += len(f.redirect_chain)
        point_stats[f.injection_point]["requests"]  += 1
        point_stats[f.injection_point]["reflected"] += int(f.reflected and not f.deduplicated)

    extra_stats = {
        "blocked_hosts": [],   # blocker not accessible here; main sets this before calling
        "per_host":  dict(host_stats),
        "per_point": dict(point_stats),
    }

    scan_finished_at = now_iso()
    combined = baseline_store + merged
    save_combined(combined, config.output_dir, scan_started_at, scan_finished_at,
                  extra_stats=extra_stats)

    if not no_report:
        try:
            generate_report(combined, config.output_dir, scan_started_at, scan_finished_at)
        except Exception as exc:
            log.warning("Report generation failed: %s", exc)


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    print(BANNER)
    args = parse_args()
    _setup_logging(args.verbose)
    _install_signal_handler()

    # ── 1. Config ────────────────────────────────────────────────────────────
    try:
        config = load_config(args.config)
    except Exception as exc:
        print(f"\n[ERROR] {exc}")
        sys.exit(1)

    # CLI overrides
    if args.output_dir:
        config.output_dir = args.output_dir
    if args.points:
        config.test_points = [p.lower() for p in args.points]
    if args.max_runtime is not None:
        config.max_runtime_secs = args.max_runtime
    if args.proxy is not None:
        from scanner.config import _parse_proxy
        try:
            config.proxy = _parse_proxy(args.proxy)
        except ValueError as exc:
            print(f"\n[ERROR] --proxy: {exc}")
            sys.exit(1)

    runtime_limit = config.max_runtime_secs
    deadline: Optional[float] = (
        time.monotonic() + runtime_limit if runtime_limit > 0 else None
    )

    proxy_label = config.proxy if config.proxy else "disabled (direct connections)"
    log.info("Proxy         : %s", proxy_label)
    log.info("Test points   : %s", ", ".join(config.test_points))
    log.info("Workers       : %d  (max_per_host: %d)", config.max_workers, config.max_per_host)
    log.info("Delay         : %.1f–%.1fs   Retries: %d", config.delay_min, config.delay_max, config.retries)
    log.info("Baseline      : %s", "enabled" if config.baseline_enabled else "disabled")
    log.info("Block on      : %s  (threshold: %d)", config.block_on_status, config.block_threshold)
    if deadline:
        log.info("Max runtime   : %ds", runtime_limit)

    # ── 2. Targets ───────────────────────────────────────────────────────────
    targets_path = _resolve_targets_path(args.targets)
    try:
        raw = load_targets(targets_path)
    except Exception as exc:
        log.error("Failed to load targets: %s", exc)
        sys.exit(1)

    if not raw:
        log.warning("No targets in %s — add authorized targets and retry.", targets_path)
        sys.exit(0)

    targets = normalize_targets(raw)
    log.info("Targets       : %d\n", len(targets))

    # ── 3. Output dirs ───────────────────────────────────────────────────────
    ensure_output_dirs(config.output_dir)

    # ── 4. Resume ────────────────────────────────────────────────────────────
    resumed_findings: list[Finding] = []
    completed_ids: set[str] = set()
    if args.resume:
        combined_path = str(Path(config.output_dir) / "combined.json")
        resumed_findings, completed_ids = load_completed(combined_path)

    # ── 5. Build test cases ──────────────────────────────────────────────────
    all_cases: list[TestCase] = []
    for target in targets:
        all_cases.extend(build_test_cases(target, config))

    if completed_ids:
        all_cases = filter_cases(all_cases, completed_ids)

    total = len(all_cases)
    log.info("Test cases    : %d%s", total,
             f"  (+{len(resumed_findings)} resumed)" if resumed_findings else "")
    log.info("Starting scan…\n")

    scan_started_at  = now_iso()
    all_findings:    list[Finding] = []
    baseline_store:  list[Finding] = []
    findings_lock    = threading.Lock()
    reflected_log:   list[tuple]  = []   # (line, finding)

    done_count = reflected_count = 0

    # ── 6. Shared infrastructure ─────────────────────────────────────────────
    throttle = HostThrottleRegistry(backoff_secs=15.0)
    blocker  = HostBlockRegistry(
        block_on_status=config.block_on_status,
        threshold=config.block_threshold,
    )

    timed_out = False

    try:
        with SharedClient(config) as client:

            # ── 6a. Baselines ────────────────────────────────────────────────
            baselines: dict[str, Optional[BaselineResponse]] = {}
            if config.baseline_enabled and not _shutdown.is_set():
                log.info("Collecting baselines…")
                for target in targets:
                    if _shutdown.is_set():
                        break
                    if deadline and time.monotonic() > deadline:
                        timed_out = True
                        break
                    try:
                        bl = _run_baseline(target, config, client, throttle, blocker)
                        baselines[target] = bl
                        log.info("  baseline  [%s] %s", bl.status_code or "ERR", target)
                        baseline_store.append(_baseline_finding(target, bl, config))
                    except Exception as exc:
                        log.warning("  baseline failed for %s: %s", target, exc)
                        baselines[target] = None
                print()

            # ── 6b. Injection scan ───────────────────────────────────────────
            if not _shutdown.is_set() and not timed_out:
                with ThreadPoolExecutor(max_workers=config.max_workers) as pool:
                    futures = {
                        pool.submit(
                            _process, tc, config, client, throttle, blocker,
                            baselines.get(tc.target),
                        ): tc
                        for tc in all_cases
                    }

                    for future in as_completed(futures):
                        # ── Shutdown / timeout checks ────────────────────────
                        if _shutdown.is_set():
                            break
                        if deadline and time.monotonic() > deadline:
                            timed_out = True
                            log.warning("\nMax runtime reached — stopping scan.")
                            break

                        tc = futures[future]
                        try:
                            finding = future.result()
                            with findings_lock:
                                all_findings.append(finding)
                                done_count += 1
                                if finding.reflected:
                                    reflected_count += 1
                                    reflected_log.append((
                                        f"  [HIT] {finding.request_id[:12]}… "
                                        f"{finding.method} {finding.injection_point}:"
                                        f"{finding.parameter_name} → {finding.target}",
                                        finding,
                                    ))

                            secs_left = (deadline - time.monotonic()) if deadline else None
                            print(
                                _bar(done_count, total, reflected_count,
                                     len(blocker.blocked_hosts()), secs_left),
                                end="", flush=True,
                            )

                        except Exception as exc:
                            with findings_lock:
                                done_count += 1
                            log.error("\nWorker error on %s: %s", tc.url, exc)

    except Exception as exc:
        log.error("Unexpected error during scan: %s", exc)

    finally:
        print()  # newline after progress bar

        # ── Always flush ─────────────────────────────────────────────────────
        new_findings = [f for f in all_findings if not f.resumed]
        new_findings, dup_count = deduplicate(new_findings)
        merged = resumed_findings + new_findings
        classify_all(merged)

        injection = [f for f in merged if f.injection_point != "baseline"]
        unique_reflected = [f for f in injection if f.reflected and not f.deduplicated]

        for f in unique_reflected:
            try:
                save_reflected_finding(f, config.output_dir)
            except Exception as exc:
                log.warning("Failed to save reflected finding %s: %s", f.request_id, exc)

        # ── Print reflected hits with severity ───────────────────────────────
        if reflected_log:
            print()
            for line, f in reflected_log:
                icon = SEV_COLOUR.get(f.severity, "⚪")
                print(f"{icon} {line}")
                chain_note = f" ↪ {len(f.redirect_chain)} hop(s)" if f.redirect_chain else ""
                print(f"      └─ {f.final_url or f.request_url}{chain_note}")
                if f.snippets:
                    print(f"         …{f.snippets[0][:80]}…")

        # ── Scan stats ───────────────────────────────────────────────────────
        scan_finished_at = now_iso()
        host_stats: dict = defaultdict(lambda: {"requests": 0, "reflected": 0, "errors": 0, "redirects": 0})
        point_stats: dict = defaultdict(lambda: {"requests": 0, "reflected": 0})
        for f in injection:
            h = extract_hostname(f.target)
            host_stats[h]["requests"]  += 1
            host_stats[h]["reflected"] += int(f.reflected and not f.deduplicated)
            host_stats[h]["errors"]    += int(bool(f.error))
            host_stats[h]["redirects"] += len(f.redirect_chain)
            point_stats[f.injection_point]["requests"]  += 1
            point_stats[f.injection_point]["reflected"] += int(f.reflected and not f.deduplicated)

        extra_stats = {
            "blocked_hosts": blocker.blocked_hosts(),
            "per_host":      dict(host_stats),
            "per_point":     dict(point_stats),
            "timed_out":     timed_out,
            "interrupted":   _shutdown.is_set(),
        }

        combined = baseline_store + merged
        output_path = save_combined(
            combined, config.output_dir, scan_started_at, scan_finished_at,
            extra_stats=extra_stats,
        )

        report_path = None
        if not args.no_report:
            try:
                report_path = generate_report(
                    combined, config.output_dir, scan_started_at, scan_finished_at,
                )
            except Exception as exc:
                log.warning("Report generation failed: %s", exc)

        # ── Terminal summary ─────────────────────────────────────────────────
        W = 60
        error_total    = sum(1 for f in injection if f.error)
        redirect_total = sum(len(f.redirect_chain) for f in injection)
        blocked_hosts  = blocker.blocked_hosts()
        sev_counts     = {s: sum(1 for f in unique_reflected if f.severity == s)
                          for s in SEVERITY_ORDER if s != "none"}

        status_line = "Scan complete"
        if timed_out:
            status_line = "Scan stopped — runtime limit reached"
        elif _shutdown.is_set():
            status_line = "Scan interrupted — results flushed"

        print(f"\n{'═' * W}")
        print(f"  {status_line}")
        print(f"{'─' * W}")
        print(f"  Targets             : {len(targets)}")
        print(f"  Requests sent       : {len(injection)}")
        print(f"  Unique reflections  : {len(unique_reflected)}")
        if resumed_findings:
            resumed_inj = [f for f in resumed_findings if f.injection_point != "baseline"]
            print(f"  Resumed (prior run) : {len(resumed_inj)}")
        print(f"  Duplicates skipped  : {dup_count}")
        print(f"  Errors              : {error_total}")
        print(f"  Redirects logged    : {redirect_total}")
        if blocked_hosts:
            print(f"  Hosts blocked       : {len(blocked_hosts)}")
            for h in blocked_hosts:
                print(f"    • {h}")

        # Severity breakdown
        if any(sev_counts.values()):
            print(f"{'─' * W}")
            print(f"  Severity breakdown:")
            for sev in SEVERITY_ORDER:
                if sev == "none":
                    continue
                c = sev_counts.get(sev, 0)
                icon = SEV_COLOUR.get(sev, "")
                if c:
                    print(f"    {icon} {sev.upper():<10}: {c}")

        # Per-point table
        if point_stats:
            print(f"{'─' * W}")
            print(f"  {'Point':<12} {'Requests':>9} {'Reflected':>10}")
            for pt in sorted(point_stats):
                ps = point_stats[pt]
                print(f"  {pt:<12} {ps['requests']:>9} {ps['reflected']:>10}")

        print(f"{'─' * W}")
        print(f"  JSON output         : {output_path}")
        if unique_reflected:
            print(f"  Reflected files     : {config.output_dir}/reflected/")
        if report_path:
            print(f"  Markdown report     : {report_path}")
        print(f"{'═' * W}\n")


if __name__ == "__main__":
    main()
