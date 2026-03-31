import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createApp, resetDb, request, registerTestUser, createTestAgent, run, getOrgSetting, setOrgSetting, getSetting, DATA_DIR } from './setup.js';
import { generateId } from '../src/utils/uuid.js';

describe('System API', () => {
  let app, cookie, orgId;

  beforeEach(async () => {
    resetDb();
    app = createApp();
    const reg = await registerTestUser(app);
    cookie = reg.cookie;
    orgId = reg.orgId;
  });

  describe('GET /api/settings', () => {
    it('returns default settings', async () => {
      const res = await request(app, 'GET', '/api/settings', { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.smtp_port, '587');
      assert.equal(res.body.notifications_enabled, '0');
    });

    it('masks smtp_pass', async () => {
      setOrgSetting(orgId, 'smtp_pass', 'supersecret');
      const res = await request(app, 'GET', '/api/settings', { cookie });
      assert.equal(res.body.smtp_pass, '********');
    });
  });

  describe('PUT /api/settings', () => {
    it('updates allowed settings', async () => {
      const res = await request(app, 'PUT', '/api/settings', {
        cookie,
        body: {
          smtp_host: 'smtp.test.com',
          notifications_enabled: '1',
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      // smtp_host and notifications_enabled are org-level
      assert.equal(getOrgSetting(orgId, 'smtp_host'), 'smtp.test.com');
      assert.equal(getOrgSetting(orgId, 'notifications_enabled'), '1');
    });

    it('ignores disallowed keys', async () => {
      await request(app, 'PUT', '/api/settings', {
        cookie,
        body: { some_random_key: 'val' },
      });
      assert.equal(getSetting('some_random_key'), null);
      assert.equal(getOrgSetting(orgId, 'some_random_key'), null);
    });

    it('does not update smtp_pass when masked value sent', async () => {
      setOrgSetting(orgId, 'smtp_pass', 'real_password');
      await request(app, 'PUT', '/api/settings', {
        cookie,
        body: { smtp_pass: '********' },
      });
      assert.equal(getOrgSetting(orgId, 'smtp_pass'), 'real_password');
    });

    it('updates smtp_pass when real value sent', async () => {
      await request(app, 'PUT', '/api/settings', {
        cookie,
        body: { smtp_pass: 'new_secret' },
      });
      assert.equal(getOrgSetting(orgId, 'smtp_pass'), 'new_secret');
    });
  });

  describe('GET /api/status', () => {
    it('returns system status', async () => {
      const res = await request(app, 'GET', '/api/status', { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(typeof res.body.agents, 'number');
      assert.equal(typeof res.body.active_tasks, 'number');
      assert.equal(typeof res.body.total_messages, 'number');
      assert.equal(typeof res.body.uptime, 'number');
    });

    it('reflects correct agent count', async () => {
      await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'StatusBot1' },
      });
      await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'StatusBot2' },
      });
      const res = await request(app, 'GET', '/api/status', { cookie });
      assert.equal(res.body.agents, 2);
    });

    it('returns usage stats', async () => {
      const res = await request(app, 'GET', '/api/status', { cookie });
      assert.ok(res.body.usage);
      assert.ok(res.body.usage.total);
      assert.ok(res.body.usage.last_30d);
      assert.equal(typeof res.body.usage.total.executions, 'number');
      assert.equal(typeof res.body.usage.total.tokens_in, 'number');
      assert.equal(typeof res.body.usage.total.cost, 'number');
      assert.equal(typeof res.body.usage.total.errors, 'number');
      assert.ok(Array.isArray(res.body.usage.top_models));
      assert.ok(Array.isArray(res.body.usage.top_agents));
    });

    it('usage stats reflect actual usage events', async () => {
      const agent = await createTestAgent(app, cookie);
      // Insert usage events directly
      run(
        `INSERT INTO usage_events (id, org_id, agent_id, backend, model, tokens_in, tokens_out, total_cost, duration_ms, status)
         VALUES (?, ?, ?, 'claude-cli', 'claude-sonnet-4-6', 1000, 500, 0.05, 3000, 'success')`,
        [generateId(), orgId, agent.id]
      );
      run(
        `INSERT INTO usage_events (id, org_id, agent_id, backend, model, tokens_in, tokens_out, total_cost, duration_ms, status)
         VALUES (?, ?, ?, 'claude-cli', 'claude-sonnet-4-6', 2000, 800, 0.08, 5000, 'success')`,
        [generateId(), orgId, agent.id]
      );
      run(
        `INSERT INTO usage_events (id, org_id, agent_id, backend, model, tokens_in, tokens_out, total_cost, duration_ms, status)
         VALUES (?, ?, ?, 'claude-cli', 'claude-opus-4-6', 500, 200, 0.10, 2000, 'error')`,
        [generateId(), orgId, agent.id]
      );

      const res = await request(app, 'GET', '/api/status', { cookie });
      assert.equal(res.body.usage.total.executions, 3);
      assert.equal(res.body.usage.total.tokens_in, 3500);
      assert.equal(res.body.usage.total.tokens_out, 1500);
      assert.equal(res.body.usage.total.errors, 1);
      assert.ok(res.body.usage.top_models.length >= 1);
      assert.ok(res.body.usage.top_agents.length >= 1);
      // Top model should be claude-sonnet-4-6 (2 executions vs 1)
      assert.equal(res.body.usage.top_models[0].model, 'claude-sonnet-4-6');
      assert.equal(res.body.usage.top_models[0].executions, 2);
    });
  });

  describe('GET /api/global-knowledge', () => {
    it('returns global CLAUDE.md content', async () => {
      const res = await request(app, 'GET', '/api/global-knowledge', { cookie });
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.content, 'string');
      assert.ok(res.body.content.includes('Global Knowledge'));
    });
  });

  describe('PUT /api/global-knowledge', () => {
    it('writes content to org-scoped global CLAUDE.md', async () => {
      const res = await request(app, 'PUT', '/api/global-knowledge', {
        cookie,
        body: { content: '# Updated\nNew shared knowledge.' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      const filePath = path.join(DATA_DIR, 'orgs', orgId, 'global', 'CLAUDE.md');
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.includes('Updated'));
      assert.ok(content.includes('New shared knowledge'));
    });

    it('rejects missing content', async () => {
      const res = await request(app, 'PUT', '/api/global-knowledge', {
        cookie,
        body: {},
      });
      assert.equal(res.status, 400);
    });

    it('allows empty string content', async () => {
      const res = await request(app, 'PUT', '/api/global-knowledge', {
        cookie,
        body: { content: '' },
      });
      assert.equal(res.status, 200);

      const filePath = path.join(DATA_DIR, 'orgs', orgId, 'global', 'CLAUDE.md');
      assert.equal(fs.readFileSync(filePath, 'utf-8'), '');
    });

    it('persists across reads', async () => {
      await request(app, 'PUT', '/api/global-knowledge', {
        cookie,
        body: { content: '# Persistent content' },
      });
      const res = await request(app, 'GET', '/api/global-knowledge', { cookie });
      assert.ok(res.body.content.includes('Persistent content'));
    });
  });
});
