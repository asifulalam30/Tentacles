'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs-extra');
const logger  = require('../logger');

const router = express.Router();

// ── Health ────────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Default test credentials ──────────────────────────────────────────────
// Stored on the VPS at /opt/tentacles/default-credentials.json (mode 0600).
// Never bundled into source code. Used by Tentacles when running directives
// that need to be authenticated (e.g. test logged-in IDOR).
const DEFAULT_CREDS_PATH = process.env.DEFAULT_CREDENTIALS_PATH || '/opt/tentacles/default-credentials.json';

router.get('/default-credentials', async (req, res) => {
  try {
    if (!await fs.pathExists(DEFAULT_CREDS_PATH)) {
      return res.json({ accounts: [] });
    }
    const stat = await fs.stat(DEFAULT_CREDS_PATH);
    if ((stat.mode & 0o077) !== 0) {
      logger.warn(`default-credentials.json has loose perms — refusing. Run: chmod 600 ${DEFAULT_CREDS_PATH}`);
      return res.status(500).json({ error: 'default-credentials file has loose permissions; chmod 600 it' });
    }
    const data = await fs.readJson(DEFAULT_CREDS_PATH);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/default-credentials', async (req, res) => {
  try {
    const { accounts } = req.body || {};
    if (!Array.isArray(accounts)) return res.status(400).json({ error: 'accounts array required' });
    await fs.ensureDir(path.dirname(DEFAULT_CREDS_PATH));
    await fs.writeJson(DEFAULT_CREDS_PATH, { accounts }, { spaces: 2 });
    await fs.chmod(DEFAULT_CREDS_PATH, 0o600);
    res.json({ saved: true, count: accounts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/default-credentials', async (req, res) => {
  try {
    if (await fs.pathExists(DEFAULT_CREDS_PATH)) {
      await fs.unlink(DEFAULT_CREDS_PATH);
    }
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
