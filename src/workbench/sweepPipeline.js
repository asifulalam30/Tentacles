/**
 * SWEEP PIPELINE
 *
 * Runs the full set of auto-runnable tools as one staged pipeline.
 * Independent from baseline recon — you launch this separately.
 *
 * Design principles:
 *   1. Crash-safe: every tool error is caught; sweep continues on failure.
 *   2. Resumable: state persists to disk; on Node restart, sweep can resume.
 *   3. Memory-bounded: each runner has a hard timeout cap.
 *   4. Block-friendly: rates are throttled by default, WAF-aware where possible.
 *   5. Single sweep per workbench — concurrent starts are rejected.
 *   6. The final lead regen runs once at the end, not per-tool.
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const sessionStore = require('./sessionStore');
const tools = require('./tools');
const chatEngine = require('./chatEngine');
const stealthProfile = require('./stealthProfile');
const hostHealth = require('./hostHealth');

// Tools whose runs should be skipped entirely on hot hosts (they're noisy
// or send signature-detectable payloads).
const NOISY_TOOLS = new Set(['ffuf', 'nuclei', 'arjun', 'reflection']);

// Build a temporary input file for a stage that contains only healthy hosts.
// Returns the relative filename (within reconDir) the runner should use.
async function _filterHostsForStage(wbId, reconDir, baseFilename, toolId) {
  if (!NOISY_TOOLS.has(toolId)) return baseFilename;
  const fullPath = path.join(reconDir, baseFilename);
  if (!await fs.pathExists(fullPath)) return baseFilename;
  const lines = (await fs.readFile(fullPath, 'utf8')).split('\n').filter(Boolean);
  if (lines.length === 0) return baseFilename;

  const healthy = await hostHealth.filterToHealthyHosts(wbId, lines);
  if (healthy.length === lines.length) {
    // No filtering needed
    return baseFilename;
  }
  if (healthy.length === 0) {
    // All hosts hot — caller should skip this stage
    return null;
  }

  // Write a filtered version
  const filteredName = `_${toolId}_healthy_${baseFilename}`;
  await fs.writeFile(path.join(reconDir, filteredName), healthy.join('\n') + '\n');
  return filteredName;
}

// ──────────────────────────────────────────────────────────────────────────
// Stage definitions — the dependency DAG is encoded as ordered stages
// ──────────────────────────────────────────────────────────────────────────
//
// Each entry: { id, label, tool (registry id), needs (recon files that must
//   exist + be non-empty), options: function(level, paths) → tool options,
//   timeoutMs, optional (whether to skip silently if requirements unmet) }
//
// Stages run sequentially. Tools within a stage MAY run in parallel (currently
// we keep them serial for predictability + to avoid blasting the target).
//
// Levels: polite | standard | heavy

const SWEEP_STAGES = [
  // ── STAGE 1: Fast surface tools that read alive_hosts/dangling/etc ─────
  // These don't depend on each other and can run as soon as baseline recon
  // is done. We run them serially to keep request rates polite.
  {
    id: 'wafw00f',
    label: 'WAF Detection',
    tool: 'wafw00f',
    needs: ['alive_hosts.txt'],
    options: (level) => ({
      inputFile: 'alive_hosts.txt',
      concurrency: level === 'heavy' ? 8 : level === 'standard' ? 5 : 3,
    }),
    timeoutMs: 30 * 60 * 1000,  // 30 min cap
  },
  {
    id: 'whatweb',
    label: 'Tech Fingerprinting',
    tool: 'whatweb',
    needs: ['alive_hosts.txt'],
    options: (level) => ({
      inputFile: 'alive_hosts.txt',
      // Aggression 4 is "loud" and gets you flagged. Even on heavy, cap at 3.
      aggression: '3',
      concurrency: level === 'heavy' ? 8 : level === 'standard' ? 5 : 3,
    }),
    timeoutMs: 60 * 60 * 1000,  // 60 min cap
  },
  {
    id: 'gowitness',
    label: 'Screenshots',
    tool: 'gowitness',
    needs: ['alive_hosts.txt'],
    options: (level) => ({
      inputFile: 'alive_hosts.txt',
      threads: level === 'heavy' ? 6 : 4,
      timeout: 15,
      fullPage: level === 'heavy',
    }),
    timeoutMs: 60 * 60 * 1000,
  },
  {
    id: 'testssl',
    label: 'TLS/SSL Audit',
    tool: 'testssl',
    needs: ['alive_hosts.txt'],
    options: (level) => ({
      inputFile: 'alive_hosts.txt',
      // Even on heavy, keep severity floor at LOW so we don't drown in INFO noise
      severity: level === 'heavy' ? 'LOW' : level === 'standard' ? 'MEDIUM' : 'HIGH',
      concurrency: 2,  // testssl is heavy — always cap at 2
      maxRuntimePerHost: level === 'heavy' ? 8 : 5,
    }),
    timeoutMs: 4 * 60 * 60 * 1000,  // 4 hr total cap
  },
  {
    id: 'subzy',
    label: 'Takeover Confirmation',
    tool: 'subzy',
    // Optional: if dangling.txt is empty, we silently skip (no takeovers to verify)
    needs: ['dangling.txt'],
    optional: true,
    options: () => ({
      inputFile: 'dangling.txt',
      concurrency: 10,
      verifySsl: false,
    }),
    timeoutMs: 30 * 60 * 1000,
  },
  {
    id: 's3scanner',
    label: 'Cloud Bucket Scan',
    tool: 's3scanner',
    needs: [],  // no input file — derives from workbench target
    options: (level, ctx) => ({
      // Use registered org name when available, else fall back to target
      orgName: '',  // empty means "use target name"
      permutations: level === 'heavy' ? 'large' : level === 'standard' ? 'medium' : 'small',
      providers: ['aws', 'gcp'],
    }),
    timeoutMs: 60 * 60 * 1000,
  },

  // ── STAGE 2: Site Mirror — must run before tools that benefit from it ──
  // Site Mirror enriches the recon corpus with forms.txt, html_comments.txt,
  // and adds discovered URLs/params. JS analysis and lead-gen benefit from
  // the enriched data, so they run AFTER mirror.
  {
    id: 'mirror',
    label: 'Site Mirror',
    tool: 'mirror',
    needs: ['direct_hosts.txt'],  // prefer direct (no CDN waste)
    fallbackInput: 'alive_hosts.txt',
    options: (level) => ({
      inputFile: 'direct_hosts.txt',  // overwritten by gating logic if direct empty
      depth: level === 'heavy' ? 3 : 2,
      maxPagesPerHost: level === 'heavy' ? 500 : level === 'standard' ? 200 : 100,
      includeAssets: true,
      rateLimit: 5,
      triggerLeadRegen: false,  // sweep does its own final regen
    }),
    timeoutMs: 4 * 60 * 60 * 1000,  // mirror can be huge
  },

  // ── STAGE 3: Tools that benefit from the enriched corpus ──────────────
  // These read all_urls.txt / params.txt / js_files.txt — all of which were
  // potentially enriched by Site Mirror.
  {
    id: 'js_analyzer',
    label: 'JS & Secrets Analysis',
    tool: 'js_analyzer',
    needs: ['all_urls.txt'],
    options: (level) => ({
      inputFile: 'all_urls.txt',
      maxFiles: level === 'heavy' ? 200 : level === 'standard' ? 100 : 50,
      fetchTimeout: 8,  // seconds per JS file fetch — runner expects this
      mergeIntoUrls: true,
      useTrufflehog: true,
      useXnLinkFinder: true,
    }),
    timeoutMs: 90 * 60 * 1000,
  },
  {
    id: 'arjun',
    label: 'Parameter Discovery (Arjun)',
    tool: 'arjun',
    needs: ['alive_hosts.txt'],
    options: (level) => ({
      inputFile: 'alive_hosts.txt',
      method: 'GET',
      concurrency: 5,
      threadsPerHost: level === 'heavy' ? 5 : 3,
      timeoutPerHost: 120,  // seconds per host — runner expects this
      stable: false,
    }),
    timeoutMs: 90 * 60 * 1000,
  },

  // ── STAGE 4: The heavies. These get serialized — even on heavy mode ───
  // we don't run FFUF + Nuclei + Reflection in parallel because that triples
  // the request rate from the target's perspective.
  {
    id: 'ffuf',
    label: 'Directory Fuzzing (FFUF)',
    tool: 'ffuf',
    needs: ['alive_hosts.txt'],
    options: (level) => ({
      inputFile: 'alive_hosts.txt',
      wordlist: level === 'heavy' ? 'raft-large' : level === 'standard' ? 'raft-medium' : 'common',
      rate: 5,  // CDN hosts auto-drop to 2 in the runner
      extensions: '',
      matchCodes: '200,201,301,302,307,401,403',
      filterSize: '',
      maxRuntime: level === 'heavy' ? 60 : level === 'standard' ? 30 : 15,  // minutes
    }),
    timeoutMs: 2 * 60 * 60 * 1000,
  },
  {
    id: 'nuclei',
    label: 'Vulnerability Scan (Nuclei)',
    tool: 'nuclei',
    needs: ['alive_hosts.txt'],
    options: (level) => ({
      inputFile: 'alive_hosts.txt',
      templateSet: level === 'heavy' ? 'full' : level === 'standard' ? 'default' : 'critical_high',
      customTemplatePath: '',
      severityFilter: level === 'heavy' ? '' : 'critical,high,medium',
      rateLimit: 30,
      maxRuntime: level === 'heavy' ? 90 : level === 'standard' ? 45 : 20,
    }),
    timeoutMs: 3 * 60 * 60 * 1000,
  },
  {
    id: 'reflection',
    label: 'Reflection Scan (SPINEL)',
    tool: 'reflection',
    needs: ['alive_hosts.txt'],
    options: (level) => ({
      inputFile: 'alive_hosts.txt',
      // All 5 SPINEL insertion surfaces. SPINEL discovers params per-target
      // internally — no need for a params file.
      points: ['query', 'headers', 'cookies', 'form', 'json'],
      maxWorkers: 3,
      maxPerHost: 2,
      delayMin: 0.8,
      delayMax: 2,
      maxRuntime: level === 'heavy' ? 90 : level === 'standard' ? 45 : 20,
      proxy: '',
    }),
    timeoutMs: 2 * 60 * 60 * 1000,
  },

  // ── STAGE 5: GitHub Recon — only if PAT was provided ──────────────────
  {
    id: 'github_recon',
    label: 'GitHub Recon',
    tool: 'github_recon',
    needs: [],
    requiresPat: true,
    options: (level, ctx) => ({
      orgOrUser: '',  // empty = derive from target
      githubToken: ctx.githubPat || '',
      maxRepos: level === 'heavy' ? 100 : level === 'standard' ? 50 : 25,
      onlyVerified: true,
    }),
    timeoutMs: 90 * 60 * 1000,
  },
];

// ──────────────────────────────────────────────────────────────────────────
// State management — sweep state lives at workbenchDir/sweep_state.json
// ──────────────────────────────────────────────────────────────────────────

function _statePath(wbId) {
  return path.join(sessionStore.workbenchDir(wbId), 'sweep_state.json');
}

async function _readState(wbId) {
  try {
    return await fs.readJson(_statePath(wbId));
  } catch {
    return null;
  }
}

async function _writeState(wbId, state) {
  await fs.writeJson(_statePath(wbId), state, { spaces: 2 });
}

// In-memory map of active sweep loops. We keep this so cancel/skip can signal
// the running loop. Survives Node restart? No — but the on-disk state does,
// and `getStatus()` will return the last-known state from disk.
const _activeSweeps = new Map();  // wbId → { abortFlag: bool, skipFlag: bool }

// ──────────────────────────────────────────────────────────────────────────
// Pre-flight checks — run before the sweep starts
// ──────────────────────────────────────────────────────────────────────────

async function _preflight(wbId, target, level, githubPat) {
  const issues = [];
  const sanitizedTarget = (target || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const reconDir = path.join(sessionStore.workbenchDir(wbId), 'recon', sanitizedTarget);

  if (!await fs.pathExists(reconDir)) {
    issues.push(`Recon directory not found at ${reconDir}. Run baseline recon first.`);
    return { ok: false, issues };
  }

  // Check for any meaningful recon data
  const aliveFile = path.join(reconDir, 'alive_hosts.txt');
  if (!await fs.pathExists(aliveFile)) {
    issues.push('alive_hosts.txt not found — baseline recon must complete first.');
  } else {
    const lines = (await fs.readFile(aliveFile, 'utf8')).split('\n').filter(Boolean);
    if (lines.length === 0) {
      issues.push('alive_hosts.txt is empty — no hosts to test.');
    }
  }

  return { ok: issues.length === 0, issues, reconDir };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-stage gate — checks whether a stage's needs are satisfied
// ──────────────────────────────────────────────────────────────────────────

async function _stageGate(stage, reconDir, ctx) {
  // PAT-required stages
  if (stage.requiresPat && !ctx.githubPat) {
    return { ok: false, reason: 'no GitHub PAT provided', skipReason: 'pat_missing' };
  }

  // No input-file requirement (e.g. s3scanner)
  if (!stage.needs || stage.needs.length === 0) return { ok: true };

  for (const need of stage.needs) {
    const fp = path.join(reconDir, need);
    if (!await fs.pathExists(fp)) {
      // Try fallback input if specified
      if (stage.fallbackInput) {
        const fb = path.join(reconDir, stage.fallbackInput);
        if (await fs.pathExists(fb)) {
          const lines = (await fs.readFile(fb, 'utf8')).split('\n').filter(Boolean);
          if (lines.length > 0) {
            return { ok: true, useFallback: stage.fallbackInput };
          }
        }
      }
      return {
        ok: false,
        reason: `required file missing: ${need}`,
        skipReason: 'missing_input',
      };
    }
    const lines = (await fs.readFile(fp, 'utf8')).split('\n').filter(Boolean);
    if (lines.length === 0) {
      if (stage.fallbackInput) {
        const fb = path.join(reconDir, stage.fallbackInput);
        if (await fs.pathExists(fb)) {
          const fbLines = (await fs.readFile(fb, 'utf8')).split('\n').filter(Boolean);
          if (fbLines.length > 0) {
            return { ok: true, useFallback: stage.fallbackInput };
          }
        }
      }
      return {
        ok: false,
        reason: `${need} is empty`,
        skipReason: 'empty_input',
      };
    }
  }
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────
// Main loop — runs every stage in order, catching all errors
// ──────────────────────────────────────────────────────────────────────────

async function _runSweepLoop(wbId, level, ctx) {
  const wb = await sessionStore.getWorkbench(wbId);
  if (!wb) {
    return { ok: false, error: 'Workbench not found' };
  }
  const sanitizedTarget = (wb.target || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const reconDir = path.join(sessionStore.workbenchDir(wbId), 'recon', sanitizedTarget);

  for (let i = 0; i < SWEEP_STAGES.length; i++) {
    const stage = SWEEP_STAGES[i];

    // Check abort signal
    const ctrl = _activeSweeps.get(wbId);
    if (ctrl && ctrl.abortFlag) {
      await chatEngine.pushReconFinding(wbId, {
        icon: '⛔',
        headline: 'Sweep cancelled by user',
        detail: `Stopped before stage ${i + 1}/${SWEEP_STAGES.length} (${stage.label})`,
      });
      const state = await _readState(wbId) || { stages: [] };
      state.status = 'cancelled';
      state.cancelledAt = new Date().toISOString();
      await _writeState(wbId, state);
      _activeSweeps.delete(wbId);
      return { ok: false, cancelled: true };
    }

    // Gate: are this stage's prerequisites satisfied?
    const gate = await _stageGate(stage, reconDir, ctx);
    if (!gate.ok) {
      const reason = stage.optional || gate.skipReason === 'pat_missing'
        ? `skipped: ${gate.reason}`
        : `skipped: ${gate.reason}`;
      await chatEngine.pushReconFinding(wbId, {
        icon: '⊘',
        headline: `Stage ${i + 1}/${SWEEP_STAGES.length}: ${stage.label} — ${reason}`,
      });
      await _appendStageResult(wbId, {
        stageId: stage.id, label: stage.label, status: 'skipped',
        reason: gate.reason, startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      continue;
    }

    // Build options. If we used a fallback file, override inputFile.
    const opts = stage.options(level, ctx);
    if (gate.useFallback) {
      opts.inputFile = gate.useFallback;
    }

    // Apply stealth profile + speed preset to the options
    const stealthAdjusted = stealthProfile.applyStealthToOptions(stage.tool, opts, {
      stealth: !!ctx.stealth,
      speed: ctx.speed || 'standard',
    });

    // Adaptive backoff: filter the input file to only healthy hosts for noisy tools
    if (stealthAdjusted.inputFile && NOISY_TOOLS.has(stage.tool)) {
      const filtered = await _filterHostsForStage(wbId, reconDir, stealthAdjusted.inputFile, stage.tool);
      if (filtered === null) {
        // All hosts are hot — skip this stage entirely
        await chatEngine.pushReconFinding(wbId, {
          icon: '⊘',
          headline: `Stage ${i + 1}/${SWEEP_STAGES.length}: ${stage.label} — all hosts blocked, skipping`,
        });
        await _appendStageResult(wbId, {
          stageId: stage.id, label: stage.label, status: 'skipped',
          reason: 'all hosts marked hot by adaptive backoff',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });
        continue;
      }
      stealthAdjusted.inputFile = filtered;
    }

    // Mark stage as starting
    const startedAt = new Date().toISOString();
    await _appendStageResult(wbId, {
      stageId: stage.id, label: stage.label, status: 'running',
      startedAt,
    });
    await chatEngine.pushReconFinding(wbId, {
      icon: '▶',
      headline: `Sweep stage ${i + 1}/${SWEEP_STAGES.length}: ${stage.label}`,
      detail: `Tool: ${stage.tool} | level=${level}`,
    });

    // Run the tool with timeout protection
    let result = { status: 'failed', error: 'unknown' };
    try {
      const runner = _runnerFor(stage.tool);
      if (!runner) {
        throw new Error(`No runner registered for tool: ${stage.tool}`);
      }

      // Race the runner against our timeout cap
      result = await _raceWithTimeout(
        runner(wbId, stealthAdjusted),
        stage.timeoutMs,
        `${stage.label} exceeded ${Math.round(stage.timeoutMs / 60000)}min cap`
      );
      result.status = 'completed';
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      result = { status: 'failed', error: errMsg };
      await chatEngine.pushReconFinding(wbId, {
        icon: '⚠',
        headline: `Stage ${i + 1} (${stage.label}) failed`,
        detail: errMsg.slice(0, 400),
      });
    }

    // Check for skip signal — set by /sweep/skip-tool
    if (ctrl && ctrl.skipFlag) {
      ctrl.skipFlag = false;  // consume signal
      await chatEngine.pushReconFinding(wbId, {
        icon: '⏭',
        headline: `Stage ${i + 1} (${stage.label}) skipped to next`,
      });
    }

    // Adaptive backoff: scan the just-completed tool's output for blocking
    // status codes and update host_health.json accordingly.
    if (result.status === 'completed' && result.runId) {
      try {
        await _observeHostHealthFromRun(wbId, stage.tool, result.runId);
      } catch (e) {
        // Non-fatal — health observation failure shouldn't kill the sweep
      }
    }

    await _updateStageResult(wbId, stage.id, {
      status: result.status,
      error: result.error || null,
      completedAt: new Date().toISOString(),
    });
  }

  // Sweep done — rebuild the recon summary so the new tool data is visible
  // in the dashboard tiles, then announce completion.
  try {
    const reconAdapter = require('./reconAdapter');
    const summary = await reconAdapter.buildSummaryFromReconDir(wbId, sanitizedTarget);
    if (summary && !summary.error) {
      await fs.writeJson(
        path.join(sessionStore.workbenchDir(wbId), 'recon_summary.json'),
        summary,
        { spaces: 2 }
      );
    }
  } catch {}

  await chatEngine.pushReconFinding(wbId, {
    icon: '🏁',
    headline: 'Sweep complete',
    detail: 'Open the Recon tab to browse the data per-subdomain or by category.',
  });

  // Mark sweep as completed
  const finalState = await _readState(wbId) || {};
  finalState.status = 'completed';
  finalState.completedAt = new Date().toISOString();
  await _writeState(wbId, finalState);
  _activeSweeps.delete(wbId);

  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function _runnerFor(toolId) {
  const map = {
    ffuf:         tools.runFfuf,
    arjun:        tools.runArjun,
    js_analyzer:  tools.runJsAnalyzer,
    nuclei:       tools.runNuclei,
    reflection:   tools.runReflection,
    gowitness:    tools.runGowitness,
    testssl:      tools.runTestssl,
    wafw00f:      tools.runWafw00f,
    whatweb:      tools.runWhatweb,
    s3scanner:    tools.runS3scanner,
    github_recon: tools.runGithubRecon,
    subzy:        tools.runSubzy,
    mirror:       tools.runMirror,
  };
  return map[toolId];
}

async function _raceWithTimeout(promise, timeoutMs, timeoutMessage) {
  let timer;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutP]);
  } finally {
    clearTimeout(timer);
  }
}

// After a tool completes, scan its output files for blocking status codes
// (429/403/503) and update host_health.json. Best-effort — different tools
// dump output in different formats, so this only handles the high-signal
// ones (FFUF, Nuclei). The others contribute via direct mark-host-hot calls
// from the runners themselves if they detect block patterns.
async function _observeHostHealthFromRun(wbId, toolId, runId) {
  const run = await tools.getToolRun(wbId, runId);
  if (!run || !run.outputDir) return;

  if (toolId === 'nuclei') {
    // nuclei_findings.json is JSONL — one finding per line, each has matched-at URL
    const fp = path.join(run.outputDir, 'nuclei_findings.json');
    if (!await fs.pathExists(fp)) return;
    try {
      const text = await fs.readFile(fp, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          // Look for matchers that indicate blocking responses. Nuclei sometimes
          // tags these explicitly as "waf-detect" templates, sometimes not.
          // Best signal: meta.status from the matcher when available.
          const url = j['matched-at'] || j.host;
          const tmpl = j['template-id'] || '';
          if (!url) continue;
          // If the template name suggests WAF detection, treat as a hot signal
          if (/waf|cloudflare|akamai|incapsula|imperva/i.test(tmpl)) {
            await hostHealth.markHostHot(wbId, url, `nuclei detected protection: ${tmpl}`);
          }
        } catch {}
      }
    } catch {}
  }

  if (toolId === 'ffuf') {
    // FFUF per-target JSON files contain status codes for every match.
    // We didn't include 429/403/503 in match codes by default, but FFUF still
    // logs them as filtered. We can't easily see them here. Instead, parse
    // the per-target output for an unusual ratio of one status code → blocked.
    try {
      const entries = await fs.readdir(run.outputDir);
      for (const entry of entries) {
        if (!entry.startsWith('_per_target_') || !entry.endsWith('.json')) continue;
        try {
          const data = await fs.readJson(path.join(run.outputDir, entry));
          const results = data.results || [];
          if (results.length === 0) continue;
          // If a high ratio of results have status 403, treat the host as hot
          const counts = {};
          let host = null;
          for (const r of results) {
            counts[r.status] = (counts[r.status] || 0) + 1;
            if (!host && r.url) {
              try { host = new URL(r.url).host; } catch {}
            }
          }
          if (!host) continue;
          // If >80% of results are 403, that's a WAF blanket block, not real findings
          const total = results.length;
          if (counts[403] && counts[403] / total > 0.8 && total > 10) {
            await hostHealth.markHostHot(wbId, host, `ffuf saw ${counts[403]}/${total} 403s — WAF blanket block`);
          }
        } catch {}
      }
    } catch {}
  }
}

async function _appendStageResult(wbId, entry) {
  const state = (await _readState(wbId)) || {
    status: 'running', stages: [], startedAt: new Date().toISOString(),
  };
  // If a stage with same id already exists in the running state, replace it
  const idx = state.stages.findIndex(s => s.stageId === entry.stageId);
  if (idx >= 0) {
    state.stages[idx] = { ...state.stages[idx], ...entry };
  } else {
    state.stages.push(entry);
  }
  await _writeState(wbId, state);
}

async function _updateStageResult(wbId, stageId, patch) {
  const state = await _readState(wbId);
  if (!state) return;
  const stage = state.stages.find(s => s.stageId === stageId);
  if (stage) Object.assign(stage, patch);
  await _writeState(wbId, state);
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

async function startSweep(wbId, opts = {}) {
  const level = ['polite', 'standard', 'heavy'].includes(opts.level) ? opts.level : 'heavy';
  const speed = ['standard', 'slow', 'glacial'].includes(opts.speed) ? opts.speed : 'standard';
  const stealth = !!opts.stealth;
  const githubPat = (opts.githubPat || '').trim();

  // Reject if a sweep is already in flight
  if (_activeSweeps.has(wbId)) {
    return { ok: false, error: 'A sweep is already running for this workbench. Cancel it first.' };
  }

  // Also reject if the on-disk state says running (in case of restart)
  const existingState = await _readState(wbId);
  if (existingState && existingState.status === 'running') {
    // Stale: marked running but no in-memory entry. Mark as crashed.
    existingState.status = 'crashed';
    existingState.crashedAt = new Date().toISOString();
    await _writeState(wbId, existingState);
  }

  // Pre-flight
  const wb = await sessionStore.getWorkbench(wbId);
  if (!wb) return { ok: false, error: 'Workbench not found' };

  const pre = await _preflight(wbId, wb.target, level, githubPat);
  if (!pre.ok) {
    return { ok: false, error: 'Pre-flight failed', issues: pre.issues };
  }

  // Reset host health for the new sweep — old hot flags shouldn't carry over
  await hostHealth.resetHealth(wbId);

  // Initialize state
  const state = {
    status: 'running',
    level,
    speed,
    stealth,
    target: wb.target,
    startedAt: new Date().toISOString(),
    stages: [],
    githubPatProvided: !!githubPat,  // never store the actual PAT
  };
  await _writeState(wbId, state);

  // Register active sweep BEFORE kicking off (so concurrent starts get blocked)
  const ctrl = { abortFlag: false, skipFlag: false };
  _activeSweeps.set(wbId, ctrl);

  const stealthDesc = stealth ? ' [stealth]' : '';
  const speedDesc = speed !== 'standard' ? ` [${speed}]` : '';
  await chatEngine.pushReconFinding(wbId, {
    icon: '🚀',
    headline: `Full Tool Sweep started — ${SWEEP_STAGES.length} stages, level=${level}${stealthDesc}${speedDesc}`,
    detail: 'This will take a while. You can keep using Tentacles — sweep runs in the background.',
  });

  // Fire and forget — the loop manages its own state file
  const ctx = { githubPat, stealth, speed };
  _runSweepLoop(wbId, level, ctx).catch(err => {
    // Catch-all so a bug in the loop doesn't crash Node
    chatEngine.pushReconFinding(wbId, {
      icon: '⚠',
      headline: 'Sweep loop crashed',
      detail: (err && err.message) || String(err),
    }).catch(() => {});
    _activeSweeps.delete(wbId);
    _readState(wbId).then(s => {
      if (s) {
        s.status = 'crashed';
        s.error = (err && err.message) || String(err);
        s.crashedAt = new Date().toISOString();
        return _writeState(wbId, s);
      }
    }).catch(() => {});
  });

  return { ok: true, status: 'started', stages: SWEEP_STAGES.length, level, speed, stealth };
}

async function getStatus(wbId) {
  const state = await _readState(wbId);
  if (!state) return { status: 'never_run' };
  // Decorate with whether it's actively running in this process
  return {
    ...state,
    activeInProcess: _activeSweeps.has(wbId),
    totalStages: SWEEP_STAGES.length,
  };
}

async function cancelSweep(wbId) {
  const ctrl = _activeSweeps.get(wbId);
  if (!ctrl) {
    return { ok: false, error: 'No active sweep for this workbench' };
  }
  ctrl.abortFlag = true;
  // Also stop the currently running tool, if any
  try {
    const active = tools.getActiveRun(wbId);
    if (active && active.runId) {
      await tools.stopRun(wbId, active.runId);
    }
  } catch {}
  return { ok: true };
}

async function skipCurrentTool(wbId) {
  const ctrl = _activeSweeps.get(wbId);
  if (!ctrl) {
    return { ok: false, error: 'No active sweep for this workbench' };
  }
  ctrl.skipFlag = true;
  // Stop the currently running tool — the loop catches the error and advances
  try {
    const active = tools.getActiveRun(wbId);
    if (active && active.runId) {
      await tools.stopRun(wbId, active.runId);
    }
  } catch {}
  return { ok: true };
}

function isSweepRunning(wbId) {
  return _activeSweeps.has(wbId);
}

module.exports = {
  startSweep,
  getStatus,
  cancelSweep,
  skipCurrentTool,
  isSweepRunning,
  SWEEP_STAGES,
};
