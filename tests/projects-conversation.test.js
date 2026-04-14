import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser, getOne, getAll } from './setup.js';

const ASYNC_SETTLE = 500; // Wait for async executor (will fail but stores error message)

describe('Project Conversation', () => {
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
    const body = { name: 'TestProj', git_remote_url: 'git@test:org/repo.git', ...overrides };
    const res = await request(app, 'POST', '/api/projects', { cookie, body });
    return res.body;
  }

  it('project has conversation on creation', async () => {
    const project = await createProject();
    const conv = getOne('SELECT * FROM conversations WHERE project_id = ?', [project.id]);
    assert.ok(conv);
    assert.equal(conv.agent_id, project.coordinator_agent_id);
    assert.equal(conv.project_id, project.id);
  });

  it('posts message to project conversation', async () => {
    const agent = await createAgent('Coord');
    const project = await createProject({ coordinator_agent_id: agent.id });

    const res = await request(app, 'POST', `/api/projects/${project.id}/messages`, {
      cookie, body: { content: 'Hello project!' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.role, 'user');
    assert.equal(res.body.content, 'Hello project!');
    assert.equal(res.body.agent_id, agent.id); // defaults to coordinator

    // Wait for executor to settle (will fail in test env but message is stored)
    await new Promise(r => setTimeout(r, ASYNC_SETTLE));
  });

  it('reads messages from project conversation', async () => {
    const agent = await createAgent('Coord');
    const project = await createProject({ coordinator_agent_id: agent.id });

    await request(app, 'POST', `/api/projects/${project.id}/messages`, {
      cookie, body: { content: 'First message' },
    });
    await request(app, 'POST', `/api/projects/${project.id}/messages`, {
      cookie, body: { content: 'Second message' },
    });

    await new Promise(r => setTimeout(r, ASYNC_SETTLE));

    const res = await request(app, 'GET', `/api/projects/${project.id}/messages`, { cookie });
    assert.equal(res.status, 200);
    // Should have user messages + error responses from executor
    assert.ok(res.body.length >= 2);
    const userMsgs = res.body.filter(m => m.role === 'user');
    assert.equal(userMsgs.length, 2);
    assert.equal(userMsgs[0].content, 'First message');
    assert.equal(userMsgs[1].content, 'Second message');
  });

  it('messages from multiple agents appear in same conversation', async () => {
    const coord = await createAgent('Coord');
    const worker = await createAgent('Worker');
    const project = await createProject({ coordinator_agent_id: coord.id });

    // Assign worker to project
    await request(app, 'POST', `/api/projects/${project.id}/agents`, {
      cookie, body: { agent_id: worker.id },
    });

    // Post targeting different agents
    await request(app, 'POST', `/api/projects/${project.id}/messages`, {
      cookie, body: { content: 'Task for coord', agent_id: coord.id },
    });
    await request(app, 'POST', `/api/projects/${project.id}/messages`, {
      cookie, body: { content: 'Task for worker', agent_id: worker.id },
    });

    await new Promise(r => setTimeout(r, ASYNC_SETTLE));

    const res = await request(app, 'GET', `/api/projects/${project.id}/messages`, { cookie });
    assert.ok(res.body.length >= 2);

    // Both messages in same conversation
    const conv = getOne('SELECT * FROM conversations WHERE project_id = ?', [project.id]);
    const msgs = res.body.filter(m => m.role === 'user');
    for (const msg of msgs) {
      assert.equal(msg.conversation_id, conv.id);
    }
  });

  it('rejects posting if agent not assigned to project', async () => {
    const coord = await createAgent('Coord');
    const outsider = await createAgent('Outsider');
    const project = await createProject({ coordinator_agent_id: coord.id });

    const res = await request(app, 'POST', `/api/projects/${project.id}/messages`, {
      cookie, body: { content: 'hello', agent_id: outsider.id },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not assigned/);
  });

  it('cannot access other org project conversation', async () => {
    const agent = await createAgent('Coord');
    const project = await createProject({ coordinator_agent_id: agent.id });

    const reg2 = await registerTestUser(app, { email: 'other@test.com', name: 'Other', orgName: 'Other Org' });

    const res = await request(app, 'GET', `/api/projects/${project.id}/messages`, { cookie: reg2.cookie });
    assert.equal(res.status, 404);
  });

  it('defaults to coordinator when no agent_id specified', async () => {
    const coord = await createAgent('Coord');
    const project = await createProject({ coordinator_agent_id: coord.id });

    const res = await request(app, 'POST', `/api/projects/${project.id}/messages`, {
      cookie, body: { content: 'Who responds?' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.agent_id, coord.id);

    await new Promise(r => setTimeout(r, ASYNC_SETTLE));
  });

  it('stores messages with correct conversation_id', async () => {
    const coord = await createAgent('Coord');
    const project = await createProject({ coordinator_agent_id: coord.id });

    await request(app, 'POST', `/api/projects/${project.id}/messages`, {
      cookie, body: { content: 'test' },
    });

    await new Promise(r => setTimeout(r, ASYNC_SETTLE));

    const conv = getOne('SELECT * FROM conversations WHERE project_id = ?', [project.id]);
    const messages = getAll('SELECT * FROM messages WHERE conversation_id = ?', [conv.id]);
    assert.ok(messages.length >= 1);
    assert.equal(messages[0].conversation_id, conv.id);
  });
});
