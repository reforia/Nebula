import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createApp, resetDb, request, registerTestUser, getOne, DATA_DIR } from './setup.js';

describe('Agents API', () => {
  let app, cookie, orgId;

  beforeEach(async () => {
    resetDb();
    app = createApp();
    const reg = await registerTestUser(app);
    cookie = reg.cookie;
    orgId = reg.orgId;
  });

  describe('GET /api/agents', () => {
    it('returns empty array initially', async () => {
      const res = await request(app, 'GET', '/api/agents', { cookie });
      assert.equal(res.status, 200);
      assert.deepStrictEqual(res.body, []);
    });

    it('returns agents with unread counts', async () => {
      // Create agent directly
      await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'TestBot', role: 'tester' },
      });
      const res = await request(app, 'GET', '/api/agents', { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 1);
      assert.equal(res.body[0].name, 'TestBot');
      assert.equal(res.body[0].unread_count, 0);
    });
  });

  describe('POST /api/agents', () => {
    it('creates agent with minimal fields', async () => {
      const res = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'MinimalBot' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'MinimalBot');
      assert.equal(res.body.role, '');
      assert.equal(res.body.model, 'claude-sonnet-4-6');
      assert.equal(res.body.allowed_tools, 'Read,Grep,Glob,WebFetch,Bash');
      assert.equal(res.body.enabled, 1);
      assert.equal(res.body.org_id, orgId);
      assert.ok(res.body.id);
      assert.ok(res.body.session_id);
    });

    it('creates agent with all fields', async () => {
      const res = await request(app, 'POST', '/api/agents', {
        cookie,
        body: {
          name: 'FullBot',
          role: 'DevOps specialist',
          emoji: '🔧',
          model: 'claude-opus-4-6',
          allowed_tools: 'Read,Grep,Bash',
          security_tier: 'elevated',
          notify_email: false,
        },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'FullBot');
      assert.equal(res.body.role, 'DevOps specialist');
      assert.equal(res.body.emoji, '🔧');
      assert.equal(res.body.model, 'claude-opus-4-6');
      assert.equal(res.body.allowed_tools, 'Read,Grep,Bash');
      assert.equal(res.body.security_tier, 'elevated');
      assert.equal(res.body.notify_email, 0);
    });

    it('creates workspace directories on disk (no CLAUDE.md — agent creates during init)', async () => {
      const res = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'DiskBot', role: 'file tester' },
      });
      const agentDir = path.join(DATA_DIR, 'orgs', orgId, 'agents', res.body.id);
      assert.ok(fs.existsSync(path.join(agentDir, 'workspace')));
      // Memory is now DB-managed, no memory/ directory created
      assert.ok(!fs.existsSync(path.join(agentDir, 'memory')));
      // CLAUDE.md is NOT created at agent creation — agent creates it during initialization
      assert.ok(!fs.existsSync(path.join(agentDir, 'CLAUDE.md')));
    });

    it('rejects empty name', async () => {
      const res = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: '' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Name is required/);
    });

    it('rejects missing name', async () => {
      const res = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { role: 'no name' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects duplicate name', async () => {
      await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'DupeBot' },
      });
      const res = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'DupeBot' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /already exists/);
    });

    it('trims whitespace from name', async () => {
      const res = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: '  SpaceyBot  ' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'SpaceyBot');
    });

    it('generates unique UUIDs for id and session_id', async () => {
      const res1 = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'Bot1' },
      });
      const res2 = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'Bot2' },
      });
      assert.notEqual(res1.body.id, res2.body.id);
      assert.notEqual(res1.body.session_id, res2.body.session_id);
    });
  });

  describe('GET /api/agents/:id', () => {
    it('returns agent detail (no claude_md for uninitialized agent)', async () => {
      const create = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'DetailBot', role: 'detail provider' },
      });
      const res = await request(app, 'GET', `/api/agents/${create.body.id}`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'DetailBot');
      assert.equal(res.body.initialized, 0);
      // claude_md is empty string since CLAUDE.md doesn't exist yet
      assert.equal(res.body.claude_md, '');
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'GET', '/api/agents/no-such-id', { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('PUT /api/agents/:id', () => {
    let agentId;

    beforeEach(async () => {
      const create = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'UpdateBot' },
      });
      agentId = create.body.id;
    });

    it('updates name', async () => {
      const res = await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie,
        body: { name: 'RenamedBot' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'RenamedBot');
    });

    it('updates role and model', async () => {
      const res = await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie,
        body: { role: 'new role', model: 'claude-opus-4-6' },
      });
      assert.equal(res.body.role, 'new role');
      assert.equal(res.body.model, 'claude-opus-4-6');
    });

    it('updates enabled flag', async () => {
      const res = await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie,
        body: { enabled: false },
      });
      assert.equal(res.body.enabled, 0);
    });

    it('updates claude_md on disk', async () => {
      await request(app, 'PUT', `/api/agents/${agentId}`, {
        cookie,
        body: { claude_md: '# Custom Knowledge\nSpecial instructions.' },
      });
      const mdPath = path.join(DATA_DIR, 'orgs', orgId, 'agents', agentId, 'CLAUDE.md');
      const content = fs.readFileSync(mdPath, 'utf-8');
      assert.ok(content.includes('Custom Knowledge'));
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'PUT', '/api/agents/no-such-id', {
        cookie,
        body: { name: 'Nope' },
      });
      assert.equal(res.status, 404);
    });
  });

  describe('DELETE /api/agents/:id', () => {
    it('deletes agent and cleans up filesystem', async () => {
      const create = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'DeleteMe' },
      });
      const id = create.body.id;
      const agentDir = path.join(DATA_DIR, 'orgs', orgId, 'agents', id);
      assert.ok(fs.existsSync(agentDir));

      const res = await request(app, 'DELETE', `/api/agents/${id}`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      // Verify gone from DB
      assert.equal(getOne('SELECT * FROM agents WHERE id = ?', [id]), undefined);
      // Verify directory removed
      assert.ok(!fs.existsSync(agentDir));
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'DELETE', '/api/agents/no-such-id', { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /api/agents/:id/reset-session', () => {
    it('generates new session_id and resets initialized flag', async () => {
      const create = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'ResetBot' },
      });
      const oldSessionId = create.body.session_id;

      const res = await request(app, 'POST', `/api/agents/${create.body.id}/reset-session`, { cookie });
      assert.equal(res.status, 200);
      assert.ok(res.body.session_id);
      assert.notEqual(res.body.session_id, oldSessionId);

      // Verify in DB
      const agent = getOne('SELECT * FROM agents WHERE id = ?', [create.body.id]);
      assert.equal(agent.session_initialized, 0);
      assert.equal(agent.session_id, res.body.session_id);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'POST', '/api/agents/no-such-id/reset-session', { cookie });
      assert.equal(res.status, 404);
    });
  });
});
