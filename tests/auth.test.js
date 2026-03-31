import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser, setupAdmin, getOne } from './setup.js';

// Tests run with AUTH_PROVIDER=local (the default)

describe('Auth API (local provider)', () => {
  let app;

  beforeEach(() => {
    resetDb();
    app = createApp();
  });

  // ─── Registration ─────────────────────────────────────────

  describe('POST /api/auth/register', () => {
    it('creates a new user and returns JWT cookies', async () => {
      const res = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com', password: 'testpass123', name: 'Alice' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'alice@example.com');
      assert.equal(res.body.user.name, 'Alice');
      assert.ok(res.body.orgs.length > 0);
      assert.ok(res.body.currentOrgId);
      const cookies = res.headers['set-cookie'];
      assert.ok(cookies?.some(c => c.startsWith('nebula_access=')));
      assert.ok(cookies?.some(c => c.startsWith('nebula_refresh=')));
    });

    it('normalizes email to lowercase', async () => {
      const res = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'Alice@Example.COM', password: 'testpass123', name: 'Alice' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'alice@example.com');
    });

    it('uses email as name when name is not provided', async () => {
      const res = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'noname@example.com', password: 'testpass123' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.name, 'noname@example.com');
    });

    it('creates an org named after the user', async () => {
      const res = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com', password: 'testpass123', name: 'Alice' },
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.orgs[0].name.includes('Alice'));
    });

    it('rejects duplicate email', async () => {
      await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com', password: 'testpass123', name: 'Alice' },
      });
      const res = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com', password: 'testpass123', name: 'Alice2' },
      });
      assert.equal(res.status, 409);
    });

    it('rejects duplicate email case-insensitively', async () => {
      await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com', password: 'testpass123', name: 'Alice' },
      });
      const res = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'ALICE@Example.com', password: 'testpass123', name: 'Alice2' },
      });
      assert.equal(res.status, 409);
    });

    it('rejects short password', async () => {
      const res = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com', password: 'short', name: 'Alice' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects missing email', async () => {
      const res = await request(app, 'POST', '/api/auth/register', {
        body: { password: 'testpass123' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects missing password', async () => {
      const res = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects empty email', async () => {
      const res = await request(app, 'POST', '/api/auth/register', {
        body: { email: '  ', password: 'testpass123' },
      });
      assert.equal(res.status, 400);
    });

    it('stores hashed password, not plaintext', async () => {
      await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com', password: 'testpass123', name: 'Alice' },
      });
      const user = getOne('SELECT * FROM users WHERE email = ?', ['alice@example.com']);
      assert.ok(user.password_hash);
      assert.notEqual(user.password_hash, 'testpass123');
      assert.ok(user.password_hash.startsWith('$2'));
    });
  });

  // ─── Login ────────────────────────────────────────────────

  describe('POST /api/auth/login', () => {
    it('authenticates with valid credentials', async () => {
      await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com', password: 'testpass123', name: 'Alice' },
      });

      const res = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'alice@example.com', password: 'testpass123' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'alice@example.com');
      assert.ok(res.body.currentOrgId);
      const cookies = res.headers['set-cookie'];
      assert.ok(cookies?.some(c => c.startsWith('nebula_access=')));
      assert.ok(cookies?.some(c => c.startsWith('nebula_refresh=')));
    });

    it('login is case-insensitive for email', async () => {
      await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com', password: 'testpass123', name: 'Alice' },
      });

      const res = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'ALICE@Example.COM', password: 'testpass123' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'alice@example.com');
    });

    it('returns all orgs for the user', async () => {
      await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com', password: 'testpass123', name: 'Alice' },
      });

      const res = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'alice@example.com', password: 'testpass123' },
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.orgs));
      assert.ok(res.body.orgs.length >= 1);
    });

    it('rejects wrong password', async () => {
      await request(app, 'POST', '/api/auth/register', {
        body: { email: 'alice@example.com', password: 'testpass123', name: 'Alice' },
      });

      const res = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'alice@example.com', password: 'wrongpass123' },
      });
      assert.equal(res.status, 401);
    });

    it('rejects non-existent user', async () => {
      const res = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'nobody@example.com', password: 'testpass123' },
      });
      assert.equal(res.status, 401);
    });

    it('rejects OAuth-only user trying local login', async () => {
      registerTestUser(app, { email: 'oauth@example.com' });
      const res = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'oauth@example.com', password: 'anything' },
      });
      assert.equal(res.status, 401);
    });

    it('rejects missing email', async () => {
      const res = await request(app, 'POST', '/api/auth/login', {
        body: { password: 'testpass123' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects missing password', async () => {
      const res = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'alice@example.com' },
      });
      assert.equal(res.status, 400);
    });

    it('uses generic error message for wrong email and wrong password', async () => {
      // Should not leak whether email exists
      const res1 = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'nobody@example.com', password: 'testpass123' },
      });
      const res2 = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'nobody@example.com', password: 'wrongpass' },
      });
      assert.equal(res1.body.error, res2.body.error);
    });
  });

  // ─── Full auth flow ───────────────────────────────────────

  describe('register → login → me → logout flow', () => {
    it('completes a full auth lifecycle', async () => {
      // Register
      const regRes = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'flow@example.com', password: 'testpass123', name: 'Flow User' },
      });
      assert.equal(regRes.status, 200);
      const regCookies = regRes.headers['set-cookie'];
      const regCookie = regCookies.map(c => c.split(';')[0]).join('; ');

      // /me with registration cookies
      const meRes = await request(app, 'GET', '/api/auth/me', { cookie: regCookie });
      assert.equal(meRes.status, 200);
      assert.equal(meRes.body.user.email, 'flow@example.com');
      assert.equal(meRes.body.authProvider, 'local');

      // Logout
      const logoutRes = await request(app, 'POST', '/api/auth/logout', { cookie: regCookie });
      assert.equal(logoutRes.status, 200);

      // Login again
      const loginRes = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'flow@example.com', password: 'testpass123' },
      });
      assert.equal(loginRes.status, 200);
      const loginCookies = loginRes.headers['set-cookie'];
      const loginCookie = loginCookies.map(c => c.split(';')[0]).join('; ');

      // /me with login cookies
      const meRes2 = await request(app, 'GET', '/api/auth/me', { cookie: loginCookie });
      assert.equal(meRes2.status, 200);
      assert.equal(meRes2.body.user.email, 'flow@example.com');
    });
  });

  // ─── Token refresh ────────────────────────────────────────

  describe('POST /api/auth/refresh', () => {
    it('refreshes access token using refresh cookie', async () => {
      const { cookie } = registerTestUser(app);
      const res = await request(app, 'POST', '/api/auth/refresh', { cookie });
      assert.equal(res.status, 200);
      assert.ok(res.body.user);
      assert.ok(res.body.orgs);
      assert.ok(res.body.currentOrgId);
    });

    it('rejects without refresh cookie', async () => {
      const res = await request(app, 'POST', '/api/auth/refresh');
      assert.equal(res.status, 401);
    });

    it('rejects invalid refresh token', async () => {
      const res = await request(app, 'POST', '/api/auth/refresh', {
        cookie: 'nebula_refresh=invalid-token',
      });
      assert.equal(res.status, 401);
    });

    it('can switch org via orgId in body', async () => {
      const { cookie, orgId } = registerTestUser(app);
      const res = await request(app, 'POST', '/api/auth/refresh', {
        cookie,
        body: { orgId },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.currentOrgId, orgId);
    });
  });

  // ─── /me endpoint ─────────────────────────────────────────

  describe('GET /api/auth/me', () => {
    it('returns null user without cookie', async () => {
      const res = await request(app, 'GET', '/api/auth/me');
      assert.equal(res.status, 200);
      assert.equal(res.body.user, null);
    });

    it('returns user info with valid cookie', async () => {
      const { cookie, user } = registerTestUser(app);
      const res = await request(app, 'GET', '/api/auth/me', { cookie });
      assert.equal(res.status, 200);
      assert.ok(res.body.user);
      assert.equal(res.body.user.id, user.id);
      assert.ok(res.body.orgs);
      assert.ok(res.body.currentOrgId);
      assert.equal(res.body.authProvider, 'local');
    });

    it('does not include platformUrl or license in local mode', async () => {
      const { cookie } = registerTestUser(app);
      const res = await request(app, 'GET', '/api/auth/me', { cookie });
      assert.equal(res.body.platformUrl, undefined);
      assert.equal(res.body.license, undefined);
    });

    it('returns null user with invalid cookie', async () => {
      const res = await request(app, 'GET', '/api/auth/me', {
        cookie: 'nebula_access=bogus',
      });
      assert.equal(res.body.user, null);
    });
  });

  // ─── Logout ───────────────────────────────────────────────

  describe('POST /api/auth/logout', () => {
    it('clears cookies and returns ok', async () => {
      const cookie = setupAdmin(app);
      const res = await request(app, 'POST', '/api/auth/logout', { cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('cleared cookies prevent auth', async () => {
      const cookie = setupAdmin(app);
      const logoutRes = await request(app, 'POST', '/api/auth/logout', { cookie });
      assert.equal(logoutRes.status, 200);
      const meRes = await request(app, 'GET', '/api/auth/me');
      assert.equal(meRes.body.user, null);
    });
  });

  // ─── Password change ─────────────────────────────────────

  describe('PUT /api/users/me/password', () => {
    it('changes password with valid current password', async () => {
      // Register via local auth
      const regRes = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'pwd@example.com', password: 'oldpass123', name: 'PwdUser' },
      });
      const cookie = regRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');

      // Change password
      const res = await request(app, 'PUT', '/api/users/me/password', {
        cookie,
        body: { currentPassword: 'oldpass123', newPassword: 'newpass456' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      // Login with new password
      const loginRes = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'pwd@example.com', password: 'newpass456' },
      });
      assert.equal(loginRes.status, 200);

      // Old password no longer works
      const oldRes = await request(app, 'POST', '/api/auth/login', {
        body: { email: 'pwd@example.com', password: 'oldpass123' },
      });
      assert.equal(oldRes.status, 401);
    });

    it('rejects wrong current password', async () => {
      const regRes = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'pwd2@example.com', password: 'oldpass123', name: 'PwdUser2' },
      });
      const cookie = regRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');

      const res = await request(app, 'PUT', '/api/users/me/password', {
        cookie,
        body: { currentPassword: 'wrongpass', newPassword: 'newpass456' },
      });
      assert.equal(res.status, 401);
    });

    it('rejects short new password', async () => {
      const regRes = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'pwd3@example.com', password: 'oldpass123', name: 'PwdUser3' },
      });
      const cookie = regRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');

      const res = await request(app, 'PUT', '/api/users/me/password', {
        cookie,
        body: { currentPassword: 'oldpass123', newPassword: 'short' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects for OAuth-only users', async () => {
      const { cookie } = registerTestUser(app); // Creates user with __oauth__ password
      const res = await request(app, 'PUT', '/api/users/me/password', {
        cookie,
        body: { currentPassword: 'anything', newPassword: 'newpass456' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects missing fields', async () => {
      const regRes = await request(app, 'POST', '/api/auth/register', {
        body: { email: 'pwd4@example.com', password: 'oldpass123', name: 'PwdUser4' },
      });
      const cookie = regRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');

      const res = await request(app, 'PUT', '/api/users/me/password', {
        cookie,
        body: { currentPassword: 'oldpass123' },
      });
      assert.equal(res.status, 400);
    });
  });

  // ─── requireAuth middleware ───────────────────────────────

  describe('requireAuth middleware', () => {
    it('blocks unauthenticated API requests with 401', async () => {
      const res = await request(app, 'GET', '/api/agents');
      assert.equal(res.status, 401);
    });

    it('allows authenticated requests', async () => {
      const cookie = setupAdmin(app);
      const res = await request(app, 'GET', '/api/agents', { cookie });
      assert.equal(res.status, 200);
    });
  });

  // ─── OAuth endpoints not available in local mode ──────────

  describe('OAuth endpoints in local mode', () => {
    it('GET /api/auth/login-url is not available in local mode', async () => {
      const res = await request(app, 'GET', '/api/auth/login-url');
      // Route not registered — falls through to requireAuth on other routes or 401
      assert.ok([401, 404].includes(res.status), `Expected 401 or 404, got ${res.status}`);
    });

    it('GET /api/auth/callback is not available in local mode', async () => {
      const res = await request(app, 'GET', '/api/auth/callback?code=test&state=test');
      assert.ok([401, 404].includes(res.status), `Expected 401 or 404, got ${res.status}`);
    });
  });
});
