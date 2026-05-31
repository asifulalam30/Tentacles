/**
 * RECON DEEPEN — focused second-pass recon
 *
 * Triggered when the user wants to dig deeper on something:
 *   - "expand subdomains" — re-run with more sources, longer timeout
 *   - "deeper JS analysis" — pull all alive hosts and analyze JS bundles
 *   - "expand ports" — port scan everything alive
 *   - "expand parameters" — fuzz known endpoints for hidden params
 *   - "expand schemas" — probe for swagger/openapi/graphql on every alive host
 *
 * Each adds findings to the chat stream just like initial recon does, but
 * doesn't re-run the brief generator (the brief is updated incrementally
 * via the normal lead-generation flow when recon stream messages arrive).
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const { executeTool } = require('../tools/executor');
const { parse } = require('../parser/outputParser');
const sessionStore = require('./sessionStore');
const chatEngine = require('./chatEngine');
const stateManager = require('../state/stateManager');

const _activeDeepens = new Map(); // wbId -> { mode, startedAt }

const DEEPEN_MODES = {
  subdomains:  { label: 'Expand subdomains',     description: 'Run additional passive enumeration sources' },
  js_analysis: { label: 'Deep JS analysis',      description: 'Pull all alive hosts, analyze every JS bundle' },
  ports:       { label: 'Port scan alive hosts', description: 'Scan top-1000 ports on every alive host' },
  parameters:  { label: 'Param fuzzing',         description: 'Discover hidden parameters on known endpoints' },
  schemas:     { label: 'Schema discovery',      description: 'Look for OpenAPI/Swagger/GraphQL on every alive host' },
};

async function _push(wbId, finding) {
  return chatEngine.pushReconFinding(wbId, finding).catch(() => {});
}

async function _readAliveHosts(wbId) {
  // Try recon_summary.json first; fall back to none
  const summaryPath = path.join(sessionStore.workbenchDir(wbId), 'recon_summary.json');
  try {
    const s = await fs.readJson(summaryPath);
    return s.aliveHosts || [];
  } catch {
    return [];
  }
}

async function _modeSubdomains(wbId, target, sessionId, execId) {
  await _push(wbId, { icon: '🔭', headline: 'Expanding subdomain enumeration (passive sources)' });
  // Run subfinder again with -all flag to use more sources
  const r = await executeTool(sessionId, execId, 'shell', {
    command: `subfinder -d ${target} -all -silent 2>/dev/null | sort -u`,
    timeout: 90000,
  }).catch(() => null);
  if (!r?.output) {
    await _push(wbId, { icon: '⚠', headline: 'No additional subdomains found' });
    return;
  }
  const newSubs = r.output.split('\n').map(s => s.trim()).filter(Boolean);
  // Compare against existing
  const summaryPath = path.join(sessionStore.workbenchDir(wbId), 'recon_summary.json');
  let existing = [];
  try { existing = (await fs.readJson(summaryPath)).subdomains || []; } catch {}
  const existingSet = new Set(existing);
  const additions = newSubs.filter(s => !existingSet.has(s));
  if (additions.length === 0) {
    await _push(wbId, { icon: '✓', headline: 'No new subdomains beyond what we already had' });
    return;
  }
  // Persist
  try {
    const s = await fs.readJson(summaryPath).catch(() => ({}));
    s.subdomains = [...new Set([...(s.subdomains || []), ...additions])];
    await fs.writeJson(summaryPath, s);
  } catch {}
  await _push(wbId, {
    icon: '🎯',
    headline: `Found ${additions.length} additional subdomains`,
    detail: additions.slice(0, 12).map(s => `  • \`${s}\``).join('\n') +
            (additions.length > 12 ? `\n  ...(+${additions.length - 12} more)` : ''),
  });
}

async function _modeJsAnalysis(wbId, target, sessionId, execId) {
  const hosts = await _readAliveHosts(wbId);
  if (hosts.length === 0) {
    await _push(wbId, { icon: '⚠', headline: 'No alive hosts on record — run subdomain enum first' });
    return;
  }
  await _push(wbId, {
    icon: '📜', headline: `Deep JS analysis on ${hosts.length} alive host(s)`,
    detail: 'This may take 5-15 minutes for large surfaces.',
  });
  let totalEndpoints = 0, totalSecrets = 0;
  for (const url of hosts.slice(0, 30)) {
    const r = await executeTool(sessionId, execId, 'js_analysis', { target: url }).catch(() => null);
    if (!r?.output) continue;
    const out = r.output;
    const endpoints = [...new Set([...out.matchAll(/["'](\/(?:api|v\d|admin|internal)[\w\/.\-]+)["']/g)].map(m => m[1]))];
    const secrets = [...out.matchAll(/(api[_-]?key|secret|token|aws[_-]?access)[\s'":=]+([A-Za-z0-9_\-]{15,})/gi)];
    if (endpoints.length > 0 || secrets.length > 0) {
      const findings = [];
      if (endpoints.length > 0) findings.push(`${endpoints.length} endpoints`);
      if (secrets.length > 0) findings.push(`${secrets.length} possible secrets`);
      await _push(wbId, {
        icon: '📍',
        headline: `${url}: ${findings.join(', ')}`,
        detail: endpoints.slice(0, 6).map(e => `  • \`${e}\``).join('\n') +
                (secrets.length > 0 ? `\n\nSecrets-like patterns:\n` + secrets.slice(0, 3).map(m => `  • \`${m[1]}: ${m[2].slice(0, 24)}...\``).join('\n') : ''),
      });
      totalEndpoints += endpoints.length;
      totalSecrets += secrets.length;
    }
  }
  await _push(wbId, {
    icon: '✅',
    headline: `Deep JS analysis complete: ${totalEndpoints} endpoints, ${totalSecrets} secrets-like patterns across ${hosts.length} hosts`,
  });
}

async function _modePorts(wbId, target, sessionId, execId) {
  const hosts = await _readAliveHosts(wbId);
  if (hosts.length === 0) {
    await _push(wbId, { icon: '⚠', headline: 'No alive hosts on record — run subdomain enum first' });
    return;
  }
  await _push(wbId, {
    icon: '🔌', headline: `Scanning top 1000 ports on ${Math.min(hosts.length, 20)} host(s)`,
  });
  for (const url of hosts.slice(0, 20)) {
    const host = url.replace(/^https?:\/\//, '').replace(/\/.*/, '').replace(/:\d+$/, '');
    const r = await executeTool(sessionId, execId, 'shell', {
      command: `nmap -Pn --top-ports 1000 -T4 --open ${host} 2>/dev/null | grep -E "^[0-9]+/" || true`,
      timeout: 60000,
    }).catch(() => null);
    if (!r?.output || !r.output.trim()) continue;
    const lines = r.output.split('\n').filter(l => /^\d+\//.test(l)).slice(0, 8);
    if (lines.length > 1) {  // more than just port 443/80
      await _push(wbId, {
        icon: '🚪',
        headline: `${host}: ${lines.length} open port(s)`,
        detail: lines.map(l => `  • ${l.trim()}`).join('\n'),
      });
    }
  }
}

