"""
normalizer.py - Convert raw target inputs into consistent HTTPS URLs.
"""

from urllib.parse import urlparse, urlunparse


def normalize_target(raw: str) -> str:
    raw = raw.strip()

    # Add scheme if missing
    if not raw.startswith("http://") and not raw.startswith("https://"):
        raw = "https://" + raw

    parsed = urlparse(raw)

    # Rebuild cleanly
    scheme = parsed.scheme or "https"
    netloc = parsed.netloc
    path = parsed.path.rstrip("/") if parsed.path not in ("", "/") else ""
    params = parsed.params
    query = parsed.query
    fragment = ""  # drop fragments

    normalized = urlunparse((scheme, netloc, path, params, query, fragment))
    return normalized


def normalize_targets(raw_list: list[str]) -> list[str]:
    seen = set()
    results = []
    for raw in raw_list:
        normalized = normalize_target(raw)
        if normalized not in seen:
            seen.add(normalized)
            results.append(normalized)
    return results
