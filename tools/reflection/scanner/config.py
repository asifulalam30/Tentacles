"""
config.py - Load and validate configuration.

Author: Asiful

Proxy is fully optional. Default is None (no proxy — VPS mode).
Set proxy: "http://host:port" in config.yaml or via --proxy on the CLI
to route traffic through Burp, ZAP, or any CONNECT proxy.
"""

import re
import yaml
from pathlib import Path
from typing import Optional
from scanner.models import Config

VALID_TEST_POINTS = {"query", "headers", "cookies", "form", "json"}
VALID_METHODS     = {"GET", "POST", "PUT", "PATCH", "HEAD", "OPTIONS"}

DEFAULTS: dict = {
    "proxy": None,              # None = no proxy (VPS mode) — this is the safe default
    "timeout": 10,
    "verify_tls": True,
    "follow_redirects": True,
    "max_workers": 3,
    "max_per_host": 2,
    "delay_min": 0.8,
    "delay_max": 2.0,
    "retries": 2,
    "marker_prefix": "SPINEL",
    "methods": ["GET", "POST"],
    "test_points": ["query", "headers", "cookies", "form", "json"],
    "default_headers": {
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
    },
    "reflection": {
        "check_body": True,
        "check_headers": True,
        "snippet_radius": 60,
    },
    "output_dir": "output",
    "baseline_enabled": True,
    "throttle_on_status": [429, 503],
    "block_on_status": [403],
    "block_threshold": 5,
    "max_runtime_secs": 0,
}

_PROXY_RE = re.compile(r"^https?://[^/]+")


def _parse_proxy(raw_value) -> Optional[str]:
    """
    Return a validated proxy string or None.

    Accepts:
        None          → no proxy (VPS mode)
        ""            → no proxy (VPS mode)
        "null"        → no proxy (YAML null parsed as string edge case)
        valid URL     → proxy enabled

    Raises ValueError for non-empty strings that aren't valid http(s) URLs.
    """
    if raw_value is None:
        return None
    s = str(raw_value).strip()
    if s == "" or s.lower() == "null":
        return None
    if not _PROXY_RE.match(s):
        raise ValueError(
            f"'proxy' must be a valid http(s) URL or null/empty, got: {s!r}"
        )
    return s


