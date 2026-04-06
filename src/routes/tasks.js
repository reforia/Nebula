import { Router } from 'express';
import { getAll, getOne, run } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { registerCron, unregisterCron, fireTask, validateCron } from '../services/scheduler.js';
import { buildUpdate } from '../utils/update-builder.js';

// Agent-scoped routes: mounted at /api/agents
export const agentTasksRouter = Router();

// GET /api/agents/:id/tasks
agentTasksRouter.get('/:id/tasks', (req, res) => {
  const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const tasks = getAll('SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at ASC', [req.params.id]);
  res.json(tasks);
});

// POST /api/agents/:id/tasks — create task
agentTasksRouter.post('/:id/tasks', (req, res) => {
  const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { name, prompt, cron_expression, trigger_type, enabled, max_turns, timeout_ms } = req.body;
  const type = trigger_type || 'cron';

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is required' });

  if (type === 'cron') {
    if (!cron_expression) return res.status(400).json({ error: 'Cron expression is required for cron triggers' });
    if (!validateCron(cron_expression)) return res.status(400).json({ error: 'Invalid cron expression' });
  }

  const id = generateId();
  const webhookSecret = type === 'webhook' ? generateId() : null;

  run(
    `INSERT INTO tasks (id, agent_id, name, prompt, trigger_type, cron_expression, webhook_secret, enabled, max_turns, timeout_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      req.params.id,
      name.trim(),
      prompt.trim(),
      type,
      type === 'cron' ? cron_expression : null,
      webhookSecret,
      enabled !== undefined ? (enabled ? 1 : 0) : 1,
      max_turns || 50,
      timeout_ms || null,
    ]
  );

  const task = getOne('SELECT * FROM tasks WHERE id = ?', [id]);
  if (task.enabled && task.trigger_type === 'cron' && task.cron_expression) registerCron(task);

  if (task.trigger_type === 'webhook') {
    task.webhook_url = `/api/webhooks/${task.id}`;
  }

  res.status(201).json(task);
});

// Task-level routes: mounted at /api/tasks
const tasksRouter = Router();

// PUT /api/tasks/:id — update task
tasksRouter.put('/:id', (req, res) => {
  // Verify task belongs to an agent in the user's org
  const task = getOne(
    `SELECT t.* FROM tasks t
     JOIN agents a ON t.agent_id = a.id
     WHERE t.id = ? AND a.org_id = ?`,
    [req.params.id, req.orgId]
  );
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (req.body.cron_expression && !validateCron(req.body.cron_expression)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  const { updates, params } = buildUpdate(req.body,
    ['name', 'prompt', 'trigger_type', 'cron_expression', 'enabled', 'max_turns', 'timeout_ms'],
    { name: 'trim', prompt: 'trim', enabled: 'boolean' }
  );

  if (updates.length > 0) {
    params.push(req.params.id);
    run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const updated = getOne('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
  registerCron(updated);

  res.json(updated);
});

// DELETE /api/tasks/:id
tasksRouter.delete('/:id', (req, res) => {
  const task = getOne(
    `SELECT t.* FROM tasks t
     JOIN agents a ON t.agent_id = a.id
     WHERE t.id = ? AND a.org_id = ?`,
    [req.params.id, req.orgId]
  );
  if (!task) return res.status(404).json({ error: 'Task not found' });

  unregisterCron(task.id);
  run('DELETE FROM tasks WHERE id = ?', [req.params.id]);

  res.json({ ok: true });
});

// POST /api/tasks/:id/trigger — fire immediately
tasksRouter.post('/:id/trigger', (req, res) => {
  const task = getOne(
    `SELECT t.* FROM tasks t
     JOIN agents a ON t.agent_id = a.id
     WHERE t.id = ? AND a.org_id = ?`,
    [req.params.id, req.orgId]
  );
  if (!task) return res.status(404).json({ error: 'Task not found' });

  fireTask(task.id);
  res.json({ ok: true, message: 'Task triggered' });
});

export default tasksRouter;
