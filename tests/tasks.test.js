import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, setupAdmin, getOne } from './setup.js';

describe('Tasks API', () => {
  let app, cookie, agentId;

  beforeEach(async () => {
    resetDb();
    app = createApp();
    cookie = await setupAdmin(app);

    const create = await request(app, 'POST', '/api/agents', {
      cookie,
      body: { name: 'TaskBot' },
    });
    agentId = create.body.id;
  });

  describe('GET /api/agents/:id/tasks', () => {
    it('returns empty array initially', async () => {
      const res = await request(app, 'GET', `/api/agents/${agentId}/tasks`, { cookie });
      assert.equal(res.status, 200);
      assert.deepStrictEqual(res.body, []);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'GET', '/api/agents/no-such-id/tasks', { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /api/agents/:id/tasks', () => {
    it('creates task with required fields', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: {
          name: 'Daily Check',
          prompt: 'Check system health',
          cron_expression: '0 9 * * *',
        },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'Daily Check');
      assert.equal(res.body.prompt, 'Check system health');
      assert.equal(res.body.cron_expression, '0 9 * * *');
      assert.equal(res.body.enabled, 1);
      assert.equal(res.body.max_turns, 50);
      assert.equal(res.body.timeout_ms, 600000);
      assert.equal(res.body.agent_id, agentId);
      assert.ok(res.body.id);
    });

    it('creates task with all fields', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: {
          name: 'Custom Task',
          prompt: 'Do custom thing',
          cron_expression: '*/5 * * * *',
          enabled: false,
          max_turns: 5,
          timeout_ms: 300000,
        },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.enabled, 0);
      assert.equal(res.body.max_turns, 5);
      assert.equal(res.body.timeout_ms, 300000);
    });

    it('rejects missing name', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { prompt: 'do thing', cron_expression: '0 0 1 1 *' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Name/);
    });

    it('rejects missing prompt', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'No Prompt', cron_expression: '0 0 1 1 *' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Prompt/);
    });

    it('rejects missing cron_expression', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'No Cron', prompt: 'do thing' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Cron/);
    });

    it('rejects invalid cron expression', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'Bad Cron', prompt: 'do thing', cron_expression: 'not-a-cron' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Invalid cron/);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'POST', '/api/agents/no-such-id/tasks', {
        cookie,
        body: { name: 'Task', prompt: 'p', cron_expression: '0 0 1 1 *' },
      });
      assert.equal(res.status, 404);
    });
  });

  describe('PUT /api/tasks/:id', () => {
    let taskId;

    beforeEach(async () => {
      const create = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'Updatable', prompt: 'original', cron_expression: '0 9 * * *' },
      });
      taskId = create.body.id;
    });

    it('updates task name', async () => {
      const res = await request(app, 'PUT', `/api/tasks/${taskId}`, {
        cookie,
        body: { name: 'Renamed Task' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Renamed Task');
    });

    it('updates prompt', async () => {
      const res = await request(app, 'PUT', `/api/tasks/${taskId}`, {
        cookie,
        body: { prompt: 'new prompt' },
      });
      assert.equal(res.body.prompt, 'new prompt');
    });

    it('updates cron expression', async () => {
      const res = await request(app, 'PUT', `/api/tasks/${taskId}`, {
        cookie,
        body: { cron_expression: '*/30 * * * *' },
      });
      assert.equal(res.body.cron_expression, '*/30 * * * *');
    });

    it('updates enabled flag', async () => {
      const res = await request(app, 'PUT', `/api/tasks/${taskId}`, {
        cookie,
        body: { enabled: false },
      });
      assert.equal(res.body.enabled, 0);
    });

    it('updates max_turns and timeout_ms', async () => {
      const res = await request(app, 'PUT', `/api/tasks/${taskId}`, {
        cookie,
        body: { max_turns: 20, timeout_ms: 120000 },
      });
      assert.equal(res.body.max_turns, 20);
      assert.equal(res.body.timeout_ms, 120000);
    });

    it('rejects invalid cron expression', async () => {
      const res = await request(app, 'PUT', `/api/tasks/${taskId}`, {
        cookie,
        body: { cron_expression: 'invalid' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Invalid cron/);
    });

    it('returns 404 for nonexistent task', async () => {
      const res = await request(app, 'PUT', '/api/tasks/no-such-id', {
        cookie,
        body: { name: 'Nope' },
      });
      assert.equal(res.status, 404);
    });
  });

  describe('DELETE /api/tasks/:id', () => {
    it('deletes task', async () => {
      const create = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'DeleteMe', prompt: 'p', cron_expression: '0 0 1 1 *' },
      });

      const res = await request(app, 'DELETE', `/api/tasks/${create.body.id}`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      const row = getOne('SELECT * FROM tasks WHERE id = ?', [create.body.id]);
      assert.equal(row, undefined);
    });

    it('returns 404 for nonexistent task', async () => {
      const res = await request(app, 'DELETE', '/api/tasks/no-such-id', { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /api/tasks/:id/trigger', () => {
    it('returns ok for existing task', async () => {
      const create = await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'TriggerMe', prompt: 'go', cron_expression: '0 0 * * *' },
      });
      // Note: actual execution will fail (no CC) but the trigger endpoint returns immediately
      const res = await request(app, 'POST', `/api/tasks/${create.body.id}/trigger`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('returns 404 for nonexistent task', async () => {
      const res = await request(app, 'POST', '/api/tasks/no-such-id/trigger', { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('task-agent relationship', () => {
    it('lists only tasks for the specified agent', async () => {
      const agent2 = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'OtherBot' },
      });

      await request(app, 'POST', `/api/agents/${agentId}/tasks`, {
        cookie,
        body: { name: 'Task1', prompt: 'p1', cron_expression: '0 0 1 1 *' },
      });
      await request(app, 'POST', `/api/agents/${agent2.body.id}/tasks`, {
        cookie,
        body: { name: 'Task2', prompt: 'p2', cron_expression: '0 0 1 1 *' },
      });

      const res1 = await request(app, 'GET', `/api/agents/${agentId}/tasks`, { cookie });
      assert.equal(res1.body.length, 1);
      assert.equal(res1.body[0].name, 'Task1');

      const res2 = await request(app, 'GET', `/api/agents/${agent2.body.id}/tasks`, { cookie });
      assert.equal(res2.body.length, 1);
      assert.equal(res2.body[0].name, 'Task2');
    });
  });
});
