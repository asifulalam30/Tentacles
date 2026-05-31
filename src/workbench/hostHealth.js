/**
 * HOST HEALTH TRACKER
 *
 * Tracks per-host signals so the sweep can adapt:
 *   - 429 / 403 / 503 hit counts
 *   - When a host first started blocking us
 *   - "hot" flag → tools should slow down or skip this host
 *
 * State lives at workbenchDir/host_health.json. Async-safe — writes are
 * serialized via a per-workbench mutex to prevent torn JSON.
 *
 * Trigger threshold: ≥3 blocking responses (any of 429/403/503) within
 * 60 seconds → host marked hot. Once hot, stays hot for the rest of the
 * sweep (we don't auto-recover; defenders can keep you blocked once they
 * notice you).
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const sessionStore = require('./sessionStore');

// Per-workbench write mutex
const _mutexes = new Map();
async function _withLock(wbId, fn) {
  while (_mutexes.get(wbId)) {
    await _mutexes.get(wbId);
  }
  let release;
  const promise = new Promise(r => { release = r; });
  _mutexes.set(wbId, promise);
  try {
    return await fn();
  } finally {
    _mutexes.delete(wbId);
    release();
  }
}

function _statePath(wbId) {
  return path.join(sessionStore.workbenchDir(wbId), 'host_health.json');
}

async function _read(wbId) {
  try {
    return await fs.readJson(_statePath(wbId));
  } catch {
    return { hosts: {} };
  }
}

async function _write(wbId, state) {
  await fs.writeJson(_statePath(wbId), state, { spaces: 2 });
}

// Strip scheme + path + port → bare hostname
function _normalize(host) {
  if (!host) return null;
  let h = String(host).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(':')[0];
  return h || null;
}

const BLOCK_STATUSES = new Set([429, 403, 503]);
const TRIGGER_COUNT = 3;
const TRIGGER_WINDOW_MS = 60_000;

/**
 * Record one observed response. Trips "hot" if N blocking responses arrive
 * within W milliseconds.
 *
 * Returns the host's current state after the update.
 */
async function recordResponse(wbId, host, status, toolId = null) {
  const k = _normalize(host);
  if (!k) return null;
  const numStatus = typeof status === 'string' ? parseInt(status, 10) : status;
  if (isNaN(numStatus)) return null;

  return _withLock(wbId, async () => {
    const state = await _read(wbId);
    const now = Date.now();
    const entry = state.hosts[k] || {
      blocks: [], totalRequests: 0, hot: false, hotSince: null, hotReason: null,
    };
    entry.totalRequests++;
    if (BLOCK_STATUSES.has(numStatus)) {
      entry.blocks.push({ at: now, status: numStatus, tool: toolId });
      // Trim old blocks outside the trigger window
      entry.blocks = entry.blocks.filter(b => now - b.at < TRIGGER_WINDOW_MS);
      if (!entry.hot && entry.blocks.length >= TRIGGER_COUNT) {
        entry.hot = true;
        entry.hotSince = new Date().toISOString();
        entry.hotReason = `${entry.blocks.length}× ${entry.blocks.map(b => b.status).join('/')} in ${Math.round(TRIGGER_WINDOW_MS/1000)}s`;
      }
    }
    state.hosts[k] = entry;
    await _write(wbId, state);
    return entry;
  });
}

/**
 * Manually mark a host hot (used by sweep when a tool fails entirely on a host).
 */
async function markHostHot(wbId, host, reason) {
  const k = _normalize(host);
  if (!k) return null;
  return _withLock(wbId, async () => {
    const state = await _read(wbId);
    state.hosts[k] = state.hosts[k] || { blocks: [], totalRequests: 0 };
    state.hosts[k].hot = true;
    state.hosts[k].hotSince = state.hosts[k].hotSince || new Date().toISOString();
    state.hosts[k].hotReason = reason || state.hosts[k].hotReason || 'manually marked';
    await _write(wbId, state);
    return state.hosts[k];
  });
}

async function isHostHot(wbId, host) {
  const k = _normalize(host);
  if (!k) return false;
  const state = await _read(wbId);
  return !!(state.hosts[k] && state.hosts[k].hot);
}

async function getHotHosts(wbId) {
  const state = await _read(wbId);
  const hot = [];
  for (const [host, entry] of Object.entries(state.hosts || {})) {
    if (entry.hot) hot.push({ host, ...entry });
  }
  return hot;
}

async function getAllStatus(wbId) {
  return _read(wbId);
}

/**
 * Filter a list of hosts down to those that are NOT hot. Used by sweep
 * stages to skip noisy tools on hot hosts.
 */
async function filterToHealthyHosts(wbId, hosts) {
  const state = await _read(wbId);
  return (hosts || []).filter(h => {
    const k = _normalize(h);
    return !(k && state.hosts[k] && state.hosts[k].hot);
  });
}

/**
 * Reset hot status. Call this only at the start of a new sweep, never mid-sweep.
 */
async function resetHealth(wbId) {
  return _withLock(wbId, async () => {
    await _write(wbId, { hosts: {}, resetAt: new Date().toISOString() });
  });
}

module.exports = {
  recordResponse,
  markHostHot,
  isHostHot,
  getHotHosts,
  getAllStatus,
  filterToHealthyHosts,
  resetHealth,
  // Exposed for tests
  _normalize,
  BLOCK_STATUSES,
  TRIGGER_COUNT,
  TRIGGER_WINDOW_MS,
};
