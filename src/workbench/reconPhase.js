/**
 * RECON PHASE RUNNER
 *
 * Runs one specific phase of retrox-recon.sh by setting all OTHER SKIP_* flags
 * to 1. Reuses the same script and the same streaming infrastructure as full
 * scans — just with a narrower scope.
 *
 * Phase metadata:
 *   - id: stable identifier
 *   - label: human-readable name
 *   - skipKeysToUnset: which env keys to NOT set to 1
 *   - dependencies: array of phase ids that must have produced their outputs first
 *   - outputs: array of files this phase writes (used to detect "has run before")
 *
 * Records of phase runs are stored in <workbenchDir>/phase_runs.json so the UI
 * can show "last run: 2 hours ago — 47 results" per phase.
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const sessionStore = require('./sessionStore');
const chatEngine = require('./chatEngine');
const reconStreamer = require('./reconStreamer');

const RECON_SCRIPT = path.resolve(__dirname, '../../recon/retrox-recon.sh');

function _sanitize(s) { return String(s).replace(/[^A-Za-z0-9._-]/g, '_'); }

// All 6 SKIP_ env keys the script understands
const ALL_SKIP_KEYS = ['SKIP_NMAP', 'SKIP_URLS', 'SKIP_JS', 'SKIP_ARJUN', 'SKIP_FFUF', 'SKIP_PROBES'];

const PHASES = {
  subdomain_enum: {
    label: 'Subdomain enumeration',
    // Phase 1 is always-on in the script (no SKIP flag). Running this also
    // forcibly does Phase 2 (DNS) since they're tightly coupled and the script
    // doesn't gate phase 2. We accept that — running "subdomain_enum" gives
    // you a full re-resolve too. Worth it for simplicity.
    skipAllExceptThis: true,
    requiredSkipFlags: [...ALL_SKIP_KEYS],
    deps: [],
    outputs: ['all_subs.txt', 'resolved.txt', 'ips.txt', 'cnames.txt', 'dangling.txt'],
  },
  dns_resolve: {
    label: 'DNS resolution + CNAMEs',
    // DNS is part of Phase 2 — same situation: bundled with subdomain enum.
    // Treat it as the same as subdomain_enum.
    skipAllExceptThis: true,
    requiredSkipFlags: [...ALL_SKIP_KEYS],
    deps: ['subdomain_enum'],
    outputs: ['resolved.txt', 'ips.txt', 'cnames.txt', 'dangling.txt'],
    aliasFor: 'subdomain_enum',
  },
  port_scan: {
    label: 'Port scanning (nmap)',
    requiredSkipFlags: ALL_SKIP_KEYS.filter(k => k !== 'SKIP_NMAP'),
    deps: ['dns_resolve'],
    outputs: ['open_ports.txt'],
  },
  http_probe: {
    label: 'HTTP probing + CDN detection',
    // Phase 4 (httpx) is also always-on in the script — bundled with phases 1-2-4.
    // Running "subdomain_enum" runs this too. Treat as alias.
    skipAllExceptThis: true,
    requiredSkipFlags: [...ALL_SKIP_KEYS],
    deps: ['dns_resolve'],
    outputs: ['alive_hosts.txt', 'cloudflare_hosts.txt', 'direct_hosts.txt', 'technologies.txt'],
    aliasFor: 'subdomain_enum',
  },
  url_collection: {
    label: 'URL collection (wayback/gau/katana)',
    requiredSkipFlags: ALL_SKIP_KEYS.filter(k => k !== 'SKIP_URLS'),
    deps: ['http_probe'],
    outputs: ['all_urls.txt', 'urls_archive.txt'],
  },
  js_analysis: {
    label: 'JavaScript analysis',
    requiredSkipFlags: ALL_SKIP_KEYS.filter(k => k !== 'SKIP_JS'),
    deps: ['url_collection'],
    outputs: ['js_files.txt', 'js_endpoints.txt', 'js_secrets.txt'],
  },
  param_extraction: {
    label: 'Parameter extraction',
    // Phase 6 isn't gated by a SKIP_ flag — it always runs in the script.
    // Skipping URL collection means it has nothing to extract from.
    // We can run it independently by re-running with all OTHER SKIP=1, but
    // with SKIP_URLS=1, phase 6 still runs (and reads existing all_urls.txt).
    requiredSkipFlags: [...ALL_SKIP_KEYS], // skip everything skippable; phase 6 still runs
    deps: ['url_collection'],
    outputs: ['params.txt', 'params_detailed.txt', 'api_endpoints.txt'],
  },
  arjun: {
    label: 'Parameter discovery (Arjun)',
    requiredSkipFlags: ALL_SKIP_KEYS.filter(k => k !== 'SKIP_ARJUN'),
    deps: ['url_collection'],
    outputs: ['params_detailed.txt'],
  },
  ffuf: {
    label: 'Web fuzzing (FFUF)',
    requiredSkipFlags: ALL_SKIP_KEYS.filter(k => k !== 'SKIP_FFUF'),
    deps: ['http_probe'],
    outputs: ['ffuf_findings.txt'],
  },
  probes: {
    label: 'Cheap-win probes',
    requiredSkipFlags: ALL_SKIP_KEYS.filter(k => k !== 'SKIP_PROBES'),
    deps: ['http_probe'],
    outputs: ['graphql_endpoints.txt', 'git_exposed.txt', 'env_exposed.txt', 'backup_files.txt', 'security_txt.txt'],
  },
};

async function _push(wbId, finding) {
  return chatEngine.pushReconFinding(wbId, finding).catch(() => {});
}

async function _readPhaseRuns(wbId) {
  const file = path.join(sessionStore.workbenchDir(wbId), 'phase_runs.json');
  if (!await fs.pathExists(file)) return {};
  try { return await fs.readJson(file); } catch { return {}; }
}

async function _writePhaseRun(wbId, phaseId, info) {
  const file = path.join(sessionStore.workbenchDir(wbId), 'phase_runs.json');
  const runs = await _readPhaseRuns(wbId);
  runs[phaseId] = { ...runs[phaseId], ...info, lastRunAt: Date.now() };
  await fs.writeJson(file, runs, { spaces: 2 });
}

async function _countLines(file) {
  if (!await fs.pathExists(file)) return 0;
  try {
    const c = await fs.readFile(file, 'utf8');
    return c.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

/**
 * Returns the status for ALL phases in this workbench.
 * Used by the UI to render the recon-controls panel.
 */
