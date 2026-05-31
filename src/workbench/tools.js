/**
 * TOOLS — Per-tool runner functions
 *
 * Each tool function:
 *   - Takes { wbId, options } (options already validated by toolsRegistry.validate)
 *   - Resolves the input file path against the workbench's recon dir
 *   - Spawns the tool with appropriate flags
 *   - Streams progress to chat as recon-role messages
 *   - Writes raw output to tools/<toolId>/<runId>/
 *   - Merges canonical findings into workbench-level files (e.g. ffuf_findings.txt)
 *   - Returns { runId, ... }
 *
 * Run tracking lives in <workbenchDir>/tool_runs.json — append-only history.
 *
 * Concurrency policy:
 *   - One tool at a time per workbench (gated by _activeRuns)
 *   - Refuses to start if reconStreamer is also running for this workbench
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sessionStore = require('./sessionStore');
const chatEngine = require('./chatEngine');
const reconStreamer = require('./reconStreamer');
const toolsRegistry = require('./toolsRegistry');

// ──────────────────────────────────────────────────────────────────────
// Active-run registry. wbId → { runId, toolId, child, startedAt }
// ──────────────────────────────────────────────────────────────────────
const _activeRuns = new Map();

function isToolRunning(wbId) {
  return _activeRuns.has(wbId);
}

function getActiveRun(wbId) {
  const r = _activeRuns.get(wbId);
  if (!r) return null;
  return { runId: r.runId, toolId: r.toolId, startedAt: r.startedAt };
}

function _newRunId() {
  return 'run_' + crypto.randomBytes(6).toString('hex');
}

function _sanitize(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_');
}

async function _push(wbId, finding) {
  return chatEngine.pushReconFinding(wbId, finding).catch(() => {});
}

function _reconDir(wb, wbId) {
  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return path.join(sessionStore.workbenchDir(wbId), 'recon', _sanitize(target));
}

function _toolRunsPath(wbId) {
  return path.join(sessionStore.workbenchDir(wbId), 'tool_runs.json');
}

async function _readToolRuns(wbId) {
  const fp = _toolRunsPath(wbId);
  if (!await fs.pathExists(fp)) return [];
  try { return await fs.readJson(fp); } catch { return []; }
}

async function _writeToolRun(wbId, run) {
  const fp = _toolRunsPath(wbId);
  const all = await _readToolRuns(wbId);
  // Update if exists, else prepend
  const idx = all.findIndex(r => r.runId === run.runId);
  if (idx >= 0) all[idx] = run;
  else all.unshift(run);
  // Cap history to 200
  while (all.length > 200) all.pop();
  await fs.writeJson(fp, all, { spaces: 2 });
}

async function getToolRuns(wbId) {
  return _readToolRuns(wbId);
}

async function getToolRun(wbId, runId) {
  const all = await _readToolRuns(wbId);
  return all.find(r => r.runId === runId) || null;
}

// Walk outputDir recursively (max 2 levels deep) and return entries with relative paths.
// Distinguishes files vs directories so the UI can render them differently.
async function getToolRunOutput(wbId, runId) {
  const run = await getToolRun(wbId, runId);
  if (!run) return null;
  if (!run.outputDir) return null;
  const dir = run.outputDir;
  if (!await fs.pathExists(dir)) return { files: [], note: 'Output directory missing' };

  const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.db', '.sqlite', '.zip', '.tar', '.gz']);
  const files = [];

  async function walk(rel, depth) {
    if (depth > 2) return;
    const abs = path.join(dir, rel);
    const entries = await fs.readdir(abs).catch(() => []);
    // Sort: files before directories at each level, then alphabetical
    entries.sort();
    for (const name of entries) {
      const relPath = rel ? `${rel}/${name}` : name;
      const absPath = path.join(abs, name);
      let stat;
      try { stat = await fs.stat(absPath); } catch { continue; }
      if (stat.isDirectory()) {
        const subEntries = await fs.readdir(absPath).catch(() => []);
        files.push({
          name: relPath,
          size: 0,
          isDir: true,
          childCount: subEntries.length,
        });
        await walk(relPath, depth + 1);
      } else {
        const ext = path.extname(name).toLowerCase();
        files.push({
          name: relPath,
          size: stat.size,
          isDir: false,
          isBinary: BINARY_EXT.has(ext) || stat.size > 5_000_000,
        });
      }
    }
  }

  await walk('', 0);
  return { runId, files, dir };
}

async function readRunFile(wbId, runId, filename) {
  const run = await getToolRun(wbId, runId);
  if (!run || !run.outputDir) return null;
  // Path safety: forbid traversal escapes, allow forward slashes for nested paths
  if (filename.includes('..') || filename.startsWith('/') || filename.includes('\\')) return null;
  const fp = path.join(run.outputDir, filename);
  // Resolve and verify it's still inside outputDir (defense against symlinks etc.)
  const real = path.resolve(fp);
  const dirReal = path.resolve(run.outputDir);
  if (!real.startsWith(dirReal + path.sep) && real !== dirReal) return null;
  if (!await fs.pathExists(real)) return null;
  const stat = await fs.stat(real);
  if (stat.isDirectory()) {
    return { error: 'directory', message: 'This is a folder, not a file. Click an entry inside it.' };
  }
  if (stat.size > 5_000_000) {
    return { error: 'too_large', message: `File is ${(stat.size/1024/1024).toFixed(1)}MB — too large to display in browser.` };
  }
  // Binary detection: if any null bytes in first 4KB, treat as binary
  const buf = await fs.readFile(real);
  const sample = buf.slice(0, 4096);
  let hasNull = false;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) { hasNull = true; break; }
  }
  if (hasNull) {
    return { error: 'binary', message: `Binary file (${stat.size} bytes). Use the download button instead.`, size: stat.size };
  }
  return buf.toString('utf8');
}

async function stopRun(wbId, runId) {
  const active = _activeRuns.get(wbId);
  if (!active || active.runId !== runId) {
    return { stopped: false, reason: 'No matching active run' };
  }
  try {
    if (active.child && !active.child.killed) {
      active.child.kill('SIGTERM');
      // SIGKILL after 5s if still alive
      setTimeout(() => {
        try { if (active.child && !active.child.killed) active.child.kill('SIGKILL'); } catch {}
      }, 5000);
    }
  } catch {}
  return { stopped: true, runId };
}

// ──────────────────────────────────────────────────────────────────────
// Common pre-flight check
// ──────────────────────────────────────────────────────────────────────
async function _gateAndPrepare(wbId, toolId, options) {
  const wb = await sessionStore.getWorkbench(wbId);
  if (!wb) throw new Error('Workbench not found');
  if (reconStreamer.isReconRunning(wbId)) {
    throw new Error('Baseline recon is running — wait for it to finish');
  }
  if (_activeRuns.has(wbId)) {
    const a = _activeRuns.get(wbId);
    throw new Error(`Tool "${a.toolId}" is already running (run ${a.runId})`);
  }

  const tool = toolsRegistry.get(toolId);
  if (!tool) throw new Error(`Unknown tool: ${toolId}`);

  const reconDir = _reconDir(wb, wbId);

  // Tools with an inputFile need the recon dir to exist with that file.
  // Tools without an inputFile (e.g. s3scanner, github_recon) don't need recon at all
  // — they generate their own targets. Create the recon dir lazily so output files have a home.
  const toolNeedsInputFile = (tool.inputs || []).some(i => i.type === 'file');
  if (toolNeedsInputFile) {
    if (!await fs.pathExists(reconDir)) {
      throw new Error('Recon directory missing — run baseline recon first');
    }
    if (options.inputFile) {
      const inputPath = path.join(reconDir, options.inputFile);
      if (!await fs.pathExists(inputPath)) {
        throw new Error(`Input file not found: ${options.inputFile}. Run the baseline recon first.`);
      }
      const stat = await fs.stat(inputPath);
      if (stat.size === 0) {
        throw new Error(`Input file is empty: ${options.inputFile}`);
      }
    }
  } else {
    // Lazy-create recon dir for tools that produce findings but don't need baseline data
    await fs.ensureDir(reconDir);
  }

  const runId = _newRunId();
  const outputDir = path.join(sessionStore.workbenchDir(wbId), 'tools', toolId, runId);
  await fs.ensureDir(outputDir);

  const run = {
    runId, toolId,
    label: tool.label,
    options,
    status: 'running',
    startedAt: Date.now(),
    completedAt: null,
    exitCode: null,
    durationSec: null,
    outputDir,
    findings: { count: null, summary: null },
  };
  await _writeToolRun(wbId, run);

  return { wb, tool, reconDir, runId, outputDir, run };
}

async function _completeRun(wbId, run, exitCode, findingsSummary) {
  run.completedAt = Date.now();
  run.durationSec = ((run.completedAt - run.startedAt) / 1000).toFixed(1);
  run.exitCode = exitCode;
  run.status = exitCode === 0 ? 'completed' : (exitCode === null ? 'stopped' : 'failed');
  if (findingsSummary) run.findings = findingsSummary;
  await _writeToolRun(wbId, run);
  _activeRuns.delete(wbId);
}

// ──────────────────────────────────────────────────────────────────────
// Append unique lines to a recon file
// ──────────────────────────────────────────────────────────────────────
async function _appendUnique(filePath, newLines) {
  await fs.ensureFile(filePath);
  const existing = (await fs.readFile(filePath, 'utf8')).split('\n').filter(Boolean);
  const combined = Array.from(new Set([...existing, ...newLines]));
  combined.sort();
  await fs.writeFile(filePath, combined.join('\n') + (combined.length ? '\n' : ''));
  return { added: combined.length - existing.length, total: combined.length };
}

// Test if a command exists in PATH
async function _hasCommand(cmd) {
  return new Promise((resolve) => {
    const child = spawn('which', [cmd], { timeout: 2000 });
    child.on('close', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

// Run a command, capture stdout/stderr, return { code, stdout, stderr }
async function _runCmd(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const child = spawn(cmd, args, { timeout: timeoutMs });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout, stderr: stderr + err.message }));
  });
}

// Write a human-readable findings summary to the per-run output dir.
// Every runner calls this so the user always has a clear primary file to view.
async function _writeFindingsSummary(outputDir, toolLabel, options, lines, summary) {
  const ts = new Date().toISOString();
  const optsStr = Object.entries(options || {})
    .filter(([k,v]) => v !== undefined && v !== null && v !== '')
    .map(([k,v]) => `  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');
  const content = [
    `# ${toolLabel} — findings`,
    `# Run completed: ${ts}`,
    `# Summary: ${summary || '(none)'}`,
    '',
    '## Options used',
    optsStr || '  (none)',
    '',
    '## Findings',
    lines.length > 0 ? lines.join('\n') : '(no findings)',
    '',
  ].join('\n');
  await fs.writeFile(path.join(outputDir, 'findings.txt'), content);
}

// ══════════════════════════════════════════════════════════════════════
// FFUF
// ══════════════════════════════════════════════════════════════════════
async function runFfuf(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'ffuf', options);

  const wordlistMap = {
    'raft-small':  '/opt/SecLists/Discovery/Web-Content/raft-small-directories.txt',
    'raft-medium': '/opt/SecLists/Discovery/Web-Content/raft-medium-directories.txt',
    'raft-large':  '/opt/SecLists/Discovery/Web-Content/raft-large-directories.txt',
    'common':      '/opt/SecLists/Discovery/Web-Content/common.txt',
    'big':         '/opt/SecLists/Discovery/Web-Content/big.txt',
    'api':         '/opt/SecLists/Discovery/Web-Content/api/objects.txt',
  };
  const wordlist = wordlistMap[options.wordlist] || wordlistMap['raft-medium'];

  if (!await fs.pathExists(wordlist)) {
    await _completeRun(wbId, run, 1, { count: 0, summary: `Wordlist not found: ${wordlist}` });
    throw new Error(`Wordlist not found: ${wordlist}`);
  }

  const inputPath = path.join(reconDir, options.inputFile);
  const targets = (await fs.readFile(inputPath, 'utf8')).split('\n').filter(Boolean);

  await _push(wbId, {
    icon: '⊕',
    headline: `Starting FFUF on ${targets.length} target(s)`,
    detail: `Wordlist: ${options.wordlist} | rate=${Number(options.rate).toFixed(1)}r/s | run=${runId}`,
  });

  const ffufOutFile = path.join(outputDir, 'ffuf_results.json');
  const cdnHosts = new Set();
  try {
    const cf = await fs.readFile(path.join(reconDir, 'cloudflare_hosts.txt'), 'utf8');
    cf.split('\n').filter(Boolean).forEach(h => cdnHosts.add(h));
  } catch {}

  // Run ffuf per target, collect into a single JSON
  const allFindings = [];
  let processedCount = 0;
  let lastProgressPushAt = 0;

  for (const target of targets) {
    const isCdn = cdnHosts.has(target);
    const rate = isCdn ? Math.min(2, options.rate) : options.rate;
    const url = (target.endsWith('/') ? target.slice(0, -1) : target) + '/FUZZ';

    const args = [
      '-u', url,
      '-w', wordlist,
      '-mc', options.matchCodes,
      '-rate', String(rate),
      '-t', '5',
      '-timeout', '10',
      '-of', 'json',
      '-o', path.join(outputDir, `_per_target_${_sanitize(target)}.json`),
      '-silent',
    ];
    if (options.extensions) {
      args.push('-e', options.extensions.split(',').map(e => '.' + e.trim().replace(/^\./, '')).join(','));
    }
    if (options.filterSize) {
      args.push('-fs', options.filterSize);
    }
    args.push('-fc', '404,429,500');

    const perTargetTimeout = (options.maxRuntime * 60 * 1000) / Math.max(targets.length, 1);

    await new Promise((resolve) => {
      const child = spawn('ffuf', args, { timeout: Math.max(perTargetTimeout, 30000) });
      _activeRuns.set(wbId, { runId, toolId: 'ffuf', child, startedAt: run.startedAt });
      child.on('close', resolve);
      child.on('error', () => resolve());
    });

    // Parse this target's findings
    try {
      const perTargetFile = path.join(outputDir, `_per_target_${_sanitize(target)}.json`);
      if (await fs.pathExists(perTargetFile)) {
        const data = await fs.readJson(perTargetFile);
        for (const r of (data.results || [])) {
          allFindings.push({ url: r.url, status: r.status, length: r.length, target });
        }
      }
    } catch {}

    processedCount++;
    if (Date.now() - lastProgressPushAt > 5000) {
      await _push(wbId, {
        icon: '⊕',
        headline: `FFUF progress: ${processedCount}/${targets.length} targets, ${allFindings.length} hits so far`,
      });
      lastProgressPushAt = Date.now();
    }
  }

  // Combine results
  await fs.writeJson(ffufOutFile, allFindings, { spaces: 2 });

  // Append to canonical ffuf_findings.txt
  const findingLines = allFindings.map(f => `${f.status}\t${f.length}\t${f.url}`);
  const merged = await _appendUnique(path.join(reconDir, 'ffuf_findings.txt'), findingLines);

  const summary = `${allFindings.length} total hit(s), ${merged.added} new`;
  await _writeFindingsSummary(outputDir, 'FFUF', options, findingLines, summary);
  await _push(wbId, {
    icon: allFindings.length > 0 ? '✓' : '○',
    headline: `FFUF complete: ${summary}`,
    detail: allFindings.length > 0
      ? `Top: ${findingLines.slice(0, 6).map(l => '  ' + l).join('\n')}${allFindings.length > 6 ? `\n  ...(+${allFindings.length - 6} more)` : ''}`
      : 'No hits found.',
  });

  await _completeRun(wbId, run, 0, { count: allFindings.length, summary });
  return { runId, findings: allFindings.length, merged: merged.added };
}

// ══════════════════════════════════════════════════════════════════════
// ARJUN
// ══════════════════════════════════════════════════════════════════════
async function runArjun(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'arjun', options);

  const inputPath = path.join(reconDir, options.inputFile);
  const targets = (await fs.readFile(inputPath, 'utf8')).split('\n').filter(Boolean);

  await _push(wbId, {
    icon: '⌬',
    headline: `Starting Arjun on ${targets.length} target(s)`,
    detail: `Method: ${options.method} | concurrency=${options.concurrency} | run=${runId}`,
  });

  // Run arjun per host with concurrency cap
  const sem = options.concurrency;
  const results = [];
  let processedCount = 0;
  let activePromises = [];

  const runOne = async (target) => {
    const safeName = _sanitize(target);
    const outFile = path.join(outputDir, `${safeName}.json`);
    const args = [
      '-u', target,
      '-oJ', outFile,
      '-t', String(options.threadsPerHost),
      '-q',
    ];
    if (options.method === 'POST') args.push('-m', 'POST');
    else if (options.method === 'JSON') args.push('-m', 'JSON');
    if (options.stable) args.push('--stable');

    await new Promise((resolve) => {
      const timeoutMs = (Number(options.timeoutPerHost) || 120) * 1000;
      const child = spawn('arjun', args, { timeout: timeoutMs });
      _activeRuns.set(wbId, { runId, toolId: 'arjun', child, startedAt: run.startedAt });
      child.on('close', resolve);
      child.on('error', () => resolve());
    });

    try {
      if (await fs.pathExists(outFile)) {
        const data = await fs.readJson(outFile);
        // arjun's JSON shape varies; extract params
        const params = data?.params || data?.parameters || [];
        for (const p of params) {
          const name = typeof p === 'string' ? p : (p.name || p.parameter || JSON.stringify(p));
          results.push({ host: target, param: name });
        }
      }
    } catch {}

    processedCount++;
    await _push(wbId, {
      icon: '⌬',
      headline: `Arjun: ${processedCount}/${targets.length} hosts done`,
      detail: `${results.length} parameters discovered so far`,
    });
  };

  // Concurrency control
  const queue = [...targets];
  while (queue.length > 0) {
    const batch = queue.splice(0, sem);
    await Promise.all(batch.map(runOne));
  }

  // Append discovered params to params_detailed.txt
  const lines = results.map(r => `${r.param}\t(arjun)\t${r.host}`);
  const merged = await _appendUnique(path.join(reconDir, 'params_detailed.txt'), lines);
  // Also append to params.txt (just names, deduped)
  const justNames = Array.from(new Set(results.map(r => r.param)));
  await _appendUnique(path.join(reconDir, 'params.txt'), justNames);

  const summary = `${results.length} parameter discoveries across ${targets.length} hosts`;
  await _writeFindingsSummary(outputDir, 'Arjun', options, lines, summary);
  await _push(wbId, {
    icon: results.length > 0 ? '✓' : '○',
    headline: `Arjun complete: ${summary}`,
    detail: results.length > 0
      ? `Sample: ${results.slice(0, 8).map(r => `${r.param} on ${r.host}`).join(', ')}`
      : 'No new parameters found.',
  });

  await _completeRun(wbId, run, 0, { count: results.length, summary });
  return { runId, findings: results.length, merged: merged.added };
}

// ══════════════════════════════════════════════════════════════════════
// JS ANALYZER
// ══════════════════════════════════════════════════════════════════════
async function runJsAnalyzer(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'js_analyzer', options);

  const inputPath = path.join(reconDir, options.inputFile);
  const allUrls = (await fs.readFile(inputPath, 'utf8')).split('\n').filter(Boolean);
  const jsUrls = Array.from(new Set(
    allUrls.filter(u => /\.js($|\?)/i.test(u))
  )).slice(0, options.maxFiles);

  await _push(wbId, {
    icon: '⟦',
    headline: `JS Analyzer: ${jsUrls.length} JS file(s) to download (capped at ${options.maxFiles})`,
    detail: `Source: ${options.inputFile} | run=${runId}`,
  });

  if (jsUrls.length === 0) {
    await _push(wbId, { icon: '○', headline: 'No JS files found in input file' });
    await _completeRun(wbId, run, 0, { count: 0, summary: 'No JS files in source' });
    return { runId, files: 0 };
  }

  // Save the JS file list
  await fs.writeFile(path.join(outputDir, 'js_files.txt'), jsUrls.join('\n') + '\n');

  // Download JS files in parallel (8 at a time)
  const downloadDir = path.join(outputDir, 'downloads');
  await fs.ensureDir(downloadDir);
  const fetched = [];
  let processedCount = 0;
  const sem = 8;
  const queue = [...jsUrls];

  const fetchOne = async (url) => {
    return new Promise((resolve) => {
      const safeName = _sanitize(url).slice(-150) + '.js';
      const dest = path.join(downloadDir, safeName);
      const fetchTimeoutSec = Number(options.fetchTimeout) || 8;
      const child = spawn('curl', [
        '-skL', '--max-time', String(fetchTimeoutSec),
        '-A', 'Mozilla/5.0 (X11; Linux x86_64) Tentacles/3.0',
        '-o', dest, url,
      ], { timeout: (fetchTimeoutSec + 2) * 1000 });
      _activeRuns.set(wbId, { runId, toolId: 'js_analyzer', child, startedAt: run.startedAt });
      child.on('close', async (code) => {
        if (code === 0 && await fs.pathExists(dest)) {
          const stat = await fs.stat(dest);
          if (stat.size > 0 && stat.size < 5_000_000) {
            fetched.push({ url, file: dest });
          }
        }
        processedCount++;
        resolve();
      });
      child.on('error', () => { processedCount++; resolve(); });
    });
  };

  while (queue.length > 0) {
    const batch = queue.splice(0, sem);
    await Promise.all(batch.map(fetchOne));
    if (queue.length > 0) {
      await _push(wbId, { icon: '⟦', headline: `JS download: ${processedCount}/${jsUrls.length}` });
    }
  }

  // Endpoints + secrets extraction.
  // Try external tools first (trufflehog, xnLinkFinder) then fall back to regex.
  const endpoints = new Set();
  const secrets = [];

  // ─── Endpoint extraction ──────────────────────────────────────────────
  let usedXnLinkFinder = false;
  if (options.useXnLinkFinder !== false && await _hasCommand('xnLinkFinder')) {
    try {
      const xnOut = path.join(outputDir, 'xn_endpoints.txt');
      await new Promise((resolve) => {
        const child = spawn('xnLinkFinder', [
          '-i', downloadDir, '-o', xnOut, '-sf', '/', '-vv',
        ], { timeout: 120000 });
        _activeRuns.set(wbId, { runId, toolId: 'js_analyzer', child, startedAt: run.startedAt });
        child.on('close', resolve);
        child.on('error', resolve);
      });
      if (await fs.pathExists(xnOut)) {
        const c = await fs.readFile(xnOut, 'utf8');
        for (const line of c.split('\n').filter(Boolean)) {
          const trimmed = line.trim();
          if (trimmed.length >= 3 && trimmed.length <= 500) endpoints.add(trimmed);
        }
        usedXnLinkFinder = true;
      }
    } catch {}
  }
  if (!usedXnLinkFinder && options.useXnLinkFinder !== false && await _hasCommand('linkfinder')) {
    // LinkFinder per-file fallback (older tool but more common)
    for (const f of fetched.slice(0, 100)) {
      try {
        const out = await _runCmd('linkfinder', ['-i', f.file, '-o', 'cli'], 30000);
        for (const line of out.stdout.split('\n').filter(Boolean)) {
          const trimmed = line.trim();
          if (trimmed.length >= 3 && trimmed.length <= 500) endpoints.add(trimmed);
        }
      } catch {}
    }
    usedXnLinkFinder = true;
  }
  if (!usedXnLinkFinder) {
    // Regex fallback
    const ENDPOINT_PATTERNS = [
      /["'](\/[a-zA-Z][a-zA-Z0-9_\-/.]+)["']/g,
      /["'](https?:\/\/[a-zA-Z0-9_\-./?=&%:]+)["']/g,
    ];
    for (const f of fetched) {
      let content;
      try { content = await fs.readFile(f.file, 'utf8'); } catch { continue; }
      for (const pat of ENDPOINT_PATTERNS) {
        let m;
        while ((m = pat.exec(content)) !== null) {
          const ep = m[1];
          if (ep.length < 3 || ep.length > 500) continue;
          if (/^\/+$/.test(ep)) continue;
          if (/^\/(em|ms|px|pt|rem|vh|vw)$/i.test(ep)) continue;
          endpoints.add(ep);
        }
      }
    }
  }

  // ─── Secret extraction ────────────────────────────────────────────────
  let usedTrufflehog = false;
  if (options.useTrufflehog !== false && await _hasCommand('trufflehog')) {
    try {
      const thOut = await _runCmd('trufflehog', [
        'filesystem', downloadDir,
        '--json', '--no-update',
        '--only-verified',  // we add this option below conditionally
      ], 120000);
      // Parse JSONL output
      for (const line of thOut.stdout.split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(line);
          secrets.push({
            type: j.DetectorName || 'unknown',
            snippet: (j.Raw || '').slice(0, 200),
            source: (j.SourceMetadata?.Data?.Filesystem?.file) || 'unknown',
            verified: !!j.Verified,
          });
        } catch {}
      }
      usedTrufflehog = true;
    } catch {}
  }
  if (!usedTrufflehog) {
    // Regex fallback
    const SECRET_PATTERNS = [
      { name: 'AWS Access Key',     re: /AKIA[0-9A-Z]{16}/g },
      { name: 'Generic API key',    re: /(?:api[_-]?key|apikey|api_token)["'\s:=]+["']?([A-Za-z0-9_\-]{20,})["']?/gi },
      { name: 'JWT token',          re: /eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=\-+/]+/g },
      { name: 'Stripe secret key',  re: /sk_live_[0-9a-zA-Z]{24,}/g },
      { name: 'Google API key',     re: /AIza[0-9A-Za-z\-_]{35}/g },
      { name: 'Slack token',        re: /xox[baprs]-[A-Za-z0-9-]+/g },
    ];
    for (const f of fetched) {
      let content;
      try { content = await fs.readFile(f.file, 'utf8'); } catch { continue; }
      for (const sp of SECRET_PATTERNS) {
        let m;
        while ((m = sp.re.exec(content)) !== null) {
          secrets.push({ type: sp.name, snippet: m[0].slice(0, 200), source: f.url });
        }
      }
    }
  }
  await _push(wbId, {
    icon: '⟦',
    headline: `JS analysis: ${usedTrufflehog ? 'trufflehog' : 'regex'} (secrets) + ${usedXnLinkFinder ? 'xnLinkFinder' : 'regex'} (endpoints)`,
  });

  const endpointsList = Array.from(endpoints).sort();
  await fs.writeFile(path.join(outputDir, 'js_endpoints.txt'), endpointsList.join('\n') + '\n');
  await fs.writeFile(path.join(outputDir, 'js_secrets.txt'),
    secrets.map(s => `${s.type}\t${s.snippet}\t${s.source}`).join('\n') + '\n');

  // Merge into canonical files
  const epMerged = await _appendUnique(path.join(reconDir, 'js_endpoints.txt'), endpointsList);
  const filesMerged = await _appendUnique(path.join(reconDir, 'js_files.txt'), jsUrls);
  const secretsMerged = await _appendUnique(path.join(reconDir, 'js_secrets.txt'),
    secrets.map(s => `${s.type}\t${s.snippet}\t${s.source}`));

  // Optional: merge endpoints into all_urls.txt so they flow downstream
  if (options.mergeIntoUrls && endpointsList.length > 0) {
    // Convert relative endpoints to absolute using a representative host
    const hosts = (await fs.readFile(path.join(reconDir, 'alive_hosts.txt'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
    if (hosts.length > 0) {
      const baseHost = hosts[0].replace(/\/$/, '');
      const absUrls = endpointsList
        .filter(ep => ep.startsWith('/'))
        .map(ep => baseHost + ep);
      const absoluteAlready = endpointsList.filter(ep => /^https?:\/\//.test(ep));
      await _appendUnique(path.join(reconDir, 'all_urls.txt'), [...absUrls, ...absoluteAlready]);
    }
  }

  const summary = `${fetched.length}/${jsUrls.length} files fetched, ${endpointsList.length} endpoints, ${secrets.length} potential secrets`;
  const jsLines = [
    `=== JS files downloaded: ${fetched.length}/${jsUrls.length} ===`,
    ...fetched.slice(0, 50).map(f => `  ${f.url}`),
    '', `=== Endpoints discovered: ${endpointsList.length} ===`,
    ...endpointsList.slice(0, 200),
    '', `=== Secrets: ${secrets.length} ===`,
    ...secrets.slice(0, 50).map(s => `  [${s.type}] ${s.snippet} → ${s.source}`),
  ];
  await _writeFindingsSummary(outputDir, 'JS & Secrets', options, jsLines, summary);
  await _push(wbId, {
    icon: secrets.length > 0 ? '🚨' : '✓',
    headline: `JS Analyzer complete: ${summary}`,
    detail: secrets.length > 0
      ? `🚨 Possible secrets:\n${secrets.slice(0, 5).map(s => `  • ${s.type} in ${s.source}`).join('\n')}`
      : `${epMerged.added} new endpoints merged into all_urls.txt`,
  });

  await _completeRun(wbId, run, 0, { count: endpointsList.length, summary });
  return { runId, files: fetched.length, endpoints: endpointsList.length, secrets: secrets.length };
}

// ══════════════════════════════════════════════════════════════════════
// NUCLEI
// ══════════════════════════════════════════════════════════════════════
async function runNuclei(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'nuclei', options);

  const inputPath = path.join(reconDir, options.inputFile);
  const targetCount = (await fs.readFile(inputPath, 'utf8')).split('\n').filter(Boolean).length;

  // Map template set to nuclei flags
  // Default templates path is ~/nuclei-templates (set by `nuclei -update-templates`)
  let templateArgs = [];
  switch (options.templateSet) {
    case 'critical_high':
      templateArgs = ['-s', 'critical,high'];
      break;
    case 'exposures':
      templateArgs = ['-tags', 'exposure,exposed-config,sensitive,disclosure'];
      break;
    case 'security_headers':
      templateArgs = ['-tags', 'headers,csp,hsts,xss-headers,clickjacking,security-headers'];
      break;
    case 'ssl_tls':
      templateArgs = ['-tags', 'ssl,tls,cert'];
      break;
    case 'takeover':
      templateArgs = ['-tags', 'takeover'];
      break;
    case 'secrets':
      templateArgs = ['-tags', 'token,secret,key,exposed-token,exposure,disclosure'];
      break;
    case 'cves':
      templateArgs = ['-tags', 'cve'];
      break;
    case 'misconfig':
      templateArgs = ['-tags', 'misconfig,config'];
      break;
    case 'default':
      templateArgs = [];
      break;
    case 'full':
      templateArgs = [];
      break;
    case 'custom':
      if (options.customTemplatePath) {
        if (options.customTemplatePath.includes('/')) templateArgs = ['-t', options.customTemplatePath];
        else templateArgs = ['-tags', options.customTemplatePath];
      }
      break;
  }
  if (options.severityFilter && options.templateSet !== 'critical_high') {
    templateArgs.push('-s', options.severityFilter);
  }

  const jsonOut = path.join(outputDir, 'nuclei_findings.json');
  const txtOut = path.join(outputDir, 'nuclei_findings.txt');

  const args = [
    '-l', inputPath,
    '-rate-limit', String(Math.max(1, Math.round(Number(options.rateLimit) || 30))),
    '-timeout', '10',
    '-retries', '1',
    '-jsonl', '-o', jsonOut,
    '-silent',
    '-disable-update-check',
    '-no-color',
    ...templateArgs,
  ];

  await _push(wbId, {
    icon: '◬',
    headline: `Starting Nuclei on ${targetCount} target(s)`,
    detail: `Template set: ${options.templateSet} | rate=${Number(options.rateLimit).toFixed(1)}r/s | run=${runId}`,
  });

  await new Promise((resolve, reject) => {
    const child = spawn('nuclei', args, { timeout: options.maxRuntime * 60 * 1000 });
    _activeRuns.set(wbId, { runId, toolId: 'nuclei', child, startedAt: run.startedAt });
    let buf = '';
    let lastPushAt = 0;
    const flushProgress = async () => {
      if (Date.now() - lastPushAt < 8000) return;
      lastPushAt = Date.now();
      // Count findings written so far
      try {
        if (await fs.pathExists(jsonOut)) {
          const c = await fs.readFile(jsonOut, 'utf8');
          const lines = c.split('\n').filter(Boolean).length;
          await _push(wbId, { icon: '◬', headline: `Nuclei: ${lines} finding(s) so far` });
        }
      } catch {}
    };
    child.stdout.on('data', d => { buf += d.toString(); flushProgress(); });
    child.stderr.on('data', d => { /* nuclei spam to stderr */ });
    child.on('close', resolve);
    child.on('error', resolve);
  });

  // Parse findings
  const findings = [];
  if (await fs.pathExists(jsonOut)) {
    const content = await fs.readFile(jsonOut, 'utf8');
    for (const line of content.split('\n').filter(Boolean)) {
      try {
        const f = JSON.parse(line);
        findings.push({
          name: f['template-id'] || f.templateID || 'unknown',
          severity: f.info?.severity || 'unknown',
          host: f.host || f['matched-at'] || '',
          matched: f['matched-at'] || '',
        });
      } catch {}
    }
  }

  // Write a flat text version for the UI
  const lines = findings.map(f => `[${f.severity}]\t${f.name}\t${f.matched}`);
  await fs.writeFile(txtOut, lines.join('\n') + '\n');

  // Append to canonical
  const merged = await _appendUnique(path.join(reconDir, 'nuclei_findings.txt'), lines);

  const bySev = {};
  for (const f of findings) bySev[f.severity] = (bySev[f.severity] || 0) + 1;
  const summary = `${findings.length} finding(s): ${Object.entries(bySev).map(([s,n]) => `${n} ${s}`).join(', ')}`;
  await _writeFindingsSummary(outputDir, 'Nuclei', options, lines, summary);

  await _push(wbId, {
    icon: findings.length > 0 ? '🚨' : '✓',
    headline: `Nuclei complete: ${summary}`,
    detail: findings.length > 0
      ? findings.slice(0, 6).map(f => `  • [${f.severity}] ${f.name} → ${f.matched}`).join('\n')
      : 'No vulnerabilities matched.',
  });

  await _completeRun(wbId, run, 0, { count: findings.length, summary });
  return { runId, findings: findings.length, bySeverity: bySev };
}

