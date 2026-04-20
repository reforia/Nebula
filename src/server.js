// Prerequisites loaded from .env via `node --env-file-if-exists=.env` in
// package.json scripts. Hard requirements validated on first import:
//   - NEBULA_ENCRYPTION_KEY (src/utils/crypto.js — throws if missing/invalid)
// See README "Quick Start" for the one-liner to generate and install the key.
import express from 'express';
import http from 'http';
import path from 'path';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';

import './db.js'; // Initialize database on import
import { initWebSocket, handleUpgrade } from './services/websocket.js';
import { initRemoteWebSocket, handleRemoteUpgrade } from './services/remote-agents.js';
import { initScheduler } from './services/scheduler.js';
import { initBackupScheduler } from './services/backup.js';
import executor from './services/executor.js';
import { registry } from './backends/index.js';
import { broadcastToOrg } from './services/websocket.js';
import { rateLimit } from './utils/rate-limit.js';

import authRouter, { jwtMiddleware, requireAuth } from './routes/auth.js';
import agentsRouter from './routes/agents.js';
import messagesRouter from './routes/messages.js';
import tasksRouter, { agentTasksRouter } from './routes/tasks.js';
import conversationsRouter, { agentConversationsRouter } from './routes/conversations.js';
import systemRouter from './routes/system.js';
import mailRouter from './routes/mail.js';
import webhookRouter from './routes/webhooks.js';
import orgsRouter from './routes/orgs.js';
import usersRouter from './routes/users.js';
import skillsRouter, { agentSkillsRouter } from './routes/skills.js';
import mcpServersRouter, { agentMcpServersRouter } from './routes/mcp-servers.js';
import projectsRouter, { projectWebhooksRouter } from './routes/projects.js';
import memorySearchRouter, { agentMemoryRouter, projectMemoryRouter } from './routes/memories.js';
import templatesRouter from './routes/templates.js';
import setupRouter from './routes/setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8080', 10);

const app = express();
const server = http.createServer(app);

// Middleware — skip JSON parsing for binary uploads (vault, image uploads)
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path.match(/^\/api\/agents\/[^/]+\/(vault|uploads)$/)) {
    return next();
  }
  // Preserve raw body for webhook signature verification
  const verify = req.path.startsWith('/api/webhooks/')
    ? (req, _res, buf) => { req.rawBody = buf; }
    : undefined;
  express.json({ limit: '1mb', verify })(req, res, next);
});
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.removeHeader('X-Powered-By');
  next();
});

app.use(jwtMiddleware);

// Public routes (no auth required)
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, maxRequests: 20 }), authRouter);
app.use('/api/setup', setupRouter);
app.use('/api/webhooks', webhookRouter);
app.use('/api/project-webhooks', projectWebhooksRouter);

// Protected API routes
app.use('/api/orgs', requireAuth, orgsRouter);
app.use('/api/users', requireAuth, usersRouter);
app.use('/api/skills', requireAuth, skillsRouter);
app.use('/api/agents', requireAuth, agentsRouter);
app.use('/api/agents', requireAuth, messagesRouter);
app.use('/api/agents', requireAuth, agentTasksRouter);
app.use('/api/agents', requireAuth, agentConversationsRouter);
app.use('/api/agents', requireAuth, agentSkillsRouter);
app.use('/api/mcp-servers', requireAuth, mcpServersRouter);
app.use('/api/agents', requireAuth, agentMcpServersRouter);
app.use('/api/agents', requireAuth, agentMemoryRouter);
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/projects', requireAuth, projectMemoryRouter);
app.use('/api/memory', requireAuth, memorySearchRouter);
app.use('/api/conversations', requireAuth, conversationsRouter);
app.use('/api/tasks', requireAuth, tasksRouter);
app.use('/api/mail', requireAuth, mailRouter);
app.use('/api/templates', requireAuth, templatesRouter);
app.use('/api', requireAuth, systemRouter);

// Serve frontend static files
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// Initialize WebSocket servers (noServer mode — manual upgrade routing)
initWebSocket();
initRemoteWebSocket();

// Route HTTP upgrade requests to the correct WebSocket server
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws') {
    handleUpgrade(req, socket, head);
  } else if (pathname === '/ws/remote') {
    handleRemoteUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// Wire executor events to WebSocket
executor.on('agent_typing', ({ agentId, orgId, conversationId, active, projectId, branchName }) => {
  if (orgId) {
    const msg = { type: 'agent_typing', agent_id: agentId, conversation_id: conversationId, active };
    if (projectId) msg.project_id = projectId;
    if (branchName) msg.branch_name = branchName;
    broadcastToOrg(orgId, msg);
  }
});

// Startup: run adapter recovery and reset stale sessions
import fs from 'fs';
import crypto from 'crypto';
import { getAll, run as dbRun } from './db.js';
(() => {
  // Let each adapter perform startup recovery (e.g. restore config from backups)
  for (const adapter of registry.getAll()) {
    try { adapter.startupRecover(); } catch (err) { console.warn('[startup] Recovery failed for', adapter.cliId, ':', err.message); }
  }

  // Reset sessions whose runtime state no longer exists on disk
  const initialized = getAll(
    'SELECT c.id, c.session_id, c.agent_id, a.backend FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.session_initialized = 1'
  );
  let resetCount = 0;
  for (const conv of initialized) {
    const backend = conv.backend ? registry.getAll().find(a => a.cliId === conv.backend) : null;
    // If we can identify the adapter, ask it; otherwise skip (don't reset unknown backends)
    if (backend && !backend.sessionExists(conv.session_id)) {
      const newId = crypto.randomUUID();
      dbRun('UPDATE conversations SET session_id = ?, session_initialized = 0 WHERE id = ?', [newId, conv.id]);
      resetCount++;
    }
  }
  if (resetCount > 0) console.log(`[startup] Reset ${resetCount} stale session(s)`);
})();

// Migrate file-based memories to DB (one-time), then build search index
import { migrateFileMemories } from './services/memory-migration.js';
import { rebuildAllIndices } from './services/memory-search.js';
migrateFileMemories();
rebuildAllIndices();

// Start scheduler, backup service, and license checker
initScheduler();
initBackupScheduler();

import { startLicenseChecker } from './services/license.js';
startLicenseChecker();

import { initCleanupService } from './services/cleanup.js';
initCleanupService();

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[nebula] Server running on http://0.0.0.0:${PORT}`);
});
