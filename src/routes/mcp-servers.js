import { Router } from 'express';
import { getAll, getOne, run } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { checkSecretsForEnable } from '../services/secret-refs.js';

const VALID_TRANSPORTS = ['stdio', 'http', 'sse'];

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
  res.json({ ok: true });
});

export default mcpServersRouter;
