import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser, createTestAgent, getOne, getAll } from './setup.js';

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
        body: { name: 'test' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.transport, 'stdio');
    });
  });

  describe('PUT /api/mcp-servers/:id', () => {
    it('updates name and config', async () => {
      const created = await request(app, 'POST', '/api/mcp-servers', {
        cookie,
        body: { name: 'old-name' },
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
        body: { name: 'test' },
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
        body: { name: 'to-delete' },
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
        body: { name: 'org-server' },
      });
      // Create agent-specific server
      await request(app, 'POST', `/api/agents/${agentId}/mcp-servers`, {
        cookie,
        body: { name: 'agent-server' },
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
        body: { name: 'original' },
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
        body: { name: 'temp' },
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
        body: { name: 'org-owned' },
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
        body: { name: 'private-server' },
      });

      // Register second user (different org)
      const reg2 = await registerTestUser(app, { email: 'other@test.com', orgName: 'Other Org' });

      const res = await request(app, 'GET', '/api/mcp-servers', { cookie: reg2.cookie });
      assert.equal(res.body.length, 0);
    });
  });
});
