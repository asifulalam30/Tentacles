# SPINEL

**Authorized reflection and input-surface testing tool.**

SPINEL discovers user-controlled inputs that are echoed back in HTTP responses.
It is a *discovery and logging* tool — it does not exploit anything.
Every request is routed through a single configured transport proxy so all
traffic is captured for review.

> **Authorized use only.**  
> Only run SPINEL against systems you have explicit written permission to test.

---

## Requirements

- Python 3.10+
- A running HTTP proxy (Burp Suite, OWASP ZAP, or any CONNECT proxy)

```bash
pip install -r requirements.txt
```

`httpx`, `PyYAML`, `pydantic`, `orjson`

---

## Quick start

```bash
# 1. Add authorized targets (one per line)
echo "https://app.example.com" >> targets.txt

# 2. Set your proxy in config.yaml (default: http://127.0.0.1:8080)

# 3. Run
python main.py

# Optional flags
python main.py --config config.yaml --targets targets.txt
python main.py --verbose          # debug-level console output
python main.py --no-report        # skip Markdown report
```

---

## Project layout

```
spinel_scanner/
├── main.py                   Entry point / orchestrator
├── config.yaml               All runtime settings
├── targets.txt               One target per line (URLs or bare hostnames)
├── requirements.txt
│
├── scanner/
│   ├── models.py             Config, TestCase, ResponseData, Finding,
│   │                         BaselineResponse, BaselineDiff, RedirectHop
│   ├── config.py             YAML loading + strict startup validation
│   ├── loader.py             targets.txt reader
│   ├── normalizer.py         Adds https://, strips trailing slashes, deduplicates
│   ├── payloads.py           generate_marker()  generate_request_id()
│   ├── injectors.py          TestCase builders for each injection surface
│   ├── requester.py          SharedClient, HostThrottleRegistry,
│   │                         HostBlockRegistry, send_test_case()
│   ├── reflector.py          Exact substring match + snippet extraction
│   ├── deduplicator.py       Marks duplicate reflected findings in-place
│   ├── ratelimiter.py        PerHostRateLimiter (library-level semaphore pool)
│   ├── reporter.py           Markdown report writer
│   ├── logger.py             build_finding(), finding_to_dict()
│   ├── saver.py              combined.json + reflected/ files
│   └── utils.py              Shared logger, helpers, is_text_content()
│
├── tests/
│   ├── test_utils.py
│   ├── test_payloads.py
│   ├── test_normalizer.py
│   ├── test_injectors.py
│   ├── test_reflector.py
│   ├── test_config.py
│   ├── test_logger_saver.py
│   ├── test_ratelimiter.py
│   ├── test_deduplicator.py
│   └── test_integration.py   Local echo-server integration test (no proxy needed)
│
└── output/
    ├── combined.json          All findings + scan metadata
    ├── report.md              Markdown summary report
    ├── sample_output.json     Example combined.json for reference
    └── reflected/
        └── <host>__<point>__<param>__<request_id>.json
```

---

## Configuration reference

All settings live in `config.yaml`. Every field is validated strictly on
startup — all errors are reported at once before any network requests are made.

### Network

| Field | Default | Description |
|-------|---------|-------------|
| `proxy` | `http://127.0.0.1:8080` | Transport proxy. All traffic routes through this. |
| `timeout` | `10` | Per-request timeout in seconds (1–120). |
| `verify_tls` | `true` | Set `false` for self-signed cert environments. |
| `follow_redirects` | `true` | Follow HTTP redirects. Chains are logged. |

### Concurrency and pacing

| Field | Default | Description |
|-------|---------|-------------|
| `max_workers` | `3` | Total concurrent worker threads (1–20). |
| `max_per_host` | `2` | Max concurrent in-flight requests per hostname (1–max_workers). Enforced inside `send_test_case` for every call path including baselines. |
| `delay_min` | `0.8` | Minimum sleep between requests in seconds. |
| `delay_max` | `2.0` | Maximum sleep between requests in seconds. |
| `retries` | `2` | Retry attempts for transient network errors (0–10). |

### Host protection

| Field | Default | Description |
|-------|---------|-------------|
| `throttle_on_status` | `[429, 503]` | Transient back-off: host paused 15 s on these statuses. Resets automatically. |
| `block_on_status` | `[403]` | Hard block: consecutive hits counted. |
| `block_threshold` | `5` | Consecutive `block_on_status` responses before host is permanently skipped for this scan. Any clean response resets the counter. |

### Injection

| Field | Default | Description |
|-------|---------|-------------|
| `marker_prefix` | `SPINEL` | Payload prefix (`SPINEL_<8hex>`). |
| `methods` | `[GET, POST]` | HTTP methods to use. |
| `test_points` | all five | Which surfaces to test (see table below). |
| `baseline_enabled` | `true` | Send a clean GET per target before injection. Baseline status/length/content-type stored; `BaselineDiff` attached to every finding. |

