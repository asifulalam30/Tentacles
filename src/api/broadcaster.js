'use strict';
/**
 * WEBSOCKET BROADCASTER  v2.2
 *
 * Fix: execId is now included in EVERY message so the frontend
 * always knows which execution produced the event, regardless of
 * what activeExecId the client currently has set.
 */
const { WebSocketServer } = require('ws');
const logger = require('../logger');

class Broadcaster {
  constructor() {
    this.wss     = null;
    this.clients = new Map(); // ws → { sessionId, execId, connectedAt }
  }

  attach(server) {
    // Use noServer mode + manual upgrade routing so we can coexist with
    // the workbench's WebSocket on /ws/workbench.
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = req.url || '';
      // Workbench handles its own upgrades — let it pass through if matched.
      if (url.startsWith('/ws/workbench')) return;
      if (url.startsWith('/ws')) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
        return;
      }
      // Anything else: not for us.
      // (Don't destroy the socket — another upgrade handler might claim it.)
    });

    this.wss.on('connection', (ws, req) => {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      logger.info('WS connected', { ip });
      this.clients.set(ws, { sessionId: null, execId: null, connectedAt: Date.now() });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'subscribe' && msg.sessionId) {
            const meta = this.clients.get(ws);
            if (meta) {
              meta.sessionId = msg.sessionId;
              meta.execId    = msg.execId || null;
            }
            logger.info('WS subscribe', { sessionId: msg.sessionId, execId: msg.execId, ip });
            ws.send(JSON.stringify({ type: 'subscribed', sessionId: msg.sessionId, execId: msg.execId }));
          }
          // Client can update which execution it's watching without reconnecting
          if (msg.type === 'watch_exec' && msg.execId) {
            const meta = this.clients.get(ws);
            if (meta) meta.execId = msg.execId;
          }
        } catch { /* ignore malformed */ }
      });

      ws.on('close', () => { this.clients.delete(ws); logger.info('WS disconnected', { ip }); });
      ws.on('error', (err) => { logger.error('WS error', { err: err.message }); this.clients.delete(ws); });

      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
    });

    setInterval(() => {
      for (const [ws] of this.clients) {
        if (!ws.isAlive) { ws.terminate(); this.clients.delete(ws); continue; }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30000);

    logger.info('WebSocket server ready');
  }

  // ── Core send: include execId in every payload ────────────────────────────
  toSession(sessionId, event) {
    const payload = JSON.stringify({
      ...event,
      sessionId,
      ts: new Date().toISOString(),
      // execId is already in event if the caller included it
    });
    let sent = 0;
    for (const [ws, meta] of this.clients) {
      if (ws.readyState === 1 && (meta.sessionId === sessionId || meta.sessionId === '*')) {
        ws.send(payload);
        sent++;
      }
    }
    return sent;
  }

  toAll(event) {
    const payload = JSON.stringify({ ...event, ts: new Date().toISOString() });
    for (const [ws] of this.clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  // ── All helpers now accept and forward execId ─────────────────────────────
  emit(sessionId, type, data = {}) {
    return this.toSession(sessionId, { type, ...data });
  }

  reconPhase(sessionId, execId, phase, line) {
    this.emit(sessionId, 'recon_line', { execId, phase, line });
  }

  agentThinking(sessionId, execId, text) {
    this.emit(sessionId, 'agent_thinking', { execId, text });
  }

  agentDecision(sessionId, execId, reasoning, tool, rationale) {
    this.emit(sessionId, 'agent_decision', { execId, reasoning, tool, rationale });
  }

  toolStart(sessionId, execId, toolId, label, command) {
    this.emit(sessionId, 'tool_start', { execId, toolId, label, command });
  }

  toolOutput(sessionId, execId, toolId, chunk) {
    this.emit(sessionId, 'tool_output', { execId, toolId, chunk });
  }

  toolDone(sessionId, execId, toolId, result) {
    this.emit(sessionId, 'tool_done', { execId, toolId, result });
  }

  findingFound(sessionId, execId, finding) {
    this.emit(sessionId, 'finding_found', { execId, finding });
  }

  reportGenerated(sessionId, execId, report) {
    this.emit(sessionId, 'report_generated', { execId, report });
  }

  sessionStatus(sessionId, execId, status, data = {}) {
    this.emit(sessionId, 'session_status', { execId, status, ...data });
  }

  error(sessionId, execId, message, details = {}) {
    try {
      const fl = require('../agent/forensicLogger');
      fl.logError(sessionId, execId, message, details);
    } catch {}
    this.emit(sessionId, 'agent_error', { execId, message, details });
  }

  log(sessionId, execId, level, message, meta = {}) {
    // Store in stateManager for polling — this is how the frontend reads logs now
    try {
      const sm = require('../state/stateManager');
      sm.addLog(sessionId, execId, { kind: 'log', level, text: message, ...meta });
    } catch {}
    // Forensic write — every log goes to disk too
    try {
      const fl = require('../agent/forensicLogger');
      fl.logAgent(sessionId, execId, level, message, meta);
    } catch {}
    // Also emit via WS for any legacy listeners
    this.emit(sessionId, 'log', { execId, level, message, meta });
  }

  // Store structured log entry (for agent decisions, tool results, findings etc)
  logEntry(sessionId, execId, entry) {
    try {
      const sm = require('../state/stateManager');
      sm.addLog(sessionId, execId, entry);
    } catch {}
    this.emit(sessionId, 'log_entry', { execId, entry });
  }
}

module.exports = new Broadcaster();
