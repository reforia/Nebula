import { Router } from 'express';
import { getAll, getOne, run } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { checkSecretsForEnable } from '../services/secret-refs.js';

const VALID_TRANSPORTS = ['stdio', 'http', 'sse'];

/**
 * Structural validation of MCP server config for a given transport.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
function validateMcpConfig(transport, config) {
  let parsed = config;
  if (typeof config === 'string') {
    try { parsed = JSON.parse(config); } catch { return { valid: false, reason: 'Config is not valid JSON' }; }
  }
  if (!parsed || typeof parsed !== 'object') return { valid: false, reason: 'Config must be an object' };

  if (transport === 'stdio') {
    if (!parsed.command || typeof parsed.command !== 'string') {
      return { valid: false, reason: 'Stdio transport requires a "command" string' };
    }
  } else {
    if (!parsed.url || typeof parsed.url !== 'string') {
      return { valid: false, reason: `${transport.toUpperCase()} transport requires a "url" string` };
    }
  }
  return { valid: true };
}

/**
 * Reset CLI sessions for agents affected by an MCP config change.
 * Per-agent: checks agent.mcp_auto_reset flag.
 * Org-wide change: resets only agents that have mcp_auto_reset = 1.
 * Agent-specific change: resets only if that agent has mcp_auto_reset = 1.
 */
function resetSessionsForMcpChange(orgId, agentId = null) {
  const convs = agentId
    ? getAll(
      `SELECT c.id FROM conversations c
       JOIN agents a ON c.agent_id = a.id
       WHERE c.agent_id = ? AND a.mcp_auto_reset = 1 AND c.session_initialized = 1`,
      [agentId]
    )
    : getAll(
      `SELECT c.id FROM conversations c
       JOIN agents a ON c.agent_id = a.id
       WHERE a.org_id = ? AND a.mcp_auto_reset = 1 AND c.session_initialized = 1`,
      [orgId]
    );
  for (const conv of convs) {
    const newSessionId = generateId();
    run("UPDATE conversations SET session_id = ?, session_initialized = 0, updated_at = datetime('now') WHERE id = ?",
      [newSessionId, conv.id]);
  }
  if (convs.length > 0) {
    console.log(`[mcp] Auto-reset ${convs.length} session(s) after MCP config change (org=${orgId}, agent=${agentId || 'all'})`);
  }
}

// Org-wide MCP servers: mounted at /api/mcp-servers
const mcpServersRouter = Router();

// GET /api/mcp-servers — list org-wide MCP servers
mcpServersRouter.get('/', (req, res) => {
  const servers = getAll(
    'SELECT * FROM mcp_servers WHERE org_id = ? AND agent_id IS NULL ORDER BY created_at ASC',
    [req.orgId]
  );
  res.json(servers);
});

