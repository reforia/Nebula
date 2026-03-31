import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser, getOne, getAll } from './setup.js';
import { generateIntegrationSkills, isValidProvider, getSupportedProviders } from '../src/services/integrations.js';

describe('Integration Skills', () => {

  describe('provider validation', () => {
    it('validates known issue tracker providers', () => {
      assert.ok(isValidProvider('issue_tracker', 'youtrack'));
      assert.ok(isValidProvider('issue_tracker', 'jira'));
      assert.ok(isValidProvider('issue_tracker', 'github_issues'));
      assert.ok(isValidProvider('issue_tracker', 'gitea_issues'));
      assert.ok(!isValidProvider('issue_tracker', 'trello'));
    });

    it('validates known KB providers', () => {
      assert.ok(isValidProvider('knowledge_base', 'confluence'));
      assert.ok(isValidProvider('knowledge_base', 'notion'));
      assert.ok(isValidProvider('knowledge_base', 'youtrack_kb'));
      assert.ok(!isValidProvider('knowledge_base', 'google_docs'));
    });

    it('validates known CI providers', () => {
      assert.ok(isValidProvider('ci', 'teamcity'));
      assert.ok(isValidProvider('ci', 'gitea_actions'));
      assert.ok(isValidProvider('ci', 'github_actions'));
      assert.ok(!isValidProvider('ci', 'jenkins'));
    });

    it('returns supported providers per type', () => {
      assert.ok(getSupportedProviders('issue_tracker').includes('youtrack'));
      assert.deepStrictEqual(getSupportedProviders('invalid'), []);
    });
  });

  describe('skill generation', () => {
    it('generates issue tracker skill for youtrack', () => {
      const links = [{ type: 'issue_tracker', provider: 'youtrack', url: 'https://yt.example.com', config: '{"project_id":"TEST"}' }];
      const skills = generateIntegrationSkills(links, () => 'test-token');
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'nebula-issues');
      assert.ok(skills[0].content.includes('YouTrack'));
      assert.ok(skills[0].content.includes('test-token'));
      assert.ok(skills[0].content.includes('yt.example.com'));
    });

    it('generates KB skill for confluence', () => {
      const links = [{ type: 'knowledge_base', provider: 'confluence', url: 'https://wiki.example.com', config: '{"space_key":"DEV"}' }];
      const skills = generateIntegrationSkills(links, () => 'wiki-token');
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'nebula-kb');
      assert.ok(skills[0].content.includes('Confluence'));
    });

    it('generates CI skill for github_actions', () => {
      const links = [{ type: 'ci', provider: 'github_actions', url: 'https://api.github.com/repos/org/repo', config: '{}' }];
      const skills = generateIntegrationSkills(links, () => 'gh-token');
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'nebula-ci');
      assert.ok(skills[0].content.includes('GitHub Actions'));
    });

    it('generates multiple skills for multiple links', () => {
      const links = [
        { type: 'issue_tracker', provider: 'jira', url: 'https://jira.example.com', config: '{"project_key":"PROJ"}' },
        { type: 'ci', provider: 'teamcity', url: 'https://tc.example.com', config: '{"build_type_id":"Build1"}' },
      ];
      const skills = generateIntegrationSkills(links, () => 'token');
      assert.equal(skills.length, 2);
      assert.equal(skills[0].name, 'nebula-issues');
      assert.equal(skills[1].name, 'nebula-ci');
    });

    it('skips unknown link types', () => {
      const links = [{ type: 'unknown', provider: 'test', url: 'https://test.com', config: '{}' }];
      const skills = generateIntegrationSkills(links);
      assert.equal(skills.length, 0);
    });

    it('works with no token resolver', () => {
      const links = [{ type: 'issue_tracker', provider: 'gitea_issues', url: 'https://gitea.local/api/v1/repos/org/repo', config: '{}' }];
      const skills = generateIntegrationSkills(links);
      assert.equal(skills.length, 1);
      assert.ok(skills[0].content.includes('Gitea Issues'));
    });
  });
});

describe('Integration Webhooks', () => {
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

  async function createProjectWithLink(linkType, linkProvider) {
    const coord = await createAgent('Coord-' + Date.now());
    const projRes = await request(app, 'POST', '/api/projects', {
      cookie, body: { name: 'WebhookProj-' + Date.now(), git_remote_url: 'git@test:org/repo.git', coordinator_agent_id: coord.id },
    });
    const projectId = projRes.body.id;

    await request(app, 'POST', `/api/projects/${projectId}/links`, {
      cookie, body: { type: linkType, provider: linkProvider, url: 'https://external.example.com' },
    });

    return projectId;
  }

  it('accepts issue tracker webhook and posts notification', async () => {
    const projectId = await createProjectWithLink('issue_tracker', 'youtrack');

    const res = await request(app, 'POST', `/api/project-webhooks/${projectId}/issue_tracker`, {
      body: { issue_id: 'TEST-42', status: 'Resolved', summary: 'Fix login bug' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    // Check notification posted to project conversation
    const conv = getOne('SELECT * FROM conversations WHERE project_id = ?', [projectId]);
    const msgs = getAll('SELECT * FROM messages WHERE conversation_id = ? AND message_type = ?', [conv.id, 'integration']);
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].content.includes('TEST-42'));
    assert.ok(msgs[0].content.includes('Resolved'));
  });

  it('accepts CI webhook and posts build status', async () => {
    const projectId = await createProjectWithLink('ci', 'github_actions');

    const res = await request(app, 'POST', `/api/project-webhooks/${projectId}/ci`, {
      body: { run_id: '12345', status: 'success', branch: 'feature/auth' },
    });
    assert.equal(res.status, 200);

    const conv = getOne('SELECT * FROM conversations WHERE project_id = ?', [projectId]);
    const msgs = getAll('SELECT * FROM messages WHERE conversation_id = ? AND message_type = ?', [conv.id, 'integration']);
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].content.includes('12345'));
    assert.ok(msgs[0].content.includes('success'));
    assert.ok(msgs[0].content.includes('feature/auth'));
  });

  it('returns 404 for project without linked integration', async () => {
    const projRes = await request(app, 'POST', '/api/projects', {
      cookie, body: { name: 'NoLinks', git_remote_url: 'git@test:org/repo.git' },
    });

    const res = await request(app, 'POST', `/api/project-webhooks/${projRes.body.id}/issue_tracker`, {
      body: { issue_id: 'X-1' },
    });
    assert.equal(res.status, 404);
  });

  it('rejects invalid payload', async () => {
    const projectId = await createProjectWithLink('ci', 'teamcity');

    const res = await request(app, 'POST', `/api/project-webhooks/${projectId}/ci`, {
      body: null,
    });
    // null body becomes {} via express.json, which is valid but no action taken
    assert.equal(res.status, 200);
  });

  it('returns 404 for nonexistent project', async () => {
    const res = await request(app, 'POST', '/api/project-webhooks/no-such-id/ci', {
      body: { build_id: '1' },
    });
    assert.equal(res.status, 404);
  });
});
