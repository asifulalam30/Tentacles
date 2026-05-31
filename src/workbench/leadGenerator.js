/**
 * STUB — lead generation feature has been removed.
 *
 * This file exists only to keep latent `require('./leadGenerator')` calls
 * from crashing the chat engine (the `findRelatedLeads` WS handler still
 * has dead code that imports _scorePriority). The handler itself is
 * unreachable because the frontend no longer triggers it.
 *
 * If you remove this file, the chat engine still loads fine — the require
 * is inside a function body, not at module top — but any path that fires
 * the dead handler would 500.
 *
 * The dead handler will be deleted entirely in a future cleanup pass. For
 * now, keep this stub so nothing breaks.
 */

'use strict';

function _scorePriority(rawLead) {
  // Simple priority score 0-100 based on likelihood × impact / 100
  const lik = Number(rawLead?.likelihood) || 50;
  const imp = Number(rawLead?.impact) || 50;
  return Math.round((lik * imp) / 100);
}

// Stub generateLeads — returns "feature removed" without doing anything.
// Nothing in the live code path calls this any more, but if a stale tool
// reference ever fires it, return a graceful no-op.
async function generateLeads(wbId) {
  return { count: 0, leads: [], error: null, note: 'Lead generation has been removed.' };
}

module.exports = {
  _scorePriority,
  generateLeads,
};
