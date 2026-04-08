import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createApp, resetDb, request, registerTestUser, getOne, getAll, run, DATA_DIR } from './setup.js';
import { generateId } from '../src/utils/uuid.js';

describe('Organizations API', () => {
  let app;

  beforeEach(() => {
    resetDb();
    app = createApp();
  });

  // ─── DELETE /api/orgs/:id ──────────────────────────────────

  describe('DELETE /api/orgs/:id', () => {
    it('deletes an organization when user has multiple orgs', async () => {
      const { cookie, user, orgId } = registerTestUser(app);

      // Create a second org
      const org2Id = generateId();
      run('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)',
        [org2Id, 'Second Org', user.id]);

      const res = await request(app, 'DELETE', `/api/orgs/${orgId}`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      // Verify org is deleted from DB
      const org = getOne('SELECT * FROM organizations WHERE id = ?', [orgId]);
      assert.equal(org, undefined);
    });

    it('cascades deletion to agents and conversations', async () => {
      const { cookie, user, orgId } = registerTestUser(app);

      // Create an agent in the org
      const agent = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'TestBot' },
      });
      const agentId = agent.body.id;

      // Create second org so we can delete the first
      const org2Id = generateId();
      run('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)',
        [org2Id, 'Second Org', user.id]);

      await request(app, 'DELETE', `/api/orgs/${orgId}`, { cookie });

      // Verify agent and conversations are gone
      const agents = getAll('SELECT * FROM agents WHERE org_id = ?', [orgId]);
      assert.equal(agents.length, 0);
      const convs = getAll('SELECT * FROM conversations WHERE agent_id = ?', [agentId]);
      assert.equal(convs.length, 0);
    });

    it('deletes org filesystem directory', async () => {
      const { cookie, user, orgId } = registerTestUser(app);

      const orgDir = path.join(DATA_DIR, 'orgs', orgId);
      assert.ok(fs.existsSync(orgDir), 'Org dir should exist before delete');

      const org2Id = generateId();
      run('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)',
        [org2Id, 'Second Org', user.id]);

      await request(app, 'DELETE', `/api/orgs/${orgId}`, { cookie });

      assert.ok(!fs.existsSync(orgDir), 'Org dir should be cleaned up');
    });

    it('rejects deleting the last organization', async () => {
      const { cookie, orgId } = registerTestUser(app);

      const res = await request(app, 'DELETE', `/api/orgs/${orgId}`, { cookie });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('last organization'));

      // Verify org still exists
      const org = getOne('SELECT * FROM organizations WHERE id = ?', [orgId]);
      assert.ok(org);
    });

    it('rejects deleting org owned by another user', async () => {
      const { orgId: otherOrgId } = registerTestUser(app, { email: 'other@example.com' });
      const { cookie } = registerTestUser(app, { email: 'attacker@example.com' });

      const res = await request(app, 'DELETE', `/api/orgs/${otherOrgId}`, { cookie });
      assert.equal(res.status, 404);
    });

    it('returns 404 for nonexistent org', async () => {
      const { cookie } = registerTestUser(app);

      const res = await request(app, 'DELETE', '/api/orgs/nonexistent-id', { cookie });
      assert.equal(res.status, 404);
    });
  });

  // ─── PUT /api/orgs/:id ────────────────────────────────────

  describe('PUT /api/orgs/:id', () => {
    it('renames an organization', async () => {
      const { cookie, orgId } = registerTestUser(app);

      const res = await request(app, 'PUT', `/api/orgs/${orgId}`, {
        cookie,
        body: { name: 'New Name' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'New Name');

      const org = getOne('SELECT * FROM organizations WHERE id = ?', [orgId]);
      assert.equal(org.name, 'New Name');
    });
  });
});
