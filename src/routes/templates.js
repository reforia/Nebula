import { Router } from 'express';
import { getAll, getOne, run, orgPath } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { initScheduler } from '../services/scheduler.js';
import fs from 'fs';
import path from 'path';
import { registry } from '../backends/index.js';

const router = Router();

// Templates directory: /data/templates at runtime, ./templates as built-in fallback
const DATA_DIR = process.env.DATA_DIR || './data';
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const BUILTIN_TEMPLATES_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname), '..', '..', 'templates'
);

/**
 * Seed built-in templates into /data/templates (if they don't already exist).
 * Called once at import time.
 */
function seedBuiltinTemplates() {
  try {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    if (!fs.existsSync(BUILTIN_TEMPLATES_DIR)) return;
    for (const file of fs.readdirSync(BUILTIN_TEMPLATES_DIR)) {
      if (!file.endsWith('.json')) continue;
      const dest = path.join(TEMPLATES_DIR, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(BUILTIN_TEMPLATES_DIR, file), dest);
      }
    }
  } catch {}
}
seedBuiltinTemplates();

/**
 * GET /api/templates — list available templates from /data/templates
 */
router.get('/', (req, res) => {
  try {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
    const templates = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8');
        const tpl = JSON.parse(raw);
        templates.push({
          id: file.replace(/\.json$/, ''),
          name: tpl.name || file,
          description: tpl.description || '',
          icon: tpl.icon || '',
          agents: (tpl.agents || []).length,
          skills: (tpl.skills || []).length + (tpl.agents || []).reduce((s, a) => s + (a.skills?.length || 0), 0),
          tasks: (tpl.agents || []).reduce((s, a) => s + (a.tasks?.length || 0), 0),
        });
      } catch {}
    }
    res.json(templates);
  } catch {
    res.json([]);
  }
});

/**
 * GET /api/templates/export — export current org as a template JSON
 * Must be defined before /:id to avoid being swallowed by the param route.
 */