### Injection surfaces (`test_points`)

| Name | Method | What is injected |
|------|--------|-----------------|
| `query` | GET | Query string parameters (`?q=`, `?search=`, `?id=`, …) |
| `headers` | GET | HTTP headers (`User-Agent`, `Referer`, `X-Forwarded-Host`, …) |
| `cookies` | GET | Cookie values |
| `form` | POST | `application/x-www-form-urlencoded` body fields |
| `json` | POST | `application/json` body fields |

### Reflection detection

| Field | Default | Description |
|-------|---------|-------------|
| `reflection.check_body` | `true` | Inspect response body for payload. |
| `reflection.check_headers` | `true` | Inspect response headers for payload. |
| `reflection.snippet_radius` | `60` | Characters to capture each side of a match (10–200). |

---

## Targets file

```
# Authorized targets for engagement 2026-Q2
https://app.example.com
api.example.com                   # normalized to https://api.example.com
https://portal.example.com/login  # path preserved
```

Bare hostnames get `https://` prepended. Duplicates (after normalization) are
dropped silently.

---

## How proxy routing works

SPINEL uses `httpx.Client` with `mounts=` — the correct httpx ≥ 0.20 API:

```python
mounts={
    "http://":  httpx.HTTPTransport(proxy=proxy_url),
    "https://": httpx.HTTPTransport(proxy=proxy_url),
}
```

One `SharedClient` instance is created per scan and reused across all
requests for connection pooling. The proxy URL is recorded in every finding
under `proxy_used`.

---

## Host protection: throttle vs block

**Throttle (transient back-off)**  
When a response with a status in `throttle_on_status` (default: 429, 503) is
received, the host is marked as throttled for 15 seconds. All workers wait
before the next request to that host. The window resets automatically.

**Block (hard skip)**  
When a host returns `block_threshold` *consecutive* responses whose status is
in `block_on_status` (default: 403), the host is permanently skipped for the
rest of the scan. Any clean response resets the consecutive counter. Blocked
hosts appear in the terminal summary and in `combined.json` under
`scan_stats.blocked_hosts`.

**Per-host concurrency**  
`max_per_host` caps the number of concurrent in-flight requests to any single
hostname. This gate lives inside `send_test_case` and is enforced for every
call path — injection requests, baseline requests, and retries.

**Retry/backoff**  
Transient errors (timeout, connect failure, read error, proxy hiccup) are
retried with exponential backoff: 1 s, 2 s, 4 s… up to `retries` attempts.
Fatal errors (invalid URL, too many redirects) fail immediately.

---

## Deduplication

After the scan completes, findings are deduplicated before output.

**Deduplication key:**  
`(target, injection_point, parameter_name, status_code, sorted(reflection_locations))`

The first occurrence of each key is canonical and saved to `reflected/`.
Subsequent identical findings have `deduplicated: true` in their JSON record
and are omitted from `reflected/`. All findings — canonical and duplicates —
appear in `combined.json` for traceability.

Errors, baseline records, and non-reflected findings are never deduplicated.

---

## Redirect chain logging

Every response records intermediate hops from `httpx`'s `response.history`:

```json
"redirect_chain": [
  {"url": "http://app.example.com/old", "status_code": 301}
],
"final_url": "https://app.example.com/new"
```

The Markdown report flags findings with redirects and lists each hop inline.
`redirects_total` appears in the top-level `combined.json` metadata.

---

## Baseline diff

When `baseline_enabled: true`, a clean GET is sent to each target before
injection. The response metadata (status code, content-type, content length)
is stored as `BaselineResponse`. Every subsequent finding for that target
carries a `BaselineDiff`:

```json
"baseline_diff": {
  "status_changed": false,
  "status_baseline": 200,
  "status_injected": 200,
  "length_delta": 42,
  "content_type_changed": false
}
```

The Markdown report highlights findings where status changed, content-type
changed, or length delta exceeds 50 bytes.

---

## Output

### `output/combined.json`

```json
{
  "schema_version": "2",
  "scan_started_at": "2026-04-15T10:00:00Z",
  "scan_finished_at": "2026-04-15T10:04:12Z",
  "targets_total": 2,
  "requests_total": 56,
  "reflections_total": 3,
  "duplicates_total": 1,
  "errors_total": 0,
  "redirects_total": 4,
  "scan_stats": {
    "blocked_hosts": [],
    "per_host": { "app.example.com": { "requests": 28, "reflected": 2, ... } },
    "per_point": { "query": { "requests": 14, "reflected": 2 }, ... }
  },
  "results": [ ... ]
}
```

