import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getAll, getOne, run, orgPath, db } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { encrypt } from '../utils/crypto.js';
import { isRemoteConnected, getRemoteDevice } from '../services/remote-agents.js';
import { registry } from '../backends/index.js';
import { buildUpdate } from '../utils/update-builder.js';
import { checkSecretDeletable } from '../services/secret-refs.js';
import { requireAgentInOrg } from '../utils/route-guards.js';
import { createAgent } from '../services/agent-creation.js';
import { upsertSecret } from '../utils/secret-upsert.js';
import { sendError } from '../utils/response.js';

const router = Router();

// GET /api/agents — list all agents for current org
router.get('/', (req, res) => {
  const agents = getAll(`
    SELECT a.*,
      (SELECT COUNT(*) FROM messages m WHERE m.agent_id = a.id AND m.is_read = 0 AND m.role = 'assistant' AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.conversation_id AND c.project_id IS NOT NULL)) as unread_count,
      (SELECT content FROM messages m2 WHERE m2.agent_id = a.id AND NOT EXISTS (SELECT 1 FROM conversations c2 WHERE c2.id = m2.conversation_id AND c2.project_id IS NOT NULL) ORDER BY m2.created_at DESC LIMIT 1) as last_message,
      (SELECT created_at FROM messages m3 WHERE m3.agent_id = a.id AND NOT EXISTS (SELECT 1 FROM conversations c3 WHERE c3.id = m3.conversation_id AND c3.project_id IS NOT NULL) ORDER BY m3.created_at DESC LIMIT 1) as last_message_at
    FROM agents a
    WHERE a.org_id = ?
    ORDER BY a.sort_order ASC, a.created_at ASC
  `, [req.orgId]);
  // Add remote connection status
  for (const agent of agents) {
    if (agent.execution_mode === 'remote') {
      agent.remote_connected = isRemoteConnected(agent.id);
    }
  }
  res.json(agents);
});

// POST /api/agents — create agent
router.post('/', (req, res) => {
  const { name, role, emoji, allowed_tools, model, backend, security_tier, notify_email } = req.body;

  if (!name || !name.trim()) {
    return sendError(res, 400, 'Name is required');
  }

  // Check unique name within org
  const existing = getOne('SELECT id FROM agents WHERE name = ? AND org_id = ?', [name.trim(), req.orgId]);
  if (existing) {
    return sendError(res, 400, 'Agent name already exists');
  }

  const id = generateId();

  try {
    db.transaction(() => {
      createAgent(req.orgId, {
        id,
        name: name.trim(),
        role: role || '',
        emoji: emoji || '🤖',
        allowed_tools: allowed_tools || 'Read,Grep,Glob,WebFetch,Bash',
        model: model || 'claude-sonnet-4-6',
        backend: backend || registry.getDefault(req.orgId)?.cliId || '',
        security_tier: security_tier || 'standard',
        notify_email: notify_email !== undefined ? (notify_email ? 1 : 0) : 1,
      });
    })();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create agent' });
  }

  const agent = getOne('SELECT * FROM agents WHERE id = ?', [id]);
  res.status(201).json(agent);
});

// GET /api/agents/:id
router.get('/:id', (req, res) => {
  const agent = getOne(
    `SELECT a.*,
      (SELECT COUNT(*) FROM messages m WHERE m.agent_id = a.id AND m.is_read = 0 AND m.role = 'assistant' AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.conversation_id AND c.project_id IS NOT NULL)) as unread_count
     FROM agents a WHERE a.id = ? AND a.org_id = ?`,
    [req.params.id, req.orgId]
  );
  if (!agent) return sendError(res, 404, 'Agent not found');

  // Read agent's CLAUDE.md
  const claudeMdPath = orgPath(req.orgId, 'agents', agent.id, 'CLAUDE.md');
  agent.claude_md = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : '';

  // Remote agent status
  agent.has_remote_token = !!agent.remote_token;
  agent.remote_connected = agent.execution_mode === 'remote' ? isRemoteConnected(agent.id) : null;
  if (agent.execution_mode === 'remote') {
    agent.remote_device_info = getRemoteDevice(agent.id) || (() => { try { return agent.remote_device ? JSON.parse(agent.remote_device) : null; } catch { return null; } })();
  }
  delete agent.remote_token;
  delete agent.remote_device;

  res.json(agent);
});