// ══════════════════════════════════════════════════════════════════════
// REFLECTION (SPINEL)
// ══════════════════════════════════════════════════════════════════════
async function runReflection(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'reflection', options);

  const REFLECTION_DIR = path.resolve(__dirname, '../../tools/reflection');
  const VENV_PYTHON = path.join(REFLECTION_DIR, '.venv', 'bin', 'python');

  // Verify venv exists
  if (!await fs.pathExists(VENV_PYTHON)) {
    const msg = `Reflection venv missing at ${VENV_PYTHON}. Run \`bash run.sh\` on the VPS to set it up, or manually:\n  cd ${REFLECTION_DIR} && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`;
    await _push(wbId, { icon: '⚠', headline: 'Reflection tool not configured', detail: msg });
    await _completeRun(wbId, run, 1, { count: 0, summary: 'Reflection venv missing' });
    throw new Error(msg);
  }

  // Verify all required deps are importable in the venv
  // (catches the case where venv exists but pip install failed)
  const importCheck = await new Promise((resolve) => {
    const child = spawn(VENV_PYTHON, ['-c', 'import httpx, yaml, pydantic, orjson'], {
      timeout: 5000,
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({ code, stderr: stderr.trim() }));
    child.on('error', e => resolve({ code: -1, stderr: e.message }));
  });
  if (importCheck.code !== 0) {
    const msg = `Reflection venv exists but Python deps are missing.\n  Error: ${importCheck.stderr || 'unknown'}\n  Fix: ${REFLECTION_DIR}/.venv/bin/pip install -r ${REFLECTION_DIR}/requirements.txt`;
    await _push(wbId, { icon: '⚠', headline: 'Reflection deps missing', detail: msg });
    await _completeRun(wbId, run, 1, { count: 0, summary: 'Reflection deps missing — see chat' });
    throw new Error(msg);
  }

  // Build a per-run targets file
  const inputPath = path.join(reconDir, options.inputFile);
  const targetsForRun = path.join(outputDir, 'targets.txt');
  await fs.copy(inputPath, targetsForRun);

  // Build a per-run config.yaml (start from defaults, override key fields)
  const configForRun = path.join(outputDir, 'config.yaml');
  const baseConfig = await fs.readFile(path.join(REFLECTION_DIR, 'config.yaml'), 'utf8');
  // Tweak: override fields in YAML directly (string substitution is reliable for these specific lines)
  let cfg = baseConfig;
  const proxyValue = options.proxy ? `"${options.proxy}"` : 'null';
  cfg = cfg.replace(/^proxy: .*$/m, `proxy: ${proxyValue}`);
  cfg = cfg.replace(/^max_workers: .*$/m, `max_workers: ${options.maxWorkers}`);
  cfg = cfg.replace(/^max_per_host: .*$/m, `max_per_host: ${options.maxPerHost}`);
  cfg = cfg.replace(/^delay_min: .*$/m, `delay_min: ${options.delayMin}`);
  cfg = cfg.replace(/^delay_max: .*$/m, `delay_max: ${options.delayMax}`);
  cfg = cfg.replace(/^max_runtime_secs: .*$/m, `max_runtime_secs: ${options.maxRuntime * 60}`);
  cfg = cfg.replace(/^output_dir: .*$/m, `output_dir: "${outputDir}"`);
  // Test points block
  const pointsBlock = options.points.map(p => `  - ${p}`).join('\n');
  cfg = cfg.replace(/^test_points:[\s\S]*?(?=\n[a-z#])/m, `test_points:\n${pointsBlock}\n`);
  await fs.writeFile(configForRun, cfg);

  await _push(wbId, {
    icon: '✦',
    headline: `Starting Reflection scan`,
    detail: `Surfaces: ${options.points.join(', ')} | run=${runId}`,
  });

  const args = [
    path.join(REFLECTION_DIR, 'main.py'),
    '--config', configForRun,
    '--targets', targetsForRun,
    '--output-dir', outputDir,
    '--no-report',
    '--max-runtime', String(options.maxRuntime * 60),
  ];

  let stdoutBuf = '';
  let stderrBuf = '';
  let lastProgress = '';
  // Use a runtime cap that's at least 30s, even for quick tests
  const runtimeMs = options.maxRuntime > 0
    ? (options.maxRuntime + 2) * 60 * 1000
    : 24 * 60 * 60 * 1000;  // 24h cap for "unlimited"
  const exitCode = await new Promise((resolve) => {
    const child = spawn(VENV_PYTHON, args, {
      cwd: REFLECTION_DIR,
      timeout: runtimeMs,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },  // line-buffered for progress
    });
    _activeRuns.set(wbId, { runId, toolId: 'reflection', child, startedAt: run.startedAt });
    let lastPushAt = 0;
    child.stdout.on('data', d => {
      const s = d.toString();
      stdoutBuf += s;
      for (const line of s.split('\n')) {
        // SPINEL prints a progress bar with carriage returns — extract the latest
        const lastFrame = line.split('\r').pop().trim();
        if (/^\[.{30}\]\s+\d+\/\d+/.test(lastFrame)) {
          lastProgress = lastFrame;
          if (Date.now() - lastPushAt > 5000) {
            _push(wbId, { icon: '✦', headline: `Reflection: ${lastFrame}` }).catch(() => {});
            lastPushAt = Date.now();
          }
        } else if (/found.*reflect|reflected at|severity:/i.test(line)) {
          if (Date.now() - lastPushAt > 3000) {
            _push(wbId, { icon: '✦', headline: line.trim().slice(0, 200) }).catch(() => {});
            lastPushAt = Date.now();
          }
        }
      }
    });
    child.stderr.on('data', d => { stderrBuf += d.toString(); });
    child.on('close', code => resolve(code));
    child.on('error', e => { stderrBuf += '\nspawn error: ' + e.message; resolve(-1); });
  });

  // If SPINEL exited non-zero, surface the error
  if (exitCode !== 0 && exitCode !== null) {
    // Likely config validation failure or unhandled exception — last 2KB of stderr is most useful
    const errTail = (stderrBuf + stdoutBuf).slice(-1500).trim();
    await _push(wbId, {
      icon: '⚠',
      headline: `Reflection scan exited with code ${exitCode}`,
      detail: errTail || 'No stderr output captured.',
    });
    await _completeRun(wbId, run, exitCode, {
      count: 0,
      summary: `SPINEL exited ${exitCode} — see chat for details`,
    });
    return { runId, total: 0, reflected: 0, findings: 0, exitCode };
  }

  // Parse combined.json
  const combinedPath = path.join(outputDir, 'combined.json');
  let findings = [];
  let total = 0, reflected = 0;
  if (await fs.pathExists(combinedPath)) {
    try {
      const data = await fs.readJson(combinedPath);
      total = data.requests_total || 0;
      reflected = data.reflections_total || 0;
      findings = (data.results || []).filter(r => r.reflected);
    } catch {}
  }

  // Append to canonical
  const lines = findings.map(f =>
    `[${f.severity || 'info'}]\t${f.injection_point}\t${f.parameter_name || ''}\t${f.target}`
  );
  await _appendUnique(path.join(reconDir, 'reflection_findings.txt'), lines);
  // Also save full JSON for the UI
  await fs.copy(combinedPath, path.join(reconDir, 'reflection_combined.json')).catch(() => {});

  const summary = `${reflected} reflection(s) across ${total} requests`;
  await _writeFindingsSummary(outputDir, 'Reflection (SPINEL)', options, lines, summary);
  await _push(wbId, {
    icon: reflected > 0 ? '🚨' : '✓',
    headline: `Reflection scan complete: ${summary}`,
    detail: reflected > 0
      ? findings.slice(0, 6).map(f => `  • ${f.parameter_name} (${f.injection_point}) on ${f.target}`).join('\n')
      : 'No reflections detected.',
  });

  await _completeRun(wbId, run, 0, { count: reflected, summary });
  return { runId, total, reflected, findings: findings.length };
}


// ══════════════════════════════════════════════════════════════════════
// GOWITNESS — visual mapping
// ══════════════════════════════════════════════════════════════════════
async function runGowitness(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'gowitness', options);

  if (!await _hasCommand('gowitness')) {
    await _push(wbId, { icon: '⚠', headline: 'gowitness not installed',
      detail: 'Install: go install github.com/sensepost/gowitness@latest' });
    await _completeRun(wbId, run, 1, { count: 0, summary: 'gowitness missing' });
    throw new Error('gowitness not in PATH');
  }

  const inputPath = path.join(reconDir, options.inputFile);
  const targetCount = (await fs.readFile(inputPath, 'utf8')).split('\n').filter(Boolean).length;
  const screenshotsDir = path.join(outputDir, 'screenshots');
  await fs.ensureDir(screenshotsDir);

  await _push(wbId, {
    icon: '◳',
    headline: `Starting gowitness on ${targetCount} target(s)`,
    detail: `Threads: ${options.threads} | run=${runId}`,
  });

  // gowitness scan file --file <input> --screenshot-path <dir> -t <threads>
  const args = [
    'scan', 'file',
    '-f', inputPath,
    '--screenshot-path', screenshotsDir,
    '-t', String(options.threads),
    '--timeout', String(options.timeout),
    '--write-db',
    '--write-db-uri', `sqlite://${path.join(outputDir, 'gowitness.db')}`,
  ];
  if (options.fullPage) args.push('--screenshot-fullpage');

  const r = await new Promise((resolve) => {
    const child = spawn('gowitness', args, { timeout: targetCount * (options.timeout + 5) * 1000 });
    _activeRuns.set(wbId, { runId, toolId: 'gowitness', child, startedAt: run.startedAt });
    let stderr = '';
    child.stdout.on('data', d => {});
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({ code, stderr }));
    child.on('error', e => resolve({ code: -1, stderr: e.message }));
  });

  // Generate report
  if (r.code === 0 || r.code === null) {
    await _runCmd('gowitness', [
      'report', 'generate',
      '--db-uri', `sqlite://${path.join(outputDir, 'gowitness.db')}`,
      '-f', path.join(outputDir, 'gowitness_report.html'),
    ], 60000).catch(() => {});
  }

  // Count screenshots
  let shots = 0;
  try {
    const entries = await fs.readdir(screenshotsDir);
    shots = entries.filter(e => e.endsWith('.png') || e.endsWith('.jpeg')).length;
  } catch {}

  // If gowitness ran "successfully" but produced no shots, surface stderr +
  // diagnose Chromium availability — most common failure mode is no Chrome.
  if (shots === 0 && targetCount > 0) {
    const stderrTail = (r.stderr || '').slice(-400);
    let diagnosis = '';
    // Check whether any chromium binary exists at all
    const chromiumOk = await _hasCommand('chromium') || await _hasCommand('chromium-browser')
                    || await _hasCommand('google-chrome') || await _hasCommand('chrome');
    if (!chromiumOk) {
      diagnosis = ' Chrome/Chromium not found in PATH — install with: apt install -y chromium-browser';
    } else if (stderrTail) {
      diagnosis = ' stderr tail: ' + stderrTail.replace(/\s+/g, ' ').slice(0, 250);
    }
    await _push(wbId, {
      icon: '⚠',
      headline: `gowitness produced 0 screenshots from ${targetCount} target(s)`,
      detail: 'Likely missing browser dep.' + diagnosis,
    });
  }

  // Copy screenshots dir to recon for browsing in the Recon tab
  const reconShotsDir = path.join(reconDir, 'screenshots');
  try {
    if (await fs.pathExists(reconShotsDir)) await fs.remove(reconShotsDir);
    await fs.copy(screenshotsDir, reconShotsDir);
  } catch {}

  const summary = `${shots} screenshot(s) captured of ${targetCount} target(s)`;
  const screenshotList = [];
  try {
    const entries = await fs.readdir(screenshotsDir);
    for (const e of entries.filter(e => /\.(png|jpe?g)$/i.test(e))) {
      screenshotList.push(`  ${e}`);
    }
  } catch {}
  await _writeFindingsSummary(outputDir, 'Screenshots (gowitness)', options,
    [`${shots} screenshot(s) saved in screenshots/`, '', ...screenshotList,
     '', 'Open gowitness_report.html to browse the visual gallery.'],
    summary);
  await _push(wbId, {
    icon: shots > 0 ? '✓' : '○',
    headline: `Gowitness complete: ${summary}`,
    detail: shots > 0 ? `Open gowitness_report.html for the visual gallery.` : 'No screenshots captured.',
  });
  await _completeRun(wbId, run, r.code ?? 0, { count: shots, summary });
  return { runId, screenshots: shots };
}

