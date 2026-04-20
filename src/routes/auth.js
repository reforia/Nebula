import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getOne, getAll, run, initOrgDirectories, seedDefaultOrgSettings, db } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken, setTokenCookies, clearTokenCookies } from '../utils/jwt.js';
import { extractAndSaveLicenseFromUserinfo, getLicenseStatus } from '../services/license.js';
import { sendError, catchError } from '../utils/response.js';

const AUTH_PROVIDER = process.env.AUTH_PROVIDER || 'local';
const router = Router();

// ─── Middleware (unchanged) ──────────────────────────────────

export function jwtMiddleware(req, res, next) {
  const accessToken = req.cookies?.nebula_access;
  if (accessToken) {
    try {
      const payload = verifyAccessToken(accessToken);
      req.user = { id: payload.userId, email: payload.email };
      req.orgId = payload.orgId;
      return next();
    } catch {
      // Token expired or invalid
    }
  }

  // Internal API token (agent self-service)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7);
    const org = getOne(
      "SELECT org_id FROM org_settings WHERE key = 'internal_api_token' AND value = ?",
      [bearer]
    );
    if (org) {
      req.user = { id: '__internal__', email: 'internal' };
      req.orgId = org.org_id;
      return next();
    }
  }

  req.user = null;
  req.orgId = null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user || !req.orgId) {
    const fullPath = req.originalUrl || req.path;
    if (fullPath.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login');
  }
  next();
}

// ─── OAuth2 endpoints (enigma provider only) ────────────────

if (AUTH_PROVIDER === 'enigma') {
  // Lazy-import oauth module only when needed
  const { generateAuthUrl, exchangeCode, getUserInfo, getRedirectUri, PLATFORM_URL } = await import('../services/oauth.js');

  // GET /api/auth/login-url — generate Platform authorize URL with PKCE
  router.get('/login-url', (req, res) => {
    try {
      const redirectUri = getRedirectUri(req);
      const { url, state, codeVerifier } = generateAuthUrl(redirectUri);

      const cookieOpts = {
        httpOnly: true,
        sameSite: 'lax',
        path: '/api/auth',
        maxAge: 10 * 60 * 1000,
      };
      res.cookie('oauth_state', state, cookieOpts);
      res.cookie('oauth_verifier', codeVerifier, cookieOpts);

      res.json({ url, platformUrl: PLATFORM_URL });
    } catch (err) {
      catchError(res, 503, 'Failed to generate login URL', err);
    }
  });

  // GET /api/auth/callback — OAuth2 callback from Platform
  router.get('/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      return res.redirect(`/login?error=${encodeURIComponent(oauthError)}`);
    }

    const storedState = req.cookies?.oauth_state;
    const storedVerifier = req.cookies?.oauth_verifier;

    res.clearCookie('oauth_state', { path: '/api/auth' });
    res.clearCookie('oauth_verifier', { path: '/api/auth' });

    if (!code || !state || !storedState || state !== storedState || !storedVerifier) {
      return res.redirect('/login?error=state_mismatch');
    }

    try {
      const redirectUri = getRedirectUri(req);
      const tokens = await exchangeCode(code, storedVerifier, redirectUri);
      const userinfo = await getUserInfo(tokens.access_token);
      if (!userinfo?.id || !userinfo?.email) {
        return res.redirect('/login?error=invalid_userinfo');
      }

      db.exec('BEGIN IMMEDIATE');

      let user;
      try {
        user = getOne('SELECT * FROM users WHERE platform_user_id = ?', [userinfo.id]);

        if (user) {
          if (user.email !== userinfo.email || user.name !== userinfo.name) {
            run("UPDATE users SET email = ?, name = ?, updated_at = datetime('now') WHERE id = ?",
              [userinfo.email, userinfo.name, user.id]);
            user.email = userinfo.email;
            user.name = userinfo.name;
          }
        } else {
          user = getOne('SELECT * FROM users WHERE email = ?', [userinfo.email.toLowerCase()]);

          if (user) {
            run("UPDATE users SET platform_user_id = ?, name = ?, updated_at = datetime('now') WHERE id = ?",
              [userinfo.id, userinfo.name, user.id]);
            user.platform_user_id = userinfo.id;
          } else {
            const userId = generateId();
            run(
              'INSERT INTO users (id, email, name, password_hash, platform_user_id) VALUES (?, ?, ?, ?, ?)',
              [userId, userinfo.email.toLowerCase(), userinfo.name, '__oauth__', userinfo.id]
            );
            user = { id: userId, email: userinfo.email.toLowerCase(), name: userinfo.name };
          }
        }

        let org = getOne('SELECT * FROM organizations WHERE owner_id = ?', [user.id]);
        if (!org) {
          const orgId = generateId();
          run('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)',
            [orgId, `${userinfo.name}'s Workspace`, user.id]);
          org = { id: orgId };

          initOrgDirectories(orgId);
          seedDefaultOrgSettings(orgId);
        }

        db.exec('COMMIT');

        extractAndSaveLicenseFromUserinfo(userinfo);

        const accessToken = generateAccessToken({ userId: user.id, orgId: org.id, email: user.email });
        const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });
        setTokenCookies(res, accessToken, refreshToken);

        res.redirect('/');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }
    } catch (err) {
      console.error('[auth] OAuth callback error:', err);
      res.redirect(`/login?error=${encodeURIComponent('authentication_failed')}`);
    }
  });
}

