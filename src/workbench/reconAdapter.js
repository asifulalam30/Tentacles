/**
 * RECON ADAPTER (post-recon brief + lead generation)
 *
 * Called after retrox-recon.sh finishes. Reads the recon output files,
 * builds a structured summary, hands to LLM for the engagement brief,
 * then triggers lead generation.
 *
 * This module no longer runs recon itself — that's reconStreamer.js's job.
 * It only does post-processing.
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const sessionStore = require('./sessionStore');

const _activeBriefGen = new Map(); // wbId -> { startedAt }

function _sanitize(s) { return s.replace(/[^A-Za-z0-9._-]/g, '_'); }

async function _readLines(file, limit = 100) {
  if (!await fs.pathExists(file)) return [];
  const c = await fs.readFile(file, 'utf8');
  return c.split('\n').filter(Boolean).slice(0, limit);
}

async function _countLines(file) {
  if (!await fs.pathExists(file)) return 0;
  const c = await fs.readFile(file, 'utf8');
  return c.split('\n').filter(Boolean).length;
}

/**
 * Build the structured summary by reading retrox-recon.sh output files.
 * Returns an object suitable for handing to the LLM brief generator.
 */
async function buildSummaryFromReconDir(wbId, target) {
  const reconDir = path.join(sessionStore.workbenchDir(wbId), 'recon', _sanitize(target));
  if (!await fs.pathExists(reconDir)) {
    return { error: `Recon directory not found at ${reconDir}` };
  }

  const file = (name) => path.join(reconDir, name);

  const [
    subdomains, resolved, ips, cnames, dangling,
    aliveHosts, cloudflareHosts, directHosts, technologies,
    allUrls, params, apiEndpoints, openPorts, ffufFindings,
    jsFiles, jsEndpoints, jsSecrets,
    graphqlEndpoints, gitExposed, envExposed, backupFiles, securityTxt,
    forms, htmlComments, wafDetections, whatwebFindings,
    takeoverFindings, s3Findings, testsslFindings,
  ] = await Promise.all([
    _readLines(file('all_subs.txt'), 200),
    _readLines(file('resolved.txt'), 100),
    _readLines(file('ips.txt'), 50),
    _readLines(file('cnames.txt'), 100),
    _readLines(file('dangling.txt'), 50),
    _readLines(file('alive_hosts.txt'), 100),
    _readLines(file('cloudflare_hosts.txt'), 100),
    _readLines(file('direct_hosts.txt'), 100),
    _readLines(file('technologies.txt'), 60),
    _readLines(file('all_urls.txt'), 200),
    _readLines(file('params.txt'), 80),
    _readLines(file('api_endpoints.txt'), 60),
    _readLines(file('open_ports.txt'), 30),
    _readLines(file('ffuf_findings.txt'), 60),
    _readLines(file('js_files.txt'), 30),
    _readLines(file('js_endpoints.txt'), 60),
    _readLines(file('js_secrets.txt'), 30),
    _readLines(file('graphql_endpoints.txt'), 30),
    _readLines(file('git_exposed.txt'), 30),
    _readLines(file('env_exposed.txt'), 30),
    _readLines(file('backup_files.txt'), 50),
    _readLines(file('security_txt.txt'), 30),
    _readLines(file('forms.txt'), 80),
    _readLines(file('html_comments.txt'), 60),
    _readLines(file('waf_detections.txt'), 30),
    _readLines(file('whatweb_findings.txt'), 30),
    _readLines(file('takeover_findings.txt'), 20),
    _readLines(file('s3_findings.txt'), 20),
    _readLines(file('testssl_findings.txt'), 30),
  ]);

  return {
    target,
    counts: {
      subdomains: subdomains.length,
      resolved: resolved.length,
      ips: ips.length,
      cnames: cnames.length,
      dangling: dangling.length,
      aliveHosts: aliveHosts.length,
      cloudflareHosts: cloudflareHosts.length,
      directHosts: directHosts.length,
      allUrls: allUrls.length,
      params: params.length,
      apiEndpoints: apiEndpoints.length,
      openPorts: openPorts.length,
      ffufFindings: ffufFindings.length,
      jsFiles: jsFiles.length,
      jsEndpoints: jsEndpoints.length,
      jsSecrets: jsSecrets.length,
      graphqlEndpoints: graphqlEndpoints.length,
      forms: forms.length,
      htmlComments: htmlComments.length,
      takeoverFindings: takeoverFindings.length,
      s3Findings: s3Findings.length,
      testsslFindings: testsslFindings.length,
      gitExposed: gitExposed.length,
      envExposed: envExposed.length,
      backupFiles: backupFiles.length,
      securityTxt: securityTxt.length,
    },
    aliveHosts,
    directHosts,
    cloudflareHosts,
    dangling,
    technologies,
    allUrls,         // full URL list for surface generation
    params,          // parameter names (just names from params.txt)
    apiEndpoints,
    openPorts,
    ffufFindings,
    forms,           // forms.txt — full lines with action, method, inputs
    htmlComments,    // html_comments.txt
    jsFiles,
    jsEndpoints,
    jsSecrets,
    graphqlEndpoints,
    gitExposed,
    envExposed,
    backupFiles,
    securityTxt,
    wafDetections,
    whatwebFindings,
    takeoverFindings,
    s3Findings,
    testsslFindings,
  };
}