// ══════════════════════════════════════════════════════════════════════
// TESTSSL — TLS/SSL deep audit
// ══════════════════════════════════════════════════════════════════════
async function runTestssl(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'testssl', options);

  if (!await _hasCommand('testssl.sh')) {
    await _push(wbId, { icon: '⚠', headline: 'testssl.sh not installed',
      detail: 'Install: git clone https://github.com/drwetter/testssl.sh /opt/testssl && ln -s /opt/testssl/testssl.sh /usr/local/bin/' });
    await _completeRun(wbId, run, 1, { count: 0, summary: 'testssl.sh missing' });
    throw new Error('testssl.sh not in PATH');
  }

  const inputPath = path.join(reconDir, options.inputFile);
  const targets = (await fs.readFile(inputPath, 'utf8')).split('\n').filter(Boolean);

  await _push(wbId, {
    icon: '◐',
    headline: `Starting testssl.sh on ${targets.length} target(s)`,
    detail: `Severity ≥ ${options.severity}, concurrency=${options.concurrency} | run=${runId}`,
  });

  const allFindings = [];
  const sevOrder = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  const minSev = sevOrder[options.severity] || 1;

  // Concurrency-controlled per-host runs
  const queue = [...targets];
  let processedCount = 0;
  const runOne = async (target) => {
    const safe = _sanitize(target);
    const jsonOut = path.join(outputDir, `testssl_${safe}.json`);
    const r = await _runCmd('testssl.sh', [
      '--quiet', '--color', '0',
      '--jsonfile', jsonOut,
      '--severity', options.severity,
      target,
    ], options.maxRuntimePerHost * 60 * 1000);

    try {
      if (await fs.pathExists(jsonOut)) {
        const data = await fs.readJson(jsonOut);
        const findings = (data.scanResult?.[0]?.findings || data.findings || []);
        for (const f of findings) {
          const sev = f.severity || 'INFO';
          if ((sevOrder[sev.toUpperCase()] ?? -1) < minSev) continue;
          allFindings.push({
            host: target,
            severity: sev,
            id: f.id || 'unknown',
            finding: f.finding || '',
          });
        }
      }
    } catch {}

    processedCount++;
    await _push(wbId, {
      icon: '◐',
      headline: `testssl: ${processedCount}/${targets.length} hosts done`,
    });
  };

  while (queue.length > 0) {
    const batch = queue.splice(0, options.concurrency);
    await Promise.all(batch.map(runOne));
  }

  // Append to canonical
  const lines = allFindings.map(f => `[${f.severity}]\t${f.id}\t${f.host}\t${(f.finding || '').slice(0, 150)}`);
  await _appendUnique(path.join(reconDir, 'testssl_findings.txt'), lines);

  const bySev = {};
  for (const f of allFindings) bySev[f.severity] = (bySev[f.severity] || 0) + 1;
  const summary = `${allFindings.length} finding(s): ${Object.entries(bySev).map(([s,n]) => `${n} ${s}`).join(', ') || 'none'}`;
  await _writeFindingsSummary(outputDir, 'testssl.sh', options, lines, summary);

  await _push(wbId, {
    icon: allFindings.length > 0 ? '🚨' : '✓',
    headline: `testssl complete: ${summary}`,
    detail: allFindings.length > 0
      ? allFindings.slice(0, 5).map(f => `  • [${f.severity}] ${f.id} on ${f.host}`).join('\n')
      : 'No issues at the requested severity.',
  });
  await _completeRun(wbId, run, 0, { count: allFindings.length, summary });
  return { runId, findings: allFindings.length, bySeverity: bySev };
}

