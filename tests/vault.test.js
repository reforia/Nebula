import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { createApp, resetDb, request, registerTestUser, createTestAgent, DATA_DIR } from './setup.js';

/** Upload a file using raw body (not JSON) */
function uploadFile(app, agentId, filename, content, cookie) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const buf = Buffer.from(content);
      const req = http.request({
        hostname: '127.0.0.1', port,
        path: `/api/agents/${agentId}/vault`,
        method: 'POST',
        headers: {
          'X-Filename': filename,
          'Content-Length': buf.length,
          'Cookie': cookie,
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.write(buf);
      req.end();
    });
  });
}

describe('Vault API', () => {
  let app, cookie, agentId, orgId;

  beforeEach(async () => {
    resetDb();
    app = createApp();
    const reg = await registerTestUser(app);
    cookie = reg.cookie;
    orgId = reg.orgId;
    const agent = await createTestAgent(app, cookie);
    agentId = agent.id;
  });

  describe('GET /api/agents/:id/vault', () => {
    it('returns empty array for new agent', async () => {
      const res = await request(app, 'GET', `/api/agents/${agentId}/vault`, { cookie });
      assert.equal(res.status, 200);
      assert.deepStrictEqual(res.body, []);
    });

    it('returns 404 for nonexistent agent', async () => {
      const res = await request(app, 'GET', '/api/agents/no-such/vault', { cookie });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /api/agents/:id/vault', () => {
    it('uploads a file', async () => {
      const res = await uploadFile(app, agentId, 'test.txt', 'hello world', cookie);
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'test.txt');
      assert.equal(res.body.size, 11);

      // Verify file on disk in org-scoped path
      const filePath = path.join(DATA_DIR, 'orgs', orgId, 'agents', agentId, 'vault', 'test.txt');
      assert.ok(fs.existsSync(filePath));
      assert.equal(fs.readFileSync(filePath, 'utf-8'), 'hello world');
    });

    it('rejects missing filename header', async () => {
      const res = await uploadFile(app, agentId, '', 'data', cookie);
      assert.equal(res.status, 400);
    });

    it('rejects path traversal in filename', async () => {
      const res = await uploadFile(app, agentId, '../../../etc/passwd', 'hack', cookie);
      assert.equal(res.status, 400);
    });

    it('rejects filename with slashes', async () => {
      const res = await uploadFile(app, agentId, 'sub/dir/file.txt', 'data', cookie);
      assert.equal(res.status, 400);
    });
  });

  describe('GET /api/agents/:id/vault (after upload)', () => {
    it('lists uploaded files', async () => {
      await uploadFile(app, agentId, 'a.txt', 'aaa', cookie);
      await uploadFile(app, agentId, 'b.txt', 'bbb', cookie);

      const res = await request(app, 'GET', `/api/agents/${agentId}/vault`, { cookie });
      assert.equal(res.body.length, 2);
      const names = res.body.map(f => f.name).sort();
      assert.deepStrictEqual(names, ['a.txt', 'b.txt']);
    });
  });

  describe('DELETE /api/agents/:id/vault/:filename', () => {
    it('deletes a file', async () => {
      await uploadFile(app, agentId, 'delete-me.txt', 'bye', cookie);

      const res = await request(app, 'DELETE', `/api/agents/${agentId}/vault/delete-me.txt`, { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      // Verify gone from org-scoped path
      const filePath = path.join(DATA_DIR, 'orgs', orgId, 'agents', agentId, 'vault', 'delete-me.txt');
      assert.ok(!fs.existsSync(filePath));
    });

    it('returns 404 for nonexistent file', async () => {
      const res = await request(app, 'DELETE', `/api/agents/${agentId}/vault/no-such-file.txt`, { cookie });
      assert.equal(res.status, 404);
    });

    it('rejects path traversal', async () => {
      const res = await request(app, 'DELETE', `/api/agents/${agentId}/vault/..%2F..%2Fetc%2Fpasswd`, { cookie });
      assert.equal(res.status, 400);
    });
  });

  describe('file overwrite', () => {
    it('overwrites existing file', async () => {
      await uploadFile(app, agentId, 'ow.txt', 'original', cookie);
      await uploadFile(app, agentId, 'ow.txt', 'updated', cookie);

      const filePath = path.join(DATA_DIR, 'orgs', orgId, 'agents', agentId, 'vault', 'ow.txt');
      assert.equal(fs.readFileSync(filePath, 'utf-8'), 'updated');
    });
  });
});