async function _modeParameters(wbId, target, sessionId, execId) {
  const hosts = await _readAliveHosts(wbId);
  if (hosts.length === 0) {
    await _push(wbId, { icon: '⚠', headline: 'No alive hosts — nothing to fuzz' });
    return;
  }
  await _push(wbId, {
    icon: '🔍', headline: `Param fuzzing top ${Math.min(hosts.length, 5)} host(s)`,
    detail: 'Looking for hidden parameters that might leak data.',
  });
  for (const url of hosts.slice(0, 5)) {
    const r = await executeTool(sessionId, execId, 'arjun', { target: url }).catch(() => null);
    if (!r?.output) continue;
    const params = [...new Set([...r.output.matchAll(/[\w_-]+=/g)].map(m => m[0].slice(0, -1)))];
    if (params.length > 0) {
      await _push(wbId, {
        icon: '⚡',
        headline: `${url}: ${params.length} potential parameters discovered`,
        detail: params.slice(0, 12).map(p => `  • \`${p}\``).join('\n'),
      });
    }
  }
}

async function _modeSchemas(wbId, target, sessionId, execId) {
  const hosts = await _readAliveHosts(wbId);
  if (hosts.length === 0) {
    await _push(wbId, { icon: '⚠', headline: 'No alive hosts — nothing to probe' });
    return;
  }
  await _push(wbId, {
    icon: '📐', headline: `Probing for API schemas on ${Math.min(hosts.length, 30)} host(s)`,
  });
  const schemaPaths = ['/swagger.json', '/swagger/v1/swagger.json', '/api/swagger.json',
    '/v1/swagger.json', '/openapi.json', '/api/openapi.json', '/graphql', '/api/graphql',
    '/docs', '/redoc', '/swagger-ui/', '/api-docs'];
  let total = 0;
  for (const url of hosts.slice(0, 30)) {
    for (const sp of schemaPaths) {
      const probeUrl = url.replace(/\/$/, '') + sp;
      const r = await executeTool(sessionId, execId, 'shell', {
        command: `curl -sS -i -o /dev/null -w "%{http_code}|%{content_type}|%{size_download}" --max-time 6 "${probeUrl}"`,
        timeout: 8000,
      }).catch(() => null);
      if (!r?.output) continue;
      const [code, ct, size] = (r.output || '').split('|');
      if (code === '200' && parseInt(size, 10) > 100) {
        const isSchema = (ct || '').match(/json|yaml/) || sp.includes('swagger') || sp.includes('graphql');
        if (isSchema) {
          await _push(wbId, {
            icon: '📋',
            headline: `Schema endpoint: \`${probeUrl}\``,
            detail: `Returns ${code}, content-type ${ct}, ${size} bytes. Worth fetching the full schema.`,
          });
          total++;
        }
      }
    }
  }
  await _push(wbId, { icon: '✅', headline: `Schema discovery complete: ${total} endpoints found` });
}