// PUT /api/agents/:id — update agent
router.put('/:id', requireAgentInOrg(), (req, res) => {
  const agent = req.agent;

  // Check name uniqueness before updating
  if (req.body.name) {
    const conflict = getOne('SELECT id FROM agents WHERE name = ? AND org_id = ? AND id != ?', [req.body.name, req.orgId, req.params.id]);
    if (conflict) {
      return sendError(res, 400, 'Agent name already exists');
    }
  }

  const { updates, params } = buildUpdate(req.body,
    ['name', 'role', 'emoji', 'allowed_tools', 'model', 'backend', 'security_tier', 'enabled', 'notify_email', 'sort_order', 'nas_paths', 'execution_mode', 'timeout_ms', 'recovery_token_budget', 'mention_context_messages', 'mention_context_chars', 'mcp_auto_reset'],
    { enabled: 'boolean', notify_email: 'boolean', mcp_auto_reset: 'boolean', nas_paths: v => JSON.stringify(Array.isArray(v) ? v : []) }
  );

  // Reset session when switching execution mode
  if (req.body.execution_mode && req.body.execution_mode !== agent.execution_mode) {
    updates.push('session_initialized = ?');
    params.push(0);
  }

  // Handle CLAUDE.md update
  if (req.body.claude_md !== undefined) {
    const claudeMdPath = orgPath(req.orgId, 'agents', agent.id, 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
    fs.writeFileSync(claudeMdPath, req.body.claude_md);
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    run(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const updated = getOne('SELECT * FROM agents WHERE id = ?', [req.params.id]);
  res.json(updated);
});

// DELETE /api/agents/:id
router.delete('/:id', requireAgentInOrg(), (req, res) => {
  const agent = req.agent;

  // Block deletion if agent is assigned to any project
  const projectRefs = getAll(
    `SELECT p.name, pa.role FROM project_agents pa JOIN projects p ON pa.project_id = p.id WHERE pa.agent_id = ?`,
    [req.params.id]
  );
  if (projectRefs.length > 0) {
    const names = projectRefs.map(r => `${r.name} (${r.role})`).join(', ');
    return sendError(res, 400, `Agent is assigned to projects: ${names}. Remove from projects first.`);
  }

  run('DELETE FROM agents WHERE id = ?', [req.params.id]);

  // Clean up filesystem
  const agentDir = orgPath(req.orgId, 'agents', agent.id);
  if (fs.existsSync(agentDir)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
  const logDir = orgPath(req.orgId, 'logs', agent.id);
  if (fs.existsSync(logDir)) {
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  res.json({ ok: true });
});

// POST /api/agents/:id/reset-session
router.post('/:id/reset-session', requireAgentInOrg(), (req, res) => {
  const agent = req.agent;

  const conversationId = req.body.conversation_id;
  let conversation;
  if (conversationId) {
    conversation = getOne('SELECT * FROM conversations WHERE id = ? AND agent_id = ?', [conversationId, agent.id]);
  } else {
    conversation = getOne('SELECT * FROM conversations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1', [agent.id]);
  }

  if (!conversation) return sendError(res, 404, 'Conversation not found');

  const newSessionId = generateId();
  run(
    "UPDATE conversations SET session_id = ?, session_initialized = 0, updated_at = datetime('now') WHERE id = ?",
    [newSessionId, conversation.id]
  );

  run(
    "UPDATE agents SET session_id = ?, session_initialized = 0, updated_at = datetime('now') WHERE id = ?",
    [newSessionId, req.params.id]
  );

  res.json({ ok: true, session_id: newSessionId });
});

// PUT /api/agents/:id/compact — agent posts its session compact during dreaming
router.put('/:id/compact', requireAgentInOrg(), (req, res) => {
  const agent = req.agent;

  const { summary } = req.body;
  if (!summary || typeof summary !== 'string' || !summary.trim()) {
    return sendError(res, 400, 'summary is required');
  }

  // Find the agent's main conversation (not project-scoped)
  const conversation = getOne(
    'SELECT id FROM conversations WHERE agent_id = ? AND project_id IS NULL ORDER BY created_at DESC LIMIT 1',
    [agent.id]
  );
  if (!conversation) return sendError(res, 404, 'No conversation found');

  run(
    "UPDATE conversations SET compact_context = ?, updated_at = datetime('now') WHERE id = ?",
    [summary.trim(), conversation.id]
  );

  res.json({ ok: true });
});

// POST /api/agents/:id/generate-remote-token
router.post('/:id/generate-remote-token', requireAgentInOrg(), (req, res) => {
  const token = crypto.randomUUID();
  const newSessionId = generateId();
  run(
    "UPDATE agents SET remote_token = ?, execution_mode = 'remote', session_id = ?, session_initialized = 0, updated_at = datetime('now') WHERE id = ?",
    [token, newSessionId, req.params.id]
  );

  res.json({ token });
});


// === Agent Secrets (override org secrets per agent) ===

// GET /api/agents/:id/secrets — list keys only (never values)
router.get('/:id/secrets', requireAgentInOrg(), (req, res) => {
  const secrets = getAll(
    'SELECT id, key, created_at, updated_at FROM agent_secrets WHERE agent_id = ? ORDER BY key ASC',
    [req.params.id]
  );
  res.json(secrets);
});

// POST /api/agents/:id/secrets — create or update an agent secret
router.post('/:id/secrets', requireAgentInOrg(), (req, res) => {
  const { key, value } = req.body;
  if (!key || !key.trim()) return sendError(res, 400, 'Key is required');
  if (!value || !value.trim()) return sendError(res, 400, 'Value is required');

  const cleanKey = upsertSecret('agent_secrets', 'agent_id', req.params.id, key, value);
  res.json({ ok: true, key: cleanKey });
});

// DELETE /api/agents/:id/secrets/:secretId
router.delete('/:id/secrets/:secretId', requireAgentInOrg(), (req, res) => {
  const agent = req.agent;

  const secret = getOne(
    'SELECT id, key FROM agent_secrets WHERE id = ? AND agent_id = ?',
    [req.params.secretId, req.params.id]
  );
  if (!secret) return sendError(res, 404, 'Secret not found');

  // Guard: can't delete a secret referenced by enabled agent skills/MCP
  const { deletable, references } = checkSecretDeletable(agent.org_id, secret.key, 'agent', agent.id);
  if (!deletable) {
    const names = references.map(r => `${r.name} (${r.type})`).join(', ');
    return sendError(res, 400, `Secret is referenced by: ${names}. Disable them first.`);
  }

  run('DELETE FROM agent_secrets WHERE id = ?', [req.params.secretId]);
  res.json({ ok: true });
});

// === Vault (file storage per agent) ===

// GET /api/agents/:id/vault
router.get('/:id/vault', requireAgentInOrg(), (req, res) => {
  const vaultDir = orgPath(req.orgId, 'agents', req.params.id, 'vault');
  if (!fs.existsSync(vaultDir)) return res.json([]);

  const files = fs.readdirSync(vaultDir).map(name => {
    const stat = fs.statSync(path.join(vaultDir, name));
    return { name, size: stat.size, modified: stat.mtime.toISOString() };
  });
  res.json(files);
});

// POST /api/agents/:id/vault
router.post('/:id/vault', requireAgentInOrg(), (req, res) => {
  const filename = req.headers['x-filename'];
  if (!filename || filename.includes('..') || filename.includes('/')) {
    return sendError(res, 400, 'Invalid or missing X-Filename header');
  }

  const vaultDir = orgPath(req.orgId, 'agents', req.params.id, 'vault');
  fs.mkdirSync(vaultDir, { recursive: true });

  const contentLength = parseInt(req.headers['content-length'], 10);
  if (contentLength > 50 * 1024 * 1024) {
    return sendError(res, 413, 'File too large (max 50MB)');
  }

  const chunks = [];
  let receivedBytes = 0;
  const MAX_VAULT_SIZE = 50 * 1024 * 1024;
  req.on('data', chunk => {
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_VAULT_SIZE) {
      if (!res.headersSent) sendError(res, 413, 'File too large (max 50MB)');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(path.join(vaultDir, filename), buffer);
    const stat = fs.statSync(path.join(vaultDir, filename));
    res.status(201).json({ name: filename, size: stat.size, modified: stat.mtime.toISOString() });
  });
});

// GET /api/agents/:id/vault/:filename
router.get('/:id/vault/:filename', requireAgentInOrg(), (req, res) => {
  const { id, filename } = req.params;
  if (filename.includes('..') || filename.includes('/')) {
    return sendError(res, 400, 'Invalid filename');
  }

  const filePath = orgPath(req.orgId, 'agents', id, 'vault', filename);
  if (!fs.existsSync(filePath)) return sendError(res, 404, 'File not found');

  res.download(filePath);
});

// DELETE /api/agents/:id/vault/:filename
router.delete('/:id/vault/:filename', requireAgentInOrg(), (req, res) => {
  const { id, filename } = req.params;
  if (filename.includes('..') || filename.includes('/')) {
    return sendError(res, 400, 'Invalid filename');
  }

  const filePath = orgPath(req.orgId, 'agents', id, 'vault', filename);
  if (!fs.existsSync(filePath)) return sendError(res, 404, 'File not found');

  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// === Image Uploads (for sending images to agents) ===

const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

// POST /api/agents/:id/uploads — upload an image
router.post('/:id/uploads', requireAgentInOrg(), (req, res) => {
  const originalName = req.headers['x-filename'] || 'image.png';
  const ext = originalName.split('.').pop()?.toLowerCase() || 'png';
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return sendError(res, 400, `Unsupported image type: .${ext}`);
  }

  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  const uploadsDir = orgPath(req.orgId, 'agents', req.params.id, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const chunks = [];
  let receivedBytes = 0;
  req.on('data', chunk => {
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_IMAGE_SIZE) {
      if (!res.headersSent) sendError(res, 413, 'Image too large (max 10MB)');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(path.join(uploadsDir, filename), buffer);
    res.status(201).json({ id, filename, original_name: originalName });
  });
});

// GET /api/agents/:id/uploads/:filename — serve an image
router.get('/:id/uploads/:filename', requireAgentInOrg(), (req, res) => {
  const { id, filename } = req.params;
  if (filename.includes('..') || filename.includes('/')) {
    return sendError(res, 400, 'Invalid filename');
  }

  const filePath = orgPath(req.orgId, 'agents', id, 'uploads', filename);
  if (!fs.existsSync(filePath)) return sendError(res, 404, 'Image not found');

  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.resolve(filePath));
});

export default router;
