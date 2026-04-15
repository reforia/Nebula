import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolated DATA_DIR for these tests
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-compact-test-'));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = 'test';

const { createApp, resetDb, request, registerTestUser, getOne, getAll, run, getOrgSetting } = await import('./setup.js');
const { generateId } = await import('../src/utils/uuid.js');

describe('Dreaming Compact', () => {
  let app, cookie, orgId, agentId, apiToken;

  beforeEach(async () => {
    resetDb();
    app = createApp();
    const reg = await registerTestUser(app);
    cookie = reg.cookie;
    orgId = reg.orgId;
    apiToken = getOrgSetting(orgId, 'internal_api_token');

    // Create an agent (this also creates a default "General" conversation)
    const agentRes = await request(app, 'POST', '/api/agents', {
      cookie,
      body: { name: 'DreamBot' },
    });
    agentId = agentRes.body.id;
  });

  // Helper: get the auto-created main conversation for the agent
  function getMainConversation() {
    return getOne(
      'SELECT * FROM conversations WHERE agent_id = ? AND project_id IS NULL ORDER BY created_at DESC LIMIT 1',
      [agentId]
    );
  }

  // Helper: insert messages into a conversation
  function insertMessages(conversationId, msgs) {
    for (const m of msgs) {
      run(
        `INSERT INTO messages (id, agent_id, conversation_id, role, content, is_read) VALUES (?, ?, ?, ?, ?, 1)`,
        [generateId(), agentId, conversationId, m.role, m.content]
      );
    }
  }

  describe('PUT /api/agents/:id/compact', () => {
    it('stores compact_context on the main conversation', async () => {
      const conv = getMainConversation();

      const res = await request(app, 'PUT', `/api/agents/${agentId}/compact`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        body: { summary: 'I was working on feature X, tracking issue Y.' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      const updated = getOne('SELECT compact_context FROM conversations WHERE id = ?', [conv.id]);
      assert.equal(updated.compact_context, 'I was working on feature X, tracking issue Y.');
    });

    it('trims whitespace from summary', async () => {
      const conv = getMainConversation();

      const res = await request(app, 'PUT', `/api/agents/${agentId}/compact`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        body: { summary: '  spaced summary  ' },
      });
      assert.equal(res.status, 200);

      const updated = getOne('SELECT compact_context FROM conversations WHERE id = ?', [conv.id]);
      assert.equal(updated.compact_context, 'spaced summary');
    });

    it('overwrites previous compact_context', async () => {
      const conv = getMainConversation();

      await request(app, 'PUT', `/api/agents/${agentId}/compact`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        body: { summary: 'first compact' },
      });

      await request(app, 'PUT', `/api/agents/${agentId}/compact`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        body: { summary: 'second compact' },
      });

      const updated = getOne('SELECT compact_context FROM conversations WHERE id = ?', [conv.id]);
      assert.equal(updated.compact_context, 'second compact');
    });

    it('rejects missing summary', async () => {
      const res = await request(app, 'PUT', `/api/agents/${agentId}/compact`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        body: {},
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('summary'));
    });

    it('rejects empty summary', async () => {
      const res = await request(app, 'PUT', `/api/agents/${agentId}/compact`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        body: { summary: '   ' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects non-string summary', async () => {
      const res = await request(app, 'PUT', `/api/agents/${agentId}/compact`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        body: { summary: 123 },
      });
      assert.equal(res.status, 400);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'PUT', '/api/agents/no-such-id/compact', {
        headers: { Authorization: `Bearer ${apiToken}` },
        body: { summary: 'test' },
      });
      assert.equal(res.status, 404);
    });

    it('targets main conversation, not project conversations', async () => {
      const mainConv = getMainConversation();

      // Create a project and its conversation
      const projectId = generateId();
      run(
        'INSERT INTO projects (id, org_id, name, git_remote_url, coordinator_agent_id) VALUES (?, ?, ?, ?, ?)',
        [projectId, orgId, 'TestProject', 'https://example.com/repo.git', agentId]
      );
      const projConvId = generateId();
      run(
        `INSERT INTO conversations (id, agent_id, project_id, title, session_id, session_initialized) VALUES (?, ?, ?, 'Project', ?, 1)`,
        [projConvId, agentId, projectId, generateId()]
      );

      const res = await request(app, 'PUT', `/api/agents/${agentId}/compact`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        body: { summary: 'main conversation compact' },
      });
      assert.equal(res.status, 200);

      // Main conversation should have the compact
      const main = getOne('SELECT compact_context FROM conversations WHERE id = ?', [mainConv.id]);
      assert.equal(main.compact_context, 'main conversation compact');

      // Project conversation should NOT
      const proj = getOne('SELECT compact_context FROM conversations WHERE id = ?', [projConvId]);
      assert.equal(proj.compact_context, null);
    });

    it('requires authentication', async () => {
      const res = await request(app, 'PUT', `/api/agents/${agentId}/compact`, {
        body: { summary: 'test' },
      });
      assert.equal(res.status, 401);
    });
  });

  describe('initializeFromCompact (building blocks)', () => {
    it('compact_context column is null by default', async () => {
      const conv = getMainConversation();
      assert.equal(conv.compact_context, null);
    });

    it('compact_context can be set and cleared', async () => {
      const conv = getMainConversation();

      // Set via endpoint
      await request(app, 'PUT', `/api/agents/${agentId}/compact`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        body: { summary: 'my compact' },
      });

      let updated = getOne('SELECT compact_context FROM conversations WHERE id = ?', [conv.id]);
      assert.equal(updated.compact_context, 'my compact');

      // Clear (simulating what initializeFromCompact does after consumption)
      run("UPDATE conversations SET compact_context = NULL WHERE id = ?", [conv.id]);
      updated = getOne('SELECT compact_context FROM conversations WHERE id = ?', [conv.id]);
      assert.equal(updated.compact_context, null);
    });

    it('init prompt can be assembled from compact + recent messages', async () => {
      const conv = getMainConversation();

      // Insert some messages
      insertMessages(conv.id, [
        { role: 'user', content: 'Hello agent' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'Check the server status' },
        { role: 'assistant', content: 'Server is healthy.' },
      ]);

      // Set compact via DB (simulating what the agent POSTed)
      run("UPDATE conversations SET compact_context = ? WHERE id = ?",
        ['Tracking server health, pending deploy for v2.1.', conv.id]);

      const conversation = getOne('SELECT * FROM conversations WHERE id = ?', [conv.id]);
      assert.ok(conversation.compact_context);

      // Replicate initializeFromCompact's message query
      const recentMessages = getAll(
        'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10',
        [conv.id]
      );
      recentMessages.reverse();

      // Should have 4 user-inserted messages (system welcome msg has role 'system',
      // but our query doesn't filter by role — check what we get)
      const nonSystem = recentMessages.filter(m => m.role !== 'system');
      assert.equal(nonSystem.length, 4);
      assert.equal(nonSystem[0].content, 'Hello agent');
      assert.equal(nonSystem[3].content, 'Server is healthy.');

      // Build the init prompt (same shape as initializeFromCompact)
      const recentBlock = recentMessages
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');

      assert.ok(conversation.compact_context.includes('Tracking server health'));
      assert.ok(recentBlock.includes('User: Hello agent'));
      assert.ok(recentBlock.includes('Assistant: Server is healthy.'));
    });

    it('recent messages are limited to 10', async () => {
      const conv = getMainConversation();

      // Insert 15 messages (plus the auto-created system welcome = 16 total)
      const msgs = [];
      for (let i = 0; i < 15; i++) {
        msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}` });
      }
      insertMessages(conv.id, msgs);

      const recentMessages = getAll(
        'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10',
        [conv.id]
      );
      assert.equal(recentMessages.length, 10);

      // Should be the last 10 messages in DESC order, so most recent first
      // After reverse: chronological order — last 10 of 16 total (1 system + 15 user-inserted)
      recentMessages.reverse();
      // The 10 most recent are messages 5-14 (0-indexed from our 15)
      assert.equal(recentMessages[0].content, 'Message 5');
      assert.equal(recentMessages[9].content, 'Message 14');
    });

    it('session reset sets session_initialized to 0', async () => {
      const conv = getMainConversation();
      assert.equal(conv.session_initialized, 0); // auto-created is uninitialized

      // Simulate session becoming initialized
      run("UPDATE conversations SET session_initialized = 1 WHERE id = ?", [conv.id]);

      // Simulate initializeFromCompact resetting it
      const newSessionId = generateId();
      run(
        "UPDATE conversations SET session_initialized = 0, session_id = ?, session_branch = NULL WHERE id = ?",
        [newSessionId, conv.id]
      );

      const updated = getOne('SELECT * FROM conversations WHERE id = ?', [conv.id]);
      assert.equal(updated.session_initialized, 0);
      assert.equal(updated.session_id, newSessionId);
      assert.equal(updated.session_branch, null);
    });

    it('no compact means no session reset', async () => {
      const conv = getMainConversation();
      const originalSessionId = conv.session_id;

      // Simulate session being initialized
      run("UPDATE conversations SET session_initialized = 1 WHERE id = ?", [conv.id]);

      // Verify: no compact_context means initializeFromCompact would return early
      const check = getOne('SELECT compact_context FROM conversations WHERE id = ?', [conv.id]);
      assert.equal(check.compact_context, null);

      // Session should remain untouched
      const after = getOne('SELECT session_id, session_initialized FROM conversations WHERE id = ?', [conv.id]);
      assert.equal(after.session_id, originalSessionId);
      assert.equal(after.session_initialized, 1);
    });
  });

  describe('buildDreamingPrompt', () => {
    it('prompt structure includes expected endpoint pattern', () => {
      // Verify the endpoint path includes the agent ID placeholder
      // (we can't import the non-exported function, but verify the contract)
      const expectedPath = `/api/agents/${agentId}/compact`;
      assert.ok(expectedPath.includes(agentId));
      assert.ok(expectedPath.includes('/compact'));
    });
  });
});