// ══════════════════════════════════════════════════════════════════════
// WAFW00F — WAF detection
// ══════════════════════════════════════════════════════════════════════
async function runWafw00f(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'wafw00f', options);

  if (!await _hasCommand('wafw00f')) {
    await _push(wbId, { icon: '⚠', headline: 'wafw00f not installed',
      detail: 'Install: pip install wafw00f' });
    await _completeRun(wbId, run, 1, { count: 0, summary: 'wafw00f missing' });
    throw new Error('wafw00f not in PATH');
  }

  const inputPath = path.join(reconDir, options.inputFile);
  const targets = (await fs.readFile(inputPath, 'utf8')).split('\n').filter(Boolean);

  await _push(wbId, {
    icon: '◮',
    headline: `Starting wafw00f on ${targets.length} target(s)`,
    detail: `concurrency=${options.concurrency} | run=${runId}`,
  });

  const detections = [];
  const queue = [...targets];
  let processedCount = 0;

  const runOne = async (target) => {
    const r = await _runCmd('wafw00f', [target, '-a', '-o', '-'], 30000);
    // wafw00f stdout has lines like "[+] The site http://x is behind Cloudflare WAF"
    const lines = (r.stdout + '\n' + r.stderr).split('\n');
    for (const line of lines) {
      const m = line.match(/is behind\s+(.+?)\s*(?:WAF|$)/i);
      if (m) {
        detections.push({ host: target, waf: m[1].trim() });
        break;
      }
      if (/no waf/i.test(line) && /\(.*generic.*\)/i.test(line)) {
        detections.push({ host: target, waf: 'none-detected' });
        break;
      }
    }
    processedCount++;
    if (processedCount % 5 === 0 || processedCount === targets.length) {
      await _push(wbId, { icon: '◮', headline: `wafw00f: ${processedCount}/${targets.length} hosts done` });
    }
  };

  while (queue.length > 0) {
    const batch = queue.splice(0, options.concurrency);
    await Promise.all(batch.map(runOne));
  }

  const lines = detections.map(d => `${d.host}\t${d.waf}`);
  await _appendUnique(path.join(reconDir, 'waf_detections.txt'), lines);

  const wafs = {};
  for (const d of detections) wafs[d.waf] = (wafs[d.waf] || 0) + 1;
  // Distinguish hosts processed from hosts where a WAF was actually detected.
  // Previously summary used detections.length which made it look like 0 hosts
  // had been checked when the answer was simply "no WAF found".
  const wafCount = Object.entries(wafs).filter(([w]) => w !== 'none-detected').reduce((s, [, n]) => s + n, 0);
  const summary = `${processedCount}/${targets.length} host(s) checked, ${wafCount} WAF(s) found. ${Object.entries(wafs).map(([w,n]) => `${n}×${w}`).join(', ')}`;
  await _writeFindingsSummary(outputDir, 'wafw00f', options, lines, summary);

  await _push(wbId, {
    icon: '✓',
    headline: `wafw00f complete: ${summary}`,
    detail: detections.slice(0, 8).map(d => `  • ${d.host} → ${d.waf}`).join('\n'),
  });
  await _completeRun(wbId, run, 0, { count: detections.length, summary });
  return { runId, detections: detections.length, wafs };
}

