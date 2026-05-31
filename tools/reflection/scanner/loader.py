"""
loader.py - Read and clean targets from targets.txt.
"""

from pathlib import Path


def load_targets(path: str = "targets.txt") -> list[str]:
    targets_path = Path(path)
    if not targets_path.exists():
        raise FileNotFoundError(f"Targets file not found: {path}")

    raw_lines = targets_path.read_text(encoding="utf-8").splitlines()

    targets = []
    seen = set()

    for line in raw_lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            continue
        if stripped in seen:
            continue
        seen.add(stripped)
        targets.append(stripped)

    return targets
