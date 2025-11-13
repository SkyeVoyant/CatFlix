const WebSocket = require('ws');

let wss = null;
let snapshotProvider = null;

function setSnapshotProvider(fn) {
  snapshotProvider = typeof fn === 'function' ? fn : null;
}

async function streamSnapshot(ws) {
  if (!snapshotProvider || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: 'sync', phase: 'start' }));
    const snapshot = await snapshotProvider();
    for (const movie of snapshot.movies || []) {
      ws.send(JSON.stringify({
        type: 'event',
        event: { action: 'upsert', entityType: 'movie', payload: movie }
      }));
    }
    for (const show of snapshot.shows || []) {
      ws.send(JSON.stringify({
        type: 'event',
        event: { action: 'upsert', entityType: 'show', payload: show }
      }));
    }
    ws.send(JSON.stringify({ type: 'sync', phase: 'complete' }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'sync', phase: 'error', error: err.message || 'snapshot_failed' }));
  }
}

function setupManifestSocket(server) {
  wss = new WebSocket.Server({ server, path: '/ws/manifest' });
  wss.on('connection', (ws) => {
    ws.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch (_) {}
      }
    }, 30000);
    ws.on('error', (err) => {
      console.error('[ws] socket error', err.message || err);
      try { ws.terminate(); } catch (_) {}
    });
    ws.on('close', () => {
      if (ws.pingInterval) {
        clearInterval(ws.pingInterval);
      }
    });
    streamSnapshot(ws);
  });
}

function broadcastManifestEvents(events = []) {
  if (!wss || !events.length) return;
  const payload = JSON.stringify({ type: 'batch', events });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (_) {
        client.terminate();
      }
    }
  }
}

module.exports = {
  setupManifestSocket,
  setSnapshotProvider,
  broadcastManifestEvents
};