async function getPhaseStatus(wbId) {
  const wb = await sessionStore.getWorkbench(wbId);
  if (!wb) throw new Error('Workbench not found');
  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const reconDir = path.join(sessionStore.workbenchDir(wbId), 'recon', _sanitize(target));
  const runs = await _readPhaseRuns(wbId);

  const status = {};
  for (const [id, def] of Object.entries(PHASES)) {
    const aliasOf = def.aliasFor || id;
    const counts = {};
    let totalLines = 0;
    for (const out of def.outputs) {
      const c = await _countLines(path.join(reconDir, out));
      counts[out] = c;
      totalLines += c;
    }
    status[id] = {
      id, label: def.label,
      deps: def.deps,
      hasRun: totalLines > 0,
      lineCounts: counts,
      totalLines,
      lastRunAt: runs[aliasOf]?.lastRunAt || runs[id]?.lastRunAt || null,
    };
  }

  // Resolve dependency-met flags
  for (const phase of Object.values(status)) {
    phase.depsMet = phase.deps.every(dep => status[dep]?.hasRun);
  }

  return status;
}

/**
 * Run a single phase. Returns a promise that resolves when the phase completes.
 * Streaming output handled by reconStreamer.
 */
async function runPhase(wbId, phaseId) {
  const def = PHASES[phaseId];
  if (!def) throw new Error(`Unknown phase: ${phaseId}`);

  // If this phase aliases another phase, run that instead
  const realPhaseId = def.aliasFor || phaseId;
  const realDef = PHASES[realPhaseId];

  if (reconStreamer.isReconRunning(wbId)) {
    throw new Error('Recon is already running for this workbench');
  }

  // Check dependencies
  const allStatus = await getPhaseStatus(wbId);
  for (const dep of realDef.deps) {
    if (!allStatus[dep]?.hasRun) {
      throw new Error(`Cannot run ${realDef.label}: dependency "${PHASES[dep].label}" hasn't run yet`);
    }
  }

  // Build options — set all SKIP_ flags except the ones this phase needs
  const skipFlags = realDef.requiredSkipFlags;
  const options = {};
  if (skipFlags.includes('SKIP_NMAP'))   options.skipPorts  = true;
  if (skipFlags.includes('SKIP_URLS'))   options.skipUrls   = true;
  if (skipFlags.includes('SKIP_JS'))     options.skipJs     = true;
  if (skipFlags.includes('SKIP_ARJUN'))  options.skipArjun  = true;
  if (skipFlags.includes('SKIP_FFUF'))   options.skipFfuf   = true;
  if (skipFlags.includes('SKIP_PROBES')) options.skipProbes = true;

  await _push(wbId, {
    icon: '▶',
    headline: `Running phase: ${realDef.label}`,
    detail: `Other phases skipped. Output will merge into existing recon files.`,
  });

  // Fire-and-forget — reconStreamer streams output to chat. When done, record the run.
  const phaseStartTime = Date.now();
  reconStreamer.runStreamingRecon(wbId, options).then(async (result) => {
    // After the streamer finishes, count outputs and record the phase run
    try {
      const status = await getPhaseStatus(wbId);
      await _writePhaseRun(wbId, realPhaseId, {
        durationMs: Date.now() - phaseStartTime,
        totalLines: status[realPhaseId]?.totalLines || 0,
      });
    } catch {}
  }).catch(async (err) => {
    await _push(wbId, { icon: '⚠', headline: `Phase ${realDef.label} failed: ${err.message}` });
  });

  return { started: true, phase: phaseId, realPhase: realPhaseId, options };
}

module.exports = {
  PHASES,
  getPhaseStatus,
  runPhase,
};
