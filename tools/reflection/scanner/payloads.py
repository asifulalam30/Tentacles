"""
payloads.py - Generate unique marker payloads and request IDs.
"""

import uuid


def generate_marker(prefix: str = "SPINEL") -> str:
    """
    Generate a unique marker string.
    Format: PREFIX_<8 lowercase hex chars>
    Example: SPINEL_1a2b3c4d

    The 8-hex suffix gives 4 billion combinations — sufficient to prevent
    false-positive collisions within any single scan session.
    """
    uid = uuid.uuid4().hex[:8]
    return f"{prefix}_{uid}"


def generate_request_id() -> str:
    """
    Generate a full UUID4 hex string for use as a request_id.
    This is distinct from the payload marker so the two can be used
    independently: the marker appears in the request body/headers,
    the request_id ties the TestCase to its Finding in the output JSON.
    """
    return uuid.uuid4().hex
