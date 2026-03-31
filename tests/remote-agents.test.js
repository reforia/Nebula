import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser, createTestAgent, getOne, getOrgSetting } from './setup.js';

describe('Remote Agents API', () => {
  let app, cookie, agentId, orgId;

  beforeEach(async () => {
    resetDb();
    app = createApp();
    const reg = await registerTestUser(app);
    cookie = reg.cookie;
    orgId = reg.orgId;
    const agent = await createTestAgent(app, cookie);
    agentId = agent.id;
  });

  describe('execution_mode', () => {
    it('defaults to local', async () => {
      const res = await request(app, 'GET', `/api/agents/${agentId}`, { cookie });
      assert.equal(res.body.execution_mode, 'local');
    });

    it('can be set to remote', async () => {
      const res = await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie,
        body: { execution_mode: 'remote' },
      });
      assert.equal(res.body.execution_mode, 'remote');
    });
  });

  describe('POST /api/agents/:id/generate-remote-token', () => {
    it('generates a token and sets mode to remote', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/generate-remote-token`, { cookie });
      assert.equal(res.status, 200);
      assert.ok(res.body.token);
      assert.equal(res.body.token.length, 36); // UUID

      // Verify agent is now remote
      const agent = getOne('SELECT * FROM agents WHERE id = ?', [agentId]);
      assert.equal(agent.execution_mode, 'remote');
      assert.equal(agent.remote_token, res.body.token);
    });

    it('regenerates a new token each time', async () => {
      const res1 = await request(app, 'POST', `/api/agents/${agentId}/generate-remote-token`, { cookie });
      const res2 = await request(app, 'POST', `/api/agents/${agentId}/generate-remote-token`, { cookie });
      assert.notEqual(res1.body.token, res2.body.token);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'POST', '/api/agents/no-such-id/generate-remote-token', { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('GET /api/agents/:id (remote fields)', () => {
    it('does not expose remote_token in GET response', async () => {
      await request(app, 'POST', `/api/agents/${agentId}/generate-remote-token`, { cookie });
      const res = await request(app, 'GET', `/api/agents/${agentId}`, { cookie });
      assert.equal(res.body.remote_token, undefined);
      assert.equal(res.body.has_remote_token, true);
    });

    it('shows has_remote_token false before generation', async () => {
      const res = await request(app, 'GET', `/api/agents/${agentId}`, { cookie });
      assert.equal(res.body.has_remote_token, false);
    });

    it('shows remote_connected null for local agents', async () => {
      const res = await request(app, 'GET', `/api/agents/${agentId}`, { cookie });
      assert.equal(res.body.remote_connected, null);
    });

    it('shows remote_connected false for unconnected remote agent', async () => {
      await request(app, 'POST', `/api/agents/${agentId}/generate-remote-token`, { cookie });
      const res = await request(app, 'GET', `/api/agents/${agentId}`, { cookie });
      assert.equal(res.body.remote_connected, false);
    });
  });

  describe('Bearer token auth', () => {
    it('accepts internal API token for protected routes', async () => {
      const token = getOrgSetting(orgId, 'internal_api_token');
      const res = await request(app, 'GET', '/api/agents', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });

    it('rejects invalid Bearer token', async () => {
      const res = await request(app, 'GET', '/api/agents', {
        headers: { 'Authorization': 'Bearer wrong-token' },
      });
      assert.equal(res.status, 401);
    });
  });
});
