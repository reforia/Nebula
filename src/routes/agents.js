import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getAll, getOne, run, orgPath } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { encrypt } from '../utils/crypto.js';
import { isRemoteConnected, getRemoteDevice } from '../services/remote-agents.js';
import { registry } from '../backends/index.js';
import { buildUpdate } from '../utils/update-builder.js';
import { checkSecretDeletable } from '../services/secret-refs.js';

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
    return res.status(400).json({ error: 'Name is required' });
  }

  // Check unique name within org
  const existing = getOne('SELECT id FROM agents WHERE name = ? AND org_id = ?', [name.trim(), req.orgId]);
  if (existing) {
    return res.status(400).json({ error: 'Agent name already exists' });
  }

  const id = generateId();
  const sessionId = generateId();

  run(
    `INSERT INTO agents (id, org_id, name, role, emoji, session_id, allowed_tools, model, backend, security_tier, notify_email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      req.orgId,
      name.trim(),
      role || '',
      emoji || '🤖',
      sessionId,
      allowed_tools || 'Read,Grep,Glob,WebFetch,Bash',
      model || 'claude-sonnet-4-6',
      backend || registry.getDefault(req.orgId)?.cliId || '',
      security_tier || 'standard',
      notify_email !== undefined ? (notify_email ? 1 : 0) : 1,
    ]
  );

  // Create agent directory (no boilerplate files — agent creates them during initialization)
  const agentDir = orgPath(req.orgId, 'agents', id);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'workspace'), { recursive: true });

  // Create initial conversation with a static welcome message
  const convId = generateId();
  run(
    `INSERT INTO conversations (id, agent_id, title, session_id, session_initialized)
     VALUES (?, ?, 'General', ?, 0)`,
    [convId, id, sessionId]
  );
  const welcomeMsgId = generateId();
  run(
    `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
     VALUES (?, ?, ?, 'system', ?, 'system', 1, datetime('now'))`,
    [welcomeMsgId, id, convId,
     `Welcome! This agent needs some initial setup before it can work effectively.\n\nPlease provide:\n1. **Role** — What is this agent's primary responsibility? (set in agent settings)\n2. **Access** — What tools, APIs, or repos will it need?\n3. **Context** — Any domain knowledge or guidelines it should follow?\n\nOnce you share this, the agent will set up its working environment — guidelines, org profile, and memory.`]
  );

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
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Read agent's CLAUDE.md
  const claudeMdPath = orgPath(req.orgId, 'agents', agent.id, 'CLAUDE.md');
  agent.claude_md = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : '';

  // Remote agent status
  agent.has_remote_token = !!agent.remote_token;
  agent.remote_connected = agent.execution_mode === 'remote' ? isRemoteConnected(agent.id) : null;
  if (agent.execution_mode === 'remote') {
    agent.remote_device_info = getRemoteDevice(agent.id) || (agent.remote_device ? JSON.parse(agent.remote_device) : null);
  }
  delete agent.remote_token;
  delete agent.remote_device;

  res.json(agent);
});

