import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser, getOne } from './setup.js';

describe('Projects API', () => {
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
  // Helper: create an agent
  async function createAgent(name = 'TestBot') {
    const res = await request(app, 'POST', '/api/agents', { cookie, body: { name } });
    return res.body;
  }

  async function createProject(overrides = {}) {
    projectCounter++;
    if (!overrides.coordinator_agent_id) {
      const agent = await createAgent(`ProjBot-${projectCounter}`);
      overrides.coordinator_agent_id = agent.id;
    }
    const body = {
      name: overrides.name || `Test Project ${projectCounter}`,
      git_remote_url: overrides.git_remote_url || `git@gitea:Enigma/Test${projectCounter}.git`,
      ...overrides,
    };
    return request(app, 'POST', '/api/projects', { cookie, body });
  }

  // ==================== Projects CRUD ====================

  describe('GET /api/projects', () => {
    it('returns empty array initially', async () => {
      const res = await request(app, 'GET', '/api/projects', { cookie });
      assert.equal(res.status, 200);
      assert.deepStrictEqual(res.body, []);
    });

    it('returns projects with metadata', async () => {
      await createProject();
      const res = await request(app, 'GET', '/api/projects', { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 1);
      assert.ok(res.body[0].name.startsWith('Test Project'));
      assert.equal(res.body[0].milestone_count, 0);
      assert.equal(res.body[0].agent_count, 1); // coordinator auto-added
    });
  });

  describe('POST /api/projects', () => {
    it('creates project with required fields', async () => {
      const res = await createProject();
      assert.equal(res.status, 201);
      assert.ok(res.body.name.startsWith('Test Project'));
      assert.ok(res.body.git_remote_url.startsWith('git@gitea:Enigma/Test'));
      assert.equal(res.body.git_provider, 'gitea');
      assert.equal(res.body.status, 'not_ready');
      assert.equal(res.body.auto_merge, 0);
      assert.ok(res.body.id);
    });

    it('creates project with coordinator', async () => {
      const agent = await createAgent('Coordinator');
      const res = await createProject({ coordinator_agent_id: agent.id });
      assert.equal(res.status, 201);
      assert.equal(res.body.coordinator_agent_id, agent.id);

      // Coordinator auto-added as project agent
      const agents = await request(app, 'GET', `/api/projects/${res.body.id}/agents`, { cookie });
      assert.equal(agents.body.length, 1);
      assert.equal(agents.body[0].role, 'coordinator');
    });

    it('creates project conversation', async () => {
      const res = await createProject();
      const conv = getOne('SELECT * FROM conversations WHERE project_id = ?', [res.body.id]);
      assert.ok(conv);
      assert.equal(conv.agent_id, res.body.coordinator_agent_id);
      assert.equal(conv.project_id, res.body.id);
    });

    it('rejects missing name', async () => {
      const res = await createProject({ name: '' });
      assert.equal(res.status, 400);
    });

    it('rejects missing git_remote_url', async () => {
      const res = await createProject({ git_remote_url: '' });
      assert.equal(res.status, 400);
    });

    it('rejects duplicate name', async () => {
      await createProject({ name: 'Dupe' });
      const res = await createProject({ name: 'Dupe' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /already exists/);
    });

    it('rejects nonexistent coordinator', async () => {
      const res = await createProject({ coordinator_agent_id: 'no-such-agent' });
      assert.equal(res.status, 400);
    });
  });

  describe('GET /api/projects/:id', () => {
    it('returns project detail with agents and milestone counts', async () => {
      const agent = await createAgent('Coord');
      const proj = await createProject({ coordinator_agent_id: agent.id });
      const res = await request(app, 'GET', `/api/projects/${proj.body.id}`, { cookie });
      assert.equal(res.status, 200);
      assert.ok(res.body.name.startsWith('Test Project'));
      assert.ok(Array.isArray(res.body.agents));
      assert.equal(res.body.agents.length, 1);
      assert.equal(res.body.milestone_count, 0);
    });

    it('returns 404 for nonexistent project', async () => {
      const res = await request(app, 'GET', '/api/projects/no-such-id', { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('PUT /api/projects/:id', () => {
    it('updates project fields', async () => {
      const proj = await createProject();
      const res = await request(app, 'PUT', `/api/projects/${proj.body.id}`, {
        cookie, body: { name: 'Renamed', description: 'New desc', status: 'paused' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Renamed');
      assert.equal(res.body.description, 'New desc');
      assert.equal(res.body.status, 'paused');
    });

    it('rejects duplicate name on update', async () => {
      await createProject({ name: 'A' });
      const proj = await createProject({ name: 'B' });
      const res = await request(app, 'PUT', `/api/projects/${proj.body.id}`, {
        cookie, body: { name: 'A' },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('deletes project and cascades', async () => {
      const proj = await createProject();
      // Add milestone
      await request(app, 'POST', `/api/projects/${proj.body.id}/milestones`, {
        cookie, body: { name: 'M1' },
      });

      const res = await request(app, 'DELETE', `/api/projects/${proj.body.id}`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      // Verify cascade
      const milestones = getOne('SELECT COUNT(*) as count FROM project_milestones WHERE project_id = ?', [proj.body.id]);
      assert.equal(milestones.count, 0);
      // Verify conversation deleted
      const conv = getOne('SELECT * FROM conversations WHERE project_id = ?', [proj.body.id]);
      assert.equal(conv, undefined);
    });
  });

  // ==================== Org Scoping ====================

  describe('org scoping', () => {
    it('cannot see other org projects', async () => {
      const proj = await createProject();
      // Register a second user (different org)
      const reg2 = await registerTestUser(app, { email: 'other@example.com', name: 'Other', orgName: 'Other Org' });

      const res = await request(app, 'GET', `/api/projects/${proj.body.id}`, { cookie: reg2.cookie });
      assert.equal(res.status, 404);
    });
  });

  // ==================== Milestones ====================

  describe('Milestones', () => {
    let projectId;

    beforeEach(async () => {
      const proj = await createProject();
      projectId = proj.body.id;
    });

    it('creates and lists milestones', async () => {
      await request(app, 'POST', `/api/projects/${projectId}/milestones`, {
        cookie, body: { name: 'Alpha', sort_order: 1 },
      });
      await request(app, 'POST', `/api/projects/${projectId}/milestones`, {
        cookie, body: { name: 'Beta', sort_order: 2 },
      });

      const res = await request(app, 'GET', `/api/projects/${projectId}/milestones`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 2);
      assert.equal(res.body[0].name, 'Alpha');
      assert.equal(res.body[1].name, 'Beta');
      assert.ok(Array.isArray(res.body[0].deliverables));
    });

    it('updates milestone', async () => {
      const m = await request(app, 'POST', `/api/projects/${projectId}/milestones`, {
        cookie, body: { name: 'Draft' },
      });
      const res = await request(app, 'PUT', `/api/projects/milestones/${m.body.id}`, {
        cookie, body: { name: 'Final', status: 'in_progress' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Final');
      assert.equal(res.body.status, 'in_progress');
    });

    it('deletes milestone and cascades deliverables', async () => {
      const m = await request(app, 'POST', `/api/projects/${projectId}/milestones`, {
        cookie, body: { name: 'ToDelete' },
      });
      await request(app, 'POST', `/api/projects/milestones/${m.body.id}/deliverables`, {
        cookie, body: { name: 'D1' },
      });

      await request(app, 'DELETE', `/api/projects/milestones/${m.body.id}`, { cookie });
      const count = getOne('SELECT COUNT(*) as count FROM project_deliverables WHERE milestone_id = ?', [m.body.id]);
      assert.equal(count.count, 0);
    });
  });

  // ==================== Deliverables ====================

  describe('Deliverables', () => {
    let projectId, milestoneId;

    beforeEach(async () => {
      const agent = await createAgent('Worker');
      const proj = await createProject();
      projectId = proj.body.id;
      const m = await request(app, 'POST', `/api/projects/${projectId}/milestones`, {
        cookie, body: { name: 'M1' },
      });
      milestoneId = m.body.id;
    });

    it('creates deliverable with branch and agent', async () => {
      const agent = await createAgent('Assigned');
      const res = await request(app, 'POST', `/api/projects/milestones/${milestoneId}/deliverables`, {
        cookie, body: { name: 'Feature X', branch_name: 'feature/x', assigned_agent_id: agent.id },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'Feature X');
      assert.equal(res.body.branch_name, 'feature/x');
      assert.equal(res.body.assigned_agent_id, agent.id);
      assert.equal(res.body.status, 'pending');
    });

    it('creates multiple deliverables on same branch', async () => {
      await request(app, 'POST', `/api/projects/milestones/${milestoneId}/deliverables`, {
        cookie, body: { name: 'D1', branch_name: 'feature/auth' },
      });
      const res = await request(app, 'POST', `/api/projects/milestones/${milestoneId}/deliverables`, {
        cookie, body: { name: 'D2', branch_name: 'feature/auth' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.branch_name, 'feature/auth');
    });

    it('updates deliverable status', async () => {
      const d = await request(app, 'POST', `/api/projects/milestones/${milestoneId}/deliverables`, {
        cookie, body: { name: 'D1' },
      });
      const res = await request(app, 'PUT', `/api/projects/deliverables/${d.body.id}`, {
        cookie, body: { status: 'in_progress' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'in_progress');
    });

    it('rejects nonexistent assigned agent', async () => {
      const res = await request(app, 'POST', `/api/projects/milestones/${milestoneId}/deliverables`, {
        cookie, body: { name: 'D1', assigned_agent_id: 'no-such-agent' },
      });
      assert.equal(res.status, 400);
    });
  });

  // ==================== Agent Assignments ====================

  describe('Agent Assignments', () => {
    let projectId;

    beforeEach(async () => {
      const proj = await createProject();
      projectId = proj.body.id;
    });

    it('assigns agent to project', async () => {
      const agent = await createAgent('Worker');
      const res = await request(app, 'POST', `/api/projects/${projectId}/agents`, {
        cookie, body: { agent_id: agent.id },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.role, 'contributor');
      assert.equal(res.body.max_concurrent, 3);
      assert.equal(res.body.agent_name, 'Worker');
    });

    it('prevents duplicate assignment', async () => {
      const agent = await createAgent('Worker');
      await request(app, 'POST', `/api/projects/${projectId}/agents`, {
        cookie, body: { agent_id: agent.id },
      });
      const res = await request(app, 'POST', `/api/projects/${projectId}/agents`, {
        cookie, body: { agent_id: agent.id },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /already assigned/);
    });

    it('enforces max 1 coordinator', async () => {
      const a1 = await createAgent('Coord1');
      const a2 = await createAgent('Coord2');
      await request(app, 'POST', `/api/projects/${projectId}/agents`, {
        cookie, body: { agent_id: a1.id, role: 'coordinator' },
      });
      const res = await request(app, 'POST', `/api/projects/${projectId}/agents`, {
        cookie, body: { agent_id: a2.id, role: 'coordinator' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /coordinator/);
    });

    it('updates assignment config', async () => {
      const agent = await createAgent('Worker');
      await request(app, 'POST', `/api/projects/${projectId}/agents`, {
        cookie, body: { agent_id: agent.id },
      });
      const res = await request(app, 'PUT', `/api/projects/${projectId}/agents/${agent.id}`, {
        cookie, body: { max_concurrent: 5 },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.max_concurrent, 5);
    });

    it('removes agent from project', async () => {
      const agent = await createAgent('Worker');
      await request(app, 'POST', `/api/projects/${projectId}/agents`, {
        cookie, body: { agent_id: agent.id },
      });
      const before = await request(app, 'GET', `/api/projects/${projectId}/agents`, { cookie });
      const countBefore = before.body.length;

      const res = await request(app, 'DELETE', `/api/projects/${projectId}/agents/${agent.id}`, { cookie });
      assert.equal(res.status, 200);

      const list = await request(app, 'GET', `/api/projects/${projectId}/agents`, { cookie });
      assert.equal(list.body.length, countBefore - 1);
      assert.ok(!list.body.find(a => a.agent_id === agent.id));
    });
  });

  // ==================== External Links ====================

  describe('External Links', () => {
    let projectId;

    beforeEach(async () => {
      const proj = await createProject();
      projectId = proj.body.id;
    });

    it('adds and lists links', async () => {
      const res = await request(app, 'POST', `/api/projects/${projectId}/links`, {
        cookie, body: { type: 'issue_tracker', provider: 'youtrack', url: 'https://yt.example.com/project/TEST' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.type, 'issue_tracker');
      assert.equal(res.body.provider, 'youtrack');

      const list = await request(app, 'GET', `/api/projects/${projectId}/links`, { cookie });
      assert.equal(list.body.length, 1);
    });

    it('updates link', async () => {
      const link = await request(app, 'POST', `/api/projects/${projectId}/links`, {
        cookie, body: { type: 'ci', provider: 'teamcity', url: 'https://tc.example.com' },
      });
      const res = await request(app, 'PUT', `/api/projects/${projectId}/links/${link.body.id}`, {
        cookie, body: { url: 'https://tc2.example.com' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.url, 'https://tc2.example.com');
    });

    it('deletes link', async () => {
      const link = await request(app, 'POST', `/api/projects/${projectId}/links`, {
        cookie, body: { type: 'knowledge_base', provider: 'confluence', url: 'https://wiki.example.com' },
      });
      const res = await request(app, 'DELETE', `/api/projects/${projectId}/links/${link.body.id}`, { cookie });
      assert.equal(res.status, 200);
    });

    it('rejects invalid type', async () => {
      const res = await request(app, 'POST', `/api/projects/${projectId}/links`, {
        cookie, body: { type: 'invalid', provider: 'test', url: 'https://x.com' },
      });
      assert.equal(res.status, 400);
    });
  });

  // ==================== Backward Compatibility ====================

  describe('conversation backward compatibility', () => {
    it('agent conversations still work after schema change', async () => {
      const agent = await createAgent('ConvBot');
      const convRes = await request(app, 'GET', `/api/agents/${agent.id}/conversations`, { cookie });
      assert.equal(convRes.status, 200);
      assert.ok(convRes.body.length >= 1); // auto-created on agent creation
    });
  });
});
