/**
 * WORKBENCH MODULE — entry point
 *
 * Exposes a single `mount(app, server)` function that wires up:
 *   - REST routes under /api/workbenches
 *   - WebSocket handler at /ws/workbench
 */

'use strict';

const WebSocket = require('ws');
const { handleConnection } = require('./wsHandler');
const routes = require('./routes');

function mount(app, httpServer, { authMiddleware } = {}) {
  // REST routes
  if (authMiddleware) {
    app.use('/api/workbenches', authMiddleware, routes);
  } else {
    app.use('/api/workbenches', routes);
  }

  // WebSocket: dedicated path so it doesn't clash with any other ws on the server
  const wss = new WebSocket.Server({ noServer: true });
  wss.on('connection', handleConnection);

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/ws/workbench')) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
    // other upgrade handlers (existing ws server) will see the same event
    // — they should ignore paths they don't own
  });

  return { wss };
}

module.exports = { mount };
