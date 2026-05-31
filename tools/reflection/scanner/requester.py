"""
requester.py - Shared httpx client, optional proxy, retry/backoff, host control.

Author: Asiful

Proxy is fully optional. When config.proxy is None the client makes direct
connections — no proxy handshake, no dependency on Burp/ZAP.

Two modes
─────────
VPS mode (default):   proxy=None   → httpx.Client with no mounts
Debug/intercept mode: proxy="http://host:port" → mounts= with HTTPTransport

All other behaviour (semaphore, throttle, block, retry, redirect chain) is
identical in both modes.

httpx.ProxyError is only retryable when a proxy is configured — without a
proxy there is no proxy to hiccup. The retryable tuple is built dynamically
to reflect this.
"""

import time
from typing import Optional
import threading
import httpx

from scanner.models import Config, TestCase, ResponseData, RedirectHop
from scanner.utils import is_text_content, random_delay, log

MAX_BODY_BYTES = 100 * 1024  # 100 KB cap on stored body

_RETRYABLE_BASE = (
    httpx.TimeoutException,
    httpx.ConnectError,
    httpx.ReadError,
    httpx.WriteError,
    httpx.RemoteProtocolError,
)

_FATAL = (
    httpx.TooManyRedirects,
    httpx.InvalidURL,
    httpx.UnsupportedProtocol,
)


# ── Shared client ──────────────────────────────────────────────────────────────

class SharedClient:
    """
    One httpx.Client per scan. Thread-safe for concurrent .request() calls.

    No proxy (VPS mode):
        httpx.Client(timeout=..., verify=..., ...)
        — direct connections, no proxy settings attached at all.

    Proxy mode:
        httpx.Client(mounts={"http://": HTTPTransport(proxy=url),
                              "https://": HTTPTransport(proxy=url)}, ...)
        — both schemes routed through the configured proxy.

    The mounts= API is the correct httpx >= 0.20 way to set a universal proxy.
    We do NOT pass mounts when proxy is None, so httpx makes no attempt to
    connect to any proxy address.
    """

    def __init__(self, config: Config) -> None:
        common = dict(
            timeout=config.timeout,
            follow_redirects=config.follow_redirects,
            verify=config.verify_tls,
            limits=httpx.Limits(
                max_connections=config.max_workers + 4,
                max_keepalive_connections=config.max_workers,
            ),
        )

        if config.proxy:
            # Proxy mode: attach transport for both schemes
            transport = httpx.HTTPTransport(proxy=config.proxy, verify=config.verify_tls)
            self._client = httpx.Client(
                mounts={"http://": transport, "https://": transport},
                **common,
            )
            self._proxy_active = True
        else:
            # VPS / direct mode: no proxy, no mounts
            self._client = httpx.Client(**common)
            self._proxy_active = False

    def request(self, **kwargs) -> httpx.Response:
        return self._client.request(**kwargs)

    def close(self) -> None:
        self._client.close()

    @property
    def proxy_active(self) -> bool:
        return self._proxy_active

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


# ── Per-host throttle (back-off) ───────────────────────────────────────────────

class HostThrottleRegistry:
    """
    Transient back-off on throttle-status responses (429, 503).
    Marks a host as throttled for backoff_secs; subsequent requests wait.
    """

    def __init__(self, backoff_secs: float = 15.0) -> None:
        self._lock    = threading.Lock()
        self._until:  dict[str, float] = {}
        self._backoff = backoff_secs

    def mark(self, hostname: str) -> None:
        with self._lock:
            self._until[hostname] = time.monotonic() + self._backoff
        log.warning("Host %s throttled for %.0fs", hostname, self._backoff)

    def wait_if_throttled(self, hostname: str) -> None:
        with self._lock:
            until = self._until.get(hostname, 0.0)
        remaining = until - time.monotonic()
        if remaining > 0:
            log.debug("Waiting %.1fs for throttled host %s", remaining, hostname)
            time.sleep(remaining)


# ── Per-host block (permanent skip) ───────────────────────────────────────────

class HostBlockRegistry:
    """
    Hard block after block_threshold consecutive block-status responses.
    Any clean response resets the counter. Blocked hosts are skipped entirely.
    """

    def __init__(self, block_on_status: list[int], threshold: int) -> None:
        self._statuses  = set(block_on_status)
        self._threshold = threshold
        self._lock      = threading.Lock()
        self._counts:   dict[str, int] = {}
        self._blocked:  set[str]       = set()

    def record(self, hostname: str, status_code: Optional[int]) -> None:
        if status_code is None:
            return
        with self._lock:
            if status_code in self._statuses:
                self._counts[hostname] = self._counts.get(hostname, 0) + 1
                if self._counts[hostname] >= self._threshold:
                    if hostname not in self._blocked:
                        self._blocked.add(hostname)
                        log.warning(
                            "Host %s BLOCKED after %d consecutive %s responses",
                            hostname, self._threshold, sorted(self._statuses),
                        )
            else:
                self._counts[hostname] = 0

    def is_blocked(self, hostname: str) -> bool:
        with self._lock:
            return hostname in self._blocked

    def blocked_hosts(self) -> list[str]:
        with self._lock:
            return sorted(self._blocked)


