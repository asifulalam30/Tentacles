/**
 * WORKBENCH REST ROUTES (v2 — chat-first)
 *
 * Mounted under /api/workbenches
 */

'use strict';

const express = require('express');
const router = express.Router();
const sessionStore = require('./sessionStore');
const reconStreamer = require('./reconStreamer');
const reconAdapter = require('./reconAdapter');

// ── List + create + get + delete ─────────────────────────────────────────

router.get('/', async (req, res) => {
  const includeArchived = ['1', 'true', 'yes'].includes(String(req.query.includeArchived || '').toLowerCase());
  const items = await sessionStore.listWorkbenches({ includeArchived });
  res.json({ workbenches: items });
});

// Archive a workbench — hides it from the default list. Reversible (data stays on disk).
router.post('/:wbId/archive', async (req, res) => {
  const wb = await sessionStore.getWorkbench(req.params.wbId);
  if (!wb) return res.status(404).json({ error: 'Not found' });
  const updated = await sessionStore.updateWorkbench(req.params.wbId, { archived: true });
  res.json({ workbench: updated });
});

router.post('/:wbId/unarchive', async (req, res) => {
  const wb = await sessionStore.getWorkbench(req.params.wbId);
  if (!wb) return res.status(404).json({ error: 'Not found' });
  const updated = await sessionStore.updateWorkbench(req.params.wbId, { archived: false });
  res.json({ workbench: updated });
});

