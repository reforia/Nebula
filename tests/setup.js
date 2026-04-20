import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';

// Create an isolated temp DATA_DIR for each test run
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-test-'));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = 'test';
// Deterministic test key (never used outside the test runner — do not reuse).
// Must be set before any module import that transitively loads src/utils/crypto.js.
process.env.NEBULA_ENCRYPTION_KEY ||=
  '0000000000000000000000000000000000000000000000000000000000000001';

// Now safe to import modules that depend on DATA_DIR
const { getAll, getOne, run, getSetting, setSetting, getOrgSetting, setOrgSetting, db, DATA_DIR } = await import('../src/db.js');
const { generateId } = await import('../src/utils/uuid.js');
const { generateAccessToken, generateRefreshToken } = await import('../src/utils/jwt.js');
const authModule = await import('../src/routes/auth.js');
const agentsRouter = (await import('../src/routes/agents.js')).default;
const messagesRouter = (await import('../src/routes/messages.js')).default;
const tasksModule = await import('../src/routes/tasks.js');
const tasksRouter = tasksModule.default;
const { agentTasksRouter } = tasksModule;
const conversationsModule = await import('../src/routes/conversations.js');
const conversationsRouter = conversationsModule.default;
const { agentConversationsRouter } = conversationsModule;
const systemRouter = (await import('../src/routes/system.js')).default;
const mailRouter = (await import('../src/routes/mail.js')).default;
const webhookRouter = (await import('../src/routes/webhooks.js')).default;
const orgsRouter = (await import('../src/routes/orgs.js')).default;
const usersRouter = (await import('../src/routes/users.js')).default;
const { stopAll: stopAllCrons } = await import('../src/services/scheduler.js');
const skillsModule = await import('../src/routes/skills.js');
const skillsRouter = skillsModule.default;
const { agentSkillsRouter } = skillsModule;
const mcpModule = await import('../src/routes/mcp-servers.js');
const mcpServersRouter = mcpModule.default;
const { agentMcpServersRouter } = mcpModule;
const projectsModule = await import('../src/routes/projects.js');
const projectsRouter = projectsModule.default;
const { projectWebhooksRouter } = projectsModule;
const setupRouter = (await import('../src/routes/setup.js')).default;
const { initOrgDirectories } = await import('../src/db.js');

const authRouter = authModule.default;
const { jwtMiddleware, requireAuth } = authModule;

/** Build a fresh Express app wired like server.js but without listener */
export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(jwtMiddleware);

  // Public routes
  app.use('/api/auth', authRouter);
  app.use('/api/setup', setupRouter);
  app.use('/api/webhooks', webhookRouter);
  app.use('/api/project-webhooks', projectWebhooksRouter);

  // Protected routes
  app.use('/api/orgs', requireAuth, orgsRouter);
  app.use('/api/users', requireAuth, usersRouter);
  app.use('/api/agents', requireAuth, agentsRouter);
  app.use('/api/agents', requireAuth, messagesRouter);
  app.use('/api/agents', requireAuth, agentTasksRouter);
  app.use('/api/agents', requireAuth, agentConversationsRouter);
  app.use('/api/agents', requireAuth, agentSkillsRouter);
  app.use('/api/agents', requireAuth, agentMcpServersRouter);
  app.use('/api/skills', requireAuth, skillsRouter);
  app.use('/api/mcp-servers', requireAuth, mcpServersRouter);
  app.use('/api/projects', requireAuth, projectsRouter);
  app.use('/api/conversations', requireAuth, conversationsRouter);
  app.use('/api/tasks', requireAuth, tasksRouter);
  app.use('/api/mail', requireAuth, mailRouter);
  app.use('/api', requireAuth, systemRouter);

  return app;
}

/** Reset DB state between tests */
export function resetDb() {
  stopAllCrons();
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM tasks');
  db.exec('DELETE FROM conversations');
  db.exec('DELETE FROM project_deliverables');
  db.exec('DELETE FROM project_milestones');
  db.exec('DELETE FROM project_agents');
  db.exec('DELETE FROM project_checklist');
  db.exec('DELETE FROM project_secrets');
  db.exec('DELETE FROM project_links');
  db.exec('DELETE FROM projects');
  db.exec('DELETE FROM usage_events');
  db.exec('DELETE FROM agent_secrets');
  db.exec('DELETE FROM mcp_servers');
  db.exec('DELETE FROM custom_skills');
  db.exec('DELETE FROM agents');
  db.exec('DELETE FROM org_settings');
  db.exec('DELETE FROM organizations');
  db.exec('DELETE FROM users');
  db.exec("DELETE FROM settings WHERE key = 'setup_completed'");
}

/** Make HTTP request against an Express app, returns {status, headers, body} */
export function request(app, method, url, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const reqHeaders = { 'Content-Type': 'application/json', ...headers };
      if (cookie) reqHeaders['Cookie'] = cookie;

      const payload = body ? JSON.stringify(body) : undefined;
      if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);

      const req = http.request(
        { hostname: '127.0.0.1', port, path: url, method, headers: reqHeaders },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            server.close();
            let parsed;
            try { parsed = JSON.parse(data); } catch { parsed = data; }
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: parsed,
            });
          });
        }
      );
      req.on('error', (err) => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

/**
 * Create a test user directly in the DB (no HTTP registration).
 * Returns { cookie, user, org, orgId } — same shape as the old registerTestUser.
 */
export function registerTestUser(app, overrides = {}) {
  const userId = generateId();
  const email = overrides.email || `test-${Date.now()}@example.com`;
  const name = overrides.name || 'Test User';
  const platformUserId = overrides.platformUserId || `plat-${userId}`;

  run(
    'INSERT INTO users (id, email, name, password_hash, platform_user_id) VALUES (?, ?, ?, ?, ?)',
    [userId, email.toLowerCase(), name, '__oauth__', platformUserId]
  );

  const orgId = generateId();
  const orgName = overrides.orgName || 'Test Org';
  run('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)', [orgId, orgName, userId]);

  initOrgDirectories(orgId);
  const defaultSettings = {
    internal_api_token: crypto.randomUUID(),
    smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', smtp_from: '',
    notify_email_to: '', notifications_enabled: '0',
    imap_host: '', imap_port: '993', imap_user: '', imap_pass: '', mail_enabled: '0',
  };
  for (const [k, v] of Object.entries(defaultSettings)) {
    setOrgSetting(orgId, k, v);
  }

  const accessToken = generateAccessToken({ userId, orgId, email: email.toLowerCase() });
  const refreshToken = generateRefreshToken({ userId, email: email.toLowerCase() });

  const cookie = `nebula_access=${accessToken}; nebula_refresh=${refreshToken}`;
  const user = { id: userId, email: email.toLowerCase(), name };
  const org = { id: orgId, name: orgName, owner_id: userId };

  return { cookie, user, org, orgId };
}

/** Legacy alias */
export function setupAdmin(app, password) {
  const { cookie } = registerTestUser(app);
  return cookie;
}

/** Create a test agent and return its data */
export async function createTestAgent(app, cookie, overrides = {}) {
  const res = await request(app, 'POST', '/api/agents', {
    cookie,
    body: { name: `TestBot-${Date.now()}`, ...overrides },
  });
  return res.body;
}

export { getAll, getOne, run, getSetting, setSetting, getOrgSetting, setOrgSetting, db, DATA_DIR };
