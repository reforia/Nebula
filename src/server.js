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
import { broadcastToOrg } from './services/websocket.js';

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
app.use(jwtMiddleware);

// Public routes (no auth required)
app.use('/api/auth', authRouter);
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

// Startup: restore CC config if missing, reset stale sessions
import fs from 'fs';
import crypto from 'crypto';
import { getAll, run as dbRun } from './db.js';
(() => {
  const home = process.env.HOME || '/home/node';
  const configPath = path.join(home, '.claude.json');
  const backupDir = path.join(home, '.claude', 'backups');
  // Restore .claude.json from latest backup if missing
  if (!fs.existsSync(configPath) && fs.existsSync(backupDir)) {
    const backups = fs.readdirSync(backupDir).filter(f => f.startsWith('.claude.json.backup.')).sort();
    if (backups.length > 0) {
      const latest = backups[backups.length - 1];
      fs.copyFileSync(path.join(backupDir, latest), configPath);
      console.log(`[startup] Restored ${configPath} from ${latest}`);
    }
  }
  // Reset sessions whose CC state no longer exists
  const initialized = getAll('SELECT id, session_id, agent_id FROM conversations WHERE session_initialized = 1');
  const projectsDir = path.join(home, '.claude', 'projects');
  let resetCount = 0;
  for (const conv of initialized) {
    // Check if session exists in CC's projects directory
    let found = false;
    if (fs.existsSync(projectsDir)) {
      for (const dir of fs.readdirSync(projectsDir)) {
        const sessionFile = path.join(projectsDir, dir, `${conv.session_id}.jsonl`);
        if (fs.existsSync(sessionFile)) { found = true; break; }
      }
    }
    if (!found) {
      const newId = crypto.randomUUID();
      dbRun('UPDATE conversations SET session_id = ?, session_initialized = 0 WHERE id = ?', [newId, conv.id]);
      resetCount++;
    }
  }
  if (resetCount > 0) console.log(`[startup] Reset ${resetCount} stale CC session(s)`);
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
