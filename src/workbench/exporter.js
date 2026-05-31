/**
 * WORKBENCH EXPORT
 *
 * Streams a zip of a workbench's data directly to the response.
 * Doesn't buffer the whole thing in memory — uses archiver's streaming
 * API. The browser starts receiving bytes immediately while the server
 * is still walking the file tree.
 *
 * What's in the zip is configurable via the `include` flags. Defaults
 * cover what most people want (recon + summaries + leads). Tool runs
 * and Site Mirror downloads are opt-in because they can be huge.
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const archiver = require('archiver');
const sessionStore = require('./sessionStore');

function _sanitizeFilename(s) {
  return (s || 'workbench')
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .slice(0, 80);
}

/**
 * Stream a zip of workbench data to a response.
 *
 * @param {object} req — Express request (used for the include flags from query)
 * @param {object} res — Express response (we set headers + pipe to it)
 * @param {string} wbId
 *
 * Query flags (all default to true unless noted):
 *   - recon=1       → recon/<target>/*.txt (all the flat files)
 *   - summaries=1   → recon_summary.json, leads.json, findings.json,
 *                     host_health.json, sweep_state.json, brief.md
 *   - tools=0       → tools/<toolId>/<runId>/* (per-tool output dirs)  [OFF by default]
 *   - mirror=0      → mirror downloads (huge HTML/JS dumps)            [OFF by default]
 *   - manifest=1    → MANIFEST.txt at the zip root with a summary
 */
async function streamExport(req, res, wbId) {
  const wb = await sessionStore.getWorkbench(wbId);
  if (!wb) {
    return res.status(404).json({ error: 'Workbench not found' });
  }

  // Parse query flags — default true for the cheap ones, false for huge ones
  const flag = (k, dflt) => {
    if (!(k in req.query)) return dflt;
    return ['1', 'true', 'yes'].includes(String(req.query[k]).toLowerCase());
  };
  const include = {
    recon:     flag('recon', true),
    summaries: flag('summaries', true),
    tools:     flag('tools', false),
    mirror:    flag('mirror', false),
    manifest:  flag('manifest', true),
  };

  const wbDir = sessionStore.workbenchDir(wbId);
  if (!await fs.pathExists(wbDir)) {
    return res.status(404).json({ error: 'Workbench directory missing' });
  }

  const sanitizedTarget = _sanitizeFilename(wb.target);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zipName = `tentacles_${sanitizedTarget}_${ts}.zip`;

  // Build a manifest in memory first so we can include it AND log it
  const manifestLines = [
    `Tentacles workbench export`,
    `${'='.repeat(40)}`,
    `Target: ${wb.target}`,
    `Workbench ID: ${wbId}`,
    `Exported at: ${new Date().toISOString()}`,
    `Includes: ${Object.entries(include).filter(([_, v]) => v).map(([k]) => k).join(', ')}`,
    '',
  ];

  // Pre-walk to compute file plan + total size (so manifest knows what's coming).
  // This walk is fast — one stat per file. We pass the plan to archiver next.
  const plan = await _buildFilePlan(wbDir, sanitizedTarget, include);

  manifestLines.push('Files:');
  let totalSize = 0;
  for (const entry of plan) {
    manifestLines.push(`  ${entry.zipPath} (${_formatSize(entry.size)})`);
    totalSize += entry.size;
  }
  manifestLines.push('');
  manifestLines.push(`Total: ${plan.length} files, ${_formatSize(totalSize)} uncompressed`);

  // Set headers BEFORE piping
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  res.setHeader('Cache-Control', 'no-store');

  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') console.error('Export archiver warning:', err);
  });
  archive.on('error', (err) => {
    console.error('Export archiver error:', err);
    // Can't reset headers at this point — just end the response
    try { res.end(); } catch {}
  });

  archive.pipe(res);

  // Add manifest first (deterministic ordering — manifest at zip root)
  if (include.manifest) {
    archive.append(manifestLines.join('\n') + '\n', { name: 'MANIFEST.txt' });
  }

  // Add planned files
  for (const entry of plan) {
    if (entry.isDirectory) continue;  // archiver doesn't need explicit dir entries
    archive.file(entry.absPath, { name: entry.zipPath });
  }

  // Finalize — this is async but we don't await; archiver streams to res
  // and emits 'end' when done. The await here matters for error handling.
  await archive.finalize();
}

/**
 * Walk the workbench dir and return the list of files we want in the zip,
 * each with absPath + zipPath + size. zipPath is the file's location inside
 * the zip, rooted at sanitized target name.
 */