// ─── Local auth endpoints (local provider only) ─────────────

if (AUTH_PROVIDER === 'local') {
  // POST /api/auth/register — create a new local account
  router.post('/register', (req, res) => {
    const { email, password, name, orgName } = req.body;

    if (!email?.trim() || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = getOne('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const userId = generateId();
    const passwordHash = bcrypt.hashSync(password, 10);

    db.exec('BEGIN IMMEDIATE');
    try {
      run(
        'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)',
        [userId, normalizedEmail, (name || '').trim() || normalizedEmail, passwordHash]
      );

      const orgId = generateId();
      run('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)',
        [orgId, orgName?.trim() || `${(name || normalizedEmail).trim()}'s Workspace`, userId]);

      initOrgDirectories(orgId);
      seedDefaultOrgSettings(orgId);

      db.exec('COMMIT');

      const accessToken = generateAccessToken({ userId, orgId, email: normalizedEmail });
      const refreshToken = generateRefreshToken({ userId, email: normalizedEmail });
      setTokenCookies(res, accessToken, refreshToken);

      res.json({
        user: { id: userId, email: normalizedEmail, name: (name || '').trim() || normalizedEmail },
        orgs: [{ id: orgId, name: orgName?.trim() || `${(name || normalizedEmail).trim()}'s Workspace`, owner_id: userId }],
        currentOrgId: orgId,
      });
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      console.error('[auth] Registration error:', err);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // POST /api/auth/login — authenticate with email/password
  router.post('/login', (req, res) => {
    const { email, password } = req.body;

    if (!email?.trim() || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = getOne('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    if (!user || user.password_hash === '__oauth__') {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const org = getOne('SELECT * FROM organizations WHERE owner_id = ? ORDER BY created_at ASC LIMIT 1', [user.id]);
    if (!org) {
      return res.status(500).json({ error: 'No organization found' });
    }

    const accessToken = generateAccessToken({ userId: user.id, orgId: org.id, email: user.email });
    const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });
    setTokenCookies(res, accessToken, refreshToken);

    const orgs = getAll('SELECT id, name, owner_id, created_at FROM organizations WHERE owner_id = ?', [user.id]);

    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      orgs,
      currentOrgId: org.id,
    });
  });
}

// ─── Token management (unchanged) ───────────────────────────

router.post('/refresh', (req, res) => {
  const refreshCookie = req.cookies?.nebula_refresh;
  if (!refreshCookie) return res.status(401).json({ error: 'No refresh token' });

  let payload;
  try {
    payload = verifyRefreshToken(refreshCookie);
  } catch {
    clearTokenCookies(res);
    return res.status(401).json({ error: 'Invalid refresh token' });
  }

  const user = getOne('SELECT * FROM users WHERE id = ?', [payload.userId]);
  if (!user) {
    clearTokenCookies(res);
    return res.status(401).json({ error: 'User not found' });
  }

  let orgId = req.body?.orgId;
  if (orgId) {
    const org = getOne('SELECT id FROM organizations WHERE id = ? AND owner_id = ?', [orgId, user.id]);
    if (!org) return res.status(403).json({ error: 'Organization not found or not owned by user' });
  } else {
    const firstOrg = getOne('SELECT id FROM organizations WHERE owner_id = ? ORDER BY created_at ASC LIMIT 1', [user.id]);
    orgId = firstOrg?.id;
    if (!orgId) return res.status(500).json({ error: 'No organizations found' });
  }

  const accessToken = generateAccessToken({ userId: user.id, orgId, email: user.email });
  res.cookie('nebula_access', accessToken, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000,
  });

  const orgs = getAll('SELECT id, name, owner_id, created_at FROM organizations WHERE owner_id = ?', [user.id]);

  res.json({
    user: { id: user.id, email: user.email, name: user.name },
    orgs,
    currentOrgId: orgId,
  });
});

router.get('/me', (req, res) => {
  if (!req.user || !req.orgId) {
    return res.json({ user: null, orgs: [], currentOrgId: null });
  }

  if (req.user.id === '__internal__') {
    return res.json({ user: req.user, orgs: [], currentOrgId: req.orgId });
  }

  const user = getOne('SELECT id, email, name FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.json({ user: null, orgs: [], currentOrgId: null });

  const orgs = getAll('SELECT id, name, owner_id, created_at FROM organizations WHERE owner_id = ?', [user.id]);

  const resp = { user, orgs, currentOrgId: req.orgId, authProvider: AUTH_PROVIDER };

  if (AUTH_PROVIDER === 'enigma') {
    const lic = getLicenseStatus();
    resp.license = lic ? {
      plan: lic.plan || null,
      plan_name: lic.plan_name || null,
      max_agents: lic.max_agents ?? null,
      max_seats: lic.max_seats ?? null,
      expires_at: lic.expires_at || null,
    } : null;
    resp.platformUrl = process.env.PLATFORM_URL || 'https://dev.enigmaetmt.com:9443';
  }

  res.json(resp);
});

router.post('/logout', (req, res) => {
  clearTokenCookies(res);
  res.json({ ok: true });
});

export default router;