### `output/reflected/<host>__<point>__<param>__<request_id>.json`

One file per unique reflected finding. The `request_id` (uuid4 hex) in the
filename prevents all collisions. Grep a `request_id` across `combined.json`
and `reflected/` to find the same record in both places.

### `output/report.md`

- Scan metadata + summary table
- Baseline responses table
- Reflected findings grouped by target, with baseline diff callouts, redirect
  chains, and snippets
- Injection point breakdown (total / reflected / deduped / errors)
- Per-target breakdown (requests / reflected / errors / redirects)
- Error table with truncated `request_id` for cross-referencing

---

## Finding schema (v2)

Every record in `combined.json` has these fields. All always present;
missing values are `null`, never absent.

```
request_id              uuid4 hex
timestamp               ISO 8601 UTC
deduplicated            true if this is a duplicate of an earlier finding
target                  normalized target URL
method                  GET | POST | …
request_url             full URL as sent (includes injected query params)
injection_point         query | header | cookie | form | json | baseline
parameter_name          injected parameter name
payload                 SPINEL_<8hex> marker string
proxy_used              proxy URL from config
request_headers         dict
request_cookies         dict
request_body            string or null
status_code             HTTP status or null
response_headers        dict
content_type            Content-Type value
response_length         full body length in bytes
response_truncated      true if body capped at 100 KB
redirect_chain          [{url, status_code}, …] — intermediate hops
final_url               URL after all redirects
reflected               true if payload found in response
matches                 count of payload occurrences
reflection_locations    ["body"] | ["header:X-Echo"] | []
snippets                surrounding text around each match
error                   error string or null
baseline                {status_code, content_type, content_length, error} or null
baseline_diff           {status_changed, status_baseline, status_injected,
                         length_delta, content_type_changed} or null
```

---

## Running the tests

```bash
# Full suite (181 tests, no proxy or internet required)
python -m pytest tests/ -v

# Single file
python -m pytest tests/test_deduplicator.py -v

# Integration tests only
python -m pytest tests/test_integration.py -v
```

The integration test spins up a stdlib HTTP echo server on a random port.
No external proxy or network access needed.

---

## Terminal output example

```
╔══════════════════════════════════════════════════════╗
║  SPINEL - Reflection & Input Surface Testing Tool    ║
║  Authorized use only. Log all activity.              ║
╚══════════════════════════════════════════════════════╝
INFO  Proxy         : http://127.0.0.1:8080
INFO  Test points   : query, headers, cookies, form, json
INFO  Workers       : 3  (max_per_host: 2)
INFO  Block on      : [403]  (threshold: 5)
INFO  Collecting baselines…
INFO    baseline  [200] https://app.example.com
INFO    baseline  [200] https://api.example.com

  [████████████████░░░░░░░░░░░░░░░░░░░░] 84/168  hits: 3

  [HIT] a1b2c3d4e5f6… GET query:q → https://app.example.com
        └─ final: https://app.example.com/?q=SPINEL_1a2b3c4d
           …<input value="SPINEL_1a2b3c4d">…

════════════════════════════════════════════════════════════
  Scan complete
────────────────────────────────────────────────────────────
  Targets             : 2
  Requests sent       : 168
  Unique reflections  : 3
  Duplicates skipped  : 1
  Errors              : 0
  Redirects logged    : 6
────────────────────────────────────────────────────────────
  Point        Requests  Reflected
  cookies            24          0
  form               20          0
  headers            28          0
  json               20          0
  query              28          3
────────────────────────────────────────────────────────────
  JSON output         : output/combined.json
  Reflected files     : output/reflected/
  Markdown report     : output/report.md
════════════════════════════════════════════════════════════
```

---

## Version scope

**Included**
- Targets from file, normalization, deduplication
- GET + POST across 5 injection surfaces
- Unique marker per request + unique `request_id`
- Baseline GET per target with `BaselineDiff` on every finding
- Redirect chain capture (`redirect_chain`, `final_url`)
- Single transport proxy via `mounts=` (httpx ≥ 0.20 API)
- Per-host concurrency (semaphore inside `send_test_case`)
- Transient throttle (429/503) + hard block (403 × N)
- Exact reflection detection in body and headers
- Deduplication of repeated reflected findings
- JSON output with stable v2 schema
- Markdown summary report
- Strict config validation — all errors reported at startup
- 181 unit and integration tests

**Not in v1**
- Browser rendering / JavaScript execution
- HTML context classification (attribute, JS string, etc.)
- Crawling / link discovery
- Authentication workflows
- Exploit generation
- Screenshots

---

## Legal notice

This tool is for authorized security testing only. Unauthorized use is
illegal and unethical. Always obtain written permission, scope your testing,
and log all activity.