async function _buildFilePlan(wbDir, sanitizedTarget, include) {
  const plan = [];
  const root = sanitizedTarget;

  // 1. Recon flat files. The on-disk layout is recon/<target>/*.txt — flatten
  // it in the zip to just <target_root>/recon/*.txt for cleaner paths.
  if (include.recon) {
    const reconDir = path.join(wbDir, 'recon');
    if (await fs.pathExists(reconDir)) {
      // The recon dir typically contains one subfolder named after the target.
      // Walk that subfolder's contents directly into the zip's recon/ folder.
      const reconSubs = await fs.readdir(reconDir).catch(() => []);
      for (const sub of reconSubs) {
        const subPath = path.join(reconDir, sub);
        let stat;
        try { stat = await fs.stat(subPath); } catch { continue; }
        if (stat.isDirectory()) {
          await _walkAddFiles(subPath, path.join(root, 'recon'), plan);
        } else if (stat.isFile()) {
          // Loose file at recon/ root — keep it
          plan.push({
            absPath: subPath,
            zipPath: path.join(root, 'recon', sub),
            size: stat.size,
            isDirectory: false,
          });
        }
      }
    }
  }

  // 2. Summary / metadata files at the workbench root
  if (include.summaries) {
    const summaryFiles = [
      'recon_summary.json',
      'leads.json',
      'findings.json',
      'host_health.json',
      'sweep_state.json',
      'brief.md',
      'tool_runs.json',
      'directives.json',
      'messages.json',
    ];
    for (const fname of summaryFiles) {
      const fp = path.join(wbDir, fname);
      if (await fs.pathExists(fp)) {
        const stat = await fs.stat(fp);
        if (stat.isFile()) {
          plan.push({
            absPath: fp,
            zipPath: path.join(root, fname),
            size: stat.size,
            isDirectory: false,
          });
        }
      }
    }
  }

  // 3. Tool runs — per-tool output dirs
  if (include.tools) {
    const toolsDir = path.join(wbDir, 'tools');
    if (await fs.pathExists(toolsDir)) {
      // For each tool/runId, optionally exclude the giant mirror download tree
      // unless include.mirror is also on. The relPath here is relative to
      // tools/, so we match "mirror/<runId>/mirror/" (NOT "tools/mirror/...").
      const filter = (relPath) => {
        if (!include.mirror) {
          // Skip anything under mirror/<runId>/mirror/
          if (/(?:^|\/)mirror\/[^/]+\/mirror(?:\/|$)/.test(relPath)) return false;
        }
        return true;
      };
      await _walkAddFiles(toolsDir, path.join(root, 'tools'), plan, { filter });
    }
  }

  return plan;
}

/**
 * Recursively walk srcDir and add files to plan with their zip paths rooted
 * at zipPrefix. Optional filter receives the *relative* path (from srcDir).
 */
async function _walkAddFiles(srcDir, zipPrefix, plan, opts = {}) {
  const filter = opts.filter || (() => true);

  async function walk(rel) {
    const abs = path.join(srcDir, rel);
    let entries;
    try { entries = await fs.readdir(abs, { withFileTypes: true }); }
    catch { return; }

    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      const childAbs = path.join(abs, e.name);

      if (e.isDirectory()) {
        // Filter check on directory level too (so we can skip whole trees)
        if (!filter(childRel)) continue;
        await walk(childRel);
      } else if (e.isFile()) {
        if (!filter(childRel)) continue;
        let stat;
        try { stat = await fs.stat(childAbs); } catch { continue; }
        plan.push({
          absPath: childAbs,
          zipPath: path.join(zipPrefix, childRel),
          size: stat.size,
          isDirectory: false,
        });
      }
      // Skip symlinks/sockets/etc.
    }
  }

  await walk('');
}

function _formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/**
 * Quick pre-check: estimate total size of an export with given include flags
 * without actually streaming. Useful for the UI to warn about big downloads.
 */
async function estimateSize(wbId, include) {
  const wb = await sessionStore.getWorkbench(wbId);
  if (!wb) return { error: 'Workbench not found' };
  const wbDir = sessionStore.workbenchDir(wbId);
  if (!await fs.pathExists(wbDir)) return { error: 'Workbench directory missing' };

  const plan = await _buildFilePlan(wbDir, _sanitizeFilename(wb.target), include);
  let total = 0;
  for (const e of plan) total += e.size;
  return {
    fileCount: plan.length,
    totalBytes: total,
    formatted: _formatSize(total),
    breakdown: {
      recon: plan.filter(e => e.zipPath.includes('/recon/')).reduce((s, e) => s + e.size, 0),
      tools: plan.filter(e => e.zipPath.includes('/tools/')).reduce((s, e) => s + e.size, 0),
      summaries: plan.filter(e => !e.zipPath.includes('/recon/') && !e.zipPath.includes('/tools/')).reduce((s, e) => s + e.size, 0),
    },
  };
}

module.exports = {
  streamExport,
  estimateSize,
};