def load_config(path: str = "config.yaml") -> Config:
    config_path = Path(path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {path}")

    with open(config_path, "r") as f:
        raw = yaml.safe_load(f) or {}

    errors: list[str] = []

    # ── proxy (optional) ──────────────────────────────────────────────────────
    try:
        proxy: Optional[str] = _parse_proxy(raw.get("proxy", DEFAULTS["proxy"]))
    except ValueError as e:
        errors.append(str(e))
        proxy = None

    # ── numeric fields ────────────────────────────────────────────────────────
    def _int(key: str, lo: int, hi: int) -> int:
        val = raw.get(key, DEFAULTS[key])
        try:
            v = int(val)
        except (TypeError, ValueError):
            errors.append(f"'{key}' must be an integer, got {val!r}")
            return DEFAULTS[key]
        if not (lo <= v <= hi):
            errors.append(f"'{key}' must be {lo}–{hi}, got {v}")
        return v

    def _float(key: str, lo: float, hi: float) -> float:
        val = raw.get(key, DEFAULTS[key])
        try:
            v = float(val)
        except (TypeError, ValueError):
            errors.append(f"'{key}' must be a number, got {val!r}")
            return DEFAULTS[key]
        if not (lo <= v <= hi):
            errors.append(f"'{key}' must be {lo}–{hi}, got {v}")
        return v

    timeout          = _int("timeout",          1, 120)
    max_workers      = _int("max_workers",      1, 20)
    max_per_host     = _int("max_per_host",     1, max_workers)
    retries          = _int("retries",          0, 10)
    block_threshold  = _int("block_threshold",  1, 100)
    max_runtime_secs = _int("max_runtime_secs", 0, 86400)
    delay_min        = _float("delay_min", 0.0, 60.0)
    delay_max        = _float("delay_max", 0.0, 60.0)

    if delay_min > delay_max:
        errors.append(f"'delay_min' ({delay_min}) must be <= 'delay_max' ({delay_max})")

    # ── bool fields ───────────────────────────────────────────────────────────
    verify_tls       = bool(raw.get("verify_tls",       DEFAULTS["verify_tls"]))
    follow_redirects = bool(raw.get("follow_redirects", DEFAULTS["follow_redirects"]))
    baseline_enabled = bool(raw.get("baseline_enabled", DEFAULTS["baseline_enabled"]))

    # ── marker prefix ─────────────────────────────────────────────────────────
    marker_prefix = str(raw.get("marker_prefix", DEFAULTS["marker_prefix"])).strip()
    if not re.match(r"^[A-Za-z][A-Za-z0-9_]{0,19}$", marker_prefix):
        errors.append(
            f"'marker_prefix' must be 1-20 alphanumeric/underscore chars "
            f"starting with a letter, got {marker_prefix!r}"
        )

    # ── methods ───────────────────────────────────────────────────────────────
    methods_raw = raw.get("methods", DEFAULTS["methods"])
    if not isinstance(methods_raw, list) or not methods_raw:
        errors.append("'methods' must be a non-empty list")
        methods_raw = DEFAULTS["methods"]
    methods = [str(m).upper() for m in methods_raw]
    bad_methods = [m for m in methods if m not in VALID_METHODS]
    if bad_methods:
        errors.append(f"Unknown methods: {bad_methods}. Valid: {sorted(VALID_METHODS)}")

    # ── test_points ───────────────────────────────────────────────────────────
    points_raw = raw.get("test_points", DEFAULTS["test_points"])
    if not isinstance(points_raw, list) or not points_raw:
        errors.append("'test_points' must be a non-empty list")
        points_raw = DEFAULTS["test_points"]
    test_points = [str(p).lower() for p in points_raw]
    bad_points = [p for p in test_points if p not in VALID_TEST_POINTS]
    if bad_points:
        errors.append(f"Unknown test_points: {bad_points}. Valid: {sorted(VALID_TEST_POINTS)}")

    # ── default_headers ───────────────────────────────────────────────────────
    dh_raw = raw.get("default_headers", DEFAULTS["default_headers"])
    if not isinstance(dh_raw, dict):
        errors.append("'default_headers' must be a mapping")
        dh_raw = DEFAULTS["default_headers"]
    default_headers = {str(k): str(v) for k, v in dh_raw.items()}

    # ── reflection block ──────────────────────────────────────────────────────
    refl_raw = raw.get("reflection", DEFAULTS["reflection"])
    if not isinstance(refl_raw, dict):
        errors.append("'reflection' must be a mapping")
        refl_raw = DEFAULTS["reflection"]
    reflection_check_body    = bool(refl_raw.get("check_body",    True))
    reflection_check_headers = bool(refl_raw.get("check_headers", True))
    snippet_radius_raw       = refl_raw.get("snippet_radius", 60)
    try:
        reflection_snippet_radius = max(10, min(200, int(snippet_radius_raw)))
    except (TypeError, ValueError):
        errors.append(f"'reflection.snippet_radius' must be an integer, got {snippet_radius_raw!r}")
        reflection_snippet_radius = 60

    # ── output_dir ────────────────────────────────────────────────────────────
    output_dir = str(raw.get("output_dir", DEFAULTS["output_dir"])).strip()
    if not output_dir:
        errors.append("'output_dir' must not be empty")

    # ── status code lists ─────────────────────────────────────────────────────
    def _status_list(key: str) -> list[int]:
        val = raw.get(key, DEFAULTS[key])
        if not isinstance(val, list):
            errors.append(f"'{key}' must be a list of HTTP status codes")
            return DEFAULTS[key]
        try:
            return [int(s) for s in val]
        except (TypeError, ValueError):
            errors.append(f"'{key}' entries must all be integers")
            return DEFAULTS[key]

    throttle_on_status = _status_list("throttle_on_status")
    block_on_status    = _status_list("block_on_status")

    if errors:
        msg = "Config validation failed:\n" + "\n".join(f"  • {e}" for e in errors)
        raise ValueError(msg)

    return Config(
        proxy=proxy,
        timeout=timeout,
        verify_tls=verify_tls,
        follow_redirects=follow_redirects,
        max_workers=max_workers,
        max_per_host=max_per_host,
        delay_min=delay_min,
        delay_max=delay_max,
        retries=retries,
        marker_prefix=marker_prefix,
        methods=methods,
        test_points=test_points,
        default_headers=default_headers,
        reflection_check_body=reflection_check_body,
        reflection_check_headers=reflection_check_headers,
        reflection_snippet_radius=reflection_snippet_radius,
        output_dir=output_dir,
        baseline_enabled=baseline_enabled,
        throttle_on_status=throttle_on_status,
        block_on_status=block_on_status,
        block_threshold=block_threshold,
        max_runtime_secs=max_runtime_secs,
    )
