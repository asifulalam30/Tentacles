"""
ratelimiter.py - Per-host concurrency limiter using threading semaphores.

Keeps no more than max_per_host concurrent requests in-flight to any single
hostname, regardless of total max_workers. This is separate from the
HostThrottleRegistry in requester.py, which handles status-code-triggered
backoff; this module handles steady-state concurrency shaping.
"""

import threading
from urllib.parse import urlparse


class PerHostRateLimiter:
    """
    Thread-safe per-hostname semaphore pool.

    Usage:
        limiter = PerHostRateLimiter(max_per_host=2)
        with limiter.acquire("https://app.example.com/path"):
            response = send(...)
    """

    def __init__(self, max_per_host: int = 2) -> None:
        if max_per_host < 1:
            raise ValueError(f"max_per_host must be >= 1, got {max_per_host}")
        self._max  = max_per_host
        self._lock = threading.Lock()
        self._sems: dict[str, threading.Semaphore] = {}

    def _semaphore(self, hostname: str) -> threading.Semaphore:
        with self._lock:
            if hostname not in self._sems:
                self._sems[hostname] = threading.Semaphore(self._max)
            return self._sems[hostname]

    def acquire(self, url: str) -> "_HostGuard":
        hostname = _extract_hostname(url)
        return _HostGuard(self._semaphore(hostname))

    def active_hosts(self) -> list[str]:
        with self._lock:
            return list(self._sems.keys())


class _HostGuard:
    """Context manager that acquires a semaphore slot on enter, releases on exit."""

    __slots__ = ("_sem",)

    def __init__(self, sem: threading.Semaphore) -> None:
        self._sem = sem

    def __enter__(self):
        self._sem.acquire()
        return self

    def __exit__(self, *_):
        self._sem.release()


def _extract_hostname(url: str) -> str:
    parsed = urlparse(url)
    return parsed.netloc or url