// ══════════════════════════════════════════════════════════════════════
// WHATWEB — tech fingerprinting
// ══════════════════════════════════════════════════════════════════════
async function runWhatweb(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'whatweb', options);

  if (!await _hasCommand('whatweb')) {
    await _push(wbId, { icon: '⚠', headline: 'whatweb not installed',
      detail: 'Install: apt install whatweb (or gem install whatweb)' });
    await _completeRun(wbId, run, 1, { count: 0, summary: 'whatweb missing' });
    throw new Error('whatweb not in PATH');
  }

  const inputPath = path.join(reconDir, options.inputFile);
  const targets = (await fs.readFile(inputPath, 'utf8')).split('\n').filter(Boolean);

  await _push(wbId, {
    icon: '◇',
    headline: `Starting whatweb on ${targets.length} target(s)`,
    detail: `Aggression=${options.aggression}, concurrency=${options.concurrency} | run=${runId}`,
  });

  const fingerprints = {};
  const queue = [...targets];
  let processedCount = 0;

  const runOne = async (target) => {
    const safe = _sanitize(target);
    const jsonOut = path.join(outputDir, `whatweb_${safe}.json`);
    const r = await _runCmd('whatweb', [
      '-a', options.aggression,
      '--log-json', jsonOut,
      '--no-errors',
      target,
    ], 60000);

    try {
      if (await fs.pathExists(jsonOut)) {
        const c = await fs.readFile(jsonOut, 'utf8');
        for (const line of c.split('\n').filter(Boolean)) {
          try {
            const j = JSON.parse(line);
            const techs = [];
            for (const [name, data] of Object.entries(j.plugins || {})) {
              const versions = (data.version || []).slice(0, 1);
              techs.push(versions.length ? `${name}/${versions[0]}` : name);
            }
            fingerprints[target] = techs;
          } catch {}
        }
      }
    } catch {}

    processedCount++;
    if (processedCount % 5 === 0 || processedCount === targets.length) {
      await _push(wbId, { icon: '◇', headline: `whatweb: ${processedCount}/${targets.length}` });
    }
  };

  while (queue.length > 0) {
    const batch = queue.splice(0, options.concurrency);
    await Promise.all(batch.map(runOne));
  }

  const lines = [];
  for (const [host, techs] of Object.entries(fingerprints)) {
    lines.push(`${host}\t${techs.join(', ')}`);
  }
  await _appendUnique(path.join(reconDir, 'whatweb_findings.txt'), lines);

  const totalTechs = Object.values(fingerprints).reduce((s, t) => s + t.length, 0);
  const summary = `${Object.keys(fingerprints).length} host(s), ${totalTechs} technology fingerprint(s)`;
  await _writeFindingsSummary(outputDir, 'whatweb', options, lines, summary);

  await _push(wbId, {
    icon: '✓',
    headline: `whatweb complete: ${summary}`,
    detail: Object.entries(fingerprints).slice(0, 6).map(([h, t]) =>
      `  • ${h}: ${t.slice(0, 5).join(', ')}${t.length > 5 ? ` (+${t.length-5})` : ''}`
    ).join('\n'),
  });
  await _completeRun(wbId, run, 0, { count: totalTechs, summary });
  return { runId, fingerprints: totalTechs };
}

