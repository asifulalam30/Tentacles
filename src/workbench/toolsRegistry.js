/**
 * TOOLS REGISTRY
 *
 * Source of truth for all available pen-testing tools that can be launched
 * from the workbench. Drives both:
 *   - Backend validation (which inputs are required, valid file types, etc.)
 *   - Frontend form generation (renders the right input controls per tool)
 *
 * To add a new tool:
 *   1. Add a descriptor here
 *   2. Add a corresponding `runX(opts)` function in tools.js
 *   3. The UI will pick up the new tool automatically
 *
 * Input types:
 *   - 'file':    select an existing recon file from the workbench
 *   - 'select':  fixed list of options
 *   - 'string':  free-text input
 *   - 'number':  numeric input with min/max
 *   - 'boolean': checkbox
 *   - 'multi':   multi-select (returns array)
 */

'use strict';

const TOOLS = [
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'ffuf',
    label: 'FFUF',
    icon: '⊕',
    description: 'Web content discovery via wordlist fuzzing',
    longDescription: 'Fuzzes paths/files against alive hosts. CDN-aware rate limiting. Output appends to ffuf_findings.txt.',
    estimatedTime: '2-15 min depending on host count and wordlist',
    outputs: ['ffuf_findings.txt'],
    inputs: [
      {
        name: 'inputFile',
        label: 'Targets file',
        type: 'file',
        accepts: ['alive_hosts.txt', 'direct_hosts.txt', 'cloudflare_hosts.txt'],
        required: true,
        help: 'List of URLs to fuzz (one per line). Use direct_hosts.txt to skip Cloudflare.',
      },
      {
        name: 'wordlist',
        label: 'Wordlist',
        type: 'select',
        options: [
          { value: 'raft-small',  label: 'raft-small-directories (20K) — fast' },
          { value: 'raft-medium', label: 'raft-medium-directories (220K) — recommended' },
          { value: 'raft-large',  label: 'raft-large-directories (60K) — sneakier paths' },
          { value: 'common',      label: 'common.txt (4.6K) — quick smoke test' },
          { value: 'big',         label: 'big.txt (20K)' },
          { value: 'api',         label: 'api/objects.txt (1K) — API-focused' },
        ],
        default: 'raft-medium',
        required: true,
      },
      {
        name: 'rate',
        label: 'Requests per second (per host)',
        type: 'number',
        default: 5,
        min: 1, max: 100,
        help: 'CDN-protected hosts are auto-throttled to 2 r/s regardless.',
      },
      {
        name: 'extensions',
        label: 'Extensions to append (comma-separated, optional)',
        type: 'string',
        default: '',
        placeholder: 'php,asp,bak,old',
        help: 'Adds .php, .asp, etc. to each wordlist entry. Leave blank for paths only.',
      },
      {
        name: 'matchCodes',
        label: 'Match HTTP status codes',
        type: 'string',
        default: '200,201,301,302,307,401,403',
        help: 'Comma-separated list of codes that count as "found".',
      },
      {
        name: 'filterSize',
        label: 'Filter response size (optional)',
        type: 'string',
        default: '',
        placeholder: '4242',
        help: 'Hide responses with this byte size (e.g. consistent 404 page size).',
      },
      {
        name: 'maxRuntime',
        label: 'Max runtime (minutes)',
        type: 'number',
        default: 15,
        min: 1, max: 120,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'arjun',
    label: 'Arjun',
    icon: '⌬',
    description: 'Hidden HTTP parameter discovery',
    longDescription: 'Brute-forces parameter names against alive endpoints to find undocumented API parameters.',
    estimatedTime: '3-10 min depending on host count',
    outputs: ['params_detailed.txt'],
    inputs: [
      {
        name: 'inputFile',
        label: 'Targets file',
        type: 'file',
        accepts: ['alive_hosts.txt', 'direct_hosts.txt', 'api_endpoints.txt'],
        required: true,
        help: 'For best results, use api_endpoints.txt if available (focused).',
      },
      {
        name: 'method',
        label: 'HTTP method',
        type: 'select',
        options: [
          { value: 'GET',  label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'JSON', label: 'POST (JSON body)' },
        ],
        default: 'GET',
      },
      {
        name: 'concurrency',
        label: 'Parallel hosts',
        type: 'number',
        default: 3,
        min: 1, max: 10,
        help: 'How many hosts to scan concurrently. Higher = faster but louder.',
      },
      {
        name: 'threadsPerHost',
        label: 'Threads per host',
        type: 'number',
        default: 5,
        min: 1, max: 20,
      },
      {
        name: 'timeoutPerHost',
        label: 'Timeout per host (seconds)',
        type: 'number',
        default: 120,
        min: 30, max: 600,
      },
      {
        name: 'stable',
        label: 'Stable mode (slower, fewer false positives)',
        type: 'boolean',
        default: false,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'js_analyzer',
    label: 'JS & Secrets',
    icon: '⟦',
    description: 'Extract endpoints + secrets from JS bundles (with trufflehog scan)',
    longDescription: 'Downloads JS files referenced in URLs, runs trufflehog (or built-in regex if missing) for secrets detection, and extracts endpoints via xnLinkFinder/LinkFinder. Output flows into Endpoints + Secrets findings.',
    estimatedTime: '1-5 min depending on JS file count',
    outputs: ['js_files.txt', 'js_endpoints.txt', 'js_secrets.txt'],
    inputs: [
      {
        name: 'inputFile',
        label: 'URL source file',
        type: 'file',
        accepts: ['all_urls.txt', 'urls_archive.txt'],
        required: true,
        help: 'JS files will be filtered out of this URL list.',
      },
      {
        name: 'maxFiles',
        label: 'Max JS files to download',
        type: 'number',
        default: 200,
        min: 10, max: 2000,
        help: 'Caps the number of JS files fetched. Most apps only need 50-100.',
      },
      {
        name: 'fetchTimeout',
        label: 'Fetch timeout per file (seconds)',
        type: 'number',
        default: 8,
        min: 3, max: 30,
      },
      {
        name: 'mergeIntoUrls',
        label: 'Merge discovered endpoints into all_urls.txt',
        type: 'boolean',
        default: true,
        help: 'When true, JS-discovered endpoints flow into the Endpoints tab and other tools.',
      },
      {
        name: 'useTrufflehog',
        label: 'Use trufflehog for secret scanning (recommended)',
        type: 'boolean',
        default: true,
        help: 'Trufflehog finds many more secret types than regex alone. Falls back to regex if not installed.',
      },
      {
        name: 'useXnLinkFinder',
        label: 'Use xnLinkFinder for endpoint extraction (recommended)',
        type: 'boolean',
        default: true,
        help: 'Better than basic regex. Falls back to regex if not installed.',
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'nuclei',
    label: 'Nuclei',
    icon: '◬',
    description: 'Template-based vulnerability scanner',
    longDescription: 'Runs nuclei templates against alive hosts. Produces structured findings tagged with severity and CVE references.',
    estimatedTime: '5-30 min depending on template count and hosts',
    outputs: ['nuclei_findings.txt', 'nuclei_findings.json'],
    inputs: [
      {
        name: 'inputFile',
        label: 'Targets file',
        type: 'file',
        accepts: ['alive_hosts.txt', 'direct_hosts.txt'],
        required: true,
      },
      {
        name: 'templateSet',
        label: 'Template set',
        type: 'select',
        options: [
          { value: 'critical_high',     label: 'Critical & High severity only — fastest' },
          { value: 'exposures',         label: 'Exposures (sensitive files, configs, panels)' },
          { value: 'security_headers',  label: 'Security headers (CSP, HSTS, X-Frame, etc.)' },
          { value: 'ssl_tls',           label: 'SSL/TLS misconfigurations (weak ciphers, expired certs)' },
          { value: 'takeover',          label: 'Subdomain takeover (nuclei takeover templates)' },
          { value: 'secrets',           label: 'Exposed secrets (API keys, tokens in responses)' },
          { value: 'cves',              label: 'CVEs only' },
          { value: 'misconfig',         label: 'Misconfigurations' },
          { value: 'default',           label: 'Default templates (curated by ProjectDiscovery)' },
          { value: 'full',              label: 'Full templates — slow, comprehensive' },
          { value: 'custom',            label: 'Custom path (specify below)' },
        ],
        default: 'critical_high',
      },
      {
        name: 'customTemplatePath',
        label: 'Custom template path (only if "Custom path" selected above)',
        type: 'string',
        default: '',
        placeholder: '/path/to/templates or template-tag',
      },
      {
        name: 'severityFilter',
        label: 'Severity filter (comma-separated, blank = all)',
        type: 'string',
        default: 'critical,high',
        placeholder: 'critical,high,medium',
      },
      {
        name: 'rateLimit',
        label: 'Requests per second (global)',
        type: 'number',
        default: 30,
        min: 5, max: 300,
      },
      {
        name: 'maxRuntime',
        label: 'Max runtime (minutes)',
        type: 'number',
        default: 30,
        min: 5, max: 240,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'reflection',
    label: 'Reflection (SPINEL)',
    icon: '✦',
    description: 'Reflected input-surface mapper (XSS canary)',
    longDescription: 'Submits unique markers in query/header/cookie/form/JSON inputs and detects which ones come back in responses. Output is the start of an XSS hunt — every reflected param is a candidate.',
    estimatedTime: '5-20 min depending on target count',
    outputs: ['reflection_findings.txt', 'reflection_combined.json'],
    inputs: [
      {
        name: 'inputFile',
        label: 'Targets file',
        type: 'file',
        accepts: ['alive_hosts.txt', 'all_urls.txt', 'direct_hosts.txt'],
        required: true,
        help: 'all_urls.txt gives broader coverage, alive_hosts.txt is faster.',
      },
      {
        name: 'points',
        label: 'Injection surfaces',
        type: 'multi',
        options: [
          { value: 'query',   label: 'Query string parameters' },
          { value: 'headers', label: 'HTTP headers (X-Forwarded-Host, etc.)' },
          { value: 'cookies', label: 'Cookies' },
          { value: 'form',    label: 'Form-encoded body (POST)' },
          { value: 'json',    label: 'JSON body (POST)' },
        ],
        default: ['query', 'headers', 'cookies', 'form', 'json'],
        required: true,
      },
      {
        name: 'maxWorkers',
        label: 'Concurrent workers (global)',
        type: 'number',
        default: 3,
        min: 1, max: 20,
      },
      {
        name: 'maxPerHost',
        label: 'Max concurrent per host',
        type: 'number',
        default: 2,
        min: 1, max: 10,
      },
      {
        name: 'delayMin',
        label: 'Min delay between requests (seconds)',
        type: 'number',
        default: 0.8,
        min: 0, max: 30,
      },
      {
        name: 'delayMax',
        label: 'Max delay between requests (seconds)',
        type: 'number',
        default: 2.0,
        min: 0, max: 60,
      },
      {
        name: 'maxRuntime',
        label: 'Max runtime (minutes, 0 = unlimited)',
        type: 'number',
        default: 30,
        min: 0, max: 240,
      },
      {
        name: 'proxy',
        label: 'Proxy URL (optional, for Burp/ZAP capture)',
        type: 'string',
        default: '',
        placeholder: 'http://127.0.0.1:8080',
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'gowitness',
    label: 'Screenshots (gowitness)',
    icon: '◳',
    description: 'Visual mapping of alive hosts via headless Chrome',
    longDescription: 'Captures screenshots of every alive host using gowitness. Useful for spotting login panels, default installs, error pages, and clustering similar UIs at a glance.',
    estimatedTime: '2-15 min depending on host count',
    outputs: ['screenshots/', 'gowitness_report.html'],
    inputs: [
      {
        name: 'inputFile',
        label: 'Targets file',
        type: 'file',
        accepts: ['alive_hosts.txt', 'direct_hosts.txt'],
        required: true,
      },
      {
        name: 'threads',
        label: 'Concurrent screenshots',
        type: 'number',
        default: 4,
        min: 1, max: 20,
      },
      {
        name: 'timeout',
        label: 'Per-host timeout (seconds)',
        type: 'number',
        default: 15,
        min: 5, max: 60,
      },
      {
        name: 'fullPage',
        label: 'Full-page screenshots (slower, more useful)',
        type: 'boolean',
        default: false,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'testssl',
    label: 'TLS/SSL (testssl.sh)',
    icon: '◐',
    description: 'Deep TLS/SSL configuration audit',
    longDescription: 'Runs testssl.sh to find weak ciphers, expired/self-signed certs, vulnerable protocols (SSLv3, TLS 1.0), Heartbleed, and missing security extensions. Slow but thorough.',
    estimatedTime: '3-10 min per host',
    outputs: ['testssl_findings.txt', 'testssl_<host>.json'],
    inputs: [
      {
        name: 'inputFile',
        label: 'Targets file',
        type: 'file',
        accepts: ['alive_hosts.txt', 'direct_hosts.txt'],
        required: true,
      },
      {
        name: 'severity',
        label: 'Minimum severity',
        type: 'select',
        options: [
          { value: 'LOW',      label: 'LOW (everything)' },
          { value: 'MEDIUM',   label: 'MEDIUM (skip info-level)' },
          { value: 'HIGH',     label: 'HIGH (only serious issues)' },
          { value: 'CRITICAL', label: 'CRITICAL (only critical)' },
        ],
        default: 'MEDIUM',
      },
      {
        name: 'concurrency',
        label: 'Parallel hosts',
        type: 'number',
        default: 2,
        min: 1, max: 5,
        help: 'testssl.sh is heavy. Keep concurrency low to avoid getting rate-limited.',
      },
      {
        name: 'maxRuntimePerHost',
        label: 'Max runtime per host (minutes)',
        type: 'number',
        default: 5,
        min: 2, max: 30,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'wafw00f',
    label: 'WAF Detection (wafw00f)',
    icon: '◮',
    description: 'Identify WAFs in front of alive hosts',
    longDescription: 'Detects WAFs (Cloudflare, AWS WAF, Akamai, Imperva, F5, Sucuri, etc.) by sending probe requests. Important for choosing rate-limit strategy in subsequent tools.',
    estimatedTime: '~5s per host',
    outputs: ['waf_detections.txt'],
    inputs: [
      {
        name: 'inputFile',
        label: 'Targets file',
        type: 'file',
        accepts: ['alive_hosts.txt', 'direct_hosts.txt', 'cloudflare_hosts.txt'],
        required: true,
      },
      {
        name: 'concurrency',
        label: 'Parallel hosts',
        type: 'number',
        default: 5,
        min: 1, max: 20,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'whatweb',
    label: 'Tech Fingerprint (whatweb)',
    icon: '◇',
    description: 'Deep technology stack identification',
    longDescription: 'Identifies CMS (WordPress, Drupal, Joomla), web frameworks, server software, JS libraries, analytics platforms, and version numbers. Aggressive mode finds more but is louder.',
    estimatedTime: '1-5 min depending on host count',
    outputs: ['whatweb_findings.txt', 'whatweb_<host>.json'],
    inputs: [
      {
        name: 'inputFile',
        label: 'Targets file',
        type: 'file',
        accepts: ['alive_hosts.txt', 'direct_hosts.txt'],
        required: true,
      },
      {
        name: 'aggression',
        label: 'Aggression level',
        type: 'select',
        options: [
          { value: '1', label: '1 — Stealthy (passive, single GET)' },
          { value: '3', label: '3 — Aggressive (active, multiple probes)' },
          { value: '4', label: '4 — Heavy (try every plugin, very loud)' },
        ],
        default: '3',
      },
      {
        name: 'concurrency',
        label: 'Parallel hosts',
        type: 'number',
        default: 5,
        min: 1, max: 25,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  {
    id: 's3scanner',
    label: 'Cloud Buckets (s3scanner)',
    icon: '◭',
    description: 'Find open S3 buckets for the target',
    longDescription: 'Generates likely S3 bucket names from the target organization (e.g. asterdex-backups, asterdex-prod, asterdex-dev) and tests each for public read/write access.',
    estimatedTime: '2-8 min depending on permutation count',
    outputs: ['s3_findings.txt', 's3_buckets.txt'],
    inputs: [
      {
        name: 'orgName',
        label: 'Organization base name',
        type: 'string',
        default: '',
        placeholder: 'asterdex',
        required: true,
        help: 'Used to generate bucket name candidates (asterdex-backup, asterdex-prod, etc.). Defaults to workbench target if blank.',
      },
      {
        name: 'permutations',
        label: 'Permutation set',
        type: 'select',
        options: [
          { value: 'small',  label: 'Small (~50 candidates) — fastest' },
          { value: 'medium', label: 'Medium (~250 candidates)' },
          { value: 'large',  label: 'Large (~1000 candidates)' },
        ],
        default: 'medium',
      },
      {
        name: 'providers',
        label: 'Cloud providers to scan',
        type: 'multi',
        options: [
          { value: 'aws',    label: 'AWS S3' },
          { value: 'gcp',    label: 'Google Cloud Storage' },
          { value: 'azure',  label: 'Azure Blob' },
          { value: 'digitalocean', label: 'DigitalOcean Spaces' },
        ],
        default: ['aws', 'gcp'],
        required: true,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'github_recon',
    label: 'GitHub Recon (trufflehog)',
    icon: '◓',
    description: 'Find leaked secrets in GitHub repos for the org',
    longDescription: 'Scans the target organization\'s public GitHub repositories using trufflehog for credentials, API keys, JWT tokens, and other secrets. Requires a GitHub personal access token (read-only is fine).',
    estimatedTime: '5-30 min depending on org repo count',
    outputs: ['github_secrets.txt', 'github_<repo>.json'],
    inputs: [
      {
        name: 'orgOrUser',
        label: 'GitHub organization or user',
        type: 'string',
        default: '',
        placeholder: 'asterdex',
        required: true,
        help: 'GitHub org or user name. Defaults to workbench target if blank.',
      },
      {
        name: 'githubToken',
        label: 'GitHub PAT (read-only)',
        type: 'string',
        default: '',
        placeholder: 'ghp_xxxxxxxx (required)',
        required: true,
        help: 'Read-only token. Stored in workbench memory only — not written to disk.',
      },
      {
        name: 'maxRepos',
        label: 'Max repos to scan',
        type: 'number',
        default: 25,
        min: 1, max: 200,
      },
      {
        name: 'onlyVerified',
        label: 'Only show verified findings (recommended)',
        type: 'boolean',
        default: true,
        help: 'Trufflehog can verify findings against the actual provider. Filters out false positives.',
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'subzy',
    label: 'Takeover Check (subzy)',
    icon: '◬',
    description: 'Confirm subdomain takeover candidates',
    longDescription: 'Tests subdomains with dangling CNAMEs against takeover fingerprints (S3, GitHub Pages, Heroku, Azure, etc.). Confirms exploitability of dangling CNAMEs found during DNS resolution.',
    estimatedTime: '1-5 min depending on candidate count',
    outputs: ['takeover_findings.txt'],
    inputs: [
      {
        name: 'inputFile',
        label: 'Targets file',
        type: 'file',
        accepts: ['dangling.txt', 'all_subs.txt', 'cnames.txt'],
        required: true,
        help: 'dangling.txt is the most efficient input — it only contains hosts with dangling CNAMEs.',
      },
      {
        name: 'concurrency',
        label: 'Parallel checks',
        type: 'number',
        default: 10,
        min: 1, max: 50,
      },
      {
        name: 'verifySsl',
        label: 'Verify SSL certificates',
        type: 'boolean',
        default: false,
        help: 'When false, accepts self-signed/invalid certs — finds more takeovers.',
      },
    ],
  },


  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'mirror',
    label: 'Site Mirror',
    icon: '⛁',
    description: 'Download the full HTML/JS/CSS surface for offline analysis',
    longDescription: 'Recursively crawls the target via wget, capturing all HTML, JS, CSS, and assets. After download, extracts forms, hidden inputs, comments, and inline JS. Feeds discovered URLs and parameters back into the recon corpus and triggers a fresh lead-generation pass with the richer surface.',
    estimatedTime: '5-30 min depending on site size',
    outputs: ['mirror/', 'mirror_findings.txt', 'mirror_summary.txt'],
    inputs: [
      {
        name: 'inputFile',
        label: 'Targets file',
        type: 'file',
        accepts: ['alive_hosts.txt', 'direct_hosts.txt'],
        required: true,
        help: 'direct_hosts.txt is best — avoids wasting bandwidth on Cloudflare-protected mirrors.',
      },
      {
        name: 'depth',
        label: 'Crawl depth (link-recursion)',
        type: 'number',
        default: 2,
        min: 1, max: 5,
        help: 'Depth 1 = just the entry pages. Depth 2 = pages linked from entries. Higher depths multiply time and bandwidth.',
      },
      {
        name: 'maxPagesPerHost',
        label: 'Max pages per host',
        type: 'number',
        default: 100,
        min: 10, max: 1000,
        help: 'Hard cap to keep the crawl bounded. Pages over the cap are skipped.',
      },
      {
        name: 'includeAssets',
        label: 'Include CSS / JS / images',
        type: 'boolean',
        default: true,
        help: 'When true, downloads JS bundles and CSS too. Required for richer secret/endpoint extraction.',
      },
      {
        name: 'rateLimit',
        label: 'Requests per second',
        type: 'number',
        default: 5,
        min: 1, max: 30,
        help: 'Lower = less likely to be flagged or blocked. Stay polite.',
      },
      {
        name: 'triggerLeadRegen',
        label: 'Re-generate leads after crawl',
        type: 'boolean',
        default: true,
        help: 'Once the mirror finishes, automatically run lead generation again with the enriched data.',
      },
    ],
  },
];

// Quick lookup
const BY_ID = Object.fromEntries(TOOLS.map(t => [t.id, t]));

function get(id) {
  return BY_ID[id] || null;
}

function list() {
  return TOOLS.map(t => ({
    id: t.id, label: t.label, icon: t.icon,
    description: t.description, longDescription: t.longDescription,
    estimatedTime: t.estimatedTime, outputs: t.outputs,
    inputs: t.inputs,
  }));
}

/**
 * Validate user-supplied options against the tool's input schema.
 * Returns { ok: true, normalized: {...} } or { ok: false, error: '...' }.
 */
function validate(toolId, raw) {
  const tool = get(toolId);
  if (!tool) return { ok: false, error: `Unknown tool: ${toolId}` };
  const out = {};
  for (const input of tool.inputs) {
    const v = raw && raw[input.name];
    if (v === undefined || v === null || v === '') {
      if (input.required) {
        return { ok: false, error: `Missing required field: ${input.label} (${input.name})` };
      }
      out[input.name] = input.default !== undefined ? input.default : null;
      continue;
    }
    switch (input.type) {
      case 'number': {
        const n = Number(v);
        if (Number.isNaN(n)) return { ok: false, error: `${input.label} must be a number` };
        if (input.min !== undefined && n < input.min) return { ok: false, error: `${input.label} must be ≥ ${input.min}` };
        if (input.max !== undefined && n > input.max) return { ok: false, error: `${input.label} must be ≤ ${input.max}` };
        out[input.name] = n;
        break;
      }
      case 'boolean':
        out[input.name] = !!v;
        break;
      case 'select': {
        const valid = input.options.map(o => o.value);
        if (!valid.includes(v)) return { ok: false, error: `${input.label}: "${v}" is not a valid option` };
        out[input.name] = v;
        break;
      }
      case 'multi': {
        if (!Array.isArray(v)) return { ok: false, error: `${input.label} must be an array` };
        const valid = input.options.map(o => o.value);
        for (const item of v) {
          if (!valid.includes(item)) return { ok: false, error: `${input.label}: "${item}" is not a valid option` };
        }
        out[input.name] = v;
        break;
      }
      case 'file': {
        if (typeof v !== 'string') return { ok: false, error: `${input.label} must be a filename string` };
        if (input.accepts && !input.accepts.includes(v)) {
          return { ok: false, error: `${input.label}: "${v}" not allowed. Pick from ${input.accepts.join(', ')}` };
        }
        // Defense: prevent path traversal
        if (v.includes('/') || v.includes('..')) {
          return { ok: false, error: `${input.label}: invalid filename` };
        }
        out[input.name] = v;
        break;
      }
      case 'string':
      default:
        out[input.name] = String(v);
        break;
    }
  }
  return { ok: true, normalized: out };
}

module.exports = { list, get, validate, TOOLS };