router.post('/', async (req, res) => {
  try {
    const { target, program, reconOptions, skipRecon, skipAutoSweep } = req.body || {};
    if (!target || typeof target !== 'string') {
      return res.status(400).json({ error: 'target is required' });
    }
    const wb = await sessionStore.createWorkbench({
      target: target.trim(),
      program,
      autoSweep: !skipAutoSweep,  // default ON
    });
    // Auto-trigger streaming recon unless skipRecon=true
    if (!skipRecon) {
      reconStreamer.runStreamingRecon(wb.wbId, reconOptions || {}).catch(() => {});
    }
    res.status(201).json({ workbench: wb });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:wbId', async (req, res) => {
  const wb = await sessionStore.getWorkbench(req.params.wbId);
  if (!wb) return res.status(404).json({ error: 'Not found' });
  const reconRunning = reconStreamer.isReconRunning(req.params.wbId)
                    || reconAdapter.isReconRunning(req.params.wbId);
  res.json({ workbench: wb, reconRunning });
});

router.delete('/:wbId', async (req, res) => {
  await sessionStore.deleteWorkbench(req.params.wbId);
  res.json({ deleted: true });
});

// ── Recon trigger ────────────────────────────────────────────────────────

router.post('/:wbId/recon', async (req, res) => {
  const wb = await sessionStore.getWorkbench(req.params.wbId);
  if (!wb) return res.status(404).json({ error: 'Not found' });
  if (reconStreamer.isReconRunning(req.params.wbId)) {
    return res.json({ alreadyRunning: true });
  }
  const reconOptions = req.body?.reconOptions || {};
  reconStreamer.runStreamingRecon(req.params.wbId, reconOptions).catch(() => {});
  res.json({ started: true, options: reconOptions });
});

router.get('/:wbId/recon', async (req, res) => {
  const streaming = reconStreamer.reconStatus(req.params.wbId);
  const briefing = reconAdapter.reconStatus(req.params.wbId);
  res.json({
    running: !!streaming || !!briefing,
    phase: streaming?.currentPhase || briefing?.phase || null,
  });
});

// ── Brief + hypotheses + artifacts ───────────────────────────────────────

router.get('/:wbId/brief', async (req, res) => {
  const md = await sessionStore.readBrief(req.params.wbId);
  res.type('text/markdown').send(md);
});

router.get('/:wbId/hypotheses', async (req, res) => {
  const data = await sessionStore.getHypotheses(req.params.wbId);
  res.json(data);
});

router.patch('/:wbId/hypotheses/:idx', async (req, res) => {
  const idx = parseInt(req.params.idx, 10);
  const { status } = req.body || {};
  if (!['open', 'testing', 'confirmed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  const data = await sessionStore.getHypotheses(req.params.wbId);
  if (!data.items[idx]) return res.status(404).json({ error: 'hypothesis not found' });
  data.items[idx].status = status;
  await sessionStore.setHypotheses(req.params.wbId, data.items);
  res.json({ items: data.items });
});

router.get('/:wbId/artifacts', async (req, res) => {
  const items = await sessionStore.listArtifacts(req.params.wbId);
  res.json({ artifacts: items });
});

router.get('/:wbId/artifacts/:artifactId', async (req, res) => {
  const a = await sessionStore.getArtifact(req.params.wbId, req.params.artifactId);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json({ artifact: a });
});

router.get('/:wbId/messages', async (req, res) => {
  const max = Math.min(parseInt(req.query.max || '500', 10), 2000);
  const messages = await sessionStore.readChatMessages(req.params.wbId, max);
  res.json({ messages });
});


// ── Recon deepen — focused second-pass recon ─────────────────────────────

router.post('/:wbId/recon/deepen', async (req, res) => {
  const { mode } = req.body || {};
  if (!mode) return res.status(400).json({ error: 'mode required' });
  try {
    const reconDeepen = require('./reconDeepen');
    if (!reconDeepen.DEEPEN_MODES[mode]) {
      return res.status(400).json({ error: `unknown mode: ${mode}`, valid: Object.keys(reconDeepen.DEEPEN_MODES) });
    }
    if (reconDeepen.isDeepening(req.params.wbId)) {
      return res.json({ alreadyRunning: true, mode: reconDeepen.deepenStatus(req.params.wbId).mode });
    }
    // Fire and forget — runs in background, pushes findings to chat
    reconDeepen.deepenRecon(req.params.wbId, mode).catch(() => {});
    res.json({ started: true, mode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:wbId/recon/deepen', async (req, res) => {
  const reconDeepen = require('./reconDeepen');
  res.json({
    running: reconDeepen.isDeepening(req.params.wbId),
    status: reconDeepen.deepenStatus(req.params.wbId),
    modes: reconDeepen.DEEPEN_MODES,
  });
});

// ── Stop running recon ───────────────────────────────────────────────────

router.post('/:wbId/recon/stop', async (req, res) => {
  try {
    const reconStreamer = require('./reconStreamer');
    const ok = reconStreamer.killRecon(req.params.wbId);
    res.json({ stopped: ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Recon phases (per-phase running) ────────────────────────────────────

const reconPhase = require('./reconPhase');

// GET status for all phases (used to render the per-phase control panel)
router.get('/:wbId/recon/phases', async (req, res) => {
  try {
    const status = await reconPhase.getPhaseStatus(req.params.wbId);
    res.json({ phases: status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST: run a specific phase
router.post('/:wbId/recon/phase/:phaseId', async (req, res) => {
  try {
    const result = await reconPhase.runPhase(req.params.wbId, req.params.phaseId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Tools (ffuf / arjun / js_analyzer / nuclei / reflection) ─────────────

const tools = require('./tools');
const toolsRegistry = require('./toolsRegistry');

// List all available tools (used by frontend to render the launcher)
router.get('/tools/registry', (req, res) => {
  res.json({ tools: toolsRegistry.list() });
});

// Run a tool — fire and forget, returns runId immediately
router.post('/:wbId/tools/:toolId', async (req, res) => {
  const { wbId, toolId } = req.params;
  const validation = toolsRegistry.validate(toolId, req.body || {});
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  // Pick the right runner
  const runners = {
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
  const runner = runners[toolId];
  if (!runner) return res.status(400).json({ error: `No runner for tool: ${toolId}` });

  // Pre-flight check synchronously so the user gets immediate feedback
  if (tools.isToolRunning(wbId)) {
    const active = tools.getActiveRun(wbId);
    return res.status(409).json({
      error: `Another tool is already running: ${active.toolId} (run ${active.runId})`,
      active,
    });
  }

  // Fire and forget — the runner pushes status to chat.
  // We need to return the runId so the UI modal can track this specific run.
  // The runner allocates the runId synchronously inside _gateAndPrepare.
  let kickoffError = null;
  const runnerPromise = runner(wbId, validation.normalized).catch(err => {
    // Capture the synchronous error so we can decide how to respond
    kickoffError = err;
    console.error(`Tool ${toolId} failed:`, err.message);
    require('./chatEngine').pushReconFinding(wbId, {
      icon: '⚠',
      headline: `Tool ${toolId} failed`,
      detail: err.message,
    }).catch(() => {});
  });

  // Wait briefly for the runner to either fail in pre-flight (sync errors) or
  // allocate a runId (which appears in tools.getActiveRun(wbId)).
  let attempts = 0;
  let activeRun = null;
  while (attempts < 30 && !activeRun && !kickoffError) {
    await new Promise(r => setTimeout(r, 50));
    activeRun = tools.getActiveRun(wbId);
    attempts++;
  }

  if (kickoffError) {
    return res.status(400).json({ error: kickoffError.message });
  }
  if (!activeRun) {
    // Runner finished within the 1.5s wait — look at the most recent run
    const allRuns = await tools.getToolRuns(wbId);
    const lastRun = allRuns[0];
    if (lastRun && lastRun.toolId === toolId) {
      return res.json({ started: true, toolId, runId: lastRun.runId });
    }
    return res.json({ started: true, toolId, runId: null });
  }

  res.json({ started: true, toolId, runId: activeRun.runId });
});

// Get tool run history for a workbench
router.get('/:wbId/tools/runs', async (req, res) => {
  try {
    const runs = await tools.getToolRuns(req.params.wbId);
    const active = tools.getActiveRun(req.params.wbId);
    res.json({ runs, active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a specific run's metadata
router.get('/:wbId/tools/runs/:runId', async (req, res) => {
  try {
    const run = await tools.getToolRun(req.params.wbId, req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const output = await tools.getToolRunOutput(req.params.wbId, req.params.runId);
    res.json({ run, output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a specific output file from a run.
// Uses wildcard (*) so nested paths like "screenshots/host1.png" are captured.
router.get('/:wbId/tools/runs/:runId/output/*', async (req, res) => {
  try {
    // Express 4 captures wildcard path in req.params[0]
    const filename = req.params[0] || '';
    if (!filename) return res.status(400).json({ error: 'No filename provided' });

    const result = await tools.readRunFile(req.params.wbId, req.params.runId, filename);
    if (result === null) return res.status(404).json({ error: 'File not found' });

    // Error-shape responses from readRunFile (binary, directory, too_large)
    if (typeof result === 'object' && result.error) {
      return res.status(415).json({ filename, ...result });
    }

    // Normal text content
    res.json({ filename, content: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Raw download of a file (binary or text). For images and large files.
router.get('/:wbId/tools/runs/:runId/download/*', async (req, res) => {
  try {
    const filename = req.params[0] || '';
    if (!filename) return res.status(400).json({ error: 'No filename provided' });
    if (filename.includes('..') || filename.startsWith('/')) return res.status(400).json({ error: 'Invalid path' });

    const run = await tools.getToolRun(req.params.wbId, req.params.runId);
    if (!run || !run.outputDir) return res.status(404).json({ error: 'Run not found' });

    const path = require('path');
    const fs = require('fs-extra');
    const fp = path.join(run.outputDir, filename);
    const real = path.resolve(fp);
    const dirReal = path.resolve(run.outputDir);
    if (!real.startsWith(dirReal + path.sep) && real !== dirReal) {
      return res.status(400).json({ error: 'Path outside run directory' });
    }
    if (!await fs.pathExists(real)) return res.status(404).json({ error: 'File not found' });
    const stat = await fs.stat(real);
    if (stat.isDirectory()) return res.status(415).json({ error: 'Is a directory' });

    const baseName = path.basename(filename);
    res.setHeader('Content-Disposition', `inline; filename="${baseName}"`);
    res.sendFile(real);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stop a running tool
router.post('/:wbId/tools/runs/:runId/stop', async (req, res) => {
  const result = await tools.stopRun(req.params.wbId, req.params.runId);
  res.json(result);
});

// ── Recon ad-hoc actions (per-target tools) ──────────────────────────────
// Each runs one tool against one target, streams to chat, merges into recon files.

const reconActions = require('./reconActions');

router.post('/:wbId/recon/action/:action', async (req, res) => {
  const { action } = req.params;
  const { target, host, ip } = req.body || {};
  const wbId = req.params.wbId;

  try {
    let result;
    switch (action) {
      case 'ffuf':
        if (!host) return res.status(400).json({ error: 'host required' });
        // Fire and forget — UX is via chat stream
        reconActions.ffufOne(wbId, host).catch(e => console.error('ffufOne error:', e.message));
        return res.json({ started: true, action, host });
      case 'portscan':
        if (!ip) return res.status(400).json({ error: 'ip required' });
        reconActions.portScanOne(wbId, ip).catch(e => console.error('portScanOne error:', e.message));
        return res.json({ started: true, action, ip });
      case 'subdomain_refresh':
        reconActions.subdomainRefresh(wbId).catch(e => console.error('subdomainRefresh error:', e.message));
        return res.json({ started: true, action });
      case 'probe':
        if (!host) return res.status(400).json({ error: 'host required' });
        reconActions.probeOne(wbId, host).catch(e => console.error('probeOne error:', e.message));
        return res.json({ started: true, action, host });
      default:
        return res.status(400).json({ error: `unknown action: ${action}` });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Recon summary (counts for stat cards) ────────────────────────────────

router.get('/:wbId/recon-summary', async (req, res) => {
  const path = require('path');
  const fs = require('fs-extra');
  const wb = await sessionStore.getWorkbench(req.params.wbId);
  if (!wb) return res.status(404).json({ error: 'Not found' });

  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const safe = target.replace(/[^A-Za-z0-9._-]/g, '_');
  const reconDir = path.join(sessionStore.workbenchDir(req.params.wbId), 'recon', safe);

  // Count lines from the actual recon files on every call so stat cards update
  // in real time as retrox-recon.sh writes them. This avoids the "stat cards
  // stay at 0 until recon fully completes" problem with the cached summary.
  const _countLines = async (filename) => {
    const fp = path.join(reconDir, filename);
    if (!await fs.pathExists(fp)) return 0;
    try {
      const c = await fs.readFile(fp, 'utf8');
      return c.split('\n').filter(Boolean).length;
    } catch { return 0; }
  };

  if (!await fs.pathExists(reconDir)) {
    return res.json({ target: wb.target, counts: {}, hasData: false, reconRunning: require('./reconStreamer').isReconRunning(req.params.wbId) });
  }

  const [
    subdomains, resolved, ips, cnames, dangling,
    aliveHosts, cloudflareHosts, directHosts,
    allUrls, params, apiEndpoints, openPorts, ffufFindings,
    jsFiles, jsEndpoints, jsSecrets,
    graphqlEndpoints, gitExposed, envExposed, backupFiles, securityTxt,
  ] = await Promise.all([
    _countLines('all_subs.txt'), _countLines('resolved.txt'), _countLines('ips.txt'),
    _countLines('cnames.txt'), _countLines('dangling.txt'),
    _countLines('alive_hosts.txt'), _countLines('cloudflare_hosts.txt'), _countLines('direct_hosts.txt'),
    _countLines('all_urls.txt'), _countLines('params.txt'), _countLines('api_endpoints.txt'),
    _countLines('open_ports.txt'), _countLines('ffuf_findings.txt'),
    _countLines('js_files.txt'), _countLines('js_endpoints.txt'), _countLines('js_secrets.txt'),
    _countLines('graphql_endpoints.txt'), _countLines('git_exposed.txt'),
    _countLines('env_exposed.txt'), _countLines('backup_files.txt'), _countLines('security_txt.txt'),
  ]);

  const counts = {
    subdomains, resolved, ips, cnames, dangling,
    aliveHosts, cloudflareHosts, directHosts,
    allUrls, params, apiEndpoints, openPorts, ffufFindings,
    jsFiles, jsEndpoints, jsSecrets,
    graphqlEndpoints, gitExposed, envExposed, backupFiles, securityTxt,
  };

  const total = Object.values(counts).reduce((s, v) => s + v, 0);

  res.json({
    target: wb.target,
    counts,
    hasData: total > 0,
    reconRunning: require('./reconStreamer').isReconRunning(req.params.wbId),
  });
});

// ── Aggregated findings across all tools ─────────────────────────────────

router.get('/:wbId/findings', async (req, res) => {
  const path = require('path');
  const fs = require('fs-extra');
  const wb = await sessionStore.getWorkbench(req.params.wbId);
  if (!wb) return res.status(404).json({ error: 'Not found' });

  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const safe = target.replace(/[^A-Za-z0-9._-]/g, '_');
  const reconDir = path.join(sessionStore.workbenchDir(req.params.wbId), 'recon', safe);
  if (!await fs.pathExists(reconDir)) return res.json({ findings: [], total: 0, bySeverity: {}, byTool: {} });

  // Map: tool source → findings file → parser
  const SOURCES = [
    {
      tool: 'nuclei',
      icon: '◬',
      file: 'nuclei_findings.txt',
      parse: (line) => {
        // [severity]\tname\thost
        const m = line.match(/^\[([^\]]+)\]\s*(.+?)\s+(\S+)$/);
        if (!m) return null;
        return { severity: m[1].toLowerCase(), title: m[2].trim(), target: m[3].trim() };
      },
    },
    {
      tool: 'reflection',
      icon: '✦',
      file: 'reflection_findings.txt',
      parse: (line) => {
        // [sev]\tinj\tparam\ttarget
        const parts = line.split('\t');
        if (parts.length < 4) return null;
        const sev = (parts[0] || '').replace(/[\[\]]/g, '').toLowerCase() || 'info';
        return { severity: sev, title: `Reflected ${parts[1]} param "${parts[2]}"`, target: parts[3] };
      },
    },
    {
      tool: 'ffuf',
      icon: '⊕',
      file: 'ffuf_findings.txt',
      parse: (line) => {
        // status\tlength\turl
        const parts = line.split('\t');
        if (parts.length < 3) return null;
        const status = parts[0];
        const sev = ['200', '301', '302', '307'].includes(status) ? 'info' :
                    ['401', '403'].includes(status) ? 'low' : 'info';
        return { severity: sev, title: `Hit ${status} (${parts[1]}B)`, target: parts[2] };
      },
    },
    {
      tool: 'arjun',
      icon: '⌬',
      file: 'params_detailed.txt',
      parse: (line) => {
        // param\t(arjun)\thost
        const parts = line.split('\t');
        if (parts.length < 3 || !parts[1].includes('arjun')) return null;
        return { severity: 'info', title: `Discovered param: ${parts[0]}`, target: parts[2] };
      },
    },
    {
      tool: 'js_secrets',
      icon: '🚨',
      file: 'js_secrets.txt',
      parse: (line) => {
        // type\tsnippet\tsource
        const parts = line.split('\t');
        if (parts.length < 3) return null;
        return { severity: 'high', title: `Possible secret: ${parts[0]}`, target: parts[2] };
      },
    },
    {
      tool: 'github_recon',
      icon: '◓',
      file: 'github_secrets.txt',
      parse: (line) => {
        // [VERIFIED|unverified]\ttype\trepo\tfile\tcommit
        const parts = line.split('\t');
        if (parts.length < 4) return null;
        const verified = parts[0].includes('VERIFIED');
        return { severity: verified ? 'critical' : 'high', title: `${parts[1]} secret in ${parts[2]}`, target: parts[3] };
      },
    },
    {
      tool: 'testssl',
      icon: '◐',
      file: 'testssl_findings.txt',
      parse: (line) => {
        // [SEV]\tid\thost\tfinding
        const parts = line.split('\t');
        if (parts.length < 3) return null;
        const sev = (parts[0] || '').replace(/[\[\]]/g, '').toLowerCase() || 'info';
        return { severity: sev, title: `${parts[1]}: ${(parts[3] || '').slice(0, 80)}`, target: parts[2] };
      },
    },
    {
      tool: 's3',
      icon: '◭',
      file: 's3_findings.txt',
      parse: (line) => {
        // [access]\tprovider\tbucket\turl
        const parts = line.split('\t');
        if (parts.length < 3) return null;
        const access = (parts[0] || '').replace(/[\[\]]/g, '').toLowerCase();
        const sev = access.includes('open') || access === 'public' ? 'critical' : 'info';
        return { severity: sev, title: `${access} bucket: ${parts[2]}`, target: parts[1] };
      },
    },
    {
      tool: 'takeover',
      icon: '◬',
      file: 'takeover_findings.txt',
      parse: (line) => {
        // [VULNERABLE]\tservice\thost
        const parts = line.split('\t');
        if (parts.length < 3) return null;
        return { severity: 'critical', title: `Takeover: ${parts[1]}`, target: parts[2] };
      },
    },
    {
      tool: 'dangling',
      icon: '▴',
      file: 'dangling.txt',
      parse: (line) => {
        // raw subdomain
        const trimmed = line.trim();
        if (!trimmed) return null;
        return { severity: 'high', title: 'Dangling CNAME (potential takeover)', target: trimmed };
      },
    },
    {
      tool: 'waf',
      icon: '◮',
      file: 'waf_detections.txt',
      parse: (line) => {
        const parts = line.split('\t');
        if (parts.length < 2) return null;
        if (parts[1] === 'none-detected') return null;  // skip non-findings
        return { severity: 'info', title: `WAF: ${parts[1]}`, target: parts[0] };
      },
    },
    {
      tool: 'whatweb',
      icon: '◇',
      file: 'whatweb_findings.txt',
      parse: (line) => {
        const parts = line.split('\t');
        if (parts.length < 2) return null;
        return { severity: 'info', title: `Tech: ${(parts[1] || '').slice(0, 100)}`, target: parts[0] };
      },
    },
  ];

  const findings = [];
  for (const src of SOURCES) {
    const fp = path.join(reconDir, src.file);
    if (!await fs.pathExists(fp)) continue;
    try {
      const c = await fs.readFile(fp, 'utf8');
      for (const line of c.split('\n').filter(Boolean)) {
        const parsed = src.parse(line);
        if (parsed) {
          findings.push({ ...parsed, tool: src.tool, icon: src.icon, raw: line.slice(0, 250) });
        }
      }
    } catch {}
  }

  // Sort: critical → high → medium → low → info
  const sevRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4, unknown: 5 };
  findings.sort((a, b) => {
    const ra = sevRank[a.severity] ?? 5;
    const rb = sevRank[b.severity] ?? 5;
    if (ra !== rb) return ra - rb;
    return (a.title || '').localeCompare(b.title || '');
  });

  // Aggregate counts
  const bySeverity = {};
  const byTool = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byTool[f.tool] = (byTool[f.tool] || 0) + 1;
  }

  res.json({ findings, total: findings.length, bySeverity, byTool });
});

// ── Recon data viewer ────────────────────────────────────────────────────

router.get('/:wbId/recon-files', async (req, res) => {
  const path = require('path');
  const fs = require('fs-extra');
  const wb = await sessionStore.getWorkbench(req.params.wbId);
  if (!wb) return res.status(404).json({ error: 'Not found' });
  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const safe = target.replace(/[^A-Za-z0-9._-]/g, '_');
  const reconDir = path.join(sessionStore.workbenchDir(req.params.wbId), 'recon', safe);
  if (!await fs.pathExists(reconDir)) {
    return res.json({ files: [], dir: reconDir });
  }
  const files = await fs.readdir(reconDir);
  const out = [];
  for (const f of files) {
    try {
      const fp = path.join(reconDir, f);
      const stat = await fs.stat(fp);
      if (!stat.isFile()) continue;
      // Skip JSON dumps and noisy files
      if (f.endsWith('.log') || f === 'httpx_subs.json') continue;
      // Get line count for text files
      let lines = 0;
      if (stat.size < 5_000_000) {
        try {
          const c = await fs.readFile(fp, 'utf8');
          lines = c.split('\n').filter(Boolean).length;
        } catch {}
      }
      out.push({ name: f, size: stat.size, lines, mtime: stat.mtime });
    } catch {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ files: out, dir: reconDir });
});

router.get('/:wbId/recon-files/:filename', async (req, res) => {
  const path = require('path');
  const fs = require('fs-extra');
  const wb = await sessionStore.getWorkbench(req.params.wbId);
  if (!wb) return res.status(404).json({ error: 'Not found' });
  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const safe = target.replace(/[^A-Za-z0-9._-]/g, '_');
  const reconDir = path.join(sessionStore.workbenchDir(req.params.wbId), 'recon', safe);
  // Sanitize filename — only allow simple names
  const fn = (req.params.filename || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!fn) return res.status(400).json({ error: 'invalid filename' });
  const fp = path.join(reconDir, fn);
  if (!await fs.pathExists(fp)) return res.status(404).json({ error: 'file not found' });
  const stat = await fs.stat(fp);
  // Cap at 5MB
  if (stat.size > 5_000_000) {
    return res.status(413).json({ error: 'file too large to view in browser' });
  }
  const content = await fs.readFile(fp, 'utf8');
  res.json({ name: fn, size: stat.size, content });
});

// ── Full Tool Sweep — runs every auto-runnable tool in dependency order ─

router.post('/:wbId/sweep/start', async (req, res) => {
  try {
    const sweepQueue = require('./sweepQueue');
    const { level, githubPat, stealth, speed } = req.body || {};
    const result = await sweepQueue.enqueueSweep(req.params.wbId, {
      level: level || 'heavy',
      githubPat: githubPat || '',
      stealth: !!stealth,
      speed: speed || 'standard',
    });
    if (!result.ok) {
      return res.status(409).json(result);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:wbId/sweep/status', async (req, res) => {
  try {
    const sweepPipeline = require('./sweepPipeline');
    const status = await sweepPipeline.getStatus(req.params.wbId);
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:wbId/sweep/cancel', async (req, res) => {
  try {
    const sweepPipeline = require('./sweepPipeline');
    const result = await sweepPipeline.cancelSweep(req.params.wbId);
    if (!result.ok) {
      return res.status(404).json(result);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:wbId/sweep/skip-tool', async (req, res) => {
  try {
    const sweepPipeline = require('./sweepPipeline');
    const result = await sweepPipeline.skipCurrentTool(req.params.wbId);
    if (!result.ok) {
      return res.status(404).json(result);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sweep/stages', (req, res) => {
  // Public: lets the UI show the full stage list before sweep starts
  const sweepPipeline = require('./sweepPipeline');
  res.json({
    stages: sweepPipeline.SWEEP_STAGES.map(s => ({
      id: s.id,
      label: s.label,
      tool: s.tool,
      requiresPat: !!s.requiresPat,
      optional: !!s.optional,
      timeoutMin: Math.round(s.timeoutMs / 60000),
    })),
  });
});

// ── Sweep queue + multi-target launch + host health ──────────────────────

router.get('/sweep/queue', (req, res) => {
  try {
    const sweepQueue = require('./sweepQueue');
    res.json(sweepQueue.getQueueState());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/sweep/queue/remove/:wbId', (req, res) => {
  try {
    const sweepQueue = require('./sweepQueue');
    const result = sweepQueue.removeFromQueue(req.params.wbId);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Launch multiple sweeps in one call. Each goes through the queue admission
// controller — first 3 (or however many slots free) start immediately, rest
// queue.
router.post('/sweep/multi-start', async (req, res) => {
  try {
    const sweepQueue = require('./sweepQueue');
    const { wbIds, level, stealth, speed, githubPat } = req.body || {};
    if (!Array.isArray(wbIds) || wbIds.length === 0) {
      return res.status(400).json({ error: 'wbIds must be a non-empty array' });
    }
    const results = [];
    for (const wbId of wbIds) {
      const r = await sweepQueue.enqueueSweep(wbId, {
        level: level || 'heavy',
        githubPat: githubPat || '',
        stealth: !!stealth,
        speed: speed || 'standard',
      });
      results.push({ wbId, ...r });
    }
    res.json({ results, queue: sweepQueue.getQueueState() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:wbId/sweep/host-health', async (req, res) => {
  try {
    const hostHealth = require('./hostHealth');
    const state = await hostHealth.getAllStatus(req.params.wbId);
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Export — stream a zip of workbench data ──────────────────────────────

router.get('/:wbId/export/estimate', async (req, res) => {
  try {
    const exporter = require('./exporter');
    const flag = (k, dflt) => {
      if (!(k in req.query)) return dflt;
      return ['1', 'true', 'yes'].includes(String(req.query[k]).toLowerCase());
    };
    const include = {
      recon: flag('recon', true),
      summaries: flag('summaries', true),
      tools: flag('tools', false),
      mirror: flag('mirror', false),
    };
    const result = await exporter.estimateSize(req.params.wbId, include);
    if (result.error) return res.status(404).json(result);
    res.json({ ...result, include });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:wbId/export/zip', async (req, res) => {
  try {
    const exporter = require('./exporter');
    await exporter.streamExport(req, res, req.params.wbId);
  } catch (e) {
    // Headers may already be sent — best effort
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      try { res.end(); } catch {}
    }
  }
});

// ── Subdomain pivot — recon data organized per-subdomain ──────────────────

router.get('/:wbId/by-subdomain', async (req, res) => {
  try {
    const subdomainPivot = require('./subdomainPivot');
    const result = await subdomainPivot.listSubdomains(req.params.wbId);
    if (result.error) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:wbId/by-subdomain/target-wide', async (req, res) => {
  try {
    const subdomainPivot = require('./subdomainPivot');
    const result = await subdomainPivot.getTargetWideData(req.params.wbId);
    if (result.error) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:wbId/by-subdomain/:host', async (req, res) => {
  try {
    const subdomainPivot = require('./subdomainPivot');
    const data = await subdomainPivot.getSubdomainData(req.params.wbId, req.params.host);
    if (data.error) return res.status(404).json(data);
    // Also try to find a screenshot for this host
    const screenshot = await subdomainPivot.findScreenshotForHost(req.params.wbId, req.params.host);
    res.json({ ...data, screenshot });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