// ══════════════════════════════════════════════════════════════════════
// S3SCANNER — open cloud bucket discovery
// ══════════════════════════════════════════════════════════════════════
async function runS3scanner(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 's3scanner', options);

  // s3scanner is the canonical tool name. Fallback to s3-scanner if needed.
  const cmd = await _hasCommand('s3scanner') ? 's3scanner' :
              await _hasCommand('cloud_enum') ? 'cloud_enum' : null;
  if (!cmd) {
    await _push(wbId, { icon: '⚠', headline: 's3scanner / cloud_enum not installed',
      detail: 'Install: pip install s3scanner OR pip install cloud-enum' });
    await _completeRun(wbId, run, 1, { count: 0, summary: 's3scanner missing' });
    throw new Error('Neither s3scanner nor cloud_enum in PATH');
  }

  // Determine org name
  const orgName = (options.orgName || '').trim() ||
    wb.target.replace(/^https?:\/\//, '').replace(/\.[a-z]+$/i, '').replace(/\..*/, '');

  await _push(wbId, {
    icon: '◭',
    headline: `Starting ${cmd} for org "${orgName}"`,
    detail: `Permutations=${options.permutations}, providers=${options.providers.join(',')} | run=${runId}`,
  });

  // Generate candidate bucket names
  const SUFFIXES_SMALL = ['', '-prod', '-dev', '-staging', '-backup', '-data', '-uploads', '-public', '-private', '-assets'];
  const SUFFIXES_MEDIUM = [...SUFFIXES_SMALL,
    '-internal', '-test', '-qa', '-images', '-files', '-static', '-cdn', '-logs', '-archive',
    '-tmp', '-temp', '-old', '-new', '-www', '-app', '-api', '-web', '-store', '-config',
    '-secrets', '-keys', '-sec', '-storage', '-media', '-photos', '-videos', '-deploy', '-release',
  ];
  const SUFFIXES_LARGE = [...SUFFIXES_MEDIUM,
    '-bucket', '-buckets', '-s3', '-aws', '-cloud', '-google', '-gcp', '-azure', '-do',
    '-1', '-2', '-3', '-01', '-02', '-prod1', '-prod2', '-dev1', '-stage', '-stage1',
    '-website', '-site', '-landing', '-page', '-marketing', '-sales', '-customers',
    '-employees', '-hr', '-finance', '-accounting', '-legal', '-engineering', '-product',
    '-data-prod', '-data-dev', '-backup-prod', '-backup-dev',
  ];
  const PREFIXES = ['', 'backup-', 'data-', 'prod-', 'dev-', 'staging-'];
  const setMap = { small: SUFFIXES_SMALL, medium: SUFFIXES_MEDIUM, large: SUFFIXES_LARGE };
  const suffixes = setMap[options.permutations] || SUFFIXES_MEDIUM;
  const candidates = new Set();
  for (const p of PREFIXES) {
    for (const s of suffixes) {
      candidates.add(`${p}${orgName}${s}`);
    }
  }
  const candidatesList = Array.from(candidates);
  const candidatesFile = path.join(outputDir, 'candidates.txt');
  await fs.writeFile(candidatesFile, candidatesList.join('\n'));

  const findings = [];
  const args = cmd === 's3scanner'
    ? ['scan', '-f', candidatesFile, '--json', path.join(outputDir, 's3_results.json')]
    : ['-k', orgName, '--disable-azure', ...(options.providers.includes('azure') ? [] : []),
       '-l', path.join(outputDir, 'cloud_enum_log.txt')];

  // Disable providers based on user selection (s3scanner-style)
  if (cmd === 's3scanner') {
    const providerFlags = {
      aws: '--enabled-providers=aws',
      gcp: '--enabled-providers=gcp',
    };
    // s3scanner uses one --providers flag with comma list:
    const providerArg = options.providers
      .filter(p => ['aws','gcp','digitalocean','linode'].includes(p))
      .join(',');
    if (providerArg) args.push('--providers', providerArg);
  }

  const r = await _runCmd(cmd, args, 30 * 60 * 1000);

  // Parse output (s3scanner JSONL)
  const resultsFile = path.join(outputDir, 's3_results.json');
  if (await fs.pathExists(resultsFile)) {
    const c = await fs.readFile(resultsFile, 'utf8');
    for (const line of c.split('\n').filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        if (j.exists) {
          findings.push({
            bucket: j.name || j.bucket,
            provider: j.provider || 'unknown',
            access: j.acls || j.access || 'unknown',
            url: j.url || '',
          });
        }
      } catch {}
    }
  }

  // Fallback parsing for cloud_enum from log
  if (cmd === 'cloud_enum' && findings.length === 0) {
    const logFile = path.join(outputDir, 'cloud_enum_log.txt');
    if (await fs.pathExists(logFile)) {
      const c = await fs.readFile(logFile, 'utf8');
      for (const line of c.split('\n')) {
        if (/OPEN.*S3.*Bucket/.test(line) || /OPEN.*Storage/.test(line)) {
          findings.push({ bucket: line, provider: 'aws', access: 'open', url: '' });
        }
      }
    }
  }

  const lines = findings.map(f => `[${f.access}]\t${f.provider}\t${f.bucket}\t${f.url}`);
  await _appendUnique(path.join(reconDir, 's3_findings.txt'), lines);
  await _appendUnique(path.join(reconDir, 's3_buckets.txt'), findings.map(f => f.bucket));

  const summary = `${findings.length} bucket(s) found across ${candidatesList.length} candidates`;
  await _writeFindingsSummary(outputDir, 's3scanner', options, lines, summary);
  await _push(wbId, {
    icon: findings.length > 0 ? '🚨' : '✓',
    headline: `${cmd} complete: ${summary}`,
    detail: findings.length > 0
      ? findings.slice(0, 8).map(f => `  • [${f.access}] ${f.provider}: ${f.bucket}`).join('\n')
      : 'No open buckets found.',
  });
  await _completeRun(wbId, run, 0, { count: findings.length, summary });
  return { runId, candidates: candidatesList.length, findings: findings.length };
}

