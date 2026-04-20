import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { WebSocket } from 'ws';
import crypto from 'crypto';
import { createApp, resetDb, registerTestUser, run, getOne } from './setup.js';
import { initWebSocket, handleUpgrade, broadcastToOrg } from '../src/services/websocket.js';

function uid() { return crypto.randomUUID().slice(0, 12); }

function startServer() {
  return new Promise((resolve) => {
    const app = createApp();
    const server = http.createServer(app);
    server.on('upgrade', handleUpgrade);
    server.listen(0, '127.0.0.1', () => resolve({ app, server, port: server.address().port }));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function connectWs(port, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
    const captured = [];
    ws.on('message', (data) => {
      try { captured.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    ws.once('open', () => {
      // Attach capture buffer so tests can read snapshot messages sent pre-resolve.
      ws._captured = captured;
      resolve(ws);
    });
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`unexpected status ${res.statusCode}`)));
  });
}

function drain(ws, timeoutMs = 200) {
  return new Promise((resolve) => {
    setTimeout(() => resolve([...(ws._captured || [])]), timeoutMs);
  });
}

describe('websocket', () => {
  before(() => { initWebSocket(); });

  beforeEach(() => { resetDb(); });

  it('rejects upgrade with no cookie', async () => {
    const { server, port } = await startServer();
    try {
      await assert.rejects(
        () => new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
          ws.once('open', () => { ws.close(); resolve(); });
          ws.once('error', reject);
        }),
        /unexpected server response|socket hang up/,
      );
    } finally {
      await stopServer(server);
    }
  });

  it('rejects upgrade with invalid JWT cookie', async () => {
    const { server, port } = await startServer();
    try {
      await assert.rejects(connectWs(port, 'nebula_access=garbage.token.here'));
    } finally {
      await stopServer(server);
    }
  });

  it('accepts upgrade with valid JWT and sends snapshot messages', async () => {
    const { app, server, port } = await startServer();
    try {
      const reg = await registerTestUser(app);
      const ws = await connectWs(port, reg.cookie);
      const msgs = await drain(ws, 300);
      ws.close();
      const types = msgs.map(m => m.type);
      assert.ok(types.includes('unread_update'), `expected unread_update snapshot, got: ${types.join(',')}`);
    } finally {
      await stopServer(server);
    }
  });

  it('broadcastToOrg only reaches clients in that org', async () => {
    const { app, server, port } = await startServer();
    try {
      const regA = await registerTestUser(app, { email: `a-${uid()}@t.com`, orgName: 'Org A' });
      const regB = await registerTestUser(app, { email: `b-${uid()}@t.com`, orgName: 'Org B' });

      const wsA = await connectWs(port, regA.cookie);
      const wsB = await connectWs(port, regB.cookie);

      await new Promise(r => setTimeout(r, 100));
      const preA = wsA._captured.length;
      const preB = wsB._captured.length;

      broadcastToOrg(regA.orgId, { type: 'test_event', payload: 'for-A' });
      await new Promise(r => setTimeout(r, 150));

      const newA = wsA._captured.slice(preA);
      const newB = wsB._captured.slice(preB);
      wsA.close();
      wsB.close();

      assert.ok(newA.some(m => m.type === 'test_event' && m.payload === 'for-A'),
        'org A client should receive broadcast');
      assert.equal(newB.filter(m => m.type === 'test_event').length, 0,
        'org B client must not receive org A broadcast');
    } finally {
      await stopServer(server);
    }
  });

  it('mark_read messages are scoped to the sender org', async () => {
    const { app, server, port } = await startServer();
    try {
      const regA = await registerTestUser(app, { email: `ma-${uid()}@t.com`, orgName: 'MR A' });
      const regB = await registerTestUser(app, { email: `mb-${uid()}@t.com`, orgName: 'MR B' });

      // Agent + unread message in Org B
      const agentB = `a-${uid()}`;
      run('INSERT INTO agents (id, org_id, name, session_id) VALUES (?, ?, ?, ?)',
        [agentB, regB.orgId, `botB-${uid()}`, `s-${uid()}`]);
      const convB = `c-${uid()}`;
      run('INSERT INTO conversations (id, agent_id, session_id) VALUES (?, ?, ?)',
        [convB, agentB, `sess-${uid()}`]);
      run(
        "INSERT INTO messages (id, conversation_id, agent_id, role, content, is_read) VALUES (?, ?, ?, 'assistant', 'hi', 0)",
        [`m-${uid()}`, convB, agentB]
      );

      // Connect as Org A and send mark_read for Org B's agent — should be ignored
      const wsA = await connectWs(port, regA.cookie);
      await new Promise(r => setTimeout(r, 100));
      wsA.send(JSON.stringify({ type: 'mark_read', agent_id: agentB }));
      await new Promise(r => setTimeout(r, 150));
      wsA.close();

      const row = getOne('SELECT is_read FROM messages WHERE agent_id = ?', [agentB]);
      assert.equal(row.is_read, 0, 'cross-org mark_read must not update messages');
    } finally {
      await stopServer(server);
    }
  });

  it('malformed message does not crash or disconnect', async () => {
    const { app, server, port } = await startServer();
    try {
      const reg = await registerTestUser(app);
      const ws = await connectWs(port, reg.cookie);
      await new Promise(r => setTimeout(r, 100));
      ws.send('not json');
      await new Promise(r => setTimeout(r, 100));
      assert.equal(ws.readyState, WebSocket.OPEN, 'socket must stay open after malformed input');
      ws.close();
    } finally {
      await stopServer(server);
    }
  });
});
