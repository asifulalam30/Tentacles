"""
models.py - Structured data models for the Reflection scanner.

Author: Asiful
"""

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Config:
    proxy: Optional[str]        # None or "" = no proxy (VPS mode); URL = proxy mode
    timeout: int
    verify_tls: bool
    follow_redirects: bool
    max_workers: int
    max_per_host: int
    delay_min: float
    delay_max: float
    retries: int
    marker_prefix: str
    methods: list[str]
    test_points: list[str]
    default_headers: dict[str, str]
    reflection_check_body: bool
    reflection_check_headers: bool
    reflection_snippet_radius: int
    output_dir: str
    baseline_enabled: bool
    throttle_on_status: list[int]
    block_on_status: list[int]
    block_threshold: int
    max_runtime_secs: int       # 0 = unlimited; >0 = hard wall-clock cutoff


@dataclass
class TestCase:
    target: str
    method: str
    url: str
    injection_point: str        # query | header | cookie | form | json | baseline
    parameter_name: str
    payload: str
    request_id: str             # uuid4 hex, unique per request
    headers: dict[str, str] = field(default_factory=dict)
    cookies: dict[str, str] = field(default_factory=dict)
    body: Optional[str] = None
    content_type: Optional[str] = None


@dataclass
class RedirectHop:
    url: str
    status_code: int


@dataclass
class ResponseData:
    status_code: Optional[int]
    headers: dict[str, str]
    body_text: str
    final_url: str
    content_type: str
    content_length: int
    redirect_chain: list[RedirectHop] = field(default_factory=list)
    response_truncated: bool = False
    error: Optional[str] = None


@dataclass
class ReflectionResult:
    reflected: bool
    reflection_locations: list[str]
    matches: int
    snippets: list[str]


@dataclass
class BaselineResponse:
    status_code: Optional[int]
    content_type: str
    content_length: int
    error: Optional[str]


@dataclass
class BaselineDiff:
    status_changed: bool
    status_baseline: Optional[int]
    status_injected: Optional[int]
    length_delta: int
    content_type_changed: bool


# ── Severity ───────────────────────────────────────────────────────────────────
SEVERITY_ORDER = ["critical", "high", "medium", "info", "none"]


@dataclass
class Finding:
    request_id: str
    timestamp: str
    target: str
    method: str
    request_url: str
    injection_point: str
    parameter_name: str
    payload: str
    proxy_used: Optional[str]           # None when running without proxy
    request_headers: dict[str, str]
    request_cookies: dict[str, str]
    request_body: Optional[str]
    status_code: Optional[int]
    response_headers: dict[str, str]
    content_type: str
    response_length: int
    response_truncated: bool
    redirect_chain: list[RedirectHop]
    final_url: str
    reflected: bool
    matches: int
    reflection_locations: list[str]
    snippets: list[str]
    error: Optional[str]
    severity: str = "none"
    baseline: Optional[BaselineResponse] = None
    baseline_diff: Optional[BaselineDiff] = None
    deduplicated: bool = False
    resumed: bool = False
