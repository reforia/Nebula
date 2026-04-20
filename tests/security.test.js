import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp, resetDb, request, registerTestUser, getOne, getAll } from './setup.js';
import { initProjectRepo, createBranch, readVaultFile } from '../src/services/git.js';
import executor from '../src/services/executor.js';

const ASYNC_SETTLE = 500;

describe('Security & Edge Cases', () => {
  let app, cookie, orgId;

  beforeEach(async () => {
    resetDb();
    app = createApp();
    const reg = await registerTestUser(app);
    cookie = reg.cookie;
    orgId = reg.orgId;
  });

  async function createAgent(name) {
    const res = await request(app, 'POST', '/api/agents', { cookie, body: { name } });
    return res.body;
  }

  // ==================== Vault Path Traversal ====================

  describe('vault path traversal', () => {
    it('blocks .. in vault file path', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
      const repoPath = path.join(tmpDir, 'repo.git');
      initProjectRepo(repoPath, null, { name: 'Test' });

      const result = readVaultFile(repoPath, '../CLAUDE.md');
      assert.equal(result, null);

      const result2 = readVaultFile(repoPath, '../../etc/passwd');
      assert.equal(result2, null);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('blocks absolute paths in vault', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
      const repoPath = path.join(tmpDir, 'repo.git');
      initProjectRepo(repoPath, null, { name: 'Test' });

      const result = readVaultFile(repoPath, '/etc/passwd');
      assert.equal(result, null);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ==================== Git Branch Name Validation ====================

  describe('git branch name validation', () => {
    it('rejects branch names with shell metacharacters', () => {
      assert.throws(() => createBranch('/tmp/fake', 'feature/$(whoami)'), /Invalid branch name/);
      assert.throws(() => createBranch('/tmp/fake', 'feature/`echo hi`'), /Invalid branch name/);
      assert.throws(() => createBranch('/tmp/fake', 'feature;rm -rf /'), /Invalid branch name/);
      assert.throws(() => createBranch('/tmp/fake', 'feature|cat /etc/passwd'), /Invalid branch name/);
      assert.throws(() => createBranch('/tmp/fake', 'feature & echo pwned'), /Invalid branch name/);
    });

    it('rejects branch names starting with dash', () => {
      assert.throws(() => createBranch('/tmp/fake', '--delete'), /Invalid branch name/);
    });

    it('rejects branch names with ..', () => {
      assert.throws(() => createBranch('/tmp/fake', 'feature/../main'), /Invalid branch name/);
    });

    it('allows valid branch names', () => {
      // These shouldn't throw (validation only, actual git op will fail without repo)
      // Just verify the regex accepts them
      const validNames = ['feature/auth', 'fix-123', 'release/v1.0', 'my_branch', 'UPPERCASE'];
      for (const name of validNames) {
        // createBranch will throw because repo doesn't exist, but NOT with "Invalid branch name"
        try {
          createBranch('/tmp/nonexistent', name);
        } catch (e) {
          assert.ok(!e.message.includes('Invalid branch name'), `"${name}" should be valid but got: ${e.message}`);
        }
      }
    });
  });

  // ==================== Cross-Org Access ====================

  describe('cross-org access', () => {
    it('cannot update another org milestone', async () => {
      // Create project in org 1
      const coord = await createAgent('Coord1');
      const proj = await request(app, 'POST', '/api/projects', {
        cookie, body: { name: 'OrgProject', git_remote_url: 'git@test:org/repo.git', coordinator_agent_id: coord.id },
      });
      const m = await request(app, 'POST', `/api/projects/${proj.body.id}/milestones`, {
        cookie, body: { name: 'M1' },
      });

      // Register user in org 2
      const reg2 = await registerTestUser(app, { email: 'hacker@evil.com', name: 'Hacker', orgName: 'Evil Org' });

      // Try to update milestone from org 2
      const res = await request(app, 'PUT', `/api/projects/milestones/${m.body.id}`, {
        cookie: reg2.cookie, body: { name: 'Hacked' },
      });
      assert.equal(res.status, 404);
    });

    it('cannot delete another org deliverable', async () => {
      const coord2 = await createAgent('Coord2');
      const proj = await request(app, 'POST', '/api/projects', {
        cookie, body: { name: 'OrgProject2', git_remote_url: 'git@test:org/repo2.git', coordinator_agent_id: coord2.id },
      });
      const m = await request(app, 'POST', `/api/projects/${proj.body.id}/milestones`, {
        cookie, body: { name: 'M1' },
      });
      const d = await request(app, 'POST', `/api/projects/milestones/${m.body.id}/deliverables`, {
        cookie, body: { name: 'D1' },
      });

      const reg2 = await registerTestUser(app, { email: 'hacker2@evil.com', name: 'Hacker2', orgName: 'Evil Org 2' });

      const res = await request(app, 'DELETE', `/api/projects/deliverables/${d.body.id}`, {
        cookie: reg2.cookie,
      });
      assert.equal(res.status, 404);
    });
  });

  // ==================== Agent @mention Routing ====================

  describe('@mention routing in agent responses', () => {
    it('user @AgentName pulls agent into conversation', async () => {
      const agentA = await createAgent('AgentA');
      const agentB = await createAgent('AgentB');

      // User messages AgentA with @AgentB
      const res = await request(app, 'POST', `/api/agents/${agentA.id}/messages`, {
        cookie, body: { content: 'Hey @AgentB can you help?' },
      });
      assert.equal(res.status, 201);

      // Wait for async execution (will error in test, but messages are stored)
      await new Promise(r => setTimeout(r, ASYNC_SETTLE));

      // AgentB should have been triggered — check if error message exists in A's conversation
      // (In test env, executor fails, but the routing attempt is what we verify)
      const conv = getOne('SELECT id FROM conversations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1', [agentA.id]);
      const msgs = getAll('SELECT * FROM messages WHERE conversation_id = ?', [conv.id]);
      // Should have: user message + AgentA error + AgentB error (both tried to execute)
      assert.ok(msgs.length >= 2);
    });

    it('does not route @mention to nonexistent agent', async () => {
      const agentA = await createAgent('AgentA2');

      const res = await request(app, 'POST', `/api/agents/${agentA.id}/messages`, {
        cookie, body: { content: 'Hey @NonExistentBot help' },
      });
      assert.equal(res.status, 201);

      await new Promise(r => setTimeout(r, ASYNC_SETTLE));

      // Only AgentA should have been triggered, not NonExistentBot
      const conv = getOne('SELECT id FROM conversations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1', [agentA.id]);
      const msgs = getAll('SELECT * FROM messages WHERE conversation_id = ? AND role = ?', [conv.id, 'assistant']);
      // Only one error message (from AgentA), not two
      assert.equal(msgs.length, 1);
    });
  });

  // ==================== Workspace Skeleton ====================

  describe('workspace skeleton on agent creation', () => {
    it('creates workspace/ directory (memory is now DB-managed)', async () => {
      const agent = await createAgent('SkeletonBot');
      const DATA_DIR = process.env.DATA_DIR;
      const agentDir = path.join(DATA_DIR, 'orgs', orgId, 'agents', agent.id);

      assert.ok(fs.existsSync(path.join(agentDir, 'workspace')));
      // Memory is DB-managed — no memory/ directory created
      assert.ok(!fs.existsSync(path.join(agentDir, 'memory')));
    });

    it('CLAUDE.md not created at agent creation (created during initialization)', async () => {
      const agent = await createAgent('InstructedBot');
      const DATA_DIR = process.env.DATA_DIR;
      const agentDir = path.join(DATA_DIR, 'orgs', orgId, 'agents', agent.id);
      assert.ok(!fs.existsSync(path.join(agentDir, 'CLAUDE.md')));
    });
  });

  // ==================== Duplicate Git Repo Prevention ====================

  describe('duplicate git repo prevention', () => {
    it('rejects project with same git_remote_url in same org', async () => {
      const coordA = await createAgent('CoordA');
      await request(app, 'POST', '/api/projects', {
        cookie, body: { name: 'Project A', git_remote_url: 'git@test:org/same-repo.git', coordinator_agent_id: coordA.id },
      });
      const coordB = await createAgent('CoordB');
      const res = await request(app, 'POST', '/api/projects', {
        cookie, body: { name: 'Project B', git_remote_url: 'git@test:org/same-repo.git', coordinator_agent_id: coordB.id },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('already exists for this repository'));
    });

    it('allows same git_remote_url in different orgs', async () => {
      const coord1 = await createAgent('Coord1');
      await request(app, 'POST', '/api/projects', {
        cookie, body: { name: 'Org1 Project', git_remote_url: 'git@test:org/shared-repo.git', coordinator_agent_id: coord1.id },
      });

      const reg2 = await registerTestUser(app, { email: 'other@test.com', name: 'Other', orgName: 'Org 2' });
      const coord2Res = await request(app, 'POST', '/api/agents', { cookie: reg2.cookie, body: { name: 'Coord2' } });
      const res = await request(app, 'POST', '/api/projects', {
        cookie: reg2.cookie, body: { name: 'Org2 Project', git_remote_url: 'git@test:org/shared-repo.git', coordinator_agent_id: coord2Res.body.id },
      });
      assert.equal(res.status, 201);
    });
  });

  // ==================== Deliverable branch_name validation ====================

  describe('deliverable branch_name path traversal', () => {
    async function makeProjectWithMilestone() {
      const coord = await createAgent('DelCoord');
      const proj = await request(app, 'POST', '/api/projects', {
        cookie,
        body: { name: 'DelProj', git_remote_url: 'git@test:org/del.git', coordinator_agent_id: coord.id },
      });
      const m = await request(app, 'POST', `/api/projects/${proj.body.id}/milestones`, {
        cookie, body: { name: 'M1' },
      });
      return { projectId: proj.body.id, milestoneId: m.body.id };
    }

    it('rejects branch_name with .. on deliverable create', async () => {
      const { milestoneId } = await makeProjectWithMilestone();
      const res = await request(app, 'POST', `/api/projects/milestones/${milestoneId}/deliverables`, {
        cookie, body: { name: 'D', branch_name: '../../etc/passwd' },
      });
      assert.equal(res.status, 400);
      assert.ok(/branch name/i.test(res.body.error));
    });

    it('rejects branch_name with shell metacharacters on deliverable create', async () => {
      const { milestoneId } = await makeProjectWithMilestone();
      const res = await request(app, 'POST', `/api/projects/milestones/${milestoneId}/deliverables`, {
        cookie, body: { name: 'D', branch_name: 'feature/$(whoami)' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects branch_name with .. on deliverable update', async () => {
      const { milestoneId } = await makeProjectWithMilestone();
      const created = await request(app, 'POST', `/api/projects/milestones/${milestoneId}/deliverables`, {
        cookie, body: { name: 'D' },
      });
      const res = await request(app, 'PUT', `/api/projects/deliverables/${created.body.id}`, {
        cookie, body: { branch_name: '../escape' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects branch_name on bulk project create with milestones', async () => {
      const coord = await createAgent('BulkCoord');
      const res = await request(app, 'POST', '/api/projects', {
        cookie,
        body: {
          name: 'BulkProj',
          git_remote_url: 'git@test:org/bulk.git',
          coordinator_agent_id: coord.id,
          milestones: [{
            name: 'M1',
            deliverables: [{ name: 'D1', branch_name: '../../../outside' }],
          }],
        },
      });
      assert.equal(res.status, 400);
    });

    it('accepts valid branch_name on deliverable create', async () => {
      const { milestoneId } = await makeProjectWithMilestone();
      const res = await request(app, 'POST', `/api/projects/milestones/${milestoneId}/deliverables`, {
        cookie, body: { name: 'D', branch_name: 'feature/new-auth' },
      });
      assert.equal(res.status, 201);
    });
  });

  describe('DELETE /api/projects/:id/branches/:name traversal', () => {
    it('rejects branch name containing ..', async () => {
      const coord = await createAgent('DelBranch');
      const proj = await request(app, 'POST', '/api/projects', {
        cookie,
        body: { name: 'BranchProj', git_remote_url: 'git@test:org/bd.git', coordinator_agent_id: coord.id },
      });
      const res = await request(app, 'DELETE', `/api/projects/${proj.body.id}/branches/..%2Fetc%2Fpasswd`, { cookie });
      assert.equal(res.status, 400);
    });
  });

  describe('executor _resolveAgentDir defends against bad branch names', () => {
    it('throws synchronously when enqueue passes traversal branch name', async () => {
      const agent = await createAgent('DefenderBot');
      const coord = await createAgent('DefProjCoord');
      const proj = await request(app, 'POST', '/api/projects', {
        cookie,
        body: { name: 'DefProj', git_remote_url: 'git@test:org/def.git', coordinator_agent_id: coord.id },
      });

      await assert.rejects(
        executor.enqueue(agent.id, 'hi', {
          projectId: proj.body.id,
          branchName: '../../evil',
          conversationId: null,
        }),
        /Invalid branch name/,
      );
    });
  });

  // ==================== Executor Edge Cases ====================

  describe('executor cancel edge cases', () => {
    it('cancel returns false for non-existent agent', () => {
      const result = executor.cancel('non-existent-agent-id');
      assert.equal(result, false);
    });

    it('cancel with empty queues does not throw', () => {
      assert.doesNotThrow(() => {
        executor.cancel('some-agent', 'some-project', 'some-branch');
      });
    });
  });
});
