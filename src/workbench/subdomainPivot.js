/**
 * SUBDOMAIN PIVOT
 *
 * Builds a "view" of recon data organized by subdomain instead of by file
 * type. The flat files on disk remain the source of truth — this module
 * just slices them per-host so the UI can show them in subdomain folders.
 *
 * Two endpoints:
 *   - listSubdomains(wbId)         → light index for the sidebar (host + counts)
 *   - getSubdomainData(wbId, host) → full per-host view (URLs, params, JS, etc.)
 *   - getTargetWideData(wbId)      → cross-host data (S3 buckets, GitHub, takeovers)
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const sessionStore = require('./sessionStore');

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function _sanitize(s) {
  return (s || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
}

async function _readLines(filepath) {
  if (!await fs.pathExists(filepath)) return [];
  const c = await fs.readFile(filepath, 'utf8');
  return c.split('\n').filter(Boolean);
}

// Extract bare hostname from any URL or line like "https://api.example.com/foo"
function _extractHost(s) {
  if (!s) return null;
  // Strip leading status-like prefixes (some files start with "[200]" or "200" or severity tags)
  let stripped = s.replace(/^\[[^\]]+\]\s*/, '').trim();
  // Strip inline brackets that aren't URL-y
  // Try URL parsing first
  try {
    const u = new URL(stripped);
    return u.host.toLowerCase();
  } catch {}
  // Fallback: maybe it's just a host
  const hostMatch = stripped.match(/^([a-z0-9][a-z0-9.-]*[a-z0-9])(?::\d+)?(?:\/|$|\s)/i);
  if (hostMatch) return hostMatch[1].toLowerCase();
  return null;
}

// Some files start with a CNAME (e.g. cnames.txt: "api.example.com -> abc.cloudfront.net")
function _hostFromCnameLine(s) {
  const m = s.match(/^([a-z0-9][a-z0-9.-]*[a-z0-9])\s*->/i);
  return m ? m[1].toLowerCase() : null;
}

// Forms.txt format: "[METHOD] action\tinputs"
function _hostFromFormLine(s) {
  const m = s.match(/^\[[^\]]+\]\s*(\S+)/);
  if (!m) return null;
  return _extractHost(m[1]);
}

// HTML comments format: "host\tcomment"
function _hostFromCommentLine(s) {
  const tab = s.indexOf('\t');
  if (tab === -1) return null;
  return s.slice(0, tab).toLowerCase();
}

// Nuclei findings line — the URL is usually the last whitespace-separated token, or in [tag] format
function _hostFromNucleiLine(s) {
  const urls = s.match(/https?:\/\/\S+/g);
  if (urls && urls.length > 0) {
    return _extractHost(urls[urls.length - 1]);
  }
  return null;
}

// Reflection findings — similar pattern
function _hostFromReflectionLine(s) {
  return _hostFromNucleiLine(s);
}

// FFUF: "200	1234	https://example.com/admin"
function _hostFromFfufLine(s) {
  const urls = s.match(/https?:\/\/\S+/);
  return urls ? _extractHost(urls[0]) : null;
}

// testssl: "[severity] host:port — finding"
function _hostFromTestsslLine(s) {
  const m = s.match(/^\[[^\]]+\]\s*([a-z0-9][a-z0-9.-]*[a-z0-9])(?::\d+)?/i);
  return m ? m[1].toLowerCase() : null;
}

// whatweb_findings.txt: "host\ttechs..." OR "https://host\t..."
function _hostFromWhatwebLine(s) {
  const tab = s.indexOf('\t');
  const head = tab >= 0 ? s.slice(0, tab) : s;
  return _extractHost(head) || head.toLowerCase().replace(/[^a-z0-9.-]/g, '');
}

// waf_detections.txt: "host\twaf_name" or "[host] waf_name"
function _hostFromWafLine(s) {
  const tab = s.indexOf('\t');
  if (tab >= 0) return _extractHost(s.slice(0, tab));
  const m = s.match(/^([a-z0-9][a-z0-9.-]*[a-z0-9])/i);
  return m ? m[1].toLowerCase() : null;
}

