"""
utils.py - Small helper functions used across the scanner.
"""

import re
import time
import random
import logging
from datetime import datetime, timezone
from urllib.parse import urlparse

# ── Console logger ─────────────────────────────────────────────────────────────
# All modules use this single logger. main.py configures its level and format.
# JSON output is written directly to files — never through this logger.
log = logging.getLogger("spinel")


def now_iso() -> str:
    """Return current UTC time in ISO 8601 format."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def safe_filename(value: str, max_length: int = 64) -> str:
    """
    Convert a string into a safe filename fragment.
    Replaces any character that is not alphanumeric, dash, dot, or underscore.
    """
    clean = re.sub(r"[^\w\-.]", "_", value)
    return clean[:max_length]


def extract_hostname(url: str) -> str:
    """Extract the netloc (host[:port]) from a URL."""
    parsed = urlparse(url)
    return parsed.netloc or parsed.path


def random_delay(min_secs: float, max_secs: float) -> None:
    """Sleep for a random duration between min and max seconds."""
    if max_secs <= 0:
        return
    delay = random.uniform(min_secs, max_secs)
    time.sleep(delay)


def sanitize_snippet(snippet: str) -> str:
    """Remove null bytes, carriage returns, and leading/trailing whitespace."""
    return snippet.replace("\x00", "").replace("\r", "").strip()


# ── Content-type detection ─────────────────────────────────────────────────────
# These prefixes cover all common text-bearing content types that a scanner
# would want to inspect for reflection. Matched case-insensitively against
# the leading portion of the Content-Type header value (before any ';').

_TEXT_PREFIXES = (
    "text/",
    "application/json",
    "application/ld+json",
    "application/geo+json",
    "application/xml",
    "application/atom+xml",
    "application/rss+xml",
    "application/xhtml+xml",
    "application/x-www-form-urlencoded",
    "application/javascript",
    "application/ecmascript",
    "application/x-javascript",
)


def is_text_content(content_type: str) -> bool:
    """
    Return True if the Content-Type header indicates a text-inspectable response.

    Strips charset/boundary parameters before matching so that values like
    'application/json; charset=utf-8' are handled correctly.
    """
    if not content_type:
        return False
    # Take only the MIME type part, ignore params like '; charset=utf-8'
    ct = content_type.split(";")[0].strip().lower()
    return any(ct.startswith(prefix) for prefix in _TEXT_PREFIXES)
