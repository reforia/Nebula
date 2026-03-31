import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser, createTestAgent, getOne, run } from './setup.js';

describe('Agent Secrets API', () => {
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

  describe('GET /api/agents/:id/secrets', () => {
    it('returns empty list initially', async () => {
      const res = await request(app, 'GET', `/api/agents/${agentId}/secrets`, { cookie });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'GET', '/api/agents/no-such/secrets', { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /api/agents/:id/secrets', () => {
    it('creates an encrypted secret', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/secrets`, {
        cookie,
        body: { key: 'MY_TOKEN', value: 'secret123' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.key, 'MY_TOKEN');

      // Value is encrypted in DB
      const row = getOne('SELECT value FROM agent_secrets WHERE agent_id = ? AND key = ?', [agentId, 'MY_TOKEN']);
      assert.ok(row);
      assert.notEqual(row.value, 'secret123');
    });

    it('normalizes key to uppercase', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/secrets`, {
        cookie,
        body: { key: 'my-token', value: 'val' },
      });
      assert.equal(res.body.key, 'MY_TOKEN');
    });

    it('updates existing secret with same key', async () => {
      await request(app, 'POST', `/api/agents/${agentId}/secrets`, {
        cookie, body: { key: 'TOKEN', value: 'old' },
      });
      await request(app, 'POST', `/api/agents/${agentId}/secrets`, {
        cookie, body: { key: 'TOKEN', value: 'new' },
      });

      const list = await request(app, 'GET', `/api/agents/${agentId}/secrets`, { cookie });
      assert.equal(list.body.length, 1);
    });

    it('rejects empty key', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/secrets`, {
        cookie, body: { key: '', value: 'val' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects empty value', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/secrets`, {
        cookie, body: { key: 'K', value: '' },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('DELETE /api/agents/:id/secrets/:secretId', () => {
    it('deletes a secret', async () => {
      await request(app, 'POST', `/api/agents/${agentId}/secrets`, {
        cookie, body: { key: 'TEMP', value: 'val' },
      });
      const list = await request(app, 'GET', `/api/agents/${agentId}/secrets`, { cookie });
      const secretId = list.body[0].id;

      const res = await request(app, 'DELETE', `/api/agents/${agentId}/secrets/${secretId}`, { cookie });
      assert.equal(res.status, 200);

      const after = await request(app, 'GET', `/api/agents/${agentId}/secrets`, { cookie });
      assert.equal(after.body.length, 0);
    });

    it('returns 404 for nonexistent secret', async () => {
      const res = await request(app, 'DELETE', `/api/agents/${agentId}/secrets/no-such`, { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('cascade on agent delete', () => {
    it('deletes agent secrets when agent is deleted', async () => {
      await request(app, 'POST', `/api/agents/${agentId}/secrets`, {
        cookie, body: { key: 'CASCADED', value: 'val' },
      });

      await request(app, 'DELETE', `/api/agents/${agentId}`, { cookie });

      const row = getOne('SELECT * FROM agent_secrets WHERE agent_id = ?', [agentId]);
      assert.equal(row, undefined);
    });
  });

  describe('does not expose values', () => {
    it('GET response has no value field', async () => {
      await request(app, 'POST', `/api/agents/${agentId}/secrets`, {
        cookie, body: { key: 'HIDDEN', value: 'supersecret' },
      });
      const list = await request(app, 'GET', `/api/agents/${agentId}/secrets`, { cookie });
      assert.equal(list.body[0].key, 'HIDDEN');
      assert.equal(list.body[0].value, undefined);
    });
  });

  describe('org isolation', () => {
    it('cannot see secrets from another org agent', async () => {
      await request(app, 'POST', `/api/agents/${agentId}/secrets`, {
        cookie, body: { key: 'PRIVATE', value: 'val' },
      });

      const reg2 = await registerTestUser(app, { email: 'other@test.com', orgName: 'Other' });
      const res = await request(app, 'GET', `/api/agents/${agentId}/secrets`, { cookie: reg2.cookie });
      assert.equal(res.status, 404); // Agent not found in their org
    });
  });
});
