'use strict';
/**
 * STATE MANAGER  v2.1
 *
 * Data model:
 *   Session  — a named target (e.g. "example.com"). Lives forever.
 *   Execution — one autonomous pentest run within a session.
 *               A session can hold many executions.
 *
 * Persistence:
 *   All state is written to STATE_FILE (JSON) on every mutation.
 *   Writes are queued so concurrent calls never corrupt the file.
 *   On startup, any in-progress executions are marked 'interrupted'.
 *
 * Usage pattern:
 *   const sess = stateManager.createSession(id, target);
 *   const exec = stateManager.createExecution(sessionId, execId);
 *   stateManager.addFinding(sessionId, execId, finding);
 *   stateManager.addReport(sessionId, execId, report);
 */

const fs   = require('fs-extra');
const path = require('path');
const { EventEmitter } = require('events');
const logger = require('../logger');

// STATE_FILE has its own env var; fall back to WORKSPACE_DIR/state.json
function resolveStateFile() {
  if (process.env.STATE_FILE) return process.env.STATE_FILE;
  const base = process.env.WORKSPACE_DIR || '/tmp/tentacles';
  return path.join(base, 'state.json');
}

class StateManager extends EventEmitter {
  constructor() {
    super();
    this.sessions    = new Map();      // sessionId  → Session
    this.writeQueue  = Promise.resolve();
    this._dirty      = false;
    this._stateFile  = resolveStateFile();
    fs.ensureDirSync(path.dirname(this._stateFile));
    this._load();

    // Throttled flush: at most one disk write per 500 ms no matter how many
    // mutations happen in quick succession.
    this._flushTimer = null;
  }

  // ── Disk I/O ────────────────────────────────────────────────────────────────
  _load() {
    try {
      if (fs.existsSync(this._stateFile)) {
        const raw = fs.readJsonSync(this._stateFile);
        let loaded = 0;
        for (const [id, sess] of Object.entries(raw.sessions || {})) {
          // Normalise: add executions array if old format
          if (!sess.executions) sess.executions = [];

          // Mark any still-running executions as interrupted
          for (const exec of sess.executions) {
            if (['running', 'recon', 'pentest', 'created'].includes(exec.status)) {
              exec.status     = 'interrupted';
              exec.stoppedAt  = new Date().toISOString();
            }
          }
          this.sessions.set(id, sess);
          loaded++;
        }
        logger.info('State loaded from disk', { file: this._stateFile, sessions: loaded });
      } else {
        logger.info('No state file found — starting fresh', { file: this._stateFile });
      }
    } catch (err) {
      logger.error('State load failed — starting fresh', { err: err.message });
    }
  }