// js_files.txt + js_endpoints.txt are full URLs; js_secrets.txt has lines like "type=X, value=Y → source=URL"
function _hostFromJsSecretLine(s) {
  // Look for the source URL anywhere in the line
  const urls = s.match(/https?:\/\/\S+/g);
  if (urls && urls.length > 0) return _extractHost(urls[urls.length - 1]);
  return null;
}

// open_ports.txt: typically "host:port" or "host\tport"
function _hostFromPortLine(s) {
  const m = s.match(/^([a-z0-9][a-z0-9.-]*[a-z0-9])[:\s\t]/i);
  return m ? m[1].toLowerCase() : null;
}

// resolved.txt: "host -> IP" or "host:IP" or "host\tIP"
function _hostFromResolvedLine(s) {
  const m = s.match(/^([a-z0-9][a-z0-9.-]*[a-z0-9])/i);
  return m ? m[1].toLowerCase() : null;
}

// Strip a port from a host (api.example.com:443 → api.example.com)
function _stripPort(host) {
  if (!host) return host;
  return host.split(':')[0];
}

// ──────────────────────────────────────────────────────────────────────────
// Build the full pivot
// ──────────────────────────────────────────────────────────────────────────

async function _buildPivot(wbId) {
  const wb = await sessionStore.getWorkbench(wbId);
  if (!wb) return { error: 'Workbench not found' };

  const target = _sanitize(wb.target);
  const reconDir = path.join(sessionStore.workbenchDir(wbId), 'recon', target);
  if (!await fs.pathExists(reconDir)) {
    return { error: `Recon directory not found: ${reconDir}` };
  }

  const file = (name) => path.join(reconDir, name);

  // Read all the source files in parallel
  const [
    allSubs, resolved, cnames, dangling,
    aliveHosts, cloudflareHosts, directHosts,
    technologies, whatwebFindings, wafDetections, openPorts,
    allUrls, urlsArchive, apiEndpoints, ffufFindings,
    forms, htmlComments,
    paramsList,
    jsFiles, jsEndpoints, jsSecrets,
    nucleiFindings, reflectionFindings, testsslFindings,
    takeoverFindings, s3Findings, githubSecrets,
    graphqlEndpoints, gitExposed, envExposed, backupFiles, securityTxt,
  ] = await Promise.all([
    _readLines(file('all_subs.txt')),
    _readLines(file('resolved.txt')),
    _readLines(file('cnames.txt')),
    _readLines(file('dangling.txt')),
    _readLines(file('alive_hosts.txt')),
    _readLines(file('cloudflare_hosts.txt')),
    _readLines(file('direct_hosts.txt')),
    _readLines(file('technologies.txt')),
    _readLines(file('whatweb_findings.txt')),
    _readLines(file('waf_detections.txt')),
    _readLines(file('open_ports.txt')),
    _readLines(file('all_urls.txt')),
    _readLines(file('urls_archive.txt')),
    _readLines(file('api_endpoints.txt')),
    _readLines(file('ffuf_findings.txt')),
    _readLines(file('forms.txt')),
    _readLines(file('html_comments.txt')),
    _readLines(file('params_detailed.txt')),  // params.txt has just names; detailed has the URL
    _readLines(file('js_files.txt')),
    _readLines(file('js_endpoints.txt')),
    _readLines(file('js_secrets.txt')),
    _readLines(file('nuclei_findings.txt')),
    _readLines(file('reflection_findings.txt')),
    _readLines(file('testssl_findings.txt')),
    _readLines(file('takeover_findings.txt')),
    _readLines(file('s3_findings.txt')),
    _readLines(file('github_secrets.txt')),
    _readLines(file('graphql_endpoints.txt')),
    _readLines(file('git_exposed.txt')),
    _readLines(file('env_exposed.txt')),
    _readLines(file('backup_files.txt')),
    _readLines(file('security_txt.txt')),
  ]);

  // Build the per-host buckets. Key = bare hostname (no port, no scheme).
  const byHost = new Map();
  const ensureHost = (h) => {
    if (!h) return null;
    const k = _stripPort(h);
    if (!byHost.has(k)) {
      byHost.set(k, {
        host: k,
        alive: false,
        behindCloudflare: false,
        direct: false,
        ip: null,
        cnameTarget: null,
        dangling: false,
        takeoverConfirmed: false,
        technologies: [],
        whatweb: [],
        waf: null,
        openPorts: [],
        urls: [],
        urlsArchive: [],
        apiEndpoints: [],
        ffufHits: [],
        forms: [],
        htmlComments: [],
        params: new Set(),
        jsFiles: [],
        jsEndpoints: [],
        jsSecrets: [],
        nucleiFindings: [],
        reflectionFindings: [],
        testsslFindings: [],
        graphqlEndpoints: [],
        gitExposed: false,
        envExposed: false,
        backupFiles: [],
        securityTxt: false,
      });
    }
    return byHost.get(k);
  };

  // 1. Subdomains — every entry creates a host bucket
  for (const s of allSubs) {
    const h = _stripPort(s.toLowerCase());
    if (h) ensureHost(h);
  }

  // 2. Resolved (host → IP)
  for (const line of resolved) {
    const h = _hostFromResolvedLine(line);
    if (!h) continue;
    const ipMatch = line.match(/(\d+\.\d+\.\d+\.\d+|[a-f0-9:]{4,})/i);
    const bucket = ensureHost(h);
    if (bucket && ipMatch) bucket.ip = ipMatch[1];
  }

  // 3. CNAMEs
  for (const line of cnames) {
    const h = _hostFromCnameLine(line);
    if (!h) continue;
    const targetMatch = line.match(/->\s*(\S+)/);
    const bucket = ensureHost(h);
    if (bucket && targetMatch) bucket.cnameTarget = targetMatch[1];
  }

  // 4. Dangling
  for (const line of dangling) {
    const h = _stripPort(line.toLowerCase());
    const bucket = ensureHost(h);
    if (bucket) bucket.dangling = true;
  }

  // 5. Alive / Cloudflare / Direct
  for (const line of aliveHosts) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.alive = true;
  }
  for (const line of cloudflareHosts) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.behindCloudflare = true;
  }
  for (const line of directHosts) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.direct = true;
  }

  // 6. Technologies — file format is per-line, may or may not have host prefix
  // technologies.txt usually: "host\ttech1, tech2" OR just a list of techs
  for (const line of technologies) {
    const tab = line.indexOf('\t');
    if (tab >= 0) {
      const h = _extractHost(line.slice(0, tab));
      const bucket = ensureHost(h);
      if (bucket) {
        const techs = line.slice(tab + 1).split(',').map(s => s.trim()).filter(Boolean);
        bucket.technologies.push(...techs);
      }
    }
  }

  // 7. whatweb findings
  for (const line of whatwebFindings) {
    const h = _hostFromWhatwebLine(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.whatweb.push(line);
  }

  // 8. WAF detections
  for (const line of wafDetections) {
    const h = _hostFromWafLine(line);
    const bucket = ensureHost(h);
    if (!bucket) continue;
    // Extract the WAF name (everything after the first delimiter)
    const tab = line.indexOf('\t');
    bucket.waf = tab >= 0 ? line.slice(tab + 1).trim() : line.replace(h, '').trim();
  }

  // 9. Open ports
  for (const line of openPorts) {
    const h = _hostFromPortLine(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.openPorts.push(line);
  }

  // 10. URLs (every URL gets bucketed by its host)
  for (const line of allUrls) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) {
      bucket.urls.push(line);
      // Also extract params
      try {
        const u = new URL(line);
        for (const k of u.searchParams.keys()) bucket.params.add(k);
      } catch {}
    }
  }

  // 11. Archived URLs
  for (const line of urlsArchive) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.urlsArchive.push(line);
  }

  // 12. API endpoints
  for (const line of apiEndpoints) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.apiEndpoints.push(line);
  }

  // 13. FFUF findings
  for (const line of ffufFindings) {
    const h = _hostFromFfufLine(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.ffufHits.push(line);
  }

  // 14. Forms
  for (const line of forms) {
    const h = _hostFromFormLine(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.forms.push(line);
  }

  // 15. HTML comments
  for (const line of htmlComments) {
    const h = _hostFromCommentLine(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.htmlComments.push(line);
  }

  // 16. Params (detailed format: "param\turl")
  for (const line of paramsList) {
    const tab = line.indexOf('\t');
    if (tab >= 0) {
      const param = line.slice(0, tab).trim();
      const url = line.slice(tab + 1).trim();
      const h = _extractHost(url);
      const bucket = ensureHost(h);
      if (bucket && param) bucket.params.add(param);
    }
  }

  // 17. JS files (URL of bundle)
  for (const line of jsFiles) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.jsFiles.push(line);
  }

  // 18. JS endpoints (relative paths; we can't bucket these per-host without
  // knowing which JS file they came from. Tag them to every host that served
  // a JS file, or leave them target-wide. Let's leave them target-wide and
  // let the user open the JS file to see context.)
  // Actually — cleanest approach: each js_endpoints.txt line that contains
  // an absolute URL gets bucketed by host; relative paths stay target-wide.
  const jsEndpointsTargetWide = [];
  for (const line of jsEndpoints) {
    const h = _extractHost(line);
    if (h) {
      const bucket = ensureHost(h);
      if (bucket) bucket.jsEndpoints.push(line);
    } else {
      jsEndpointsTargetWide.push(line);
    }
  }

  // 19. JS secrets — line includes source URL
  for (const line of jsSecrets) {
    const h = _hostFromJsSecretLine(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.jsSecrets.push(line);
  }

  // 20. Nuclei findings
  for (const line of nucleiFindings) {
    const h = _hostFromNucleiLine(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.nucleiFindings.push(line);
  }

  // 21. Reflection findings
  for (const line of reflectionFindings) {
    const h = _hostFromReflectionLine(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.reflectionFindings.push(line);
  }

  // 22. testssl findings
  for (const line of testsslFindings) {
    const h = _hostFromTestsslLine(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.testsslFindings.push(line);
  }

  // 23. Takeover confirmed
  for (const line of takeoverFindings) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.takeoverConfirmed = true;
  }

  // 24. GraphQL
  for (const line of graphqlEndpoints) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.graphqlEndpoints.push(line);
  }

  // 25. Exposed files
  for (const line of gitExposed) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.gitExposed = true;
  }
  for (const line of envExposed) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.envExposed = true;
  }
  for (const line of backupFiles) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.backupFiles.push(line);
  }
  for (const line of securityTxt) {
    const h = _extractHost(line);
    const bucket = ensureHost(h);
    if (bucket) bucket.securityTxt = true;
  }

  // Convert the params Set to an array on each bucket
  for (const bucket of byHost.values()) {
    bucket.params = Array.from(bucket.params).sort();
    // Dedupe technologies
    bucket.technologies = Array.from(new Set(bucket.technologies));
  }

  // Target-wide stuff that doesn't belong to any single subdomain
  const targetWide = {
    s3Findings,         // org-name S3 buckets, can match multiple subs
    githubSecrets,      // org-wide repo secrets
    jsEndpointsRelative: jsEndpointsTargetWide,
    crossHostTakeoverCandidates: dangling.filter(d => !byHost.has(_stripPort(d.toLowerCase()))),
  };

  return { byHost, targetWide };
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

async function listSubdomains(wbId) {
  const pivot = await _buildPivot(wbId);
  if (pivot.error) return pivot;

  // Lightweight index for the sidebar — host name + counts of interesting things
  const items = [];
  for (const [host, data] of pivot.byHost) {
    const counts = {
      urls: data.urls.length,
      params: data.params.length,
      forms: data.forms.length,
      jsFiles: data.jsFiles.length,
      jsSecrets: data.jsSecrets.length,
      nuclei: data.nucleiFindings.length,
      reflection: data.reflectionFindings.length,
      testssl: data.testsslFindings.length,
      ffuf: data.ffufHits.length,
    };
    // "Hot" if any high-signal data exists
    const hot = data.takeoverConfirmed || data.dangling || data.gitExposed ||
                data.envExposed || data.backupFiles.length > 0 ||
                data.jsSecrets.length > 0 || data.nucleiFindings.length > 0;

    // "Has data" only if there's *something* meaningful beyond just being a name
    const hasData = data.alive || counts.urls > 0 || counts.forms > 0 ||
                    counts.params > 0 || counts.jsFiles > 0 || hot ||
                    data.ip || data.cnameTarget;

    items.push({
      host,
      alive: data.alive,
      behindCloudflare: data.behindCloudflare,
      direct: data.direct,
      ip: data.ip,
      dangling: data.dangling,
      takeoverConfirmed: data.takeoverConfirmed,
      hot,
      hasData,
      counts,
    });
  }

  // Sort: hot first, then alive, then by count of meaningful data
  items.sort((a, b) => {
    if (a.hot !== b.hot) return a.hot ? -1 : 1;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    const aTotal = Object.values(a.counts).reduce((s, n) => s + n, 0);
    const bTotal = Object.values(b.counts).reduce((s, n) => s + n, 0);
    if (aTotal !== bTotal) return bTotal - aTotal;
    return a.host.localeCompare(b.host);
  });

  return {
    items,
    totalSubdomains: items.length,
    targetWide: {
      s3FindingsCount: pivot.targetWide.s3Findings.length,
      githubSecretsCount: pivot.targetWide.githubSecrets.length,
      jsEndpointsRelativeCount: pivot.targetWide.jsEndpointsRelative.length,
    },
  };
}

async function getSubdomainData(wbId, host) {
  const pivot = await _buildPivot(wbId);
  if (pivot.error) return pivot;
  const k = _stripPort((host || '').toLowerCase());
  const data = pivot.byHost.get(k);
  if (!data) return { error: `Subdomain ${k} not found` };
  return { host: k, data };
}

async function getTargetWideData(wbId) {
  const pivot = await _buildPivot(wbId);
  if (pivot.error) return pivot;
  return { targetWide: pivot.targetWide };
}

// Find the most recent gowitness screenshot for a host, if any.
// Returns { runId, filename } or null.
async function findScreenshotForHost(wbId, host) {
  const k = _stripPort((host || '').toLowerCase());
  const wbDir = sessionStore.workbenchDir(wbId);
  const gowitnessDir = path.join(wbDir, 'tools', 'gowitness');
  if (!await fs.pathExists(gowitnessDir)) return null;

  // Scan all gowitness runs newest-first
  const runs = (await fs.readdir(gowitnessDir).catch(() => []))
    .map(name => ({
      name,
      path: path.join(gowitnessDir, name),
    }));
  // Sort by mtime descending so most recent wins
  for (const r of runs) {
    try { r.mtime = (await fs.stat(r.path)).mtimeMs; } catch { r.mtime = 0; }
  }
  runs.sort((a, b) => b.mtime - a.mtime);

  for (const run of runs) {
    const screenshotsDir = path.join(run.path, 'screenshots');
    if (!await fs.pathExists(screenshotsDir)) continue;
    const files = await fs.readdir(screenshotsDir).catch(() => []);
    // gowitness names files like "https-api-example-com.png" or similar
    // Find anything containing the host
    const sanitizedHost = k.replace(/[^a-z0-9.-]/g, '-');
    const match = files.find(f => f.toLowerCase().includes(sanitizedHost) && /\.(png|jpe?g)$/i.test(f));
    if (match) {
      return {
        runId: run.name,
        filename: 'screenshots/' + match,
      };
    }
  }
  return null;
}

module.exports = {
  listSubdomains,
  getSubdomainData,
  getTargetWideData,
  findScreenshotForHost,
};
