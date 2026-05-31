/**
 * WORKBENCH SESSION STORE
 *
 * Persists workbench state to disk so a session survives:
 *   - Browser tab close + reopen (most common)
 *   - Server restart (less common)
 *   - Reconnection from a different device
 *
 * Each workbench session has its own directory:
 *   /opt/tentacles/workbenches/<workbenchId>/
 *     manifest.json        — session metadata (target, created, last active)
 *     scrollback.log       — append-only terminal scrollback (last N MB)
 *     commands.jsonl       — every command run, with timestamp + duration
 *     notes.jsonl          — observer notes (LLM annotations)
 *     suggestions.json     — current suggested commands (overwritten as it evolves)
 *     hypotheses.json      — engagement brief hypotheses (refined over time)
 *     brief.md             — the engagement brief, in markdown
 *
 * Workbench IDs are short (`wb_xxxxxxxx`) and human-readable.
 *
 * Single-workbench-at-a-time policy: if you start a new workbench while one is
 * active, the old one is detached (kept on disk, terminal alive in tmux) but
 * not displayed. You can reattach via the URL.
 */

'use strict';

const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const WORKBENCH_ROOT = process.env.WORKBENCH_DIR || '/opt/tentacles/workbenches';
const SCROLLBACK_MAX_BYTES = 8 * 1024 * 1024; // 8 MB cap before rotation

function workbenchDir(wbId) {
  return path.join(WORKBENCH_ROOT, wbId);
}

function newWorkbenchId() {
  return `wb_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
}

async function createWorkbench({ target, program, ownerSession, autoSweep }) {
  const wbId = newWorkbenchId();
  const dir = workbenchDir(wbId);
  await fs.ensureDir(dir);
  const manifest = {
    wbId,
    target,
    program: program || {},
    ownerSession: ownerSession || null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    state: 'idle', // idle | recon_running | recon_complete
    tmuxName: `tentacles-${wbId}`,
    autoSweep: autoSweep !== false,  // default true — user opts out via checkbox
  };
  await fs.writeJson(path.join(dir, 'manifest.json'), manifest, { spaces: 2 });
  // Initialize empty files
  await fs.writeFile(path.join(dir, 'scrollback.log'), '');
  await fs.writeFile(path.join(dir, 'commands.jsonl'), '');
  await fs.writeFile(path.join(dir, 'notes.jsonl'), '');
  await fs.writeJson(path.join(dir, 'suggestions.json'), { items: [], updatedAt: null });
  await fs.writeJson(path.join(dir, 'hypotheses.json'), { items: [], updatedAt: null });
  await fs.writeFile(path.join(dir, 'brief.md'), `# Engagement Brief — ${target}\n\nRecon starting…\n`);
  return manifest;
}

async function getWorkbench(wbId) {
  const file = path.join(workbenchDir(wbId), 'manifest.json');
  if (!await fs.pathExists(file)) return null;
  return fs.readJson(file);
}

async function listWorkbenches(opts = {}) {
  if (!await fs.pathExists(WORKBENCH_ROOT)) return [];
  const dirs = await fs.readdir(WORKBENCH_ROOT);
  const includeArchived = !!opts.includeArchived;
  const out = [];
  for (const d of dirs) {
    const m = await getWorkbench(d).catch(() => null);
    if (!m) continue;
    // Default: hide archived unless caller asks
    if (m.archived && !includeArchived) continue;

    // Decorate with sweep status (read sweep_state.json if it exists)
    try {
      const ss = await fs.readJson(path.join(workbenchDir(d), 'sweep_state.json'));
      if (ss && ss.status) {
        m.sweepStatus = ss.status;       // 'running' | 'completed' | 'cancelled' | 'crashed'
        m.sweepStartedAt = ss.startedAt || null;
        m.sweepCompletedAt = ss.completedAt || null;
      }
    } catch {
      // No sweep ever run — fine
    }

    // Decorate with queued state (consult the in-memory sweep queue)
    try {
      const sq = require('./sweepQueue');
      const qs = sq.getQueueState();
      if (qs.queued.some(q => q.wbId === d)) m.sweepQueued = true;
      if (qs.running.some(r => r.wbId === d)) m.sweepStatus = 'running';
    } catch {}

    out.push(m);
  }
  out.sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));
  return out;
}