async function deepenRecon(wbId, mode) {
  if (!DEEPEN_MODES[mode]) throw new Error(`Unknown deepen mode: ${mode}`);
  if (_activeDeepens.has(wbId)) {
    return { alreadyRunning: true, mode: _activeDeepens.get(wbId).mode };
  }
  const wb = await sessionStore.getWorkbench(wbId);
  if (!wb) throw new Error(`Workbench ${wbId} not found`);

  const sessionId = `wb-${wbId}`;
  const execId = `wb-deepen-${Date.now()}`;
  try {
    if (!stateManager.getSession(sessionId)) {
      stateManager.createSession(sessionId, wb.target, {}, wb.program || {});
    }
    if (!stateManager.getExecution(sessionId, execId)) {
      stateManager.createExecution(sessionId, execId);
    }
  } catch {}

  _activeDeepens.set(wbId, { mode, startedAt: Date.now() });
  try {
    if (mode === 'subdomains')   await _modeSubdomains(wbId, wb.target, sessionId, execId);
    else if (mode === 'js_analysis') await _modeJsAnalysis(wbId, wb.target, sessionId, execId);
    else if (mode === 'ports')   await _modePorts(wbId, wb.target, sessionId, execId);
    else if (mode === 'parameters') await _modeParameters(wbId, wb.target, sessionId, execId);
    else if (mode === 'schemas') await _modeSchemas(wbId, wb.target, sessionId, execId);
  } finally {
    _activeDeepens.delete(wbId);
  }
  return { mode, finished: true };
}

function isDeepening(wbId) {
  return _activeDeepens.has(wbId);
}

function deepenStatus(wbId) {
  return _activeDeepens.get(wbId) || null;
}

module.exports = { deepenRecon, isDeepening, deepenStatus, DEEPEN_MODES };
