"""
injectors.py - Build structured test cases for each injection point.

Query parameter injection preserves all existing query parameters from the
target URL and appends the test parameter, never clobbering them.
"""

import json
from urllib.parse import urlparse, urlencode, parse_qs, urlunparse

from scanner.models import Config, TestCase
from scanner.payloads import generate_marker, generate_request_id


# ── Injectable surfaces ────────────────────────────────────────────────────────

QUERY_PARAM_NAMES = ["q", "search", "id", "test", "input", "redirect", "url"]

INJECTABLE_HEADERS = [
    "User-Agent",
    "Referer",
    "X-Forwarded-Host",
    "X-Original-URL",
    "X-Rewrite-URL",
    "X-Custom-Test",
    "X-Request-ID",
]

INJECTABLE_COOKIES = ["session_test", "debug", "test", "tracking"]

FORM_FIELD_NAMES = ["q", "name", "input", "search", "value"]


# ── Builders ───────────────────────────────────────────────────────────────────

def _inject_query(target: str, config: Config) -> list[TestCase]:
    """Inject into query string parameters, preserving all existing params."""
    cases = []
    parsed = urlparse(target)

    for param in QUERY_PARAM_NAMES:
        marker = generate_marker(config.marker_prefix)

        # parse_qs returns lists; keep_blank_values preserves existing empties.
        # We make a shallow copy so mutations don't bleed between iterations.
        existing_qs: dict[str, list[str]] = {
            k: list(v)
            for k, v in parse_qs(parsed.query, keep_blank_values=True).items()
        }
        # Overwrite only the test parameter; all others survive unchanged.
        existing_qs[param] = [marker]
        new_query = urlencode(existing_qs, doseq=True)

        injected_url = urlunparse((
            parsed.scheme, parsed.netloc, parsed.path,
            parsed.params, new_query, ""
        ))

        cases.append(TestCase(
            target=target,
            method="GET",
            url=injected_url,
            injection_point="query",
            parameter_name=param,
            payload=marker,
            request_id=generate_request_id(),
            headers=dict(config.default_headers),
        ))

    return cases


def _inject_headers(target: str, config: Config) -> list[TestCase]:
    """Inject the payload value into specific request headers."""
    cases = []

    for header_name in INJECTABLE_HEADERS:
        marker = generate_marker(config.marker_prefix)
        headers = dict(config.default_headers)
        headers[header_name] = marker

        cases.append(TestCase(
            target=target,
            method="GET",
            url=target,
            injection_point="header",
            parameter_name=header_name,
            payload=marker,
            request_id=generate_request_id(),
            headers=headers,
        ))

    return cases


def _inject_cookies(target: str, config: Config) -> list[TestCase]:
    """Inject the payload into a cookie value."""
    cases = []

    for cookie_name in INJECTABLE_COOKIES:
        marker = generate_marker(config.marker_prefix)

        cases.append(TestCase(
            target=target,
            method="GET",
            url=target,
            injection_point="cookie",
            parameter_name=cookie_name,
            payload=marker,
            request_id=generate_request_id(),
            headers=dict(config.default_headers),
            cookies={cookie_name: marker},
        ))

    return cases


def _inject_form(target: str, config: Config) -> list[TestCase]:
    """Inject the payload into an application/x-www-form-urlencoded POST body."""
    cases = []

    for field_name in FORM_FIELD_NAMES:
        marker = generate_marker(config.marker_prefix)

        cases.append(TestCase(
            target=target,
            method="POST",
            url=target,
            injection_point="form",
            parameter_name=field_name,
            payload=marker,
            request_id=generate_request_id(),
            headers=dict(config.default_headers),
            body=urlencode({field_name: marker}),
            content_type="application/x-www-form-urlencoded",
        ))

    return cases


def _inject_json(target: str, config: Config) -> list[TestCase]:
    """Inject the payload into an application/json POST body."""
    cases = []

    for field_name in FORM_FIELD_NAMES:
        marker = generate_marker(config.marker_prefix)

        cases.append(TestCase(
            target=target,
            method="POST",
            url=target,
            injection_point="json",
            parameter_name=field_name,
            payload=marker,
            request_id=generate_request_id(),
            headers=dict(config.default_headers),
            body=json.dumps({field_name: marker}),
            content_type="application/json",
        ))

    return cases


def build_baseline_case(target: str, config: Config) -> TestCase:
    """
    Build a clean GET request for the target with no injection.
    Used to record the baseline response before injecting.
    """
    return TestCase(
        target=target,
        method="GET",
        url=target,
        injection_point="baseline",
        parameter_name="",
        payload="",
        request_id=generate_request_id(),
        headers=dict(config.default_headers),
    )


# ── Dispatch map ───────────────────────────────────────────────────────────────

_INJECTOR_MAP: dict = {
    "query":   _inject_query,
    "headers": _inject_headers,
    "cookies": _inject_cookies,
    "form":    _inject_form,
    "json":    _inject_json,
}


def build_test_cases(target: str, config: Config) -> list[TestCase]:
    """Build all injection test cases for a target based on enabled test_points."""
    all_cases: list[TestCase] = []

    for point in config.test_points:
        builder = _INJECTOR_MAP.get(point)
        if builder is None:
            from scanner.utils import log
            log.warning("Unknown test point %r — skipping", point)
            continue
        all_cases.extend(builder(target, config))

    return all_cases
