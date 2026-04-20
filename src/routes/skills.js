import { Router } from 'express';
import { getAll, getOne, run } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { checkSecretsForEnable } from '../services/secret-refs.js';
import { requireAgentInOrg } from '../utils/route-guards.js';

// Org-wide skills: mounted at /api/skills
const skillsRouter = Router();

// GET /api/skills — list org-wide custom skills
skillsRouter.get('/', (req, res) => {
  const skills = getAll(
    'SELECT * FROM custom_skills WHERE org_id = ? AND agent_id IS NULL ORDER BY created_at ASC',
    [req.orgId]
  );
  res.json(skills);
});

// POST /api/skills — create org-wide skill
skillsRouter.post('/', (req, res) => {
  const { name, description, content, enabled } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const id = generateId();
  run(
    `INSERT INTO custom_skills (id, org_id, agent_id, name, description, content, enabled)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    [id, req.orgId, name.trim(), description || '', content || '', enabled !== undefined ? (enabled ? 1 : 0) : 1]
  );

  const skill = getOne('SELECT * FROM custom_skills WHERE id = ?', [id]);
  res.status(201).json(skill);
});

// PUT /api/skills/:id — update org-wide skill
skillsRouter.put('/:id', (req, res) => {
  const skill = getOne(
    'SELECT * FROM custom_skills WHERE id = ? AND org_id = ? AND agent_id IS NULL',
    [req.params.id, req.orgId]
  );
  if (!skill) return res.status(404).json({ error: 'Skill not found' });

  // Guard: check secrets are configured before enabling
  if (req.body.enabled && !skill.enabled) {
    const content = req.body.content !== undefined ? req.body.content : skill.content;
    const { ok, missing } = checkSecretsForEnable(req.orgId, null, content);
    if (!ok) {
      return res.status(400).json({ error: `Missing secrets: ${missing.join(', ')}. Configure them in the Secrets tab.` });
    }
  }

  const fields = ['name', 'description', 'content', 'enabled'];
  const updates = [];
  const params = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      let val = req.body[field];
      if (field === 'enabled') val = val ? 1 : 0;
      if (field === 'name') val = val.trim();
      params.push(val);
    }
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    run(`UPDATE custom_skills SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const updated = getOne('SELECT * FROM custom_skills WHERE id = ?', [req.params.id]);
  res.json(updated);
});

// DELETE /api/skills/:id — delete org-wide skill
skillsRouter.delete('/:id', (req, res) => {
  const skill = getOne(
    'SELECT * FROM custom_skills WHERE id = ? AND org_id = ? AND agent_id IS NULL',
    [req.params.id, req.orgId]
  );
  if (!skill) return res.status(404).json({ error: 'Skill not found' });

  run('DELETE FROM custom_skills WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// Agent-specific skills: mounted at /api/agents
export const agentSkillsRouter = Router();

// GET /api/agents/:id/skills — list agent + org-wide skills
agentSkillsRouter.get('/:id/skills', requireAgentInOrg(), (req, res) => {
  const skills = getAll(
    `SELECT *, CASE WHEN agent_id IS NULL THEN 'org' ELSE 'agent' END as scope
     FROM custom_skills
     WHERE (org_id = ? AND agent_id IS NULL) OR agent_id = ?
     ORDER BY agent_id IS NULL DESC, created_at ASC`,
    [req.orgId, req.params.id]
  );
  res.json(skills);
});

// POST /api/agents/:id/skills — create agent-specific skill
agentSkillsRouter.post('/:id/skills', requireAgentInOrg(), (req, res) => {
  const { name, description, content, enabled } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const id = generateId();
  run(
    `INSERT INTO custom_skills (id, org_id, agent_id, name, description, content, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, req.orgId, req.params.id, name.trim(), description || '', content || '', enabled !== undefined ? (enabled ? 1 : 0) : 1]
  );

  const skill = getOne('SELECT * FROM custom_skills WHERE id = ?', [id]);
  res.status(201).json(skill);
});

// PUT /api/agents/:id/skills/:skillId — update agent-specific skill
agentSkillsRouter.put('/:id/skills/:skillId', (req, res) => {
  const skill = getOne(
    'SELECT * FROM custom_skills WHERE id = ? AND agent_id = ?',
    [req.params.skillId, req.params.id]
  );
  if (!skill) return res.status(404).json({ error: 'Skill not found' });

  // Guard: check secrets are configured before enabling
  if (req.body.enabled && !skill.enabled) {
    const content = req.body.content !== undefined ? req.body.content : skill.content;
    const { ok, missing } = checkSecretsForEnable(req.orgId, req.params.id, content);
    if (!ok) {
      return res.status(400).json({ error: `Missing secrets: ${missing.join(', ')}. Configure them in the Secrets tab.` });
    }
  }

  const fields = ['name', 'description', 'content', 'enabled'];
  const updates = [];
  const params = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      let val = req.body[field];
      if (field === 'enabled') val = val ? 1 : 0;
      if (field === 'name') val = val.trim();
      params.push(val);
    }
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(req.params.skillId);
    run(`UPDATE custom_skills SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const updated = getOne('SELECT * FROM custom_skills WHERE id = ?', [req.params.skillId]);
  res.json(updated);
});

// DELETE /api/agents/:id/skills/:skillId — delete agent-specific skill
agentSkillsRouter.delete('/:id/skills/:skillId', (req, res) => {
  const skill = getOne(
    'SELECT * FROM custom_skills WHERE id = ? AND agent_id = ?',
    [req.params.skillId, req.params.id]
  );
  if (!skill) return res.status(404).json({ error: 'Skill not found' });

  run('DELETE FROM custom_skills WHERE id = ?', [req.params.skillId]);
  res.json({ ok: true });
});

export default skillsRouter;
