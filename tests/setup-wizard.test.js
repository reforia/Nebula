import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createApp, resetDb, request, registerTestUser, getOne, getAll, getOrgSetting, getSetting, DATA_DIR } from './setup.js';

// Tests run with AUTH_PROVIDER=local (the default)

describe('Setup Wizard API', () => {
  let app;

  beforeEach(() => {
    resetDb();
    app = createApp();
  });

  // ─── GET /api/setup/status ─────────────────────────────────

  describe('GET /api/setup/status', () => {
    it('returns needsSetup=true on empty database', async () => {
      const res = await request(app, 'GET', '/api/setup/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.needsSetup, true);
      assert.equal(res.body.setupIncomplete, false);
      assert.ok(res.body.instanceId);
      assert.equal(res.body.authProvider, 'local');
    });

    it('returns setupIncomplete=true after user exists but setup not done', async () => {
      registerTestUser(app);

      const res = await request(app, 'GET', '/api/setup/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.needsSetup, false);
      assert.equal(res.body.setupIncomplete, true);
    });

    it('returns both false after setup is complete', async () => {
      const { cookie } = registerTestUser(app);

      await request(app, 'POST', '/api/setup/complete', {
        cookie,
        body: { settings: {} },
      });

      const res = await request(app, 'GET', '/api/setup/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.needsSetup, false);
      assert.equal(res.body.setupIncomplete, false);
    });

    it('returns stable instanceId across calls', async () => {
      const res1 = await request(app, 'GET', '/api/setup/status');
      const res2 = await request(app, 'GET', '/api/setup/status');
      assert.equal(res1.body.instanceId, res2.body.instanceId);
    });

    it('does not include platformUrl in local mode', async () => {
      const res = await request(app, 'GET', '/api/setup/status');
      assert.equal(res.body.platformUrl, undefined);
    });
  });

  // ─── POST /api/setup/create-admin (local auth) ────────────

  describe('POST /api/setup/create-admin', () => {
    it('creates admin user on first boot', async () => {
      const res = await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'admin@example.com', password: 'testpass123', name: 'Admin' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'admin@example.com');
      assert.equal(res.body.user.name, 'Admin');
      assert.ok(res.body.orgs.length > 0);
      assert.ok(res.body.currentOrgId);

      // JWT cookies should be set
      const cookies = res.headers['set-cookie'];
      assert.ok(cookies?.some(c => c.startsWith('nebula_access=')));
      assert.ok(cookies?.some(c => c.startsWith('nebula_refresh=')));
    });

    it('normalizes email to lowercase', async () => {
      const res = await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'ADMIN@Example.COM', password: 'testpass123', name: 'Admin' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'admin@example.com');
    });

    it('creates org named after admin', async () => {
      const res = await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'admin@example.com', password: 'testpass123', name: 'Jay' },
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.orgs[0].name.includes('Jay'));
    });

    it('creates org directories on disk', async () => {
      const res = await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'admin@example.com', password: 'testpass123', name: 'Admin' },
      });
      const orgId = res.body.currentOrgId;
      const orgDir = path.join(DATA_DIR, 'orgs', orgId);
      assert.ok(fs.existsSync(orgDir));
      assert.ok(fs.existsSync(path.join(orgDir, 'agents')));
      assert.ok(fs.existsSync(path.join(orgDir, 'global')));
    });

    it('sets default org settings (internal_api_token etc)', async () => {
      const res = await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'admin@example.com', password: 'testpass123', name: 'Admin' },
      });
      const orgId = res.body.currentOrgId;
      const token = getOrgSetting(orgId, 'internal_api_token');
      assert.ok(token, 'internal_api_token should be set');
    });

    it('stores hashed password, not plaintext', async () => {
      await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'admin@example.com', password: 'testpass123', name: 'Admin' },
      });
      const user = getOne('SELECT * FROM users WHERE email = ?', ['admin@example.com']);
      assert.ok(user.password_hash.startsWith('$2'));
      assert.notEqual(user.password_hash, 'testpass123');
    });

    it('rejects when users already exist', async () => {
      registerTestUser(app);
      const res = await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'admin2@example.com', password: 'testpass123', name: 'Admin2' },
      });
      assert.equal(res.status, 403);
    });

    it('rejects short password', async () => {
      const res = await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'admin@example.com', password: 'short', name: 'Admin' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects missing email', async () => {
      const res = await request(app, 'POST', '/api/setup/create-admin', {
        body: { password: 'testpass123' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects missing password', async () => {
      const res = await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'admin@example.com' },
      });
      assert.equal(res.status, 400);
    });

    it('admin can log in with created credentials', async () => {
      await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'admin@example.com', password: 'testpass123', name: 'Admin' },
      });

      const loginRes = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'admin@example.com', password: 'testpass123' },
      });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.user.email, 'admin@example.com');
    });

    it('admin can then complete setup', async () => {
      const adminRes = await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'admin@example.com', password: 'testpass123', name: 'Admin' },
      });
      assert.equal(adminRes.status, 200);

      const setCookies = adminRes.headers['set-cookie'];
      const cookie = setCookies.map(c => c.split(';')[0]).join('; ');

      const completeRes = await request(app, 'POST', '/api/setup/complete', {
        cookie,
        body: { settings: {} },
      });
      assert.equal(completeRes.status, 200);
      assert.equal(completeRes.body.ok, true);
      assert.equal(getSetting('setup_completed'), '1');
    });

    it('setup status transitions correctly through full flow', async () => {
      // Step 0: Fresh — needsSetup
      const s0 = await request(app, 'GET', '/api/setup/status');
      assert.equal(s0.body.needsSetup, true);
      assert.equal(s0.body.setupIncomplete, false);

      // Step 1: Create admin — setupIncomplete
      const adminRes = await request(app, 'POST', '/api/setup/create-admin', {
        body: { email: 'admin@example.com', password: 'testpass123', name: 'Admin' },
      });
      const cookie = adminRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');

      const s1 = await request(app, 'GET', '/api/setup/status');
      assert.equal(s1.body.needsSetup, false);
      assert.equal(s1.body.setupIncomplete, true);

      // Step 2: Complete setup — done
      await request(app, 'POST', '/api/setup/complete', { cookie, body: { settings: {} } });

      const s2 = await request(app, 'GET', '/api/setup/status');
      assert.equal(s2.body.needsSetup, false);
      assert.equal(s2.body.setupIncomplete, false);
    });
  });

  // ─── POST /api/setup/complete ──────────────────────────────

  describe('POST /api/setup/complete', () => {
    it('requires authentication', async () => {
      const res = await request(app, 'POST', '/api/setup/complete', {
        body: { settings: {} },
      });
      assert.equal(res.status, 401);
    });

    it('creates default agent from starter template', async () => {
      const { cookie, orgId } = registerTestUser(app);

      const res = await request(app, 'POST', '/api/setup/complete', {
        cookie,
        body: { settings: {} },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      const agents = getAll('SELECT * FROM agents WHERE org_id = ?', [orgId]);
      assert.ok(agents.length > 0, 'Expected at least one agent from starter template');
      assert.equal(agents[0].name, 'Assistant');

      const convs = getAll('SELECT * FROM conversations WHERE agent_id = ?', [agents[0].id]);
      assert.equal(convs.length, 1);
      assert.equal(convs[0].title, 'General');
    });

    it('creates agent workspace directory', async () => {
      const { cookie, orgId } = registerTestUser(app);

      await request(app, 'POST', '/api/setup/complete', {
        cookie,
        body: { settings: {} },
      });

      const agent = getOne('SELECT * FROM agents WHERE org_id = ?', [orgId]);
      const agentDir = path.join(DATA_DIR, 'orgs', orgId, 'agents', agent.id);
      assert.ok(fs.existsSync(agentDir));
      assert.ok(fs.existsSync(path.join(agentDir, 'workspace')));
    });

    it('saves default_runtime org setting', async () => {
      const { cookie, orgId } = registerTestUser(app);

      const res = await request(app, 'POST', '/api/setup/complete', {
        cookie,
        body: {
          settings: {
            default_runtime: 'claude-cli',
          },
        },
      });

      assert.equal(res.status, 200);

      const runtime = getOrgSetting(orgId, 'default_runtime');
      assert.equal(runtime, 'claude-cli');
    });

    it('rejects non-whitelisted settings keys', async () => {
      const { cookie, orgId } = registerTestUser(app);

      await request(app, 'POST', '/api/setup/complete', {
        cookie,
        body: {
          settings: {
            default_runtime: 'claude-cli',
            evil_key: 'should_not_be_saved',
          },
        },
      });

      const evil = getOrgSetting(orgId, 'evil_key');
      assert.equal(evil, null, 'Non-whitelisted key should not be saved');
    });

    it('marks setup as completed', async () => {
      const { cookie } = registerTestUser(app);

      await request(app, 'POST', '/api/setup/complete', {
        cookie,
        body: { settings: {} },
      });

      assert.equal(getSetting('setup_completed'), '1');
    });

    it('rejects second setup attempt', async () => {
      const { cookie } = registerTestUser(app);

      const res1 = await request(app, 'POST', '/api/setup/complete', {
        cookie,
        body: { settings: {} },
      });
      assert.equal(res1.status, 200);

      const res2 = await request(app, 'POST', '/api/setup/complete', {
        cookie,
        body: { settings: {} },
      });
      assert.equal(res2.status, 403);
      assert.match(res2.body.error, /already completed/i);
    });

    it('is idempotent for agent creation', async () => {
      const { cookie, orgId } = registerTestUser(app);

      const { generateId: genId } = await import('../src/utils/uuid.js');
      const agentId = genId();
      const { run: dbRun } = await import('../src/db.js');
      dbRun(
        `INSERT INTO agents (id, org_id, name, role, session_id, allowed_tools, model, backend)
         VALUES (?, ?, 'Assistant', 'test', ?, 'Read', 'claude-sonnet-4-6', 'claude-cli')`,
        [agentId, orgId, genId()]
      );

      const res = await request(app, 'POST', '/api/setup/complete', {
        cookie,
        body: { settings: {} },
      });
      assert.equal(res.status, 200);

      const agents = getAll("SELECT * FROM agents WHERE org_id = ? AND name = 'Assistant'", [orgId]);
      assert.equal(agents.length, 1);
    });

    it('handles empty settings gracefully', async () => {
      const { cookie } = registerTestUser(app);

      const res = await request(app, 'POST', '/api/setup/complete', {
        cookie,
        body: {},
      });
      assert.equal(res.status, 200);
    });
  });
});
