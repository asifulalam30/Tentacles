/**
 * FORENSIC LOGGER
 *
 * Per-session, per-execution append-only log files. Everything Tentacles
 * does gets written to disk in real-time so we have a complete forensic
 * trail even after the in-memory log buffer rolls over.
 *
 * Files written per execution to /opt/tentacles/forensics/<sessionId>/<execId>/:
 *   - agent.log              (every agent loop event)
 *   - tools.jsonl            (every tool call: input, output, duration)
 *   - llm.jsonl              (every LLM request and response)
 *   - findings.jsonl         (every finding emitted, including dropped ones)
 *   - confirmations.jsonl    (every confirmation attempt and result)
 *   - phases.jsonl           (every phase start/end)
 *   - http.jsonl             (every HTTP request made by Tentacles)
 *   - errors.log             (every error/warning)
 *   - manifest.json          (execution metadata, env, versions)
 *
 * Each file is newline-delimited JSON for easy grep/jq analysis.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FORENSICS_ROOT = process.env.FORENSICS_DIR || '/opt/tentacles/forensics';

// Cache of write streams per (sessionId, execId, kind)
const _streams = new Map();

function streamKey(sessionId, execId, kind) {
  return `${sessionId}/${execId}/${kind}`;
}

function getStream(sessionId, execId, kind) {
  const key = streamKey(sessionId, execId, kind);
  let stream = _streams.get(key);
  if (!stream) {
    const dir = path.join(FORENSICS_ROOT, sessionId, execId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const filename = kind.includes('.') ? kind : `${kind}.jsonl`;
      const filepath = path.join(dir, filename);
      stream = fs.createWriteStream(filepath, { flags: 'a' });
      stream.on('error', (err) => {
        // Silent failure — forensics shouldn't crash the agent
        console.error(`[FORENSIC] stream error: ${err.message}`);
      });
      _streams.set(key, stream);
    } catch (err) {
      console.error(`[FORENSIC] could not open stream: ${err.message}`);
      return null;
    }
  }
  return stream;
}

function closeStreams(sessionId, execId) {
  for (const [key, stream] of _streams.entries()) {
    if (key.startsWith(`${sessionId}/${execId}/`)) {
      try { stream.end(); } catch {}
      _streams.delete(key);
    }
  }
}

/**
 * Write a JSON-line entry to a forensic file.
 */
function writeJsonl(sessionId, execId, kind, entry) {
  if (!sessionId || !execId) return;
  const stream = getStream(sessionId, execId, kind);
  if (!stream) return;
  const fullEntry = {
    ts: new Date().toISOString(),
    sessionId, execId, ...entry,
  };
  try {
    stream.write(JSON.stringify(fullEntry) + '\n');
  } catch {}
}

/**
 * Append a plain-text line to a log file.
 */
function writeText(sessionId, execId, filename, line) {
  if (!sessionId || !execId) return;
  const stream = getStream(sessionId, execId, filename);
  if (!stream) return;
  try {
    const ts = new Date().toISOString();
    stream.write(`${ts} ${line}\n`);
  } catch {}
}

// ── Specific event loggers ─────────────────────────────────────────────

function logAgent(sessionId, execId, level, message, meta = {}) {
  writeText(sessionId, execId, 'agent.log', `[${level.toUpperCase()}] ${message}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}`);
}

function logTool(sessionId, execId, entry) {
  // entry: { toolId, params, output, durationMs, success, error }
  writeJsonl(sessionId, execId, 'tools', entry);
}

function logLlm(sessionId, execId, entry) {
  // entry: { tier (executor/reasoner/architect), model, prompt, response, tokens, durationMs, error }
  writeJsonl(sessionId, execId, 'llm', entry);
}

function logFinding(sessionId, execId, entry) {
  // entry: { source, severity, vuln_class, title, target, evidence, accepted, rejection_reason }
  writeJsonl(sessionId, execId, 'findings', entry);
}

function logConfirmation(sessionId, execId, entry) {
  // entry: { strategy, result, confirmed, evidence, gate, reason }
  writeJsonl(sessionId, execId, 'confirmations', entry);
}

function logPhase(sessionId, execId, entry) {
  // entry: { phase, status (start/end), durationMs, findings_count, items_added, error }
  writeJsonl(sessionId, execId, 'phases', entry);
}

function logHttp(sessionId, execId, entry) {
  // entry: { method, url, headers, body, status, response_size, response_excerpt, durationMs }
  writeJsonl(sessionId, execId, 'http', entry);
}

function logError(sessionId, execId, error, context = {}) {
  // error: Error object or string
  const message = error?.stack || error?.message || String(error);
  writeText(sessionId, execId, 'errors.log',
    `[ERROR] ${message}${Object.keys(context).length ? ' CONTEXT=' + JSON.stringify(context) : ''}`);
}

/**
 * Write the manifest at session start — captures env, versions, config
 */
function writeManifest(sessionId, execId, manifest) {
  if (!sessionId || !execId) return;
  const dir = path.join(FORENSICS_ROOT, sessionId, execId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, 'manifest.json');
    fs.writeFileSync(filepath, JSON.stringify(manifest, null, 2));
  } catch (err) {
    console.error(`[FORENSIC] manifest write failed: ${err.message}`);
  }
}

/**
 * Close all streams for an execution (call when session ends).
 */
function finalizeExecution(sessionId, execId) {
  closeStreams(sessionId, execId);
}

/**
 * Get the directory where this execution's forensics live.
 */
function getForensicsDir(sessionId, execId) {
  return path.join(FORENSICS_ROOT, sessionId, execId);
}

/**
 * Flush all open write streams for an execution to disk.
 * Used before bundling so the bundle has all data captured up to the moment of request.
 * Does NOT close the streams — execution continues writing.
 */
async function flushStreams(sessionId, execId) {
  const promises = [];
  for (const [key, stream] of _streams.entries()) {
    if (key.startsWith(`${sessionId}/${execId}/`)) {
      // cork/uncork would be nicer but write() is synchronous to OS buffer;
      // we need to make sure the OS has actually written. Best: drain.
      promises.push(new Promise((resolve) => {
        try {
          // Force a flush by writing an empty string and waiting for drain
          if (stream.write('')) {
            // Already flushed
            setImmediate(resolve);
          } else {
            stream.once('drain', resolve);
            setTimeout(resolve, 500); // safety timeout
          }
        } catch { resolve(); }
      }));
    }
  }
  await Promise.all(promises);
  // Brief pause to let OS flush to disk
  await new Promise(r => setTimeout(r, 200));
}

module.exports = {
  logAgent,
  logTool,
  logLlm,
  logFinding,
  logConfirmation,
  logPhase,
  logHttp,
  logError,
  writeManifest,
  finalizeExecution,
  flushStreams,
  getForensicsDir,
  FORENSICS_ROOT,
};