// ══════════════════════════════════════════════════════════════════════
// GITHUB_RECON — trufflehog scan of public repos
// ══════════════════════════════════════════════════════════════════════
async function runGithubRecon(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'github_recon', options);

  if (!await _hasCommand('trufflehog')) {
    await _push(wbId, { icon: '⚠', headline: 'trufflehog not installed',
      detail: 'Install: curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh -s -- -b /usr/local/bin' });
    await _completeRun(wbId, run, 1, { count: 0, summary: 'trufflehog missing' });
    throw new Error('trufflehog not in PATH');
  }

  // Derive org from target if not explicitly given. Strategy: take the first
  // dot-separated label of the bare hostname. Examples:
  //   intrix.com.au       -> intrix
  //   www.example.com     -> www  (caller should pass orgOrUser explicitly here)
  //   acme-co.io          -> acme-co
  // This is heuristic — for non-trivial cases the caller should set orgOrUser
  // explicitly via the launch dialog.
  const orgOrUser = (options.orgOrUser || '').trim() ||
    wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '').split('.')[0];

  if (!options.githubToken) {
    await _push(wbId, { icon: '⚠', headline: 'GitHub PAT required' });
    await _completeRun(wbId, run, 1, { count: 0, summary: 'PAT not provided' });
    throw new Error('GitHub PAT required');
  }

  await _push(wbId, {
    icon: '◓',
    headline: `Starting trufflehog scan of GitHub org/user "${orgOrUser}"`,
    detail: `Max repos: ${options.maxRepos}, only-verified: ${options.onlyVerified} | run=${runId}`,
  });

  const args = [
    'github',
    '--org', orgOrUser,
    '--json',
    '--no-update',
    '--token', options.githubToken,
  ];
  if (options.onlyVerified) args.push('--only-verified');

  const findings = [];
  await new Promise((resolve) => {
    const child = spawn('trufflehog', args, { timeout: 30 * 60 * 1000 });
    _activeRuns.set(wbId, { runId, toolId: 'github_recon', child, startedAt: run.startedAt });
    let stdoutBuf = '';
    child.stdout.on('data', d => {
      stdoutBuf += d.toString();
      // Trufflehog emits one JSON object per line
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();  // keep partial line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          findings.push({
            type: j.DetectorName || 'unknown',
            verified: !!j.Verified,
            repo: j.SourceMetadata?.Data?.Github?.repository || 'unknown',
            file: j.SourceMetadata?.Data?.Github?.file || '',
            commit: (j.SourceMetadata?.Data?.Github?.commit || '').slice(0, 8),
            snippet: (j.Raw || '').slice(0, 200),
          });
        } catch {}
      }
    });
    child.stderr.on('data', d => {});
    child.on('close', resolve);
    child.on('error', resolve);
  });

  // Don't write the token to disk anywhere
  const lines = findings.map(f =>
    `[${f.verified ? 'VERIFIED' : 'unverified'}]\t${f.type}\t${f.repo}\t${f.file}\t${f.commit}`
  );
  await _appendUnique(path.join(reconDir, 'github_secrets.txt'), lines);

  const verified = findings.filter(f => f.verified).length;
  const summary = `${findings.length} secret(s), ${verified} verified, across org "${orgOrUser}"`;
  // Don't include the PAT in the saved findings file
  const safeOpts = { ...options, githubToken: '(redacted)' };
  await _writeFindingsSummary(outputDir, 'GitHub Recon (trufflehog)', safeOpts, lines, summary);

  await _push(wbId, {
    icon: verified > 0 ? '🚨' : (findings.length > 0 ? '⚠' : '✓'),
    headline: `GitHub recon complete: ${summary}`,
    detail: findings.length > 0
      ? findings.slice(0, 6).map(f => `  • [${f.verified ? 'VERIFIED' : 'unverified'}] ${f.type} in ${f.repo}/${f.file}`).join('\n')
      : 'No secrets found.',
  });
  await _completeRun(wbId, run, 0, { count: findings.length, summary });
  return { runId, findings: findings.length, verified };
}

// ══════════════════════════════════════════════════════════════════════
// SUBZY — takeover confirmation
// ══════════════════════════════════════════════════════════════════════
async function runSubzy(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'subzy', options);

  if (!await _hasCommand('subzy')) {
    await _push(wbId, { icon: '⚠', headline: 'subzy not installed',
      detail: 'Install: go install github.com/PentestPad/subzy@latest' });
    await _completeRun(wbId, run, 1, { count: 0, summary: 'subzy missing' });
    throw new Error('subzy not in PATH');
  }

  const inputPath = path.join(reconDir, options.inputFile);
  const targetCount = (await fs.readFile(inputPath, 'utf8')).split('\n').filter(Boolean).length;
  const outFile = path.join(outputDir, 'subzy_output.json');

  await _push(wbId, {
    icon: '◬',
    headline: `Starting subzy on ${targetCount} target(s)`,
    detail: `concurrency=${options.concurrency}, verifySsl=${options.verifySsl} | run=${runId}`,
  });

  const args = [
    'run',
    '--targets', inputPath,
    '--output', outFile,
    '--concurrency', String(options.concurrency),
    '--hide_fails',
  ];
  if (!options.verifySsl) args.push('--verify_ssl=false');

  const r = await _runCmd('subzy', args, 30 * 60 * 1000);
  _activeRuns.set(wbId, { runId, toolId: 'subzy', child: null, startedAt: run.startedAt });

  // Parse subzy output
  const findings = [];
  if (await fs.pathExists(outFile)) {
    try {
      const data = await fs.readJson(outFile);
      for (const item of (data.results || data)) {
        if (item.status === 'VULNERABLE' || item.vulnerable === true) {
          findings.push({
            host: item.subdomain || item.target,
            service: item.engine || item.fingerprint || 'unknown',
          });
        }
      }
    } catch {
      // Fallback: parse stdout
      for (const line of r.stdout.split('\n')) {
        const m = line.match(/VULNERABLE.*?\[(.+?)\].*?:\s*(\S+)/);
        if (m) findings.push({ host: m[2], service: m[1] });
      }
    }
  }

  const lines = findings.map(f => `[VULNERABLE]\t${f.service}\t${f.host}`);
  await _appendUnique(path.join(reconDir, 'takeover_findings.txt'), lines);

  const summary = `${findings.length} confirmed takeover(s) of ${targetCount} candidate(s)`;
  await _writeFindingsSummary(outputDir, 'subzy', options, lines, summary);
  await _push(wbId, {
    icon: findings.length > 0 ? '🚨' : '✓',
    headline: `subzy complete: ${summary}`,
    detail: findings.length > 0
      ? findings.slice(0, 8).map(f => `  • ${f.host} → ${f.service}`).join('\n')
      : 'No confirmed takeovers.',
  });
  await _completeRun(wbId, run, 0, { count: findings.length, summary });
  return { runId, findings: findings.length };
}




