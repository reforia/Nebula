import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createApp, resetDb, request, registerTestUser, getOne, run, DATA_DIR } from './setup.js';

describe('Project Wizard API', () => {
  let app, cookie, orgId;
  let projectCounter = 0;

  beforeEach(async () => {
    resetDb();
    projectCounter = 0;
    app = createApp();
    const reg = await registerTestUser(app);
    cookie = reg.cookie;
    orgId = reg.orgId;
  });

  async function createProject(overrides = {}) {
    projectCounter++;
    const body = {
      name: overrides.name || `Wizard Project ${projectCounter}`,
      git_remote_url: overrides.git_remote_url || `git@gitea:Enigma/WizTest${projectCounter}.git`,
      ...overrides,
    };
    return request(app, 'POST', '/api/projects', { cookie, body });
  }

  async function createAgent(name = 'WizBot') {
    const res = await request(app, 'POST', '/api/agents', { cookie, body: { name, role: 'test agent' } });
    return res.body;
  }

  describe('POST /api/projects/:id/launch', () => {
    it('returns 400 when project is not ready', async () => {
      const proj = await createProject();
      const res = await request(app, 'POST', `/api/projects/${proj.body.id}/launch`, { cookie });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('not ready'));
      assert.ok(res.body.readiness);
    });

    it('returns 404 for nonexistent project', async () => {
      const res = await request(app, 'POST', '/api/projects/nonexistent/launch', { cookie });
      assert.equal(res.status, 404);
    });

    it('returns 400 if project is already active', async () => {
      const proj = await createProject();
      // Force active status
      run("UPDATE projects SET status = 'active' WHERE id = ?", [proj.body.id]);
      const res = await request(app, 'POST', `/api/projects/${proj.body.id}/launch`, { cookie });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('already'));
    });
  });

  describe('PUT /api/projects/:id/vault/:path', () => {
    it('writes file to vault on default branch', async () => {
      const proj = await createProject();
      const res = await request(app, 'PUT', `/api/projects/${proj.body.id}/vault/design-spec.md`, {
        cookie,
        body: { content: '# Design Spec\n\nTest content' },
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.ok);

      // Verify file exists in git vault
      const { readVaultFile } = await import('../src/services/git.js');
      const { orgPath } = await import('../src/db.js');
      const repoPath = orgPath(orgId, 'projects', proj.body.id, 'repo.git');
      const content = readVaultFile(repoPath, 'design-spec.md');
      assert.ok(content.includes('Test content'));
    });

    it('returns 403 when project is active', async () => {
      const proj = await createProject();
      run("UPDATE projects SET status = 'active' WHERE id = ?", [proj.body.id]);
      const res = await request(app, 'PUT', `/api/projects/${proj.body.id}/vault/test.md`, {
        cookie,
        body: { content: 'should fail' },
      });
      assert.equal(res.status, 403);
    });

    it('rejects path traversal', async () => {
      const proj = await createProject();
      const res = await request(app, 'PUT', `/api/projects/${proj.body.id}/vault/../etc/passwd`, {
        cookie,
        body: { content: 'evil' },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('Readiness state machine', () => {
    it('does NOT auto-promote from not_ready to active', async () => {
      const proj = await createProject();
      // Project starts as not_ready
      assert.equal(proj.body.status, 'not_ready');

      // Load the project detail (which triggers readiness evaluation)
      const detail = await request(app, 'GET', `/api/projects/${proj.body.id}`, { cookie });
      // Even if readiness could pass, status should still be not_ready (no auto-promotion)
      assert.equal(detail.body.status, 'not_ready');
    });

    it('demotes active to not_ready when prerequisite fails', async () => {
      const agent = await createAgent('Coord');
      const proj = await createProject({ coordinator_agent_id: agent.id });

      // Force project to active
      run("UPDATE projects SET status = 'active', launched_at = datetime('now') WHERE id = ?", [proj.body.id]);

      // Remove coordinator (breaks a prerequisite)
      run('UPDATE projects SET coordinator_agent_id = NULL WHERE id = ?', [proj.body.id]);

      // Trigger readiness evaluation
      const detail = await request(app, 'GET', `/api/projects/${proj.body.id}`, { cookie });
      assert.equal(detail.body.status, 'not_ready');
    });
  });

  describe('POST /api/projects (wizard mode)', () => {
    it('stores git token as project secret when provided', async () => {
      const proj = await createProject({ git_token: 'test-token-123' });
      assert.equal(proj.status, 201);

      // Check project has git_token_key set
      const project = getOne('SELECT git_token_key FROM projects WHERE id = ?', [proj.body.id]);
      assert.equal(project.git_token_key, 'GIT_TOKEN');

      // Check secret exists
      const secret = getOne('SELECT key FROM project_secrets WHERE project_id = ? AND key = ?', [proj.body.id, 'GIT_TOKEN']);
      assert.ok(secret);
    });

    it('backwards compat: works without repo_mode', async () => {
      const proj = await createProject();
      assert.equal(proj.status, 201);
      assert.equal(proj.body.status, 'not_ready');
    });
  });

  describe('POST /api/projects/validate-provider', () => {
    it('returns error for missing fields', async () => {
      const res = await request(app, 'POST', '/api/projects/validate-provider', {
        cookie,
        body: { provider: 'gitea' },
      });
      assert.equal(res.status, 400);
    });

    it('returns error for Gitea without api_url', async () => {
      const res = await request(app, 'POST', '/api/projects/validate-provider', {
        cookie,
        body: { provider: 'gitea', token: 'fake' },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('API URL'));
    });
  });
});
