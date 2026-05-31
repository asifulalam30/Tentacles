/**
 * SWEEP QUEUE
 *
 * Global admission controller for sweeps. Caps concurrent sweeps at
 * MAX_CONCURRENT_SWEEPS (default 3, env-overridable). Anything started
 * beyond the cap goes into a FIFO queue and runs when a slot opens.
 *
 * Per-workbench concurrency is still enforced — you can't have two sweeps
 * running on the same workbench. The cap is across the whole instance.
 *
 * State is in-memory only. If Node restarts, queued sweeps don't survive
 * (running ones are marked crashed and resumed by the existing sweepPipeline
 * on next request). That's the right behavior — auto-restarting queued
 * sweeps after a crash is more dangerous than helpful.
 */

'use strict';

const sweepPipeline = require('./sweepPipeline');
const chatEngine = require('./chatEngine');

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SWEEPS || '3', 10);

// In-memory state
const _running = new Map();   // wbId → { startedAt, level, stealth, speed }
const _queue = [];            // ordered list of { wbId, opts, queuedAt }

function getQueueState() {
  return {
    maxConcurrent: MAX_CONCURRENT,
    running: Array.from(_running.entries()).map(([wbId, s]) => ({ wbId, ...s })),
    queued: _queue.map(item => ({
      wbId: item.wbId,
      level: item.opts.level,
      stealth: !!item.opts.stealth,
      speed: item.opts.speed,
      queuedAt: item.queuedAt,
    })),
  };
}

/**
 * Try to start a sweep immediately. If we're at the cap, queue it instead.
 * Returns:
 *   { ok: true, status: 'started' | 'queued', position: N }
 *   { ok: false, error: '...' }
 */
async function enqueueSweep(wbId, opts) {
  // Already running for this workbench → reject (matches existing behavior)
  if (_running.has(wbId) || sweepPipeline.isSweepRunning(wbId)) {
    return { ok: false, error: 'A sweep is already running for this workbench.' };
  }
  // Already queued for this workbench → reject
  if (_queue.find(q => q.wbId === wbId)) {
    return { ok: false, error: 'This workbench is already in the sweep queue.' };
  }

  // Try to start now
  if (_running.size < MAX_CONCURRENT) {
    return _startNow(wbId, opts);
  }

  // Queue it
  _queue.push({ wbId, opts, queuedAt: new Date().toISOString() });
  await chatEngine.pushReconFinding(wbId, {
    icon: '⏳',
    headline: `Sweep queued — position ${_queue.length} (${_running.size}/${MAX_CONCURRENT} slots in use)`,
    detail: `Will start automatically when a slot frees up. Cap: ${MAX_CONCURRENT}.`,
  }).catch(() => {});
  return { ok: true, status: 'queued', position: _queue.length };
}

async function _startNow(wbId, opts) {
  const result = await sweepPipeline.startSweep(wbId, opts);
  if (!result.ok) return result;

  _running.set(wbId, {
    startedAt: new Date().toISOString(),
    level: opts.level,
    stealth: !!opts.stealth,
    speed: opts.speed || 'standard',
  });

  // Watch for completion → drain the queue
  _watchForCompletion(wbId);

  return { ok: true, status: 'started', running: _running.size, queued: _queue.length };
}

// Polls sweepPipeline.isSweepRunning to detect when a sweep ends, then drains
// the queue. Polling is fine here — sweeps run for hours, so a 5s poll cost is
// nothing relative to the work being done.
function _watchForCompletion(wbId) {
  const interval = setInterval(async () => {
    if (!sweepPipeline.isSweepRunning(wbId)) {
      clearInterval(interval);
      _running.delete(wbId);
      // Drain one from the queue
      if (_queue.length > 0 && _running.size < MAX_CONCURRENT) {
        const next = _queue.shift();
        try {
          await chatEngine.pushReconFinding(next.wbId, {
            icon: '🚀',
            headline: 'Sweep slot opened — starting now',
          });
        } catch {}
        try {
          await _startNow(next.wbId, next.opts);
        } catch (e) {
          console.error(`Failed to start queued sweep for ${next.wbId}:`, e.message);
          try {
            await chatEngine.pushReconFinding(next.wbId, {
              icon: '⚠',
              headline: `Failed to start queued sweep: ${e.message}`,
            });
          } catch {}
        }
      }
    }
  }, 5000);
  // Don't keep the process alive just for this
  if (interval.unref) interval.unref();
}

/**
 * Remove a queued sweep (not running ones). Cancelling a running sweep
 * still goes through sweepPipeline.cancelSweep.
 */
function removeFromQueue(wbId) {
  const idx = _queue.findIndex(q => q.wbId === wbId);
  if (idx < 0) return { ok: false, error: 'Not in queue' };
  _queue.splice(idx, 1);
  return { ok: true };
}

/**
 * Clear queued sweeps + active running sweeps. Used in test cleanup.
 */
function _resetForTest() {
  _running.clear();
  _queue.length = 0;
}

module.exports = {
  enqueueSweep,
  removeFromQueue,
  getQueueState,
  MAX_CONCURRENT,
  _resetForTest,
};
