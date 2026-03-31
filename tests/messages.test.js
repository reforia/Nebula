import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, setupAdmin, run, getOne, getAll } from './setup.js';

// Message send triggers async executor (CC spawn that fails in tests).
// Wait for it to settle before test ends so it doesn't leak into next test.
const ASYNC_SETTLE = 500;

describe('Messages API', () => {
  let app, cookie, agentId;

  beforeEach(async () => {
    resetDb();
    app = createApp();
    cookie = await setupAdmin(app);

    const create = await request(app, 'POST', '/api/agents', {
      cookie,
      body: { name: 'MsgBot' },
    });
    agentId = create.body.id;
  });

  describe('GET /api/agents/:id/messages', () => {
    it('returns welcome message for new agent', async () => {
      const res = await request(app, 'GET', `/api/agents/${agentId}/messages`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 1);
      assert.equal(res.body[0].message_type, 'system');
    });

    it('returns messages in chronological order', async () => {
      // Clear welcome message and insert deterministic test data
      run('DELETE FROM messages WHERE agent_id = ?', [agentId]);
      for (let i = 1; i <= 3; i++) {
        run(
          `INSERT INTO messages (id, agent_id, role, content, created_at)
           VALUES (?, ?, 'user', ?, datetime('now', '+${i} seconds'))`,
          [`msg-${i}`, agentId, `message ${i}`]
        );
      }

      const res = await request(app, 'GET', `/api/agents/${agentId}/messages`, { cookie });
      assert.equal(res.body.length, 3);
      assert.equal(res.body[0].content, 'message 1');
      assert.equal(res.body[2].content, 'message 3');
    });

    it('respects limit parameter', async () => {
      for (let i = 1; i <= 10; i++) {
        run(
          `INSERT INTO messages (id, agent_id, role, content, created_at)
           VALUES (?, ?, 'user', ?, datetime('now', '+${i} seconds'))`,
          [`lim-${i}`, agentId, `msg ${i}`]
        );
      }

      const res = await request(app, 'GET', `/api/agents/${agentId}/messages?limit=3`, { cookie });
      assert.equal(res.body.length, 3);
      // Should return the 3 most recent (8, 9, 10) in chrono order
      assert.equal(res.body[0].content, 'msg 8');
      assert.equal(res.body[2].content, 'msg 10');
    });

    it('caps limit at 200', async () => {
      // We're not inserting 200+ messages, just verify the route doesn't crash
      const res = await request(app, 'GET', `/api/agents/${agentId}/messages?limit=9999`, { cookie });
      assert.equal(res.status, 200);
    });

    it('supports before cursor for pagination', async () => {
      // Clear any existing messages (e.g. welcome message from agent creation)
      run('DELETE FROM messages WHERE agent_id = ?', [agentId]);
      for (let i = 1; i <= 5; i++) {
        run(
          `INSERT INTO messages (id, agent_id, role, content, created_at)
           VALUES (?, ?, 'user', ?, datetime('now', '+${i} seconds'))`,
          [`pag-${i}`, agentId, `page ${i}`]
        );
      }

      // Get messages before the 4th one (should return 1,2,3)
      const res = await request(app, 'GET', `/api/agents/${agentId}/messages?before=pag-4&limit=10`, { cookie });
      assert.equal(res.body.length, 3);
      assert.equal(res.body[0].content, 'page 1');
      assert.equal(res.body[2].content, 'page 3');
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'GET', '/api/agents/no-such-id/messages', { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /api/agents/:id/messages', () => {
    it('stores user message and returns 201', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/messages`, {
        cookie,
        body: { content: 'Hello agent!' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.role, 'user');
      assert.equal(res.body.content, 'Hello agent!');
      assert.equal(res.body.message_type, 'chat');
      assert.equal(res.body.is_read, 1); // User messages are auto-read
      assert.ok(res.body.id);
      assert.ok(res.body.created_at);
      await new Promise(r => setTimeout(r, ASYNC_SETTLE));
    });

    it('trims content whitespace', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/messages`, {
        cookie,
        body: { content: '  hello  ' },
      });
      assert.equal(res.body.content, 'hello');
      await new Promise(r => setTimeout(r, ASYNC_SETTLE));
    });

    it('persists message in database', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/messages`, {
        cookie,
        body: { content: 'persist me' },
      });
      const msg = getOne('SELECT * FROM messages WHERE id = ?', [res.body.id]);
      assert.ok(msg);
      assert.equal(msg.content, 'persist me');
      assert.equal(msg.agent_id, agentId);
    });

    it('rejects empty content', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/messages`, {
        cookie,
        body: { content: '' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects missing content', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/messages`, {
        cookie,
        body: {},
      });
      assert.equal(res.status, 400);
    });

    it('rejects whitespace-only content', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/messages`, {
        cookie,
        body: { content: '   ' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects message to disabled agent', async () => {
      // Disable the agent
      await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie,
        body: { enabled: false },
      });
      const res = await request(app, 'POST', `/api/agents/${agentId}/messages`, {
        cookie,
        body: { content: 'hello' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /disabled/);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'POST', '/api/agents/no-such-id/messages', {
        cookie,
        body: { content: 'hello' },
      });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /api/agents/:id/cancel', () => {
    it('returns ok when no active execution', async () => {
      const res = await request(app, 'POST', `/api/agents/${agentId}/cancel`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.cancelled, false);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'POST', '/api/agents/no-such-id/cancel', { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('PUT /api/agents/:id/read', () => {
    it('marks all unread messages as read', async () => {
      // Insert some unread assistant messages
      run(
        "INSERT INTO messages (id, agent_id, role, content, is_read) VALUES (?, ?, 'assistant', 'hi', 0)",
        ['ur1', agentId]
      );
      run(
        "INSERT INTO messages (id, agent_id, role, content, is_read) VALUES (?, ?, 'assistant', 'there', 0)",
        ['ur2', agentId]
      );

      const unreadBefore = getAll(
        'SELECT * FROM messages WHERE agent_id = ? AND is_read = 0',
        [agentId]
      );
      assert.equal(unreadBefore.length, 2);

      const res = await request(app, 'PUT', `/api/agents/${agentId}/read`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      const unreadAfter = getAll(
        'SELECT * FROM messages WHERE agent_id = ? AND is_read = 0',
        [agentId]
      );
      assert.equal(unreadAfter.length, 0);
    });

    it('is idempotent when no unread messages', async () => {
      const res = await request(app, 'PUT', `/api/agents/${agentId}/read`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });
  });
});