// Static brief — formerly LLM-generated. Now a plain-text summary of the
// recon counts so the user has something at a glance without an LLM dep.
function generateBrief(target, summary) {
  const c = summary.counts || {};
  const directHosts = (summary.directHosts || []).slice(0, 20);
  const aliveHosts = (summary.aliveHosts || []).slice(0, 20);
  const dangling = (summary.dangling || []).slice(0, 10);

  const lines = [];
  lines.push(`# Engagement Brief — ${target}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## Recon counts');
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'number' && v > 0) lines.push(`- **${k}**: ${v}`);
  }
  lines.push('');

  if (directHosts.length) {
    lines.push('## Priority hosts (no CDN)');
    for (const h of directHosts) lines.push(`- ${h}`);
    lines.push('');
  } else if (aliveHosts.length) {
    lines.push('## Alive hosts');
    for (const h of aliveHosts) lines.push(`- ${h}`);
    lines.push('');
  }

  if (dangling.length) {
    lines.push('## Dangling CNAMEs (potential takeovers)');
    for (const d of dangling) lines.push(`- ${d}`);
    lines.push('');
  }

  lines.push('## What to do next');
  lines.push('1. Browse data per-subdomain in the **Recon** tab');
  lines.push('2. Review specific findings in the **Findings** tab');
  lines.push('3. Run a **Full Tool Sweep** for deeper coverage (or wait for auto-sweep if enabled)');
  lines.push('4. Export the workbench as a zip when done');

  return lines.join('\n');
}

/**
 * Public entry: called by reconStreamer when retrox-recon.sh finishes.
 * Builds the summary and writes a static brief.
 */
async function runReconForWorkbench(wbId, opts = {}) {
  const wb = await sessionStore.getWorkbench(wbId);
  if (!wb) throw new Error(`Workbench ${wbId} not found`);

  if (_activeBriefGen.has(wbId)) return { alreadyRunning: true };
  _activeBriefGen.set(wbId, { startedAt: Date.now() });

  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  try {
    const summary = await buildSummaryFromReconDir(wbId, target);
    if (summary.error) {
      const chatEngine = require('./chatEngine');
      await chatEngine.pushReconFinding(wbId, {
        icon: '⚠',
        headline: `Brief generation skipped: ${summary.error}`,
      });
      return { error: summary.error };
    }

    // Save the structured summary
    await fs.writeJson(
      path.join(sessionStore.workbenchDir(wbId), 'recon_summary.json'),
      summary, { spaces: 2 }
    );

    // Save a static brief (no LLM call)
    const brief = generateBrief(target, summary);
    await sessionStore.writeBrief(wbId, brief);

    // Hypotheses kept empty (back-compat — anything reading this field gets empty array)
    await sessionStore.setHypotheses(wbId, []);

    return { ok: true, summary };
  } finally {
    _activeBriefGen.delete(wbId);
  }
}

function isReconRunning(wbId) {
  return _activeBriefGen.has(wbId);
}

function reconStatus(wbId) {
  return _activeBriefGen.get(wbId) || null;
}

module.exports = {
  runReconForWorkbench,
  buildSummaryFromReconDir,
  isReconRunning,
  reconStatus,
};