# ── Per-host semaphore pool ────────────────────────────────────────────────────

class _HostSemaphorePool:
    def __init__(self, max_per_host: int) -> None:
        self._max  = max_per_host
        self._lock = threading.Lock()
        self._sems: dict[str, threading.Semaphore] = {}

    def acquire(self, hostname: str) -> "_SemGuard":
        with self._lock:
            if hostname not in self._sems:
                self._sems[hostname] = threading.Semaphore(self._max)
            sem = self._sems[hostname]
        return _SemGuard(sem)


class _SemGuard:
    __slots__ = ("_sem",)

    def __init__(self, sem: threading.Semaphore) -> None:
        self._sem = sem

    def __enter__(self):
        self._sem.acquire()
        return self

    def __exit__(self, *_):
        self._sem.release()


_sem_pool: Optional[_HostSemaphorePool] = None
_sem_pool_lock = threading.Lock()
_sem_pool_size: int = 0


def _get_pool(max_per_host: int) -> _HostSemaphorePool:
    global _sem_pool, _sem_pool_size
    with _sem_pool_lock:
        if _sem_pool is None or _sem_pool_size != max_per_host:
            _sem_pool      = _HostSemaphorePool(max_per_host)
            _sem_pool_size = max_per_host
        return _sem_pool


# ── Public send function ───────────────────────────────────────────────────────

def send_test_case(
    test_case: TestCase,
    config: Config,
    client: SharedClient,
    throttle: HostThrottleRegistry,
    blocker: HostBlockRegistry,
) -> ResponseData:
    """
    Send one test case with per-host concurrency, throttle, block, and retry.

    ProxyError is only added to the retryable set when a proxy is active —
    without a proxy configured there is no proxy to hiccup.
    """
    from urllib.parse import urlparse
    hostname = urlparse(test_case.url).netloc
    pool     = _get_pool(config.max_per_host)
    last_err = ""

    # Extend retryable exceptions with ProxyError only when proxy is in use
    retryable = _RETRYABLE_BASE + (httpx.ProxyError,) if config.proxy else _RETRYABLE_BASE

    for attempt in range(1, config.retries + 2):  # retries=2 → 3 total attempts

        if blocker.is_blocked(hostname):
            return _error_response(f"HostBlocked:{hostname}")

        with pool.acquire(hostname):
            throttle.wait_if_throttled(hostname)
            random_delay(config.delay_min, config.delay_max)

            try:
                resp = _fire(test_case, client)

                blocker.record(hostname, resp.status_code)

                if resp.status_code in config.throttle_on_status:
                    throttle.mark(hostname)
                    last_err = f"ThrottleStatus:{resp.status_code}"
                    if attempt <= config.retries:
                        time.sleep(min(2 ** attempt * 2, 30))
                    continue

                return resp

            except _FATAL as exc:
                return _error_response(f"{type(exc).__name__}: {exc}")

            except retryable as exc:
                last_err = f"{type(exc).__name__}: {exc}"
                if attempt <= config.retries:
                    backoff = 2 ** (attempt - 1)
                    log.debug(
                        "Retry %d/%d %s after %s (%.0fs backoff)",
                        attempt, config.retries + 1, test_case.url, last_err, backoff,
                    )
                    time.sleep(backoff)
                continue

            except Exception as exc:
                return _error_response(f"UnknownError: {type(exc).__name__}: {exc}")

    return _error_response(f"FailedAfter{config.retries + 1}Attempts: {last_err}")


def _fire(test_case: TestCase, client: SharedClient) -> ResponseData:
    """Execute one HTTP request. Raises on network failure."""
    headers = dict(test_case.headers)
    kwargs: dict = {
        "method":  test_case.method,
        "url":     test_case.url,
        "headers": headers,
        "cookies": test_case.cookies or None,
    }

    if test_case.body is not None:
        ct = test_case.content_type or "application/x-www-form-urlencoded"
        headers["Content-Type"] = ct
        kwargs["content"] = test_case.body.encode("utf-8")

    raw = client.request(**kwargs)

    chain: list[RedirectHop] = [
        RedirectHop(url=str(r.url), status_code=r.status_code)
        for r in raw.history
    ]

    content_type = raw.headers.get("content-type", "")
    full_bytes   = raw.content
    truncated    = len(full_bytes) > MAX_BODY_BYTES
    capped       = full_bytes[:MAX_BODY_BYTES]

    body_text = ""
    if is_text_content(content_type):
        try:
            body_text = capped.decode("utf-8", errors="replace")
        except Exception:
            pass

    return ResponseData(
        status_code=raw.status_code,
        headers=dict(raw.headers),
        body_text=body_text,
        final_url=str(raw.url),
        content_type=content_type,
        content_length=len(full_bytes),
        redirect_chain=chain,
        response_truncated=truncated,
        error=None,
    )


def _error_response(msg: str) -> ResponseData:
    return ResponseData(
        status_code=None, headers={}, body_text="",
        final_url="", content_type="", content_length=0,
        redirect_chain=[], response_truncated=False, error=msg,
    )