async function updateWorkbench(wbId, patch) {
  const m = await getWorkbench(wbId);
  if (!m) return null;
  const next = { ...m, ...patch, lastActiveAt: new Date().toISOString() };
  await fs.writeJson(path.join(workbenchDir(wbId), 'manifest.json'), next, { spaces: 2 });
  return next;
}

async function deleteWorkbench(wbId) {
  const dir = workbenchDir(wbId);
  if (await fs.pathExists(dir)) await fs.remove(dir);
}

// ── Append helpers ─────────────────────────────────────────────────────────

async function appendScrollback(wbId, chunk) {
  const file = path.join(workbenchDir(wbId), 'scrollback.log');
  await fs.appendFile(file, chunk);
  // Rotate if it gets too big — keep the tail
  try {
    const stat = await fs.stat(file);
    if (stat.size > SCROLLBACK_MAX_BYTES * 1.5) {
      const fd = await fs.open(file, 'r');
      const buf = Buffer.alloc(SCROLLBACK_MAX_BYTES);
      await fs.read(fd, buf, 0, SCROLLBACK_MAX_BYTES, stat.size - SCROLLBACK_MAX_BYTES);
      await fs.close(fd);
      await fs.writeFile(file, buf);
    }
  } catch {}
}

async function readScrollback(wbId, lastBytes = SCROLLBACK_MAX_BYTES) {
  const file = path.join(workbenchDir(wbId), 'scrollback.log');
  if (!await fs.pathExists(file)) return '';
  const stat = await fs.stat(file);
  if (stat.size <= lastBytes) return fs.readFile(file, 'utf8');
  const fd = await fs.open(file, 'r');
  const buf = Buffer.alloc(lastBytes);
  await fs.read(fd, buf, 0, lastBytes, stat.size - lastBytes);
  await fs.close(fd);
  return buf.toString('utf8');
}

async function appendCommand(wbId, entry) {
  const file = path.join(workbenchDir(wbId), 'commands.jsonl');
  await fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

async function appendNote(wbId, note) {
  const file = path.join(workbenchDir(wbId), 'notes.jsonl');
  await fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...note }) + '\n');
}

