"""
classifier.py - Assign severity to reflected findings.

Severity rules (applied in order; first match wins):

  CRITICAL  Reflected in a response header (e.g. Location, Set-Cookie,
            Link) — headers are often consumed by browsers/clients without
            further sanitisation, making this the highest-risk surface.

  HIGH      Reflected via a header injection point (User-Agent, Referer,
            X-Forwarded-Host, etc.) into the response body.  Header inputs
            are frequently trusted by server-side code paths.

  HIGH      Reflected via a query parameter that is also part of a redirect
            (status 3xx), because open-redirect chains are exploitable.

  MEDIUM    Reflected in the body via query, form, or JSON injection on a
            standard 2xx response.  Classic reflected-XSS candidate surface.

  INFO      Reflected in the body via a cookie or a low-sensitivity header
            (User-Agent, Referer) on a standard 2xx response.  Lower
            priority: harder to deliver in real-world exploits.

  NONE      Not reflected, or is a baseline / error record.

Severity is attached to a Finding in-place and returned.
It is also stored in finding_to_dict() output under "severity".
"""

from scanner.models import Finding

# Response headers whose reflection is treated as critical
_CRITICAL_RESPONSE_HEADERS = {
    "location",
    "set-cookie",
    "link",
    "content-security-policy",
    "access-control-allow-origin",
    "refresh",
}

# Request injection points that raise severity to HIGH when body-reflected
_HIGH_INJECTION_POINTS = {"header"}

# Injection points that map to MEDIUM body reflection
_MEDIUM_INJECTION_POINTS = {"query", "form", "json"}

# Injection points that map to INFO body reflection
_INFO_INJECTION_POINTS = {"cookies"}


def classify(finding: Finding) -> Finding:
    """
    Assign finding.severity and return the finding.
    Non-reflected, baseline, and error findings always get 'none'.
    """
    if not finding.reflected or finding.injection_point in ("baseline",) or finding.error:
        finding.severity = "none"
        return finding

    # ── Rule 1: any reflection in a response header → CRITICAL ────────────────
    for loc in finding.reflection_locations:
        if loc.startswith("header:"):
            header_name = loc.split(":", 1)[1].lower()
            if header_name in _CRITICAL_RESPONSE_HEADERS:
                finding.severity = "critical"
                return finding
            # Any response header reflection is at least HIGH
            finding.severity = "high"
            return finding

    # ── Rule 2: redirect + body reflection → HIGH ─────────────────────────────
    is_redirect = finding.status_code is not None and 300 <= finding.status_code < 400
    if is_redirect and "body" in finding.reflection_locations:
        finding.severity = "high"
        return finding

    # ── Rule 3: header injection point reflected in body → HIGH ───────────────
    if finding.injection_point in _HIGH_INJECTION_POINTS:
        finding.severity = "high"
        return finding

    # ── Rule 4: query / form / json → MEDIUM ─────────────────────────────────
    if finding.injection_point in _MEDIUM_INJECTION_POINTS:
        finding.severity = "medium"
        return finding

    # ── Rule 5: cookie / fallback → INFO ─────────────────────────────────────
    finding.severity = "info"
    return finding


def classify_all(findings: list[Finding]) -> list[Finding]:
    """Classify a list of findings in-place. Returns the same list."""
    for f in findings:
        classify(f)
    return findings
