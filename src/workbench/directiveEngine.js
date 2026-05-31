/**
 * STUB — AI directive engine removed.
 * Other modules may still load this; we return no-ops.
 */
'use strict';

function addBroadcaster() {}
function removeBroadcaster() {}
async function executePlan() { return null; }
function cancelPlan() {}
async function getDirectiveRecord() { return null; }
async function listDirectiveRecords() { return []; }

module.exports = {
  addBroadcaster,
  removeBroadcaster,
  executePlan,
  cancelPlan,
  getDirectiveRecord,
  listDirectiveRecords,
};
