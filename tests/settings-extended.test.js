import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser, getOrgSetting, setOrgSetting } from './setup.js';

describe('Extended Settings', () => {
  let app, cookie, orgId;

  beforeEach(async () => {
    resetDb();
    app = createApp();
    const reg = await registerTestUser(app);
    cookie = reg.cookie;
    orgId = reg.orgId;
  });

  describe('IMAP settings', () => {
    it('has default IMAP settings', async () => {
      const res = await request(app, 'GET', '/api/settings', { cookie });
      assert.equal(res.body.imap_host, '');
      assert.equal(res.body.imap_port, '993');
      assert.equal(res.body.mail_enabled, '0');
    });

    it('can update IMAP settings', async () => {
      await request(app, 'PUT', '/api/settings', {
        cookie,
        body: { imap_host: 'imap.test.com', imap_port: '993', mail_enabled: '1' },
      });
      assert.equal(getOrgSetting(orgId, 'imap_host'), 'imap.test.com');
      assert.equal(getOrgSetting(orgId, 'mail_enabled'), '1');
    });

    it('masks imap_pass in GET', async () => {
      setOrgSetting(orgId, 'imap_pass', 'secret123');
      const res = await request(app, 'GET', '/api/settings', { cookie });
      assert.equal(res.body.imap_pass, '********');
    });

    it('does not overwrite imap_pass when masked value sent', async () => {
      setOrgSetting(orgId, 'imap_pass', 'real_password');
      await request(app, 'PUT', '/api/settings', {
        cookie,
        body: { imap_pass: '********' },
      });
      assert.equal(getOrgSetting(orgId, 'imap_pass'), 'real_password');
    });
  });

  describe('internal API token', () => {
    it('generates internal_api_token on registration', () => {
      const token = getOrgSetting(orgId, 'internal_api_token');
      assert.ok(token);
      assert.equal(token.length, 36);
    });
  });

  describe('NAS paths on agents', () => {
    it('defaults to empty array', async () => {
      const agent = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'NasBot' },
      });
      const detail = await request(app, 'GET', `/api/agents/${agent.body.id}`, { cookie });
      assert.equal(detail.body.nas_paths, '[]');
    });

    it('can set NAS paths', async () => {
      const agent = await request(app, 'POST', '/api/agents', {
        cookie,
        body: { name: 'NasBot2' },
      });
      const res = await request(app, 'PUT', `/api/agents/${agent.body.id}`, {
        cookie,
        body: { nas_paths: ['/mnt/nas/projects', '/mnt/nas/data'] },
      });
      const parsed = JSON.parse(res.body.nas_paths);
      assert.deepStrictEqual(parsed, ['/mnt/nas/projects', '/mnt/nas/data']);
    });
  });
});
