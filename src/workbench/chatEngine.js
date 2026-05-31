/**
 * BROADCAST-ONLY STREAM ENGINE (formerly chatEngine.js)
 *
 * The LLM/chat/lead features have been removed. This module is now purely
 * a pub/sub layer that lets other backend modules broadcast recon/sweep/
 * tool findings to connected browser tabs.
 */

'use strict';

const sessionStore = require('./sessionStore');

// In-memory subscriber map
const _subscribers = new Map(); // wbId -> Set<ws>

function addSubscriber(wbId, ws) {
  if (!_subscribers.has(wbId)) _subscribers.set(wbId, new Set());
  _subscribers.get(wbId).add(ws);
}

function removeSubscriber(wbId, ws) {
  const s = _subscribers.get(wbId);
  if (s) s.delete(ws);
}

function _broadcast(wbId, payload) {
  const subs = _subscribers.get(wbId);
  if (!subs) return;
  for (const ws of subs) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    } catch { /* dead socket */ }
  }
}

// Activity stream — log + broadcast a finding
async function pushReconFinding(wbId, finding) {
  const content = `${finding.icon || '🎯'} **${finding.headline}**${finding.detail ? '\n\n' + finding.detail : ''}`;
  let msg;
  try {
    msg = await sessionStore.appendChatMessage(wbId, {
      role: 'recon',
      content,
      kind: 'recon_finding',
      meta: {
        icon: finding.icon,
        action_label: finding.action_label,
        action_payload: finding.action_payload,
      },
    });
  } catch {
    msg = {
      id: 'ephemeral_' + Date.now(),
      role: 'recon',
      content,
      kind: 'recon_finding',
      createdAt: new Date().toISOString(),
      meta: { icon: finding.icon },
    };
  }
  _broadcast(wbId, { type: 'chat_message', message: msg });
  return msg;
}

function broadcastChatMessage(wbId, message) {
  _broadcast(wbId, { type: 'chat_message', message });
}

function broadcastEvent(wbId, type, payload = {}) {
  _broadcast(wbId, { type, ...payload });
}

async function appendChatMessage(wbId, message) {
  return sessionStore.appendChatMessage(wbId, message);
}

// Stubs for removed LLM features — return gracefully if anything calls them
async function handleUserMessage() { return null; }
function classifyInput() { return { kind: 'plain' }; }
function detectHttpResponse() { return false; }
function getActiveLead() { return null; }
function setActiveLead() {}
function clearActiveLead() {}
async function startTestingLead() { return null; }
async function evaluateLeadResponse() { return null; }
async function disputeLeadVerdict() { return null; }
async function findRelatedLeads() { return null; }

const PASTE_COLLAPSE_THRESHOLD = 1200;

module.exports = {
  addSubscriber,
  removeSubscriber,
  pushReconFinding,
  broadcastChatMessage,
  broadcastEvent,
  appendChatMessage,
  handleUserMessage,
  classifyInput,
  detectHttpResponse,
  getActiveLead,
  setActiveLead,
  clearActiveLead,
  startTestingLead,
  evaluateLeadResponse,
  disputeLeadVerdict,
  findRelatedLeads,
  PASTE_COLLAPSE_THRESHOLD,
};
