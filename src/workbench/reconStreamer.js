/**
 * RECON STREAMER (RetroX-powered)
 *
 * Drives recon by spawning the bundled retrox-recon.sh script.
 * Watches stdout for "PHASE N/10" banners + log lines, pushes interesting
 * events into the chat in real time.
 *
 * After the script finishes, all output files are at:
 *   <workbenchDir>/recon/<sanitized_target>/
 * That directory is what the "Recon data" panel reads from.
 *
 * Phases (per retrox-recon.sh):
 *   1/10   Subdomain enumeration
 *   2/10   DNS resolution + CNAMEs
 *   3/10   Port scanning
 *   4/10   HTTP probing + CDN detection
 *   5/10   URL collection
 *   5.5/10 JavaScript analysis (reordered before params)
 *   6/10   Parameter extraction
 *   7/10   Parameter discovery (Arjun)
 *   8/10   Web fuzzing (ffuf)
 *   9/10   Small probes (GraphQL / .git / .env / backups)
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const sessionStore = require('./sessionStore');
const chatEngine = require('./chatEngine');

const RECON_SCRIPT = path.resolve(__dirname, '../../recon/retrox-recon.sh');
const _activeStreamers = new Map(); // wbId -> { startedAt, currentPhase, child }

// Phase progress mapping for the header progress bar
const _PHASE_PCT = {
  starting: 2,
  '1/10': 10,   // subdomain enum
  '2/10': 20,   // DNS resolution
  '3/10': 28,   // port scan
  '4/10': 38,   // HTTP probing
  '5/10': 50,   // URL collection
  '5.5/10': 58, // JS analysis
  '6/10': 65,   // param extraction
  '7/10': 72,   // arjun
  '8/10': 88,   // ffuf
  '9/10': 96,   // small probes
};

function _sanitize(s) { return s.replace(/[^A-Za-z0-9._-]/g, '_'); }

async function _push(wbId, finding) {
  return chatEngine.pushReconFinding(wbId, finding).catch(() => {});
}

// Watch the script's output line-by-line, recognize phase transitions + ok/log lines
function _setupOutputWatcher(wbId, child, reconDir, target) {
  let buffer = '';
  let currentPhase = 'starting';

  const handleLine = async (line) => {
    line = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!line) return;

    // Phase banner detection
    const phaseMatch = line.match(/PHASE\s+(\d+(?:\.\d+)?\/10)\s*:\s*(.+)$/);
    if (phaseMatch) {
      currentPhase = phaseMatch[1];
      const phaseLabel = phaseMatch[2].trim();
      const state = _activeStreamers.get(wbId);
      if (state) {
        state.currentPhase = `phase_${currentPhase.replace('/', '_')}`;
        state.phaseLabel = phaseLabel;
      }
      // Persist phase to manifest so the dashboard list can show "subdomain enum"
      // instead of just "recon_running". Best-effort — never block the streamer.
      sessionStore.updateWorkbench(wbId, {
        reconPhase: currentPhase,
        reconPhaseLabel: phaseLabel,
      }).catch(() => {});
      // Don't spam chat with every phase banner — but the workbench header progress updates
      return;
    }

    // [+] OK lines — these are phase summaries with notable counts
    const okMatch = line.match(/^\[\+\]\s+\d{2}:\d{2}:\d{2}\s+(.+)$/);
    if (okMatch) {
      const summary = okMatch[1];

      // Phase 1: subdomain count
      const subMatch = summary.match(/^Subdomains found:\s+(\d+)/);
      if (subMatch && parseInt(subMatch[1], 10) > 0) {
        await _push(wbId, {
          icon: '🔭',
          headline: `Found ${subMatch[1]} subdomains`,
          detail: 'Now resolving them and probing for live HTTP services...',
        });
        return;
      }

      // Phase 2: resolved + CNAMEs + dangling
      const resolvedMatch = summary.match(/Resolved:\s+(\d+)\s+\|\s+IPs:\s+(\d+)\s+\|\s+CNAMEs:\s+(\d+)\s+\|\s+Dangling:\s+(\d+)/);
      if (resolvedMatch) {
        const [, resolved, ips, cnames, dangling] = resolvedMatch;
        const danglingN = parseInt(dangling, 10);
        if (danglingN > 0) {
          // Read dangling.txt to surface specific candidates
          const danglingPath = path.join(reconDir, _sanitize(target), 'dangling.txt');
          let detail = `Resolved ${resolved} | Unique IPs ${ips} | CNAMEs ${cnames}`;
          try {
            const dcontent = await fs.readFile(danglingPath, 'utf8');
            const lines = dcontent.split('\n').filter(Boolean).slice(0, 8);
            if (lines.length > 0) {
              detail += `\n\nDangling CNAMEs (takeover candidates):\n` +
                        lines.map(l => `  • ${l}`).join('\n');
            }
          } catch {}
          await _push(wbId, {
            icon: '🚩',
            headline: `${danglingN} dangling CNAME(s) found — possible takeover targets`,
            detail,
          });
        } else {
          await _push(wbId, {
            icon: '🌐',
            headline: `DNS resolution: ${resolved} resolved | ${ips} unique IPs | ${cnames} CNAMEs`,
          });
        }
        return;
      }

      // Phase 4: alive hosts
      const aliveMatch = summary.match(/^Alive:\s+(\d+)\s+\|\s+Cloudflare:\s+(\d+)\s+\|\s+Direct:\s+(\d+)\s+\|\s+Tech:\s+(\d+)/);
      if (aliveMatch) {
        const [, alive, cf, direct, tech] = aliveMatch;
        const directN = parseInt(direct, 10);
        let detail = `Alive ${alive} | Behind Cloudflare ${cf} | Direct ${directN} | Tech-detected ${tech}`;
        // Read direct_hosts.txt to surface specific direct hosts
        if (directN > 0) {
          const directPath = path.join(reconDir, _sanitize(target), 'direct_hosts.txt');
          try {
            const dcontent = await fs.readFile(directPath, 'utf8');
            const lines = dcontent.split('\n').filter(Boolean).slice(0, 10);
            detail += `\n\nDirect hosts (priority targets — no CDN):\n` +
                      lines.map(l => `  • \`${l}\``).join('\n') +
                      (parseInt(direct, 10) > 10 ? `\n  ...(+${directN - 10} more)` : '');
          } catch {}
        }
        await _push(wbId, {
          icon: directN > 0 ? '🚀' : '🛡',
          headline: directN > 0
            ? `${directN} alive host(s) NOT behind a CDN — these are your priority targets`
            : `${alive} alive but all behind Cloudflare`,
          detail,
        });
        return;
      }

      // Phase 5: URL collection
      const urlMatch = summary.match(/^URLs collected:\s+(\d+)/);
      if (urlMatch && parseInt(urlMatch[1], 10) > 0) {
        await _push(wbId, {
          icon: '🔗', headline: `Collected ${urlMatch[1]} URLs from wayback/gau/katana`,
        });
        return;
      }

      // Phase 5.5: JS analysis
      const jsMatch = summary.match(/JS files:\s+(\d+)\s+\|\s+Endpoints:\s+(\d+)\s+\|\s+Potential secrets:\s+(\d+)/);
      if (jsMatch) {
        const [, files, endpoints, secrets] = jsMatch;
        const secretsN = parseInt(secrets, 10);
        let detail = `Analyzed ${files} JS bundles. Extracted ${endpoints} endpoints.`;
        if (secretsN > 0) {
          // Surface a few specific secret hits
          const secretsPath = path.join(reconDir, _sanitize(target), 'js_secrets.txt');
          try {
            const sc = await fs.readFile(secretsPath, 'utf8');
            const lines = sc.split('\n').filter(Boolean).slice(0, 5);
            detail += `\n\nPossible secrets (verify before reporting):\n` +
                      lines.map(l => `  • \`${l.slice(0, 120)}\``).join('\n');
          } catch {}
        }
        await _push(wbId, {
          icon: secretsN > 0 ? '🔍' : '📜',
          headline: secretsN > 0
            ? `JS analysis: ${secretsN} potential secret(s) found in ${files} bundles`
            : `JS analysis: ${endpoints} endpoints extracted from ${files} bundles`,
          detail,
        });
        return;
      }

      // Phase 6: params
      const paramMatch = summary.match(/Unique params:\s+(\d+)\s+\|\s+Detailed:\s+\d+\s+\|\s+API:\s+(\d+)/);
      if (paramMatch) {
        const [, params, api] = paramMatch;
        if (parseInt(api, 10) > 0) {
          await _push(wbId, {
            icon: '⚡',
            headline: `${params} unique params extracted | ${api} API endpoints found`,
          });
        }
        return;
      }

      // Phase 7: Arjun
      const arjunMatch = summary.match(/Arjun complete:\s+(\d+)\s+\/\s+(\d+)/);
      if (arjunMatch) {
        await _push(wbId, {
          icon: '🔬',
          headline: `Arjun param discovery complete (${arjunMatch[1]} hosts scanned)`,
        });
        return;
      }

      // Phase 8: FFUF
      const ffufMatch = summary.match(/FFUF complete:\s+(\d+)\s+findings\s+across\s+(\d+)\s+scans/);
      if (ffufMatch) {
        const [, findings, scans] = ffufMatch;
        const findingsN = parseInt(findings, 10);
        let detail = `Fuzzed ${scans} hosts.`;
        if (findingsN > 0) {
          const ffufPath = path.join(reconDir, _sanitize(target), 'ffuf_findings.txt');
          try {
            const fc = await fs.readFile(ffufPath, 'utf8');
            const lines = fc.split('\n').filter(Boolean).slice(0, 8);
            detail += `\n\nTop hits:\n` + lines.map(l => `  • ${l}`).join('\n');
          } catch {}
        }
        await _push(wbId, {
          icon: findingsN > 0 ? '🎯' : '✓',
          headline: `Web fuzzing: ${findings} findings across ${scans} hosts`,
          detail,
        });
        return;
      }

      // Phase 9: small probes
      const probeMatch = summary.match(/Probes: GraphQL=(\d+) \| Git=(\d+) \| Env=(\d+) \| Backup=(\d+) \| SecurityTxt=(\d+)/);
      if (probeMatch) {
        const [, gql, git, env, backup] = probeMatch;
        const interesting = [
          parseInt(gql, 10) > 0 && `${gql} GraphQL endpoint(s)`,
          parseInt(git, 10) > 0 && `${git} exposed .git`,
          parseInt(env, 10) > 0 && `${env} exposed .env`,
          parseInt(backup, 10) > 0 && `${backup} backup file(s)`,
        ].filter(Boolean);
        if (interesting.length > 0) {
          // Each of these alone could be a confirmed bug
          let detail = `Files in your recon dir: graphql_endpoints.txt, git_exposed.txt, env_exposed.txt, backup_files.txt`;
          // Surface .git/.env hits since those are usually critical
          for (const [name, file] of [['.git', 'git_exposed.txt'], ['.env', 'env_exposed.txt']]) {
            try {
              const fp = path.join(reconDir, _sanitize(target), file);
              const c = await fs.readFile(fp, 'utf8');
              const lines = c.split('\n').filter(Boolean).slice(0, 3);
              if (lines.length > 0) {
                detail += `\n\n${name} hits:\n` + lines.map(l => `  • \`${l}\``).join('\n');
              }
            } catch {}
          }
          await _push(wbId, {
            icon: '🚨',
            headline: `Cheap-win probes: ${interesting.join(', ')}`,
            detail,
          });
        } else {
          await _push(wbId, {
            icon: '✓',
            headline: 'Cheap-win probes complete — nothing exposed',
          });
        }
        return;
      }
    }
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) handleLine(line).catch(() => {});
  });
  // Same for stderr (in case retrox writes log lines there)
  child.stderr.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) handleLine(line).catch(() => {});
  });
}

/**
 * Recon options:
 *   skipSubs:   true → SKIP_SUBS=1     (skip subdomain enum)
 *   skipDns:    true → SKIP_DNS=1      (skip DNS resolution)
 *   skipPorts:  true → SKIP_NMAP=1     (skip port scanning)
 *   skipHttp:   true → SKIP_HTTP=1     (skip HTTP probing)
 *   skipUrls:   true → SKIP_URLS=1     (skip wayback/gau/katana)
 *   skipJs:     true → SKIP_JS=1       (skip JS analysis)
 *   skipParams: true → SKIP_PARAMS=1   (skip param extraction)
 *   skipArjun:  true → SKIP_ARJUN=1    (skip param discovery)
 *   skipFfuf:   true → SKIP_FFUF=1     (skip web fuzzing)
 *   skipProbes: true → SKIP_PROBES=1   (skip cheap-win probes)
 *   deepScan:   true → DEEP_SCAN=1     (full port range)
 *   onlyPhase:  string  (one of 'subs','dns','ports','http','urls','js','params','arjun','ffuf','probes')
 *                       sets all other skips to true
 */
