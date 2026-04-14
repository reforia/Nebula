import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser } from './setup.js';

describe('Project Dashboard', () => {
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

  async function createProject(overrides = {}) {
    if (!overrides.coordinator_agent_id) {
      const agent = await createAgent('CoordBot');
      overrides.coordinator_agent_id = agent.id;
    }
    const body = { name: 'DashProj', git_remote_url: 'git@test:org/repo.git', ...overrides };
    const res = await request(app, 'POST', '/api/projects', { cookie, body });
    return res.body;
  }

  it('returns dashboard for empty project', async () => {
    const project = await createProject();
    const res = await request(app, 'GET', `/api/projects/${project.id}/dashboard`, { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.project.name, 'DashProj');
    assert.equal(res.body.progress.total_deliverables, 0);
    assert.equal(res.body.progress.percent, 0);
    assert.deepStrictEqual(res.body.milestones, []);
    assert.equal(res.body.agents.length, 1); // coordinator auto-added
    assert.equal(res.body.agents[0].role, 'coordinator');
  });

  it('returns milestone progress breakdown', async () => {
    const coord = await createAgent('Coord');
    const project = await createProject({ coordinator_agent_id: coord.id });

    // Create milestone with deliverables
    const m = await request(app, 'POST', `/api/projects/${project.id}/milestones`, {
      cookie, body: { name: 'Alpha' },
    });

    await request(app, 'POST', `/api/projects/milestones/${m.body.id}/deliverables`, {
      cookie, body: { name: 'D1' },
    });
    const d2 = await request(app, 'POST', `/api/projects/milestones/${m.body.id}/deliverables`, {
      cookie, body: { name: 'D2' },
    });
    await request(app, 'PUT', `/api/projects/deliverables/${d2.body.id}`, {
      cookie, body: { status: 'done' },
    });

    const res = await request(app, 'GET', `/api/projects/${project.id}/dashboard`, { cookie });
    assert.equal(res.body.progress.total_deliverables, 2);
    assert.equal(res.body.progress.done_deliverables, 1);
    assert.equal(res.body.progress.percent, 50);

    assert.equal(res.body.milestones.length, 1);
    assert.equal(res.body.milestones[0].name, 'Alpha');
    assert.equal(res.body.milestones[0].deliverables.total, 2);
    assert.equal(res.body.milestones[0].deliverables.done, 1);
    assert.equal(res.body.milestones[0].progress, 50);
  });

  it('returns assigned agents with deliverable counts', async () => {
    const coord = await createAgent('Coord');
    const worker = await createAgent('Worker');
    const project = await createProject({ coordinator_agent_id: coord.id });

    await request(app, 'POST', `/api/projects/${project.id}/agents`, {
      cookie, body: { agent_id: worker.id },
    });

    const m = await request(app, 'POST', `/api/projects/${project.id}/milestones`, {
      cookie, body: { name: 'M1' },
    });
    await request(app, 'POST', `/api/projects/milestones/${m.body.id}/deliverables`, {
      cookie, body: { name: 'D1', assigned_agent_id: worker.id },
    });
    const d2 = await request(app, 'POST', `/api/projects/milestones/${m.body.id}/deliverables`, {
      cookie, body: { name: 'D2', assigned_agent_id: worker.id },
    });
    await request(app, 'PUT', `/api/projects/deliverables/${d2.body.id}`, {
      cookie, body: { status: 'done' },
    });

    const res = await request(app, 'GET', `/api/projects/${project.id}/dashboard`, { cookie });
    const workerInfo = res.body.agents.find(a => a.agent_name === 'Worker');
    assert.ok(workerInfo);
    assert.equal(workerInfo.assigned_deliverables, 2);
    assert.equal(workerInfo.completed_deliverables, 1);
    assert.equal(workerInfo.role, 'contributor');
  });

  it('returns 404 for nonexistent project', async () => {
    const res = await request(app, 'GET', '/api/projects/no-such/dashboard', { cookie });
    assert.equal(res.status, 404);
  });

  it('includes auto_merge in project info', async () => {
    const project = await createProject();
    await request(app, 'PUT', `/api/projects/${project.id}`, {
      cookie, body: { auto_merge: true },
    });

    const res = await request(app, 'GET', `/api/projects/${project.id}/dashboard`, { cookie });
    assert.equal(res.body.project.auto_merge, 1);
  });
});