async function readNotes(wbId, max = 200) {
  const file = path.join(workbenchDir(wbId), 'notes.jsonl');
  if (!await fs.pathExists(file)) return [];
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const tail = lines.slice(-max);
  return tail.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function setSuggestions(wbId, items) {
  const file = path.join(workbenchDir(wbId), 'suggestions.json');
  await fs.writeJson(file, { items, updatedAt: new Date().toISOString() }, { spaces: 2 });
}

async function getSuggestions(wbId) {
  const file = path.join(workbenchDir(wbId), 'suggestions.json');
  if (!await fs.pathExists(file)) return { items: [], updatedAt: null };
  return fs.readJson(file).catch(() => ({ items: [], updatedAt: null }));
}

async function setHypotheses(wbId, items) {
  await fs.writeJson(path.join(workbenchDir(wbId), 'hypotheses.json'),
    { items, updatedAt: new Date().toISOString() }, { spaces: 2 });
}

async function getHypotheses(wbId) {
  const file = path.join(workbenchDir(wbId), 'hypotheses.json');
  if (!await fs.pathExists(file)) return { items: [], updatedAt: null };
  return fs.readJson(file).catch(() => ({ items: [], updatedAt: null }));
}

async function writeBrief(wbId, markdown) {
  await fs.writeFile(path.join(workbenchDir(wbId), 'brief.md'), markdown);
}

async function readBrief(wbId) {
  const file = path.join(workbenchDir(wbId), 'brief.md');
  if (!await fs.pathExists(file)) return '';
  return fs.readFile(file, 'utf8');
}


// ── Chat messages ──────────────────────────────────────────────────────────

async function appendChatMessage(wbId, message) {
  // message: { role: 'user' | 'tentacles' | 'system' | 'recon', content, kind?, meta? }
  const file = path.join(workbenchDir(wbId), 'chat.jsonl');
  const entry = { ts: new Date().toISOString(), ...message };
  await fs.appendFile(file, JSON.stringify(entry) + '\n');
  return entry;
}

async function readChatMessages(wbId, max = 500) {
  const file = path.join(workbenchDir(wbId), 'chat.jsonl');
  if (!await fs.pathExists(file)) return [];
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  return lines.slice(-max).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ── Leads — specific places to check for bugs ─────────────────────────────
// A lead is a concrete, testable hypothesis with:
//   id          — stable identifier (lead_xxxxxxxx)
//   rank        — display position (1, 2, 3...)
//   priority    — likelihood × impact score (0-100)
//   headline    — "Reflection on /api/profile?id="
//   signal      — what recon noticed: "param 'id' echoed in response body"
//   test        — exact request to send (curl/code, copy-pasteable)
//   confirm_if  — what response would confirm the bug exists
//   rule_out_if — what response would rule it out
//   status      — untested | checking | confirmed | dead_end
//   status_reason — one-line explanation when status changes
//   created_at, updated_at, source ("recon" or "mid_session")

async function getLeads(wbId) {
  const file = path.join(workbenchDir(wbId), 'leads.json');
  if (!await fs.pathExists(file)) return { items: [], updatedAt: null };
  return fs.readJson(file).catch(() => ({ items: [], updatedAt: null }));
}

async function setLeads(wbId, items) {
  await fs.writeJson(path.join(workbenchDir(wbId), 'leads.json'),
    { items, updatedAt: new Date().toISOString() }, { spaces: 2 });
}

async function addLead(wbId, lead) {
  const data = await getLeads(wbId);
  // De-dup: skip if a lead with the same headline already exists
  if (data.items.find(l => (l.headline || '').toLowerCase() === (lead.headline || '').toLowerCase())) {
    return null;
  }
  const newLead = {
    id: `lead_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    rank: data.items.length + 1,
    priority: 50,
    status: 'untested',
    status_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source: 'recon',
    ...lead,
  };
  data.items.push(newLead);
  // Re-rank by priority desc, then by created_at asc
  data.items.sort((a, b) => (b.priority || 0) - (a.priority || 0) || (a.created_at || '').localeCompare(b.created_at || ''));
  data.items.forEach((l, i) => { l.rank = i + 1; });
  await setLeads(wbId, data.items);
  return newLead;
}

async function updateLead(wbId, leadId, patch) {
  const data = await getLeads(wbId);
  const lead = data.items.find(l => l.id === leadId);
  if (!lead) return null;
  Object.assign(lead, patch, { updated_at: new Date().toISOString() });
  await setLeads(wbId, data.items);
  return lead;
}

// Remove all leads matching a given source. Used by lead regeneration so
// re-running doesn't double up the list. Confirmed-status leads from the same
// source are preserved (the user's manual work shouldn't be wiped).
async function removeLeadsBySource(wbId, source) {
  const data = await getLeads(wbId);
  const remaining = data.items.filter(l =>
    l.source !== source || l.status === 'confirmed' || l.status === 'checking'
  );
  if (remaining.length === data.items.length) return 0;
  // Re-rank
  remaining.forEach((l, i) => { l.rank = i + 1; });
  await setLeads(wbId, remaining);
  return data.items.length - remaining.length;
}

// ── Code artifacts (generated PoCs, scripts) ───────────────────────────────

async function saveArtifact(wbId, artifactId, payload) {
  // payload: { name, language, code, description }
  const dir = path.join(workbenchDir(wbId), 'artifacts');
  await fs.ensureDir(dir);
  await fs.writeJson(path.join(dir, `${artifactId}.json`),
    { artifactId, ...payload, savedAt: new Date().toISOString() }, { spaces: 2 });
}

async function listArtifacts(wbId) {
  const dir = path.join(workbenchDir(wbId), 'artifacts');
  if (!await fs.pathExists(dir)) return [];
  const files = await fs.readdir(dir);
  const arts = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try { arts.push(await fs.readJson(path.join(dir, f))); } catch {}
  }
  arts.sort((a,b) => (b.savedAt||'').localeCompare(a.savedAt||''));
  return arts;
}

async function getArtifact(wbId, artifactId) {
  const file = path.join(workbenchDir(wbId), 'artifacts', `${artifactId}.json`);
  if (!await fs.pathExists(file)) return null;
  return fs.readJson(file).catch(() => null);
}

module.exports = {
  WORKBENCH_ROOT,
  workbenchDir,
  createWorkbench,
  getWorkbench,
  listWorkbenches,
  updateWorkbench,
  deleteWorkbench,
  appendScrollback,
  readScrollback,
  appendCommand,
  appendNote,
  readNotes,
  setSuggestions,
  getSuggestions,
  setHypotheses,
  getHypotheses,
  writeBrief,
  readBrief,
  appendChatMessage,
  readChatMessages,
  saveArtifact,
  listArtifacts,
  getArtifact,
  getLeads,
  setLeads,
  addLead,
  updateLead,
  removeLeadsBySource,
};