async function runStreamingRecon(wbId, options = {}) {
  // Per-phase mode: skip everything except the requested phase
  if (options.onlyPhase) {
    const phaseToSkip = {
      subs:   { skipDns: true, skipPorts: true, skipHttp: true, skipUrls: true, skipJs: true, skipParams: true, skipArjun: true, skipFfuf: true, skipProbes: true },
      dns:    { skipSubs: true, skipPorts: true, skipHttp: true, skipUrls: true, skipJs: true, skipParams: true, skipArjun: true, skipFfuf: true, skipProbes: true },
      ports:  { skipSubs: true, skipDns: true, skipHttp: true, skipUrls: true, skipJs: true, skipParams: true, skipArjun: true, skipFfuf: true, skipProbes: true },
      http:   { skipSubs: true, skipDns: true, skipPorts: true, skipUrls: true, skipJs: true, skipParams: true, skipArjun: true, skipFfuf: true, skipProbes: true },
      urls:   { skipSubs: true, skipDns: true, skipPorts: true, skipHttp: true, skipJs: true, skipParams: true, skipArjun: true, skipFfuf: true, skipProbes: true },
      js:     { skipSubs: true, skipDns: true, skipPorts: true, skipHttp: true, skipUrls: true, skipParams: true, skipArjun: true, skipFfuf: true, skipProbes: true },
      params: { skipSubs: true, skipDns: true, skipPorts: true, skipHttp: true, skipUrls: true, skipJs: true, skipArjun: true, skipFfuf: true, skipProbes: true },
      arjun:  { skipSubs: true, skipDns: true, skipPorts: true, skipHttp: true, skipUrls: true, skipJs: true, skipParams: true, skipFfuf: true, skipProbes: true },
      ffuf:   { skipSubs: true, skipDns: true, skipPorts: true, skipHttp: true, skipUrls: true, skipJs: true, skipParams: true, skipArjun: true, skipProbes: true },
      probes: { skipSubs: true, skipDns: true, skipPorts: true, skipHttp: true, skipUrls: true, skipJs: true, skipParams: true, skipArjun: true, skipFfuf: true },
    };
    if (!phaseToSkip[options.onlyPhase]) {
      throw new Error(`Unknown phase: ${options.onlyPhase}`);
    }
    options = { ...phaseToSkip[options.onlyPhase], _onlyPhase: options.onlyPhase };
  }

  if (_activeStreamers.has(wbId)) return { alreadyRunning: true };

  const wb = await sessionStore.getWorkbench(wbId);
  if (!wb) throw new Error(`Workbench ${wbId} not found`);
  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  // Recon outputs go inside workbench dir
  const reconDir = path.join(sessionStore.workbenchDir(wbId), 'recon');
  await fs.ensureDir(reconDir);

  // Build a human description of what will run based on options
  const phaseLabels = {
    subs: 'subdomain enum', dns: 'DNS resolution', ports: 'port scan', http: 'HTTP probe',
    urls: 'URL collection', js: 'JS analysis', params: 'param extraction',
    arjun: 'Arjun', ffuf: 'FFUF', probes: 'cheap-win probes',
  };
  let detailMsg;
  if (options._onlyPhase) {
    detailMsg = `Running only: ${phaseLabels[options._onlyPhase] || options._onlyPhase}. Other phases skipped.`;
  } else {
    const skipped = [];
    if (options.skipSubs)   skipped.push('subdomain enum');
    if (options.skipDns)    skipped.push('DNS');
    if (options.skipPorts)  skipped.push('port scan');
    if (options.skipHttp)   skipped.push('HTTP probe');
    if (options.skipUrls)   skipped.push('URL collection');
    if (options.skipJs)     skipped.push('JS analysis');
    if (options.skipParams) skipped.push('params');
    if (options.skipArjun)  skipped.push('Arjun');
    if (options.skipFfuf)   skipped.push('FFUF');
    if (options.skipProbes) skipped.push('cheap-win probes');
    detailMsg = skipped.length === 0
      ? 'Full scan: subdomain enum → DNS → ports → HTTP probe → URLs → JS → params → arjun → ffuf → small probes. 5-25 minutes depending on surface.'
      : `Skipping: ${skipped.join(', ')}. Other phases will run normally.`;
  }

  await _push(wbId, {
    icon: '🚀',
    headline: `Starting RetroX recon on ${target}`,
    detail: detailMsg,
  });

  if (!await fs.pathExists(RECON_SCRIPT)) {
    await _push(wbId, {
      icon: '⚠',
      headline: `Recon script not found at ${RECON_SCRIPT}`,
      detail: 'Reinstall the Tentacles tarball — recon/retrox-recon.sh is missing.',
    });
    return { error: 'recon script missing' };
  }

  await sessionStore.updateWorkbench(wbId, { state: 'recon_running' });
  _activeStreamers.set(wbId, {
    startedAt: Date.now(),
    currentPhase: 'starting',
    target,
  });

  return new Promise((resolve) => {
    const reconEnv = { ...process.env, NO_COLOR: '1' };
    if (options.skipSubs)   reconEnv.SKIP_SUBS   = '1';
    if (options.skipDns)    reconEnv.SKIP_DNS    = '1';
    if (options.skipPorts)  reconEnv.SKIP_NMAP   = '1';
    if (options.skipHttp)   reconEnv.SKIP_HTTP   = '1';
    if (options.skipUrls)   reconEnv.SKIP_URLS   = '1';
    if (options.skipJs)     reconEnv.SKIP_JS     = '1';
    if (options.skipParams) reconEnv.SKIP_PARAMS = '1';
    if (options.skipArjun)  reconEnv.SKIP_ARJUN  = '1';
    if (options.skipFfuf)   reconEnv.SKIP_FFUF   = '1';
    if (options.skipProbes) reconEnv.SKIP_PROBES = '1';
    if (options.deepScan)   reconEnv.DEEP_SCAN   = '1';

    const enabledPhases = [];
    if (!options.skipPorts)  enabledPhases.push('ports');
    if (!options.skipUrls)   enabledPhases.push('URLs');
    if (!options.skipJs)     enabledPhases.push('JS');
    if (!options.skipArjun)  enabledPhases.push('arjun');
    if (!options.skipFfuf)   enabledPhases.push('ffuf');
    if (!options.skipProbes) enabledPhases.push('probes');

    const child = spawn('bash', [RECON_SCRIPT, target, reconDir], {
      cwd: reconDir,
      env: reconEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    _activeStreamers.get(wbId).child = child;
    _setupOutputWatcher(wbId, child, reconDir, target);

    child.on('error', async (err) => {
      await _push(wbId, {
        icon: '⚠',
        headline: `Recon failed to start: ${err.message}`,
        detail: 'Make sure bash, subfinder, httpx, dig, jq, etc. are installed on the VPS.',
      });
      _activeStreamers.delete(wbId);
      await sessionStore.updateWorkbench(wbId, {
        state: 'idle',
        reconPhase: null,
        reconPhaseLabel: null,
      });
      try {
        require('./chatEngine').broadcastEvent(wbId, 'recon_finished', {
          exitCode: -1,
          error: err.message,
        });
      } catch (e) { /* best-effort */ }
      resolve({ error: err.message });
    });

    child.on('close', async (code) => {
      const dt = ((Date.now() - _activeStreamers.get(wbId).startedAt) / 1000).toFixed(1);

      // Record which phases ran for the per-phase UI's "last run" timestamps
      try {
        const phaseRunsPath = path.join(sessionStore.workbenchDir(wbId), 'phase_runs.json');
        let runs = {};
        if (await fs.pathExists(phaseRunsPath)) {
          try { runs = await fs.readJson(phaseRunsPath); } catch {}
        }
        const phasesRan = [];
        if (!options.skipSubs)   phasesRan.push('subs');
        if (!options.skipDns)    phasesRan.push('dns');
        if (!options.skipPorts)  phasesRan.push('ports');
        if (!options.skipHttp)   phasesRan.push('http');
        if (!options.skipUrls)   phasesRan.push('urls');
        if (!options.skipJs)     phasesRan.push('js');
        if (!options.skipParams) phasesRan.push('params');
        if (!options.skipArjun)  phasesRan.push('arjun');
        if (!options.skipFfuf)   phasesRan.push('ffuf');
        if (!options.skipProbes) phasesRan.push('probes');
        const completedAt = code === 0 ? Date.now() : null;
        for (const p of phasesRan) {
          runs[p] = { completedAt, exitCode: code, durationSec: parseFloat(dt) };
        }
        await fs.writeJson(phaseRunsPath, runs, { spaces: 2 });
      } catch (e) {
        // Best-effort, don't crash the stream completion
      }

      await _push(wbId, {
        icon: code === 0 ? '✅' : '⚠',
        headline: code === 0
          ? `Recon complete in ${dt}s`
          : `Recon exited with code ${code} after ${dt}s`,
        detail: 'Now generating brief and lead list. Open the brief panel to see all the recon data.',
      });
      _activeStreamers.delete(wbId);
      // On success, mark state=recon_complete so dashboard shows a green dot.
      // On failure, fall back to idle so user can retry.
      await sessionStore.updateWorkbench(wbId, {
        state: code === 0 ? 'recon_complete' : 'idle',
        reconPhase: null,
        reconPhaseLabel: null,
      });

      // Broadcast recon-finished so the UI flips reconRunning to false immediately
      // (otherwise the dashboard stays in "starting/running" state forever)
      try {
        require('./chatEngine').broadcastEvent(wbId, 'recon_finished', {
          exitCode: code,
          durationSec: parseFloat(dt),
        });
      } catch (e) { /* best-effort */ }

      // Hand off to reconAdapter for static brief generation
      try {
        const reconAdapter = require('./reconAdapter');
        await reconAdapter.runReconForWorkbench(wbId, { skipShellCalls: true });
      } catch (e) {
        await _push(wbId, {
          icon: '⚠',
          headline: `Brief generation failed: ${e.message}`,
        });
      }

      // Auto-sweep: if recon succeeded and the workbench wasn't created with
      // `skipAutoSweep`, queue a full sweep. The queue handles concurrency
      // (cap-3) so this just enqueues — actual execution may wait.
      if (code === 0) {
        try {
          const wb = await sessionStore.getWorkbench(wbId);
          if (wb && wb.autoSweep !== false) {
            const sweepQueue = require('./sweepQueue');
            const result = await sweepQueue.enqueueSweep(wbId, {
              level: 'heavy',
              stealth: true,
              speed: 'standard',
            });
            await _push(wbId, {
              icon: '🚀',
              headline: result.queued
                ? `Auto-sweep queued (position ${result.position})`
                : 'Auto-sweep starting',
              detail: 'Disable per-workbench by unchecking "Auto-sweep" when creating it.',
            });
          }
        } catch (e) {
          await _push(wbId, {
            icon: '⚠',
            headline: `Auto-sweep failed to enqueue: ${e.message}`,
          });
        }
      }

      resolve({ code, dt });
    });
  });
}

function isReconRunning(wbId) {
  return _activeStreamers.has(wbId);
}

function reconStatus(wbId) {
  const s = _activeStreamers.get(wbId);
  if (!s) return null;
  return { currentPhase: s.currentPhase, phaseLabel: s.phaseLabel, target: s.target, startedAt: s.startedAt };
}

function killRecon(wbId) {
  const s = _activeStreamers.get(wbId);
  if (!s || !s.child) return false;
  try { s.child.kill('SIGTERM'); } catch {}
  return true;
}

module.exports = { runStreamingRecon, isReconRunning, reconStatus, killRecon };
