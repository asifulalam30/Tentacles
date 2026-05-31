/**
 * WORKBENCH WEBSOCKET HANDLER
 *
 * Read-only live stream. The chat input was removed when AI was stripped,
 * so the only messages a client sends are `attach` (subscribe to a workbench's
 * broadcast feed) and `ping` (keepalive).
 *
 *   Client → Server:
 *     { type: "attach", wbId }
 *     { type: "ping" }
 *
 *   Server → Client (broadcast):
 *     { type: "attached", wb, messages, brief, artifacts, reconRunning }
 *     { type: "chat_message", message }  — live recon/sweep/tool finding
 *     { type: "recon_finished", exitCode } / similar typed events
 *     { type: "pong" }
 *     { type: "error", message }
 */

'use strict';

const sessionStore = require('./sessionStore');
const chatEngine = require('./chatEngine');

function safeSend(ws, obj) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch {}
}

async function handleConnection(ws, req) {
  let attached = false;
  let wbId = null;

  ws.on('close', () => {
    if (wbId) chatEngine.removeSubscriber(wbId, ws);
  });

  ws.on('error', () => { try { ws.close(); } catch {} });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'attach': {
        if (attached) return safeSend(ws, { type: 'error', message: 'Already attached' });
        if (!msg.wbId) return safeSend(ws, { type: 'error', message: 'wbId required' });
        const wb = await sessionStore.getWorkbench(msg.wbId);
        if (!wb) return safeSend(ws, { type: 'error', message: 'Workbench not found' });

        wbId = msg.wbId;
        attached = true;
        chatEngine.addSubscriber(wbId, ws);

        // Initial state: scrollback + brief + artifacts. (No leads, no hypotheses.)
        const [messages, brief, artifacts] = await Promise.all([
          sessionStore.readChatMessages(wbId, 500),
          sessionStore.readBrief(wbId),
          sessionStore.listArtifacts(wbId),
        ]);

        let reconRunning = false;
        try {
          const reconStreamer = require('./reconStreamer');
          reconRunning = reconStreamer.isReconRunning(wbId);
        } catch {}

        safeSend(ws, {
          type: 'attached',
          wb,
          messages,
          brief,
          artifacts,
          reconRunning,
        });
        await sessionStore.updateWorkbench(wbId, {});
        break;
      }

      case 'ping':
        safeSend(ws, { type: 'pong' });
        break;

      default:
        // Silently ignore unknown types — keeps stale clients (sending
        // old chat/lead/directive messages) from spamming errors.
        break;
    }
  });
}

module.exports = { handleConnection };