// ══════════════════════════════════════════════════════════════════════
// SITE MIRROR — recursive download for richer offline analysis
// ══════════════════════════════════════════════════════════════════════
async function runMirror(wbId, options) {
  const { wb, reconDir, runId, outputDir, run } = await _gateAndPrepare(wbId, 'mirror', options);

  if (!await _hasCommand('wget')) {
    await _push(wbId, { icon: '⚠', headline: 'wget not installed',
      detail: 'Install: apt install wget' });
    await _completeRun(wbId, run, 1, { count: 0, summary: 'wget missing' });
    throw new Error('wget not in PATH');
  }

  const inputPath = path.join(reconDir, options.inputFile);
  const targets = (await fs.readFile(inputPath, 'utf8')).split('\n').filter(Boolean);
  const mirrorDir = path.join(outputDir, 'mirror');
  await fs.ensureDir(mirrorDir);

  await _push(wbId, {
    icon: '⛁',
    headline: 'Mirroring ' + targets.length + ' target(s) — depth=' + options.depth + ', cap=' + options.maxPagesPerHost + '/host',
    detail: 'This will take a while. Rate=' + Number(options.rateLimit).toFixed(1) + '/s, assets=' + (options.includeAssets ? 'on' : 'off') + ' | run=' + runId,
  });

  let totalPages = 0;
  let totalBytes = 0;
  const perHostStats = [];
  const newUrlsDiscovered = new Set();
  const newParamsDiscovered = new Set();
  const newJsFilesDiscovered = new Set();
  const formsFound = [];
  const commentsFound = [];

  // Patterns we'll need (defined once, reused per page)
  const RE_INLINE_PATH = /["'](\/[a-zA-Z][a-zA-Z0-9_\-\/.]+)["']/g;
  const RE_NUMERIC_UNIT = /^\/(em|ms|px|pt|rem|vh|vw)$/i;
  const RE_ANCHOR_HREF = /<a[^>]+href=["']([^"'#]+)["']/gi;
  const RE_FORM_BLOCK = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  const RE_FORM_ACTION = /action=["']([^"']*)["']/i;
  const RE_FORM_METHOD = /method=["']([^"']*)["']/i;
  const RE_INPUT_NAME = /<input[^>]+name=["']([^"']+)["']/gi;
  const RE_SCRIPT_SRC = /<script[^>]+src=["']([^"']+)["']/gi;
  const RE_HTML_COMMENT = /<!--([\s\S]*?)-->/g;
  const RE_BORING_COMMENT = /^(\[if|<!\[CDATA|googleoff|googleon|noindex|begin|end)/i;
  const RE_INTERESTING_COMMENT = /(TODO|FIXME|XXX|BUG|HACK|debug|password|secret|api[_-]?key|token|admin|internal|prod|staging|test|http:\/\/|https:\/\/|\/\/[a-zA-Z])/i;
  const RE_JS_EXT = /\.js(\?|$)/;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const safeHost = _sanitize(target.replace(/^https?:\/\//, '').replace(/\/.*/, ''));
    const hostDir = path.join(mirrorDir, safeHost);
    await fs.ensureDir(hostDir);

    const wait = options.rateLimit > 0 ? (1 / options.rateLimit).toFixed(2) : '0.5';
    const logFile = path.join(outputDir, 'wget_' + safeHost + '.log');
    const args = [
      '--recursive', '--level=' + options.depth,
      '--directory-prefix=' + hostDir,
      '--no-parent',
      '--no-host-directories',
      '--convert-links',
      '--adjust-extension',
      '--page-requisites',
      '--quota=200m',
      '--wait=' + wait,
      '--random-wait',
      '--user-agent=Mozilla/5.0 (Tentacles mirror)',
      '--tries=2',
      '--timeout=20',
      '--quiet',
      '--output-file=' + logFile,
    ];
    if (!options.includeAssets) {
      args.push('--reject', 'css,png,jpg,jpeg,gif,webp,ico,woff,woff2,ttf,eot,svg,mp4,mp3,pdf,zip');
    }
    args.push(target);

    await _push(wbId, {
      icon: '⛁',
      headline: 'Mirroring ' + target + ' (' + (i+1) + '/' + targets.length + ')...',
    });

    let pagesThisHost = 0;
    await new Promise((resolve) => {
      const child = spawn('wget', args, { timeout: 30 * 60 * 1000 });
      _activeRuns.set(wbId, { runId, toolId: 'mirror', child, startedAt: run.startedAt });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });

    async function walk(dir) {
      let entries = [];
      try { entries = await fs.readdir(dir); } catch { return; }
      for (const name of entries) {
        const fp = path.join(dir, name);
        let stat;
        try { stat = await fs.stat(fp); } catch { continue; }
        if (stat.isDirectory()) {
          await walk(fp);
        } else if (stat.size > 0) {
          totalBytes += stat.size;
          if (pagesThisHost >= options.maxPagesPerHost) continue;
          const ext = path.extname(name).toLowerCase();
          if (['.html', '.htm', '.php', '.asp', '.aspx', '.jsp'].includes(ext) || !ext) {
            pagesThisHost++;
            try {
              const content = await fs.readFile(fp, 'utf8');
              _scrapeMirrorPage(content, target, {
                urls: newUrlsDiscovered,
                params: newParamsDiscovered,
                jsFiles: newJsFilesDiscovered,
                forms: formsFound,
                comments: commentsFound,
              }, {
                RE_INLINE_PATH, RE_NUMERIC_UNIT, RE_ANCHOR_HREF, RE_FORM_BLOCK,
                RE_FORM_ACTION, RE_FORM_METHOD, RE_INPUT_NAME, RE_SCRIPT_SRC,
                RE_HTML_COMMENT, RE_BORING_COMMENT, RE_INTERESTING_COMMENT, RE_JS_EXT,
              });
            } catch {}
          } else if (ext === '.js' && stat.size < 2_000_000) {
            try {
              const content = await fs.readFile(fp, 'utf8');
              for (const m of content.matchAll(RE_INLINE_PATH)) {
                const ep = m[1];
                if (ep.length >= 3 && ep.length <= 500 && !RE_NUMERIC_UNIT.test(ep)) {
                  newUrlsDiscovered.add(target.replace(/\/$/, '') + ep);
                }
              }
            } catch {}
          }
        }
      }
    }
    await walk(hostDir);

    totalPages += pagesThisHost;
    perHostStats.push({ host: target, pages: pagesThisHost });
  }

  const newUrls = Array.from(newUrlsDiscovered);
  const newParams = Array.from(newParamsDiscovered);
  const newJsFiles = Array.from(newJsFilesDiscovered);

  const urlsMerged = await _appendUnique(path.join(reconDir, 'all_urls.txt'), newUrls);
  const paramsMerged = await _appendUnique(path.join(reconDir, 'params.txt'), newParams);
  const jsMerged = await _appendUnique(path.join(reconDir, 'js_files.txt'), newJsFiles);

  const formLines = formsFound.slice(0, 200).map(f =>
    '[' + f.method.toUpperCase() + '] ' + f.action + '\t' + f.inputs.join(',')
  );
  await _appendUnique(path.join(reconDir, 'forms.txt'), formLines);

  const commentLines = commentsFound.slice(0, 200).map(c =>
    c.host + '\t' + c.comment.slice(0, 200)
  );
  await _appendUnique(path.join(reconDir, 'html_comments.txt'), commentLines);

  const lines = [
    '=== Site mirror complete ===',
    'Targets crawled: ' + targets.length,
    'Total pages saved: ' + totalPages,
    'Total bytes downloaded: ' + (totalBytes/1024/1024).toFixed(1) + ' MB',
    '',
    '=== Per-host page counts ===',
    ...perHostStats.map(s => '  ' + s.host + ': ' + s.pages + ' page(s)'),
    '',
    '=== New URLs discovered: ' + newUrls.length + ' (' + urlsMerged.added + ' added to recon) ===',
    ...newUrls.slice(0, 100),
    newUrls.length > 100 ? '  ...(+' + (newUrls.length - 100) + ' more)' : '',
    '',
    '=== New params discovered: ' + newParams.length + ' (' + paramsMerged.added + ' new) ===',
    ...newParams.slice(0, 100),
    '',
    '=== New JS files: ' + newJsFiles.length + ' (' + jsMerged.added + ' new) ===',
    ...newJsFiles.slice(0, 50),
    '',
    '=== Forms found: ' + formsFound.length + ' ===',
    ...formsFound.slice(0, 50).map(f => '  [' + f.method.toUpperCase() + '] ' + f.action + ' — inputs: ' + f.inputs.join(', ')),
    '',
    '=== Interesting HTML comments: ' + commentsFound.length + ' ===',
    ...commentsFound.slice(0, 50).map(c => '  ' + c.host + ': ' + c.comment.slice(0, 160)),
  ].filter(Boolean);

  const summary = totalPages + ' page(s) mirrored, ' + (totalBytes/1024/1024).toFixed(1) + 'MB. +' + urlsMerged.added + ' URLs, +' + paramsMerged.added + ' params, +' + formsFound.length + ' forms, +' + commentsFound.length + ' HTML comments';
  await _writeFindingsSummary(outputDir, 'Site Mirror', options, lines, summary);

  await _push(wbId, {
    icon: '✓',
    headline: 'Site mirror complete: ' + summary,
    detail: 'Output: ' + mirrorDir + '\nForms: ' + formsFound.length + ' | Comments: ' + commentsFound.length + ' | New URLs: +' + urlsMerged.added,
  });

  await _completeRun(wbId, run, 0, { count: totalPages, summary });

  return { runId, pages: totalPages, bytes: totalBytes, newUrls: newUrls.length, newParams: newParams.length, forms: formsFound.length };
}

function _scrapeMirrorPage(html, baseHost, sinks, RE) {
  const baseHostNoProto = baseHost.replace(/^https?:\/\//, '').replace(/\/.*/, '');

  for (const m of html.matchAll(RE.RE_ANCHOR_HREF)) {
    const href = m[1];
    if (href.startsWith('javascript:')) continue;
    const url = _resolveUrl(href, baseHost);
    if (url) sinks.urls.add(url);
  }

  for (const m of html.matchAll(RE.RE_FORM_BLOCK)) {
    const attrs = m[1];
    const body = m[2];
    const action = (attrs.match(RE.RE_FORM_ACTION) || [, ''])[1];
    const method = (attrs.match(RE.RE_FORM_METHOD) || [, 'GET'])[1] || 'GET';
    const inputs = [];
    for (const inp of body.matchAll(RE.RE_INPUT_NAME)) {
      inputs.push(inp[1]);
      sinks.params.add(inp[1]);
    }
    sinks.forms.push({
      action: _resolveUrl(action || '/', baseHost) || action || '(self)',
      method,
      inputs,
    });
  }

  for (const m of html.matchAll(RE.RE_SCRIPT_SRC)) {
    const src = m[1];
    const url = _resolveUrl(src, baseHost);
    if (url && RE.RE_JS_EXT.test(url)) sinks.jsFiles.add(url);
  }

  for (const m of html.matchAll(RE.RE_INLINE_PATH)) {
    const ep = m[1];
    if (ep.length >= 3 && ep.length <= 500 && !RE.RE_NUMERIC_UNIT.test(ep)) {
      sinks.urls.add(baseHost.replace(/\/$/, '') + ep);
    }
  }

  for (const m of html.matchAll(RE.RE_HTML_COMMENT)) {
    const comment = m[1].trim();
    if (comment.length < 8 || comment.length > 400) continue;
    if (RE.RE_BORING_COMMENT.test(comment)) continue;
    if (RE.RE_INTERESTING_COMMENT.test(comment)) {
      sinks.comments.push({ host: baseHostNoProto, comment });
    }
  }
}

function _resolveUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}


module.exports = {
  runFfuf,
  runArjun,
  runJsAnalyzer,
  runNuclei,
  runReflection,
  runGowitness,
  runTestssl,
  runWafw00f,
  runWhatweb,
  runS3scanner,
  runGithubRecon,
  runSubzy,
  runMirror,
  isToolRunning,
  getActiveRun,
  getToolRuns,
  getToolRun,
  getToolRunOutput,
  readRunFile,
  stopRun,
};