  _schedulePersist() {
    if (this._flushTimer) return;              // already scheduled
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushNow();
    }, 500);
  }

  _flushNow() {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const data = {
          schemaVersion: 2,
          updatedAt:     new Date().toISOString(),
          sessions:      {},
        };
        for (const [id, sess] of this.sessions) {
          // Trim conversation history before persisting to keep file manageable
          const persisted = { ...sess };
          if (persisted.executions) {
            persisted.executions = persisted.executions.map(ex => {
              const e = { ...ex };
              if (e.conversationHistory && e.conversationHistory.length > 40) {
                e.conversationHistory = e.conversationHistory.slice(-40);
              }
              return e;
            });
          }
          data.sessions[id] = persisted;
        }
        await fs.writeJson(this._stateFile, data, { spaces: 2 });
      } catch (err) {
        logger.error('State persist failed', { err: err.message });
      }
    });
  }

  // ── Session CRUD ─────────────────────────────────────────────────────────────

  /**
   * Get or create a session for a target.
   * Sessions are keyed by sessionId (caller-supplied, usually a slug).
   */
  createSession(sessionId, target, options = {}, program = {}) {
    const now = new Date().toISOString();
    const session = {
      id:         sessionId,
      target,
      options,
      // ── Program context (bug bounty platform config) ──────────────────────
      program: {
        platform:    program.platform    || '',          // hackerone|bugcrowd|intigriti|custom
        minSeverity: program.minSeverity || 'MEDIUM',   // minimum reportable severity
        scope:       program.scope       || [],          // allowed domains/paths
        outOfScope:  program.outOfScope  || [],          // excluded domains/paths
        notes:       program.notes       || '',          // program-specific notes
        url:         program.url         || '',          // program URL
      },
      // ── Auth config (injected into all tool calls) ────────────────────────
      auth: {
        type:      options.auth?.type      || 'none',
        cookie:    options.auth?.cookie    || '',
        bearer:    options.auth?.bearer    || '',
        username:  options.auth?.username  || '',
        password:  options.auth?.password  || '',
        loginPath: options.auth?.loginPath || '/login',
        csrfPath:  options.auth?.csrfPath  || '',
        headers:   options.auth?.headers   || {},
      },
      // ── Victim auth (second account for IDOR testing) ─────────────────────
      victimAuth: options.victimAuth?.type && options.victimAuth.type !== 'none' ? {
        type:      options.victimAuth?.type      || 'none',
        cookie:    options.victimAuth?.cookie    || '',
        bearer:    options.victimAuth?.bearer    || '',
        username:  options.victimAuth?.username  || '',
        password:  options.victimAuth?.password  || '',
        loginPath: options.victimAuth?.loginPath || '/login',
      } : null,
      extraAccounts: (options.extraAccounts || []).filter(a => a.type !== 'none'),
      createdAt:  now,
      updatedAt:  now,
      executions: [],    // Execution[]
      operator:   options.operator || 'default',       // multi-user tag
    };
    this.sessions.set(sessionId, session);
    this._schedulePersist();
    logger.info('Session created', { sessionId, target });
    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getAllSessions() {
    return Array.from(this.sessions.values())
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  updateSession(sessionId, updates) {
    const sess = this.sessions.get(sessionId);
    if (!sess) return null;
    Object.assign(sess, updates, { updatedAt: new Date().toISOString() });
    this._schedulePersist();
    return sess;
  }

  // ── Execution CRUD ───────────────────────────────────────────────────────────

  /**
   * Create a new execution (one pentest run) within a session.
   * Returns the new execution object.
   */
  createExecution(sessionId, execId) {
    const sess = this.sessions.get(sessionId);
    if (!sess) throw new Error(`Session ${sessionId} not found`);

    const now = new Date().toISOString();
    const execution = {
      id:                  execId,
      sessionId,
      status:              'created',  // created|recon|running|stopped|interrupted|error|completed
      createdAt:           now,
      startedAt:           null,
      stoppedAt:           null,
      iteration:           0,
      phase:               'init',

      // Recon data
      reconSummary:        null,

      // LLM conversation (trimmed before persist)
      conversationHistory: [],

      // Findings & reports
      findings:            [],
      reports:             [],

      // Stats
      stats: {
        totalToolExecutions: 0,
        successfulExecutions: 0,
        failedExecutions:     0,
        criticalFindings:     0,
        highFindings:         0,
        mediumFindings:       0,
        lowFindings:          0,
      },
    };

    sess.executions.push(execution);
    sess.updatedAt = now;
    this._schedulePersist();
    logger.info('Execution created', { sessionId, execId });
    return execution;
  }

  getExecution(sessionId, execId) {
    const sess = this.sessions.get(sessionId);
    if (!sess) return null;
    return sess.executions.find(e => e.id === execId) || null;
  }

  /**
   * Get the most recent execution for a session (the "active" one).
   */
  getLatestExecution(sessionId) {
    const sess = this.sessions.get(sessionId);
    if (!sess || !sess.executions.length) return null;
    return sess.executions[sess.executions.length - 1];
  }

  updateExecution(sessionId, execId, updates) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return null;
    Object.assign(exec, updates);
    if (this.sessions.get(sessionId)) {
      this.sessions.get(sessionId).updatedAt = new Date().toISOString();
    }
    this._schedulePersist();
    return exec;
  }

  // ── Pause / Resume / Checkpoint ──────────────────────────────────────────────

  pauseExecution(sessionId, execId) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return false;
    exec.paused   = true;
    exec.pausedAt = new Date().toISOString();
    exec.status   = 'paused';
    exec.updatedAt = exec.pausedAt;
    this._schedulePersist();
    return true;
  }

  resumeExecution(sessionId, execId) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return false;
    exec.paused    = false;
    exec.resumedAt = new Date().toISOString();
    exec.status    = 'running';
    exec.updatedAt = exec.resumedAt;
    this._schedulePersist();
    return true;
  }

  saveCheckpoint(sessionId, execId, checkpoint) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return;
    exec.checkpoint = { ...checkpoint, savedAt: new Date().toISOString() };
    exec.updatedAt  = exec.checkpoint.savedAt;
    this._schedulePersist();
  }

  getCheckpoint(sessionId, execId) {
    return this.getExecution(sessionId, execId)?.checkpoint || null;
  }

  markCrashed(sessionId, execId, reason) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return;
    exec.status      = 'crashed';
    exec.crashReason = reason;
    exec.crashedAt   = new Date().toISOString();
    exec.updatedAt   = exec.crashedAt;
    this._schedulePersist();
  }

  // ── Execution data mutations ──────────────────────────────────────────────────

  addLog(sessionId, execId, entry) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return;
    if (!exec.logs) exec.logs = [];
    exec.logs.push({ id: Date.now() + Math.random(), ts: new Date().toISOString(), ...entry });
    // Keep last 2000 log entries in memory
    if (exec.logs.length > 2000) exec.logs = exec.logs.slice(-2000);
    exec.updatedAt = new Date().toISOString();
    this._schedulePersist();
  }

  addFinding(sessionId, execId, finding) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return;

    const sev = (finding.severity || '').toUpperCase();

    // ── Hard filter: LOW and INFO findings are never stored ───────────────────
    // They add noise, waste LLM tokens, and provide zero actionable value.
    // Policy: CRITICAL → HIGH → MEDIUM only. Anything else is silently dropped.
    if (sev === 'LOW' || sev === 'INFO' || !sev) return;

    // ── Deduplication: keyed by target+vulnClass not title text ──────────────
    // Two SQLi on different URLs = two findings. Same vuln on same URL = dedup.
    const normalise = t => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    const vulnClass = finding.vuln_class || finding.toolId || 'unknown';
    const targetKey = normalise(finding.target || finding.text || '');
    const textKey   = normalise(finding.text || '').slice(0, 40);
    // Dedup key: severity + vulnClass + target (allows same class on different targets)
    const key = `${(finding.severity||'').toUpperCase()}|${vulnClass}|${targetKey}`;
    // Also dedup identical text on same target (catches parser duplicates)
    const textDedup = `${textKey}|${targetKey}`;
    const isDuplicate = exec.findings.some(f => {
      const fClass   = f.vuln_class || f.toolId || 'unknown';
      const fTarget  = normalise(f.target || f.text || '').slice(0, 60);
      const fKey     = `${(f.severity||'').toUpperCase()}|${fClass}|${fTarget}`;
      const fTextDup = `${normalise(f.text||'').slice(0,40)}|${fTarget}`;
      return fKey === key || fTextDup === textDedup;
    });
    if (isDuplicate) return;

    exec.findings.push({ ...finding, severity: sev, addedAt: new Date().toISOString() });

    if (sev === 'CRITICAL')    exec.stats.criticalFindings++;
    else if (sev === 'HIGH')   exec.stats.highFindings++;
    else if (sev === 'MEDIUM') exec.stats.mediumFindings++;

    this._schedulePersist();
    this.emit('findingAdded', { sessionId, execId, finding });
  }

  addReport(sessionId, execId, report) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return;
    exec.reports.push(report);
    this._schedulePersist();
    this.emit('reportAdded', { sessionId, execId, report });
  }

  addToolResult(sessionId, execId, toolResult) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return;
    exec.stats.totalToolExecutions++;
    if (toolResult.success) exec.stats.successfulExecutions++;
    else                    exec.stats.failedExecutions++;
    this._schedulePersist();
  }

  setReconData(sessionId, execId, summary) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return;
    // Merge: preserve any existing fields (e.g. jsEndpoints added by parallel recon)
    exec.reconSummary = exec.reconSummary
      ? { ...exec.reconSummary, ...summary }
      : summary;
    this._schedulePersist();
  }

  appendConversation(sessionId, execId, message) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return;
    exec.conversationHistory.push(message);
    // In-memory keep last 60; we trim to 40 on persist
    if (exec.conversationHistory.length > 60) {
      exec.conversationHistory = exec.conversationHistory.slice(-60);
    }
    // Conversation changes frequently — don't write every message
    this._schedulePersist();
  }

  incrementIteration(sessionId, execId) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return 0;
    exec.iteration++;
    this._schedulePersist();
    return exec.iteration;
  }

  // ── Aggregate helpers (used by API routes) ────────────────────────────────────

  /**
   * Returns a safe summary of a session for the list endpoint.
   * Does not include conversation history.
   */
  sessionSummary(sess) {
    const execs = sess.executions || [];
    const latest = execs[execs.length - 1] || null;
    const allFindings = execs.flatMap(e => e.findings || []);
    const allReports  = execs.flatMap(e => e.reports  || []);
    return {
      id:            sess.id,
      target:        sess.target,
      createdAt:     sess.createdAt,
      updatedAt:     sess.updatedAt,
      executionCount: execs.length,
      latestExecution: latest ? {
        id:        latest.id,
        status:    latest.status,
        phase:     latest.phase,
        iteration: latest.iteration,
        createdAt: latest.createdAt,
        stoppedAt: latest.stoppedAt,
        stats:     latest.stats,
      } : null,
      totalFindings: allFindings.length,
      totalReports:  allReports.length,
      stats: {
        criticalFindings: allFindings.filter(f => f.severity === 'CRITICAL').length,
        highFindings:     allFindings.filter(f => f.severity === 'HIGH').length,
        mediumFindings:   allFindings.filter(f => f.severity === 'MEDIUM').length,
        lowFindings:      allFindings.filter(f => f.severity === 'LOW').length,
      },
    };
  }

  /**
   * Returns full execution detail (minus conversation history).
   */
  executionDetail(exec) {
    const { conversationHistory, ...safe } = exec;
    return { ...safe, historyLength: conversationHistory.length };
  }

  // ── Finding false-positive + annotation management ────────────────────────────
  markFindingFP(sessionId, execId, findingIdx, reason = '') {
    const exec = this.getExecution(sessionId, execId);
    if (!exec || !exec.findings?.[findingIdx]) return false;
    exec.findings[findingIdx].status    = 'false_positive';
    exec.findings[findingIdx].fpReason  = reason;
    exec.findings[findingIdx].fpAt      = new Date().toISOString();
    this._schedulePersist();
    return true;
  }

  annotateFinding(sessionId, execId, findingIdx, note) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec || !exec.findings?.[findingIdx]) return false;
    if (!exec.findings[findingIdx].annotations) exec.findings[findingIdx].annotations = [];
    exec.findings[findingIdx].annotations.push({
      note, addedAt: new Date().toISOString(),
    });
    this._schedulePersist();
    return true;
  }

  // ── Report lifecycle ─────────────────────────────────────────────────────────
  updateReportStatus(sessionId, execId, reportId, update) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return null;
    const report = (exec.reports || []).find(r => r.reportId === reportId);
    if (!report) return null;
    Object.assign(report, {
      lifecycle: update.status || report.lifecycle || 'draft',
      platformUrl:   update.platformUrl   || report.platformUrl   || '',
      bountyAmount:  update.bountyAmount  !== undefined ? update.bountyAmount  : (report.bountyAmount  || 0),
      platformNotes: update.platformNotes || report.platformNotes || '',
      updatedAt:     new Date().toISOString(),
    });
    this._schedulePersist();
    return report;
  }

  // ── Target queue (multi-target sessions) ──────────────────────────────────
  getTargetQueue() {
    // Queue lives in persisted state so it survives restarts
    if (!this._state.targetQueue) this._state.targetQueue = [];
    return this._state.targetQueue;
  }

  addToTargetQueue(entry) {
    if (!this._state.targetQueue) this._state.targetQueue = [];
    this._state.targetQueue.push({
      ...entry,
      id:       `q_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      queuedAt: new Date().toISOString(),
      status:   'pending',
    });
    this._schedulePersist();
  }

  removeFromQueue(queueId) {
    if (!this._state.targetQueue) return;
    this._state.targetQueue = this._state.targetQueue.filter(t => t.id !== queueId);
    this._schedulePersist();
  }

  updateQueueItem(queueId, patch) {
    const item = (this._state.targetQueue || []).find(t => t.id === queueId);
    if (!item) return;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    this._schedulePersist();
  }

  dequeueNextTarget() {
    if (!this._state.targetQueue) return null;
    const next = this._state.targetQueue.find(t => t.status === 'pending');
    if (next) {
      next.status    = 'running';
      next.startedAt = new Date().toISOString();
      this._schedulePersist();
    }
    return next || null;
  }

  markQueueItemDone(queueId, sessionId) {
    const item = (this._state.targetQueue || []).find(t => t.id === queueId);
    if (!item) return;
    item.status    = 'done';
    item.doneAt    = new Date().toISOString();
    item.sessionId = sessionId;
    this._schedulePersist();
  }

  markQueueItemFailed(queueId, reason) {
    const item = (this._state.targetQueue || []).find(t => t.id === queueId);
    if (!item) return;
    item.status = 'failed';
    item.failReason = reason;
    item.failedAt   = new Date().toISOString();
    this._schedulePersist();
  }

  // ── Execution diff — compare two runs on the same session ─────────────────
  diffExecutions(sessionId, eid1, eid2) {
    const e1 = this.getExecution(sessionId, eid1);
    const e2 = this.getExecution(sessionId, eid2);
    if (!e1 || !e2) return null;

    const norm = t => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);

    // New findings in e2 not in e1
    const e1Keys = new Set((e1.findings || []).map(f => `${f.severity}|${norm(f.text)}`));
    const newFindings = (e2.findings || []).filter(f => !e1Keys.has(`${f.severity}|${norm(f.text)}`));

    // Resolved findings in e1 not in e2
    const e2Keys = new Set((e2.findings || []).map(f => `${f.severity}|${norm(f.text)}`));
    const resolvedFindings = (e1.findings || []).filter(f => !e2Keys.has(`${f.severity}|${norm(f.text)}`));

    // Recon changes
    const r1 = e1.reconSummary || {}; const r2 = e2.reconSummary || {};
    const newSubdomains = (r2.subdomains || []).filter(s => !(r1.subdomains || []).includes(s));
    const goneSubdomains = (r1.subdomains || []).filter(s => !(r2.subdomains || []).includes(s));
    const newPaths = (r2.ffufFindings || []).filter(f => !(r1.ffufFindings || []).some(f1 => f1.url === f.url));

    return {
      execId1: eid1, execId2: eid2,
      summary: `+${newFindings.length} new / -${resolvedFindings.length} resolved | +${newSubdomains.length} new subs | +${newPaths.length} new paths`,
      newFindings, resolvedFindings,
      recon: { newSubdomains, goneSubdomains, newPaths },
      iterations: { before: e1.iteration, after: e2.iteration },
    };
  }

  // ── Findings velocity (rolling window for auto-stop) ──────────────────────
  getFindingsVelocity(sessionId, execId, windowIterations = 30) {
    const exec = this.getExecution(sessionId, execId);
    if (!exec) return 0;
    const recentIter = exec.iteration - windowIterations;
    const recentFindings = (exec.findings || []).filter(f => (f.iteration || 0) >= recentIter);
    return recentFindings.length;
  }
}

module.exports = new StateManager();