// POST /api/mcp-servers — create org-wide MCP server
mcpServersRouter.post('/', (req, res) => {
  const { name, transport, config, enabled } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (transport && !VALID_TRANSPORTS.includes(transport)) {
    return res.status(400).json({ error: `Transport must be one of: ${VALID_TRANSPORTS.join(', ')}` });
  }

  // Validate config is valid JSON
  if (config) {
    try {
      if (typeof config === 'string') JSON.parse(config);
    } catch {
      return res.status(400).json({ error: 'Config must be valid JSON' });
    }
  }

  const id = generateId();
  const configStr = typeof config === 'object' ? JSON.stringify(config) : (config || '{}');
  run(
    `INSERT INTO mcp_servers (id, org_id, agent_id, name, transport, config, enabled)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    [id, req.orgId, name.trim(), transport || 'stdio', configStr, enabled !== undefined ? (enabled ? 1 : 0) : 1]
  );

  const server = getOne('SELECT * FROM mcp_servers WHERE id = ?', [id]);
  // Only auto-reset if the new server is enabled and structurally valid
  if (server.enabled) {
    const { valid } = validateMcpConfig(server.transport, server.config);
    if (valid) resetSessionsForMcpChange(req.orgId);
  }
  res.status(201).json(server);
});

// PUT /api/mcp-servers/:id — update org-wide MCP server
mcpServersRouter.put('/:id', (req, res) => {
  const server = getOne(
    'SELECT * FROM mcp_servers WHERE id = ? AND org_id = ? AND agent_id IS NULL',
    [req.params.id, req.orgId]
  );
  if (!server) return res.status(404).json({ error: 'MCP server not found' });

  if (req.body.transport && !VALID_TRANSPORTS.includes(req.body.transport)) {
    return res.status(400).json({ error: `Transport must be one of: ${VALID_TRANSPORTS.join(', ')}` });
  }

  // Guard: check secrets are configured before enabling
  if (req.body.enabled && !server.enabled) {
    const config = req.body.config !== undefined ? (typeof req.body.config === 'object' ? JSON.stringify(req.body.config) : req.body.config) : server.config;
    const { ok, missing } = checkSecretsForEnable(req.orgId, null, config);
    if (!ok) {
      return res.status(400).json({ error: `Missing secrets: ${missing.join(', ')}. Configure them in the Secrets tab.` });
    }
  }

  const fields = ['name', 'transport', 'config', 'enabled'];
  const updates = [];
  const params = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      let val = req.body[field];
      if (field === 'enabled') val = val ? 1 : 0;
      if (field === 'name') val = val.trim();
      if (field === 'config' && typeof val === 'object') val = JSON.stringify(val);
      params.push(val);
    }
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    run(`UPDATE mcp_servers SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const updated = getOne('SELECT * FROM mcp_servers WHERE id = ?', [req.params.id]);
  // Auto-reset if the updated server is enabled and structurally valid
  if (updated.enabled) {
    const { valid } = validateMcpConfig(updated.transport, updated.config);
    if (valid) resetSessionsForMcpChange(req.orgId);
  }
  res.json(updated);
});

// DELETE /api/mcp-servers/:id — delete org-wide MCP server
mcpServersRouter.delete('/:id', (req, res) => {
  const server = getOne(
    'SELECT * FROM mcp_servers WHERE id = ? AND org_id = ? AND agent_id IS NULL',
    [req.params.id, req.orgId]
  );
  if (!server) return res.status(404).json({ error: 'MCP server not found' });

  run('DELETE FROM mcp_servers WHERE id = ?', [req.params.id]);
  // Deleting an enabled server changes what agents see — reset
  if (server.enabled) resetSessionsForMcpChange(req.orgId);
  res.json({ ok: true });
});

// Agent-specific MCP servers: mounted at /api/agents
export const agentMcpServersRouter = Router();

// GET /api/agents/:id/mcp-servers — list agent + org-wide MCP servers
agentMcpServersRouter.get('/:id/mcp-servers', (req, res) => {
  const agent = getOne('SELECT id, org_id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const servers = getAll(
    `SELECT *, CASE WHEN agent_id IS NULL THEN 'org' ELSE 'agent' END as scope
     FROM mcp_servers
     WHERE (org_id = ? AND agent_id IS NULL) OR agent_id = ?
     ORDER BY agent_id IS NULL DESC, created_at ASC`,
    [req.orgId, req.params.id]
  );
  res.json(servers);
});

// POST /api/agents/:id/mcp-servers — create agent-specific MCP server
agentMcpServersRouter.post('/:id/mcp-servers', (req, res) => {
  const agent = getOne('SELECT id, org_id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { name, transport, config, enabled } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (transport && !VALID_TRANSPORTS.includes(transport)) {
    return res.status(400).json({ error: `Transport must be one of: ${VALID_TRANSPORTS.join(', ')}` });
  }

  if (config) {
    try {
      if (typeof config === 'string') JSON.parse(config);
    } catch {
      return res.status(400).json({ error: 'Config must be valid JSON' });
    }
  }

  const id = generateId();
  const configStr = typeof config === 'object' ? JSON.stringify(config) : (config || '{}');
  run(
    `INSERT INTO mcp_servers (id, org_id, agent_id, name, transport, config, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, req.orgId, req.params.id, name.trim(), transport || 'stdio', configStr, enabled !== undefined ? (enabled ? 1 : 0) : 1]
  );

  const server = getOne('SELECT * FROM mcp_servers WHERE id = ?', [id]);
  if (server.enabled) {
    const { valid } = validateMcpConfig(server.transport, server.config);
    if (valid) resetSessionsForMcpChange(req.orgId, req.params.id);
  }
  res.status(201).json(server);
});

// PUT /api/agents/:id/mcp-servers/:serverId — update agent-specific MCP server
agentMcpServersRouter.put('/:id/mcp-servers/:serverId', (req, res) => {
  const server = getOne(
    'SELECT * FROM mcp_servers WHERE id = ? AND agent_id = ?',
    [req.params.serverId, req.params.id]
  );
  if (!server) return res.status(404).json({ error: 'MCP server not found' });

  if (req.body.transport && !VALID_TRANSPORTS.includes(req.body.transport)) {
    return res.status(400).json({ error: `Transport must be one of: ${VALID_TRANSPORTS.join(', ')}` });
  }

  // Guard: check secrets are configured before enabling
  if (req.body.enabled && !server.enabled) {
    const config = req.body.config !== undefined ? (typeof req.body.config === 'object' ? JSON.stringify(req.body.config) : req.body.config) : server.config;
    const { ok, missing } = checkSecretsForEnable(req.orgId, req.params.id, config);
    if (!ok) {
      return res.status(400).json({ error: `Missing secrets: ${missing.join(', ')}. Configure them in the Secrets tab.` });
    }
  }

  const fields = ['name', 'transport', 'config', 'enabled'];
  const updates = [];
  const params = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      let val = req.body[field];
      if (field === 'enabled') val = val ? 1 : 0;
      if (field === 'name') val = val.trim();
      if (field === 'config' && typeof val === 'object') val = JSON.stringify(val);
      params.push(val);
    }
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(req.params.serverId);
    run(`UPDATE mcp_servers SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const updated = getOne('SELECT * FROM mcp_servers WHERE id = ?', [req.params.serverId]);
  if (updated.enabled) {
    const { valid } = validateMcpConfig(updated.transport, updated.config);
    if (valid) resetSessionsForMcpChange(req.orgId, req.params.id);
  }
  res.json(updated);
});

// DELETE /api/agents/:id/mcp-servers/:serverId — delete agent-specific MCP server
agentMcpServersRouter.delete('/:id/mcp-servers/:serverId', (req, res) => {
  const server = getOne(
    'SELECT * FROM mcp_servers WHERE id = ? AND agent_id = ?',
    [req.params.serverId, req.params.id]
  );
  if (!server) return res.status(404).json({ error: 'MCP server not found' });

  run('DELETE FROM mcp_servers WHERE id = ?', [req.params.serverId]);
  if (server.enabled) resetSessionsForMcpChange(req.orgId, req.params.id);
  res.json({ ok: true });
});

export default mcpServersRouter;
