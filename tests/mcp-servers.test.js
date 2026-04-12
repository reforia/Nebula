import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser, createTestAgent, getOne, getAll, run } from './setup.js';

describe('MCP Servers API', () => {
  let app, cookie, orgId, agentId;

  beforeEach(async () => {
    resetDb();
    app = createApp();
    const reg = await registerTestUser(app);
    cookie = reg.cookie;
    orgId = reg.orgId;
    const agent = await createTestAgent(app, cookie);
    agentId = agent.id;
  });

  // --- Org-wide MCP servers ---

  describe('GET /api/mcp-servers', () => {
    it('returns empty list initially', async () => {
      const res = await request(app, 'GET', '/api/mcp-servers', { cookie });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });
  });

  describe('POST /api/mcp-servers', () => {
    it('creates an org-wide stdio server', async () => {
      const res = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'filesystem', transport: 'stdio', config: JSON.stringify({ command: 'npx', args: ['-y', '@mcp/fs'], env: {} }) },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'filesystem');
      assert.equal(res.body.transport, 'stdio');
      assert.equal(res.body.agent_id, null);
      assert.equal(res.body.enabled, 1);
    });

    it('creates an http server', async () => {
      const res = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'remote-api', transport: 'http', config: JSON.stringify({ url: 'https://mcp.example.com' }) },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.transport, 'http');
    });

    it('accepts config as object', async () => {
      const res = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'test', config: { command: 'node', args: ['server.js'] } },
      });
      assert.equal(res.status, 201);
      const config = JSON.parse(res.body.config);
      assert.equal(config.command, 'node');
    });

    it('rejects empty name', async () => {
      const res = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: '' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects invalid transport', async () => {
      const res = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'test', transport: 'invalid' },
      });
      assert.equal(res.status, 400);
    });

    it('defaults transport to stdio', async () => {
      const res = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'test', config: { command: 'node', args: ['server.js'] } },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.transport, 'stdio');
    });

    it('rejects stdio server without command', async () => {
      const res = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'bad' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects http server without url', async () => {
      const res = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'bad', transport: 'http', config: JSON.stringify({}) },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('PUT /api/mcp-servers/:id', () => {
    it('updates name and config', async () => {
      const created = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'old-name', config: { command: 'original' } },
      });
      const res = await request(app, 'PUT', `/api/mcp-servers/${created.body.id}`, {
        cookie,
        body: { name: 'new-name', config: JSON.stringify({ command: 'updated' }) },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'new-name');
      const config = JSON.parse(res.body.config);
      assert.equal(config.command, 'updated');
    });

    it('toggles enabled', async () => {
      const created = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'test', config: { command: 'node' } },
      });
      const res = await request(app, 'PUT', `/api/mcp-servers/${created.body.id}`, {
        cookie,
        body: { enabled: false },
      });
      assert.equal(res.body.enabled, 0);
    });

    it('returns 404 for nonexistent', async () => {
      const res = await request(app, 'PUT', '/api/mcp-servers/no-such-id', {
        cookie,
        body: { name: 'x' },
      });
      assert.equal(res.status, 404);
    });
  });

  describe('DELETE /api/mcp-servers/:id', () => {
    it('deletes an org-wide server', async () => {
      const created = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'to-delete', config: { command: 'node' } },
      });
      const res = await request(app, 'DELETE', `/api/mcp-servers/${created.body.id}`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      const list = await request(app, 'GET', '/api/mcp-servers', { cookie });
      assert.equal(list.body.length, 0);
    });
  });

  // --- Agent-specific MCP servers ---

  describe('GET /api/agents/:id/mcp-servers', () => {
    it('returns agent + inherited org servers', async () => {
      // Create org-wide server
      await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'org-server', config: { command: 'node' } },
      });
      // Create agent-specific server
      await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'agent-server', config: { command: 'npx' } },
      });

      const res = await request(app, 'GET', `/api/agents/${agentId}/mcp-servers`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 2);

      const orgServer = res.body.find(s => s.name === 'org-server');
      const agentServer = res.body.find(s => s.name === 'agent-server');
      assert.equal(orgServer.scope, 'org');
      assert.equal(agentServer.scope, 'agent');
    });
  });

  describe('POST /api/agents/:id/mcp-servers', () => {
    it('creates agent-specific server', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'agent-only', transport: 'sse', config: JSON.stringify({ url: 'http://localhost:3001/sse' }) },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.agent_id, agentId);
      assert.equal(res.body.transport, 'sse');
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'POST', '/api/agents/no-agent/mcp-servers', {
        cookie,
        body: { name: 'test' },
      });
      assert.equal(res.status, 404);
    });
  });

  describe('PUT /api/agents/:id/mcp-servers/:serverId', () => {
    it('updates agent-specific server', async () => {
      const created = await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'original', config: { command: 'node' } },
      });
      const res = await request(app, 'PUT', `/api/agents/${agentId}/mcp-servers/${created.body.id}`, {
        cookie,
        body: { name: 'renamed' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'renamed');
    });
  });

  describe('DELETE /api/agents/:id/mcp-servers/:serverId', () => {
    it('deletes agent-specific server', async () => {
      const created = await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'temp', config: { command: 'node' } },
      });
      const res = await request(app, 'DELETE', `/api/agents/${agentId}/mcp-servers/${created.body.id}`, { cookie });
      assert.equal(res.status, 200);

      // Verify only org servers remain (if any)
      const list = await request(app, 'GET', `/api/agents/${agentId}/mcp-servers`, { cookie });
      assert.equal(list.body.filter(s => s.agent_id !== null).length, 0);
    });

    it('cannot delete org server via agent route', async () => {
      const orgServer = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'org-owned', config: { command: 'node' } },
      });
      const res = await request(app, 'DELETE', `/api/agents/${agentId}/mcp-servers/${orgServer.body.id}`, { cookie });
      assert.equal(res.status, 404);
    });
  });

  // --- Org isolation ---

  describe('org isolation', () => {
    it('cannot see MCP servers from another org', async () => {
      // Create server in first org
      await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'private-server', config: { command: 'node' } },
      });

      // Register second user (different org)
      const reg2 = await registerTestUser(app, { email: 'other@test.com', orgName: 'Other Org' });

      const res = await request(app, 'GET', '/api/mcp-servers', { cookie: reg2.cookie });
      assert.equal(res.body.length, 0);
    });
  });

  // --- Auto-reset sessions on MCP change ---

  describe('mcp_auto_reset', () => {
    /** Helper: initialize a conversation's session so we can detect resets */
    function initSession(agentId) {
      const conv = getOne('SELECT id FROM conversations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1', [agentId]);
      run("UPDATE conversations SET session_initialized = 1 WHERE id = ?", [conv.id]);
      return conv.id;
    }

    function isSessionInitialized(convId) {
      return getOne('SELECT session_initialized FROM conversations WHERE id = ?', [convId]).session_initialized === 1;
    }

    it('agent mcp_auto_reset defaults to 0', async () => {
      const agent = getOne('SELECT mcp_auto_reset FROM agents WHERE id = ?', [agentId]);
      assert.equal(agent.mcp_auto_reset, 0);
    });

    it('can update mcp_auto_reset via PUT /api/agents/:id', async () => {
      await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie, body: { mcp_auto_reset: true },
      });
      const agent = getOne('SELECT mcp_auto_reset FROM agents WHERE id = ?', [agentId]);
      assert.equal(agent.mcp_auto_reset, 1);
    });

    it('does NOT reset session when auto-reset is off (default)', async () => {
      const convId = initSession(agentId);

      await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'test', transport: 'http', config: JSON.stringify({ url: 'http://localhost/mcp' }) },
      });

      assert.equal(isSessionInitialized(convId), true, 'session should remain initialized');
    });

    it('resets session when auto-reset is on and agent MCP changes', async () => {
      await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie, body: { mcp_auto_reset: true },
      });
      const convId = initSession(agentId);

      await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'test', transport: 'http', config: JSON.stringify({ url: 'http://localhost/mcp' }) },
      });

      assert.equal(isSessionInitialized(convId), false, 'session should be reset');
    });

    it('resets opted-in agent when org-wide MCP changes', async () => {
      await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie, body: { mcp_auto_reset: true },
      });
      const convId = initSession(agentId);

      await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'org-server', transport: 'http', config: JSON.stringify({ url: 'http://example.com/mcp' }) },
      });

      assert.equal(isSessionInitialized(convId), false, 'opted-in agent session should be reset');
    });

    it('does NOT reset non-opted-in agent when org-wide MCP changes', async () => {
      // agentId has auto-reset OFF (default)
      const convId = initSession(agentId);

      await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'org-server', transport: 'http', config: JSON.stringify({ url: 'http://example.com/mcp' }) },
      });

      assert.equal(isSessionInitialized(convId), true, 'non-opted-in agent session should stay');
    });

    it('rejects structurally invalid config on create', async () => {
      await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie, body: { mcp_auto_reset: true },
      });
      const convId = initSession(agentId);

      // Create with empty config (no command for stdio) — should be rejected
      const res = await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'empty', transport: 'stdio' },
      });
      assert.equal(res.status, 400);
      assert.equal(isSessionInitialized(convId), true, 'rejected create should not trigger reset');
    });

    it('does NOT reset when server is created disabled', async () => {
      await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie, body: { mcp_auto_reset: true },
      });
      const convId = initSession(agentId);

      await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'disabled', transport: 'http', config: JSON.stringify({ url: 'http://localhost/mcp' }), enabled: false },
      });

      assert.equal(isSessionInitialized(convId), true, 'disabled server should not trigger reset');
    });

    it('resets on update when server is enabled and valid', async () => {
      await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie, body: { mcp_auto_reset: true },
      });

      // Create server while session is not yet initialized (no reset expected)
      const created = await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'test', transport: 'http', config: JSON.stringify({ url: 'http://localhost/mcp' }) },
      });

      // Now initialize the session
      const convId = initSession(agentId);

      // Update the server
      await request(app, 'PUT', `/api/agents/${agentId}/mcp-servers/${created.body.id}`, {
        cookie,
        body: { config: JSON.stringify({ url: 'http://localhost:9999/mcp' }) },
      });

      assert.equal(isSessionInitialized(convId), false, 'session should be reset after update');
    });

    it('resets on delete when server was enabled', async () => {
      await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie, body: { mcp_auto_reset: true },
      });
      const created = await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'test', transport: 'http', config: JSON.stringify({ url: 'http://localhost/mcp' }) },
      });
      const convId = initSession(agentId);

      await request(app, 'DELETE', `/api/agents/${agentId}/mcp-servers/${created.body.id}`, { cookie });

      assert.equal(isSessionInitialized(convId), false, 'session should be reset after delete');
    });

    it('resets all conversations for an agent, not just the latest', async () => {
      await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie, body: { mcp_auto_reset: true },
      });

      // Create a second conversation
      await request(app, 'POST', `/api/agents/${agentId}/conversations`, {
        cookie, body: { title: 'Second' },
      });

      // Initialize both
      const convs = getAll('SELECT id FROM conversations WHERE agent_id = ?', [agentId]);
      for (const c of convs) {
        run("UPDATE conversations SET session_initialized = 1 WHERE id = ?", [c.id]);
      }

      await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'test', transport: 'http', config: JSON.stringify({ url: 'http://localhost/mcp' }) },
      });

      for (const c of convs) {
        assert.equal(isSessionInitialized(c.id), false, `conversation ${c.id} should be reset`);
      }
    });
  });
});