// PUT /api/agents/:id — update agent
router.put('/:id', (req, res) => {
  const agent = getOne('SELECT * FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Check name uniqueness before updating
  if (req.body.name) {
    const conflict = getOne('SELECT id FROM agents WHERE name = ? AND org_id = ? AND id != ?', [req.body.name, req.orgId, req.params.id]);
    if (conflict) {
      return res.status(400).json({ error: 'Agent name already exists' });
    }
  }

  const { updates, params } = buildUpdate(req.body,
    ['name', 'role', 'emoji', 'allowed_tools', 'model', 'backend', 'security_tier', 'enabled', 'notify_email', 'sort_order', 'nas_paths', 'execution_mode', 'timeout_ms', 'recovery_token_budget'],
    { enabled: 'boolean', notify_email: 'boolean', nas_paths: v => JSON.stringify(Array.isArray(v) ? v : []) }
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
router.delete('/:id', (req, res) => {
  const agent = getOne('SELECT * FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

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
router.post('/:id/reset-session', (req, res) => {
  const agent = getOne('SELECT * FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const conversationId = req.body.conversation_id;
  let conversation;
  if (conversationId) {
    conversation = getOne('SELECT * FROM conversations WHERE id = ? AND agent_id = ?', [conversationId, agent.id]);
  } else {
    conversation = getOne('SELECT * FROM conversations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1', [agent.id]);
  }

  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

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

// POST /api/agents/:id/generate-remote-token
router.post('/:id/generate-remote-token', (req, res) => {
  const agent = getOne('SELECT * FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

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
router.get('/:id/secrets', (req, res) => {
  const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const secrets = getAll(
    'SELECT id, key, created_at, updated_at FROM agent_secrets WHERE agent_id = ? ORDER BY key ASC',
    [req.params.id]
  );
  res.json(secrets);
});

// POST /api/agents/:id/secrets — create or update an agent secret
router.post('/:id/secrets', (req, res) => {
  const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { key, value } = req.body;
  if (!key || !key.trim()) return res.status(400).json({ error: 'Key is required' });
  if (!value || !value.trim()) return res.status(400).json({ error: 'Value is required' });

  const cleanKey = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const encryptedValue = encrypt(value.trim());

  const existing = getOne(
    'SELECT id FROM agent_secrets WHERE agent_id = ? AND key = ?',
    [req.params.id, cleanKey]
  );

  if (existing) {
    run(
      "UPDATE agent_secrets SET value = ?, updated_at = datetime('now') WHERE id = ?",
      [encryptedValue, existing.id]
    );
  } else {
    const id = generateId();
    run(
      'INSERT INTO agent_secrets (id, agent_id, key, value) VALUES (?, ?, ?, ?)',
      [id, req.params.id, cleanKey, encryptedValue]
    );
  }

  res.json({ ok: true, key: cleanKey });
});

// DELETE /api/agents/:id/secrets/:secretId
router.delete('/:id/secrets/:secretId', (req, res) => {
  const agent = getOne('SELECT id, org_id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const secret = getOne(
    'SELECT id, key FROM agent_secrets WHERE id = ? AND agent_id = ?',
    [req.params.secretId, req.params.id]
  );
  if (!secret) return res.status(404).json({ error: 'Secret not found' });

  // Guard: can't delete a secret referenced by enabled agent skills/MCP
  const { deletable, references } = checkSecretDeletable(agent.org_id, secret.key, 'agent', agent.id);
  if (!deletable) {
    const names = references.map(r => `${r.name} (${r.type})`).join(', ');
    return res.status(400).json({ error: `Secret is referenced by: ${names}. Disable them first.` });
  }

  run('DELETE FROM agent_secrets WHERE id = ?', [req.params.secretId]);
  res.json({ ok: true });
});

// === Vault (file storage per agent) ===

// GET /api/agents/:id/vault
router.get('/:id/vault', (req, res) => {
  const agent = getOne('SELECT id, org_id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const vaultDir = orgPath(req.orgId, 'agents', req.params.id, 'vault');
  if (!fs.existsSync(vaultDir)) return res.json([]);

  const files = fs.readdirSync(vaultDir).map(name => {
    const stat = fs.statSync(path.join(vaultDir, name));
    return { name, size: stat.size, modified: stat.mtime.toISOString() };
  });
  res.json(files);
});

// POST /api/agents/:id/vault
router.post('/:id/vault', (req, res) => {
  const agent = getOne('SELECT id, org_id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const filename = req.headers['x-filename'];
  if (!filename || filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid or missing X-Filename header' });
  }

  const vaultDir = orgPath(req.orgId, 'agents', req.params.id, 'vault');
  fs.mkdirSync(vaultDir, { recursive: true });

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    if (buffer.length > 50 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (max 50MB)' });
    }
    fs.writeFileSync(path.join(vaultDir, filename), buffer);
    const stat = fs.statSync(path.join(vaultDir, filename));
    res.status(201).json({ name: filename, size: stat.size, modified: stat.mtime.toISOString() });
  });
});

// GET /api/agents/:id/vault/:filename
router.get('/:id/vault/:filename', (req, res) => {
  const { id, filename } = req.params;
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const filePath = orgPath(req.orgId, 'agents', id, 'vault', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  res.download(filePath);
});

// DELETE /api/agents/:id/vault/:filename
router.delete('/:id/vault/:filename', (req, res) => {
  const { id, filename } = req.params;
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const filePath = orgPath(req.orgId, 'agents', id, 'vault', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// === Image Uploads (for sending images to agents) ===

const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

// POST /api/agents/:id/uploads — upload an image
router.post('/:id/uploads', (req, res) => {
  const agent = getOne('SELECT id, org_id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const originalName = req.headers['x-filename'] || 'image.png';
  const ext = originalName.split('.').pop()?.toLowerCase() || 'png';
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return res.status(400).json({ error: `Unsupported image type: .${ext}` });
  }

  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  const uploadsDir = orgPath(req.orgId, 'agents', req.params.id, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    if (buffer.length > MAX_IMAGE_SIZE) {
      return res.status(413).json({ error: 'Image too large (max 10MB)' });
    }
    fs.writeFileSync(path.join(uploadsDir, filename), buffer);
    res.status(201).json({ id, filename, original_name: originalName });
  });
});

// GET /api/agents/:id/uploads/:filename — serve an image
router.get('/:id/uploads/:filename', (req, res) => {
  const { id, filename } = req.params;
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const filePath = orgPath(req.orgId, 'agents', id, 'uploads', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Image not found' });

  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.resolve(filePath));
});

export default router;
