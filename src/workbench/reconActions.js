/**
 * RECON ACTIONS
 *
 * Per-target ad-hoc recon helpers. Each one runs a single tool against
 * one target (or a small list), streams output to chat, and appends new
 * findings into the relevant recon file so the table tabs update.
 *
 * Available actions:
 *   ffuf_one(host)           → runs ffuf, appends to ffuf_findings.txt
 *   portscan_one(ip)         → runs nmap, appends to open_ports.txt
 *   js_pull_one(host)        → fetches JS bundles from host, appends js_secrets/endpoints
 *   subdomain_refresh(target) → re-runs subfinder, merges into all_subs.txt
 *   probe_one(host)          → runs Phase 9 probes against one host
 *
 * All actions:
 *   - Are bounded (timeout, request cap)
 *   - Stream progress events to chat via pushReconFinding
 *   - Update files atomically (read, merge, sort -u, write)
 *   - Refuse to run if a full retrox-recon.sh is already in progress
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const sessionStore = require('./sessionStore');
const chatEngine = require('./chatEngine');
const reconStreamer = require('./reconStreamer');

function _sanitize(s) { return String(s).replace(/[^A-Za-z0-9._-]/g, '_'); }

async function _push(wbId, finding) {
  return chatEngine.pushReconFinding(wbId, finding).catch(() => {});
}

function _reconDir(wbId, target) {
  const safe = _sanitize(target);
  return path.join(sessionStore.workbenchDir(wbId), 'recon', safe);
}

// Append unique lines to a recon file (creates if missing)
async function _appendUnique(filePath, newLines) {
  await fs.ensureFile(filePath);
  const existing = (await fs.readFile(filePath, 'utf8')).split('\n').filter(Boolean);
  const combined = Array.from(new Set([...existing, ...newLines]));
  combined.sort();
  await fs.writeFile(filePath, combined.join('\n') + (combined.length ? '\n' : ''));
  return { added: combined.length - existing.length, total: combined.length };
}

// ──────────────────────────────────────────────────────────────────────
// Common pre-flight: gate ad-hoc actions during a full scan
// ──────────────────────────────────────────────────────────────────────
async function _gate(wbId) {
  const wb = await sessionStore.getWorkbench(wbId);
  if (!wb) throw new Error('Workbench not found');
  if (reconStreamer.isReconRunning(wbId)) {
    throw new Error('A full recon is currently running — wait for it to finish first');
  }
  return wb;
}

// ──────────────────────────────────────────────────────────────────────
// Action: ffuf one host
// Uses: ffuf with a small wordlist + the same CDN-aware rate logic as Phase 8
// Bounds: 60s timeout, default rate 5 req/s (2 if cloudflare)
// ──────────────────────────────────────────────────────────────────────
async function ffufOne(wbId, host, opts = {}) {
  const wb = await _gate(wbId);
  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const reconDir = _reconDir(wbId, target);

  // Normalize host to a URL
  let url = host.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  url = url.replace(/\/$/, '');

  // Detect Cloudflare from existing recon
  let isCf = false;
  try {
    const cf = await fs.readFile(path.join(reconDir, 'cloudflare_hosts.txt'), 'utf8');
    isCf = cf.includes(url);
  } catch {}

  const rate = isCf ? 2 : 5;
  const wordlist = opts.wordlist || '/root/SecLists/Discovery/Web-Content/raft-medium-directories.txt';
  const timeoutSec = opts.timeoutSec || 60;

  if (!await fs.pathExists(wordlist)) {
    await _push(wbId, { icon: '⚠', headline: `ffuf wordlist not found at ${wordlist}` });
    return { error: 'wordlist not found' };
  }

  await _push(wbId, {
    icon: '🎯',
    headline: `Running ffuf against ${url}`,
    detail: `Wordlist: ${path.basename(wordlist)} | rate=${rate}r/s | timeout=${timeoutSec}s | mode=${isCf ? 'Cloudflare' : 'direct'}`,
  });

  const outFile = path.join(reconDir, `ffuf_results/_adhoc_${_sanitize(url)}_${Date.now()}.json`);
  await fs.ensureDir(path.dirname(outFile));

  return new Promise((resolve) => {
    const args = [
      '-u', `${url}/FUZZ`,
      '-w', wordlist,
      '-t', '5',
      '-mc', '200,201,301,302,307,401,403',
      '-fc', '404,429,500',
      '-rate', String(rate),
      '-timeout', '10',
      '-o', outFile,
      '-of', 'json',
      '-silent',
    ];
    const child = spawn('ffuf', args, { timeout: timeoutSec * 1000 });
    let stderrBuf = '';
    child.stderr.on('data', d => stderrBuf += d.toString());
    child.on('error', async (e) => {
      await _push(wbId, { icon: '⚠', headline: `ffuf failed to start: ${e.message}` });
      resolve({ error: e.message });
    });
    child.on('close', async () => {
      let findings = [];
      try {
        if (await fs.pathExists(outFile)) {
          const data = await fs.readJson(outFile);
          findings = (data.results || [])
            .filter(r => r.status && r.status < 500)
            .map(r => `${r.status}\t${r.length}\t${r.url}`);
        }
      } catch {}

      // Merge into ffuf_findings.txt
      const merged = await _appendUnique(path.join(reconDir, 'ffuf_findings.txt'), findings);
      const preview = findings.slice(0, 6).map(l => `  ${l}`).join('\n');

      await _push(wbId, {
        icon: findings.length > 0 ? '✓' : '○',
        headline: `ffuf on ${url} complete: ${findings.length} hit(s)`,
        detail: findings.length > 0
          ? `Top hits:\n${preview}${findings.length > 6 ? `\n  ...(+${findings.length - 6} more)` : ''}\n\nMerged ${merged.added} new entries into ffuf_findings.txt`
          : 'No new endpoints found.',
      });
      resolve({ findings: findings.length, merged: merged.added });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// Action: nmap port scan one IP
// Bounds: top 1000 ports, T3 timing, 2 minute hard limit
// ──────────────────────────────────────────────────────────────────────
async function portScanOne(wbId, ip, opts = {}) {
  const wb = await _gate(wbId);
  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const reconDir = _reconDir(wbId, target);

  await _push(wbId, {
    icon: '🚪',
    headline: `Port scanning ${ip}`,
    detail: `nmap -sT -Pn --top-ports 1000 -T3 (~30-90s)`,
  });

  return new Promise((resolve) => {
    const args = ['-sT', '-Pn', '--top-ports', '1000', '-T3',
                  '--host-timeout', '90s', '--max-retries', '1',
                  '--open', ip];
    const child = spawn('nmap', args, { timeout: 120000 });
    let stdout = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.on('error', async (e) => {
      await _push(wbId, { icon: '⚠', headline: `nmap failed: ${e.message}` });
      resolve({ error: e.message });
    });
    child.on('close', async () => {
      // Parse "PORT/proto STATE SERVICE" lines
      const ports = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^(\d+)\/(tcp|udp)\s+open\s+(\S+)/);
        if (m) ports.push(`${m[1]}/${m[2]}\t${m[3]}\t${ip}`);
      }
      const merged = await _appendUnique(path.join(reconDir, 'open_ports.txt'),
                                          ports.map(p => p.split('\t')[0]));

      await _push(wbId, {
        icon: ports.length > 0 ? '✓' : '○',
        headline: `Port scan on ${ip} complete: ${ports.length} open port(s)`,
        detail: ports.length > 0
          ? `Open ports:\n${ports.map(p => `  ${p}`).join('\n')}`
          : 'No open ports in top 1000.',
      });
      resolve({ ports: ports.length, merged: merged.added });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// Action: re-run subdomain enum (subfinder only, fast pass)
// ──────────────────────────────────────────────────────────────────────
async function subdomainRefresh(wbId) {
  const wb = await _gate(wbId);
  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const reconDir = _reconDir(wbId, target);
  await fs.ensureDir(reconDir);

  await _push(wbId, {
    icon: '🔄',
    headline: `Refreshing subdomain list for ${target}`,
    detail: 'Running subfinder + crt.sh — merging new subs into all_subs.txt',
  });

  return new Promise((resolve) => {
    const cmd = `
      (subfinder -d "${target}" -silent -all 2>/dev/null || true;
       curl -s --max-time 30 "https://crt.sh/?q=%25.${target}&output=json" 2>/dev/null \
         | jq -r '.[]|.name_value,.common_name' 2>/dev/null \
         | tr ',' '\\n' | sed 's/^\\*\\.//g' \
         | grep -E "\\.${target.replace(/\./g, '\\.')}$" || true) \
      | sed '/^$/d' \
      | sort -u
    `;
    const child = spawn('bash', ['-c', cmd], { timeout: 120000 });
    let stdout = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.on('error', async (e) => {
      await _push(wbId, { icon: '⚠', headline: `Subdomain refresh failed: ${e.message}` });
      resolve({ error: e.message });
    });
    child.on('close', async () => {
      const subs = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      const merged = await _appendUnique(path.join(reconDir, 'all_subs.txt'), subs);
      await _push(wbId, {
        icon: merged.added > 0 ? '✓' : '○',
        headline: `Subdomain refresh: found ${subs.length}, ${merged.added} new`,
        detail: merged.added > 0
          ? `Total in all_subs.txt: ${merged.total}. Run "Re-run scan" to probe the new ones for HTTP.`
          : 'No new subdomains since last scan.',
      });
      resolve({ found: subs.length, added: merged.added });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// Action: small probes against one host (Phase 9 in miniature)
// ──────────────────────────────────────────────────────────────────────
async function probeOne(wbId, host) {
  const wb = await _gate(wbId);
  const target = wb.target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const reconDir = _reconDir(wbId, target);

  let url = host.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  url = url.replace(/\/$/, '');

  await _push(wbId, {
    icon: '🔬',
    headline: `Running cheap-win probes against ${url}`,
    detail: 'Checking GraphQL / .git / .env / security.txt',
  });

  const probes = [
    { path: '/.git/HEAD',                file: 'git_exposed.txt',     verify: /^ref:/m },
    { path: '/.env',                     file: 'env_exposed.txt',     verify: /[A-Z_]+=/m },
    { path: '/.well-known/security.txt', file: 'security_txt.txt',    verify: null },
    { path: '/graphql',                  file: 'graphql_endpoints.txt', verify: /__schema|types/, method: 'POST' },
    { path: '/api/graphql',              file: 'graphql_endpoints.txt', verify: /__schema|types/, method: 'POST' },
  ];

  const hits = [];
  for (const p of probes) {
    try {
      const fullUrl = url + p.path;
      const cmd = p.method === 'POST'
        ? `curl -sk -A 'Mozilla/5.0' --max-time 6 -X POST -H 'Content-Type: application/json' -d '{"query":"{__schema{types{name}}}"}' "${fullUrl}" 2>/dev/null | head -c 500`
        : `curl -sk -A 'Mozilla/5.0' --max-time 6 "${fullUrl}" 2>/dev/null | head -c 500`;
      const body = await new Promise(resolve => {
        let out = '';
        const c = spawn('bash', ['-c', cmd], { timeout: 8000 });
        c.stdout.on('data', d => out += d.toString());
        c.on('close', () => resolve(out));
        c.on('error', () => resolve(''));
      });
      if (body && (!p.verify || p.verify.test(body))) {
        hits.push({ url: fullUrl, file: p.file });
        await _appendUnique(path.join(reconDir, p.file), [fullUrl]);
      }
    } catch {}
  }

  await _push(wbId, {
    icon: hits.length > 0 ? '🚨' : '✓',
    headline: `Probes on ${url}: ${hits.length} hit(s)`,
    detail: hits.length > 0
      ? hits.map(h => `  • ${h.url} → ${h.file}`).join('\n')
      : 'Nothing exposed.',
  });
  return { hits: hits.length };
}

module.exports = {
  ffufOne,
  portScanOne,
  subdomainRefresh,
  probeOne,
};
