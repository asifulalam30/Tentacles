"""
reflector.py - Check whether the payload marker appears in the response.
"""

from scanner.models import Config, ResponseData, ReflectionResult
from scanner.utils import sanitize_snippet


def analyze_reflection(
    payload: str,
    response: ResponseData,
    config: Config,
) -> ReflectionResult:
    """
    Check if the payload appears exactly in the response body and/or headers.
    Returns a ReflectionResult with match details.
    """
    locations = []
    snippets = []
    total_matches = 0

    if config.reflection_check_body and response.body_text:
        body_matches, body_snippets = _find_in_text(
            payload, response.body_text, config.reflection_snippet_radius
        )
        if body_matches > 0:
            locations.append("body")
            snippets.extend(body_snippets)
            total_matches += body_matches

    if config.reflection_check_headers and response.headers:
        for header_name, header_value in response.headers.items():
            hdr_matches, hdr_snippets = _find_in_text(
                payload, header_value, config.reflection_snippet_radius
            )
            if hdr_matches > 0:
                locations.append(f"header:{header_name}")
                snippets.extend(hdr_snippets)
                total_matches += hdr_matches

    reflected = total_matches > 0

    return ReflectionResult(
        reflected=reflected,
        reflection_locations=locations,
        matches=total_matches,
        snippets=snippets,
    )


def _find_in_text(
    payload: str,
    text: str,
    radius: int,
) -> tuple[int, list[str]]:
    """
    Find all exact occurrences of payload in text.
    Returns count and a list of surrounding snippets.
    """
    snippets = []
    count = 0
    start = 0

    while True:
        idx = text.find(payload, start)
        if idx == -1:
            break
        count += 1

        # Extract surrounding context
        snippet_start = max(0, idx - radius)
        snippet_end = min(len(text), idx + len(payload) + radius)
        raw_snippet = text[snippet_start:snippet_end]
        snippets.append(sanitize_snippet(raw_snippet))

        start = idx + len(payload)

    return count, snippets
