import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { createApp, resetDb, request, setupAdmin, registerTestUser, createTestAgent, getOne, run, setOrgSetting } from './setup.js';

// Webhook tests trigger async executor activity (CC spawn attempts that fail in tests).
// Wait long enough for the async error path to complete before the test ends,
// so it doesn't leak into the next test's resetDb() and cause FK violations.
const ASYNC_SETTLE = 500;

describe('Webhooks API', () => {
  let app, cookie, agentId;

  beforeEach(async () => {
    resetDb();
    app = createApp();
    cookie = await setupAdmin(app);
    const agent = await createTestAgent(app, cookie);
    agentId = agent.id;
  });

  describe('webhook task creation', () => {
    it('creates a webhook task with auto-generated secret', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'On Push', prompt: 'Review this push', trigger_type: 'webhook' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.trigger_type, 'webhook');
      assert.ok(res.body.webhook_secret);
      assert.equal(res.body.webhook_url, `/api/webhooks/${res.body.id}`);
      assert.equal(res.body.cron_expression, null);
    });

    it('creates a cron task (default trigger_type)', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'Daily', prompt: 'do thing', cron_expression: '0 9 * * *' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.trigger_type, 'cron');
      assert.equal(res.body.cron_expression, '0 9 * * *');
    });

    it('rejects cron task without expression', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'Bad', prompt: 'do', trigger_type: 'cron' },
      });
      assert.equal(res.status, 400);
    });

    it('webhook task does not require cron_expression', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'Hook', prompt: 'do', trigger_type: 'webhook' },
      });
      assert.equal(res.status, 201);
    });
  });

  describe('POST /api/webhooks/:taskId', () => {
    let taskId, webhookSecret;

    beforeEach(async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'Push Handler', prompt: 'Analyze this push event', trigger_type: 'webhook' },
      });
      taskId = res.body.id;
      webhookSecret = res.body.webhook_secret;
    });

    it('accepts webhook with valid secret header', async () => {
      const res = await request(app, 'POST', `/api/webhooks/${taskId}`, {
        body: { ref: 'refs/heads/main', commits: [] },
        headers: { 'X-Webhook-Secret': webhookSecret },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      await new Promise(r => setTimeout(r, ASYNC_SETTLE));
    });

    it('accepts webhook with HMAC signature', async () => {
      const payload = JSON.stringify({ ref: 'refs/heads/main' });
      const signature = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
      const res = await request(app, 'POST', `/api/webhooks/${taskId}`, {
        body: { ref: 'refs/heads/main' },
        headers: { 'X-Gitea-Signature': signature },
      });
      assert.equal(res.status, 200);
      await new Promise(r => setTimeout(r, ASYNC_SETTLE));
    });

    it('accepts webhook with query param secret', async () => {
      const res = await request(app, 'POST', `/api/webhooks/${taskId}?secret=${webhookSecret}`, {
        body: { action: 'opened' },
      });
      assert.equal(res.status, 200);
      await new Promise(r => setTimeout(r, ASYNC_SETTLE));
    });

    it('rejects webhook with wrong secret', async () => {
      const res = await request(app, 'POST', `/api/webhooks/${taskId}`, {
        body: {},
        headers: { 'X-Webhook-Secret': 'wrong-secret' },
      });
      assert.equal(res.status, 401);
    });

    it('rejects webhook for nonexistent task', async () => {
      const res = await request(app, 'POST', '/api/webhooks/no-such-task', {
        body: {},
      });
      assert.equal(res.status, 404);
    });

    it('rejects webhook for disabled task', async () => {
      await request(app, 'PUT', `/api/tasks/${taskId}`, {
        cookie,
        body: { enabled: false },
      });
      const res = await request(app, 'POST', `/api/webhooks/${taskId}`, {
        body: {},
        headers: { 'X-Webhook-Secret': webhookSecret },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /disabled/);
    });

    it('rejects webhook for cron-type task', async () => {
      const cronRes = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'Cron Only', prompt: 'p', cron_expression: '0 0 * * *' },
      });
      const res = await request(app, 'POST', `/api/webhooks/${cronRes.body.id}`, {
        body: {},
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /not a webhook/);
    });

    it('stores webhook prompt as task message', async () => {
      await request(app, 'POST', `/api/webhooks/${taskId}`, {
        body: { ref: 'refs/heads/main' },
        headers: { 'X-Webhook-Secret': webhookSecret },
      });
      // Webhook stores user message synchronously before async executor
      await new Promise(r => setTimeout(r, ASYNC_SETTLE));

      const msgs = await request(app, 'GET', `/api/agents/${agentId}/messages`, { cookie });
      const taskMsg = msgs.body.find(m => m.message_type === 'task' && m.role === 'user');
      assert.ok(taskMsg, 'Expected a task user message');
      assert.ok(taskMsg.content.includes('refs/heads/main'));
      assert.ok(taskMsg.content.includes('Analyze this push event'));
    });

    it('is publicly accessible without session cookie', async () => {
      const res = await request(app, 'POST', `/api/webhooks/${taskId}?secret=${webhookSecret}`, {
        body: { test: true },
      });
      assert.equal(res.status, 200);
      await new Promise(r => setTimeout(r, ASYNC_SETTLE));
    });

    it('rejects webhook when cron_enabled is disabled for org', async () => {
      // Get the agent's org_id to set the org setting
      const agent = getOne('SELECT * FROM agents WHERE id = ?', [agentId]);
      setOrgSetting(agent.org_id, 'cron_enabled', '0');

      const res = await request(app, 'POST', `/api/webhooks/${taskId}`, {
        body: { ref: 'refs/heads/main' },
        headers: { 'X-Webhook-Secret': webhookSecret },
      });
      assert.equal(res.status, 503);
      assert.ok(res.body.error.includes('paused'));
    });

    it('accepts webhook when cron_enabled is re-enabled', async () => {
      const agent = getOne('SELECT * FROM agents WHERE id = ?', [agentId]);
      setOrgSetting(agent.org_id, 'cron_enabled', '0');
      setOrgSetting(agent.org_id, 'cron_enabled', '1');

      const res = await request(app, 'POST', `/api/webhooks/${taskId}`, {
        body: { ref: 'refs/heads/main' },
        headers: { 'X-Webhook-Secret': webhookSecret },
      });
      assert.equal(res.status, 200);
      await new Promise(r => setTimeout(r, ASYNC_SETTLE));
    });
  });

  describe('webhook task update', () => {
    it('can change trigger_type from cron to webhook', async () => {
      const cron = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'Was Cron', prompt: 'p', cron_expression: '0 9 * * *' },
      });
      const res = await request(app, 'PUT', `/api/tasks/${cron.body.id}`, {
        cookie,
        body: { trigger_type: 'webhook' },
      });
      assert.equal(res.body.trigger_type, 'webhook');
    });
  });
});
