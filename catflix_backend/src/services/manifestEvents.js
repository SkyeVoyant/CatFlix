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
    
    // Sort movies and shows alphabetically by title
    const sortedMovies = [...(snapshot.movies || [])].sort((a, b) => 
      (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase())
    );
    const sortedShows = [...(snapshot.shows || [])].sort((a, b) => 
      (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase())
    );
    
    // Interleave movies and shows alphabetically for smooth loading
    const allItems = [...sortedMovies.map(m => ({ type: 'movie', data: m })), 
                      ...sortedShows.map(s => ({ type: 'show', data: s }))];
    allItems.sort((a, b) => 
      (a.data.title || '').toLowerCase().localeCompare((b.data.title || '').toLowerCase())
    );
    
    // Send one at a time for smooth cascading effect
    for (const item of allItems) {
      if (ws.readyState !== WebSocket.OPEN) break;
      ws.send(JSON.stringify({
        type: 'event',
        event: { action: 'upsert', entityType: item.type, payload: item.data }
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
