'use strict';
require('dotenv').config();

const http      = require('http');
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const fs        = require('fs-extra');
const logger    = require('./logger');
const broadcaster = require('./api/broadcaster');
const routes    = require('./api/routes');

// ── Ensure required directories ───────────────────────────────────────────────
const dirs = [
  process.env.WORKSPACE_DIR || '/tmp/tentacles/workspace',
  process.env.REPORTS_DIR   || '/tmp/tentacles/reports',
  process.env.SCRIPTS_DIR   || '/tmp/tentacles/scripts',
  path.dirname(process.env.LOG_FILE || '/tmp/tentacles/logs/tentacles.log'),
  path.dirname(process.env.STATE_FILE || '/tmp/tentacles/state.json'),
];
for (const dir of dirs) fs.ensureDirSync(dir);

// ── Validate critical env vars ────────────────────────────────────────────────
if (!process.env.API_SECRET_KEY || process.env.API_SECRET_KEY === 'change-this-to-a-random-secret-key') {
  logger.warn('API_SECRET_KEY not set — backend is unauthenticated');
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
// Development: allow all origins so you can hit the API from any device.
// Production:  only allow the origins listed in ALLOWED_ORIGINS.
const isDev = (process.env.NODE_ENV || 'development') === 'development';

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Always allow localhost variants regardless of env
const alwaysAllow = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:4000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
];

app.use(cors({
  origin: (origin, cb) => {
    // No origin = same-origin request or curl — allow
    if (!origin) return cb(null, true);
    // Dev mode: allow everything
    if (isDev) return cb(null, true);
    // Always allow localhost
    if (alwaysAllow.some(o => origin.startsWith(o))) return cb(null, true);
    // Check configured list
    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);

    logger.warn('CORS blocked', { origin, allowedOrigins });
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
}));

// Handle preflight for all routes
app.options('*', cors());

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api', rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '200'),
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limit in dev
  skip: () => isDev,
  message: { error: 'Rate limit exceeded — try again shortly' },
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path !== '/api/health') {
    logger.info(`${req.method} ${req.path}`, { ip: req.ip });
  }
  next();
});

// ── Auth: verify frontend password ────────────────────────────────────────────
// POST /api/auth/verify  { password: "..." }  → { ok: true } or 401
// Plain text compare — works on HTTP (no crypto.subtle needed).
// The frontend password is completely separate from the Anthropic API key.
app.post('/api/auth/verify', (req, res) => {
  const { password } = req.body || {};
  const expected = process.env.FRONTEND_PASSWORD || 'L@t1tude';
  if (password === expected) {
    // Return the API key so the frontend saves it automatically
    // User only needs to know the FRONTEND_PASSWORD, not the API_SECRET_KEY
    res.json({ ok: true, apiKey: process.env.API_SECRET_KEY || '' });
  } else {
    res.status(401).json({ ok: false, error: 'Incorrect password' });
  }
});

// ── Workbench REST routes — must be registered BEFORE general /api router
try {
  const workbenchRoutes = require('./workbench/routes');
  app.use('/api/workbenches', workbenchRoutes);
  logger.info('Workbench routes mounted at /api/workbenches');
} catch (e) {
  logger.warn('Workbench routes failed to mount: ' + e.message);
}

// ── API routes (protected by API_SECRET_KEY header) ───────────────────────────
app.use('/api', routes);

// ── Serve built frontend in production ────────────────────────────────────────
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
  logger.info('Serving built frontend from', { dir: frontendDist });
}

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  if (err.message?.startsWith('CORS:')) {
    return res.status(403).json({ error: err.message });
  }
  logger.error('Unhandled error', { err: err.message, path: req.path });
  res.status(500).json({ error: isDev ? err.message : 'Internal server error' });
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
broadcaster.attach(server);

// Workbench WebSocket handler — needs the http.Server instance
try {
  const wbWs = require('./workbench/wsHandler');
  const WebSocket = require('ws');
  const wbWss = new WebSocket.Server({ noServer: true });
  wbWss.on('connection', wbWs.handleConnection);
  server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/ws/workbench')) {
      wbWss.handleUpgrade(req, socket, head, (ws) => wbWss.emit('connection', ws, req));
    }
  });
  logger.info('Workbench WS handler attached at /ws/workbench');
} catch (e) {
  logger.warn('Workbench WS handler failed to attach: ' + e.message);
}

const PORT = parseInt(process.env.PORT || '4000');
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  const mode = isDev ? 'DEVELOPMENT' : 'PRODUCTION';
  logger.info('TENTACLES backend started', { port: PORT, host: HOST, mode });

  console.log(`
╔══════════════════════════════════════════════╗
║        TENTACLES v3 — BACKEND (${mode.padEnd(10)})  ║
╠══════════════════════════════════════════════╣
║  API  : http://${HOST}:${PORT}/api              ║
║  WS   : ws://${HOST}:${PORT}/ws                ║
║  Mode : ${mode.padEnd(36)}║
║                                              ║
║  API_SECRET_KEY    : ${process.env.API_SECRET_KEY && process.env.API_SECRET_KEY !== 'change-this-to-a-random-secret-key' ? '✓ set' : '⚠ using default'}            ║
║  FRONTEND_PASSWORD : ${process.env.FRONTEND_PASSWORD ? '✓ set' : '⚠ using default'}                  ║
╚══════════════════════════════════════════════╝`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received — shutting down`);
  server.close(() => { logger.info('Server closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err) => logger.error('Uncaught exception',  { err: err.message, stack: err.stack }));
process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', { reason: String(reason) }));

module.exports = { app, server };