router.get('/export', (req, res) => {
  const org = getOne('SELECT name FROM organizations WHERE id = ?', [req.orgId]);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const agents = getAll('SELECT * FROM agents WHERE org_id = ?', [req.orgId]);

  const templateAgents = agents.map(agent => {
    const tasks = getAll(
      'SELECT name, cron_expression, prompt, enabled FROM tasks WHERE agent_id = ?',
      [agent.id]
    );
    const skills = getAll(
      'SELECT name, description, content, enabled FROM custom_skills WHERE agent_id = ?',
      [agent.id]
    );
    const mcpServers = getAll(
      'SELECT name, transport, config, enabled FROM mcp_servers WHERE agent_id = ?',
      [agent.id]
    );

    return {
      name: agent.name,
      role: agent.role || '',
      model: agent.model || 'claude-sonnet-4-6',
      backend: agent.backend || undefined,
      allowed_tools: agent.allowed_tools || 'Read,Grep,Glob,WebFetch,Bash',
      timeout_ms: agent.timeout_ms || null,
      execution_mode: agent.execution_mode || 'local',
      tasks: tasks.map(t => ({
        name: t.name,
        cron: t.cron_expression,
        prompt: t.prompt || '',
        enabled: !!t.enabled,
      })),
      skills: skills.map(s => ({
        name: s.name,
        description: s.description || '',
        content: s.content || '',
        enabled: !!s.enabled,
      })),
      mcp_servers: mcpServers.map(m => ({
        name: m.name,
        transport: m.transport,
        config: JSON.parse(m.config || '{}'),
        enabled: !!m.enabled,
      })),
    };
  });

  // Org-wide skills
  const orgSkills = getAll(
    'SELECT name, description, content, enabled FROM custom_skills WHERE org_id = ? AND agent_id IS NULL',
    [req.orgId]
  );

  // Org-wide MCP servers
  const orgMcpServers = getAll(
    'SELECT name, transport, config, enabled FROM mcp_servers WHERE org_id = ? AND agent_id IS NULL',
    [req.orgId]
  );

  const template = {
    version: 1,
    name: `${org.name} Template`,
    description: `Exported from ${org.name}`,
    agents: templateAgents,
    skills: orgSkills.map(s => ({
      name: s.name,
      description: s.description || '',
      content: s.content || '',
      enabled: !!s.enabled,
    })),
    mcp_servers: orgMcpServers.map(m => ({
      name: m.name,
      transport: m.transport,
      config: JSON.parse(m.config || '{}'),
      enabled: !!m.enabled,
    })),
  };

  if (req.query.download === 'true') {
    const filename = `template-${org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }

  res.json(template);
});

/**
 * POST /api/templates/import — apply a template to the current org
 * Creates agents, skills, tasks, MCP servers. Does NOT touch org name/knowledge/secrets.
 */
router.post('/import', (req, res) => {
  const template = req.body;

  if (!template || !template.agents || !Array.isArray(template.agents)) {
    return res.status(400).json({ error: 'Invalid template: agents array is required' });
  }

  const counts = { agents: 0, skills: 0, tasks: 0, mcp_servers: 0 };

  // Helper: deduplicate name within org
  function uniqueAgentName(baseName) {
    let name = baseName.trim();
    let suffix = 2;
    while (getOne('SELECT id FROM agents WHERE name = ? AND org_id = ?', [name, req.orgId])) {
      name = `${baseName.trim()} (${suffix++})`;
    }
    return name;
  }

  function uniqueSkillName(baseName, agentId) {
    let name = baseName.trim();
    let suffix = 2;
    const query = agentId
      ? 'SELECT id FROM custom_skills WHERE name = ? AND org_id = ? AND agent_id = ?'
      : 'SELECT id FROM custom_skills WHERE name = ? AND org_id = ? AND agent_id IS NULL';
    const params = agentId ? [name, req.orgId, agentId] : [name, req.orgId];
    while (getOne(query, params)) {
      name = `${baseName.trim()} (${suffix++})`;
      if (agentId) params[0] = name; else params[0] = name;
    }
    return name;
  }

  // Import agents
  for (const agentDef of template.agents) {
    if (!agentDef.name) continue;

    const agentName = uniqueAgentName(agentDef.name);
    const agentId = generateId();
    const sessionId = generateId();

    run(
      `INSERT INTO agents (id, org_id, name, role, session_id, allowed_tools, model, backend, timeout_ms, execution_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId, req.orgId, agentName,
        agentDef.role || '',
        sessionId,
        agentDef.allowed_tools || 'Read,Grep,Glob,WebFetch,Bash',
        agentDef.model || 'claude-sonnet-4-6',
        agentDef.backend || registry.getDefault(req.orgId)?.cliId || 'claude-cli',
        agentDef.timeout_ms || null,
        agentDef.execution_mode || 'local',
      ]
    );

    // Create agent directory
    const agentDir = orgPath(req.orgId, 'agents', agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'workspace'), { recursive: true });

    // Create initial conversation
    const convId = generateId();
    run(
      `INSERT INTO conversations (id, agent_id, title, session_id, session_initialized)
       VALUES (?, ?, 'General', ?, 0)`,
      [convId, agentId, sessionId]
    );

    counts.agents++;

    // Agent tasks
    if (Array.isArray(agentDef.tasks)) {
      for (const taskDef of agentDef.tasks) {
        if (!taskDef.name) continue;
        const taskId = generateId();
        run(
          `INSERT INTO tasks (id, agent_id, name, cron_expression, prompt, enabled)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [taskId, agentId, taskDef.name, taskDef.cron || null, taskDef.prompt || '', taskDef.enabled ? 1 : 0]
        );
        counts.tasks++;
      }
    }

    // Agent skills
    if (Array.isArray(agentDef.skills)) {
      for (const skillDef of agentDef.skills) {
        if (!skillDef.name) continue;
        const skillId = generateId();
        run(
          `INSERT INTO custom_skills (id, org_id, agent_id, name, description, content, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [skillId, req.orgId, agentId, skillDef.name, skillDef.description || '', skillDef.content || '', skillDef.enabled ? 1 : 0]
        );
        counts.skills++;
      }
    }

    // Agent MCP servers
    if (Array.isArray(agentDef.mcp_servers)) {
      for (const mcpDef of agentDef.mcp_servers) {
        if (!mcpDef.name) continue;
        const mcpId = generateId();
        run(
          `INSERT INTO mcp_servers (id, org_id, agent_id, name, transport, config, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [mcpId, req.orgId, agentId, mcpDef.name, mcpDef.transport || 'stdio', JSON.stringify(mcpDef.config || {}), mcpDef.enabled ? 1 : 0]
        );
        counts.mcp_servers++;
      }
    }
  }

  // Org-wide skills
  if (Array.isArray(template.skills)) {
    for (const skillDef of template.skills) {
      if (!skillDef.name) continue;
      const name = uniqueSkillName(skillDef.name, null);
      const skillId = generateId();
      run(
        `INSERT INTO custom_skills (id, org_id, agent_id, name, description, content, enabled)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
        [skillId, req.orgId, name, skillDef.description || '', skillDef.content || '', skillDef.enabled ? 1 : 0]
      );
      counts.skills++;
    }
  }

  // Org-wide MCP servers
  if (Array.isArray(template.mcp_servers)) {
    for (const mcpDef of template.mcp_servers) {
      if (!mcpDef.name) continue;
      const mcpId = generateId();
      run(
        `INSERT INTO mcp_servers (id, org_id, agent_id, name, transport, config, enabled)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
        [mcpId, req.orgId, mcpDef.name, mcpDef.transport || 'stdio', JSON.stringify(mcpDef.config || {}), mcpDef.enabled ? 1 : 0]
      );
      counts.mcp_servers++;
    }
  }

  // Re-initialize scheduler to pick up new cron tasks
  initScheduler();

  res.json({ ok: true, created: counts });
});

/**
 * GET /api/templates/:id — get a specific template by filename (without .json)
 * Must be after /export and /import to avoid swallowing those paths.
 */
router.get('/:id', (req, res) => {
  const filePath = path.join(TEMPLATES_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Template not found' });
  try {
    const tpl = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(tpl);
  } catch {
    res.status(500).json({ error: 'Failed to parse template' });
  }
});

export default router;
