"""
logger.py - Assemble Finding records and compute baseline diffs.

Console output → scanner.utils.log (stdlib logger).
JSON output    → written directly to disk by saver.py.
Never mix them.
"""

from typing import Optional

from scanner.models import (
    Config, TestCase, ResponseData, ReflectionResult,
    Finding, BaselineResponse, BaselineDiff,
)
from scanner.utils import now_iso


def _compute_diff(
    baseline: Optional[BaselineResponse],
    response: ResponseData,
) -> Optional[BaselineDiff]:
    if baseline is None:
        return None
    return BaselineDiff(
        status_changed       = baseline.status_code != response.status_code,
        status_baseline      = baseline.status_code,
        status_injected      = response.status_code,
        length_delta         = response.content_length - baseline.content_length,
        content_type_changed = (
            baseline.content_type.split(";")[0].strip().lower()
            != response.content_type.split(";")[0].strip().lower()
        ),
    )


def build_finding(
    test_case: TestCase,
    response: ResponseData,
    reflection: ReflectionResult,
    config: Config,
    baseline: Optional[BaselineResponse] = None,
) -> Finding:
    """Assemble a complete, schema-stable Finding."""
    return Finding(
        request_id         = test_case.request_id,
        timestamp          = now_iso(),
        target             = test_case.target,
        method             = test_case.method,
        request_url        = test_case.url,
        injection_point    = test_case.injection_point,
        parameter_name     = test_case.parameter_name,
        payload            = test_case.payload,
        proxy_used         = config.proxy,
        request_headers    = test_case.headers,
        request_cookies    = test_case.cookies,
        request_body       = test_case.body,
        status_code        = response.status_code,
        response_headers   = response.headers,
        content_type       = response.content_type,
        response_length    = response.content_length,
        response_truncated = response.response_truncated,
        redirect_chain     = response.redirect_chain,
        final_url          = response.final_url,
        reflected          = reflection.reflected,
        matches            = reflection.matches,
        reflection_locations = reflection.reflection_locations,
        snippets           = reflection.snippets,
        error              = response.error,
        severity           = "none",   # classifier.classify() fills this in
        baseline           = baseline,
        baseline_diff      = _compute_diff(baseline, response),
    )


def finding_to_dict(finding: Finding) -> dict:
    """
    Serialise a Finding to a plain dict for JSON output.
    Every field always present; missing values are null, never absent.
    Schema version 3: adds severity, resumed.
    """
    baseline_dict = None
    if finding.baseline is not None:
        baseline_dict = {
            "status_code":    finding.baseline.status_code,
            "content_type":   finding.baseline.content_type,
            "content_length": finding.baseline.content_length,
            "error":          finding.baseline.error,
        }

    diff_dict = None
    if finding.baseline_diff is not None:
        d = finding.baseline_diff
        diff_dict = {
            "status_changed":       d.status_changed,
            "status_baseline":      d.status_baseline,
            "status_injected":      d.status_injected,
            "length_delta":         d.length_delta,
            "content_type_changed": d.content_type_changed,
        }

    chain = [
        {"url": h.url, "status_code": h.status_code}
        for h in finding.redirect_chain
    ]

    return {
        # ── Identity ─────────────────────────────────────────────────────────
        "request_id":    finding.request_id,
        "timestamp":     finding.timestamp,
        "deduplicated":  finding.deduplicated,
        "resumed":       finding.resumed,
        "severity":      finding.severity,
        # ── Target + method ──────────────────────────────────────────────────
        "target":        finding.target,
        "method":        finding.method,
        "request_url":   finding.request_url,
        # ── Injection surface ────────────────────────────────────────────────
        "injection_point":  finding.injection_point,
        "parameter_name":   finding.parameter_name,
        "payload":          finding.payload,
        # ── Request metadata ─────────────────────────────────────────────────
        "proxy_used":       finding.proxy_used,
        "request_headers":  finding.request_headers,
        "request_cookies":  finding.request_cookies,
        "request_body":     finding.request_body,
        # ── Response metadata ────────────────────────────────────────────────
        "status_code":          finding.status_code,
        "response_headers":     finding.response_headers,
        "content_type":         finding.content_type,
        "response_length":      finding.response_length,
        "response_truncated":   finding.response_truncated,
        "redirect_chain":       chain,
        "final_url":            finding.final_url,
        # ── Reflection ───────────────────────────────────────────────────────
        "reflected":             finding.reflected,
        "matches":               finding.matches,
        "reflection_locations":  finding.reflection_locations,
        "snippets":              finding.snippets,
        # ── Diff + error + baseline ──────────────────────────────────────────
        "baseline":      baseline_dict,
        "baseline_diff": diff_dict,
        "error":         finding.error,
    }
