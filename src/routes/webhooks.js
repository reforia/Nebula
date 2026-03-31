import { Router } from 'express';
import crypto from 'crypto';
import { getOne } from '../db.js';
import { executeTask } from '../services/task-executor.js';

const router = Router();

// POST /api/webhooks/:taskId — receive webhook, fire the task
// Public endpoint — no session auth. Verified via webhook_secret.
router.post('/:taskId', async (req, res) => {
  const task = getOne('SELECT * FROM tasks WHERE id = ?', [req.params.taskId]);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.enabled) return res.status(400).json({ error: 'Task is disabled' });
  if (task.trigger_type !== 'webhook') return res.status(400).json({ error: 'Task is not a webhook trigger' });

  // Verify secret if set
  if (task.webhook_secret) {
    const simpleSecret = req.query.secret || req.headers['x-webhook-secret'];
    if (simpleSecret === task.webhook_secret) {
      // Authorized
    } else {
      const signature = req.headers['x-gitea-signature']
        || req.headers['x-hub-signature-256']?.replace('sha256=', '');

      if (signature) {
        const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
        const expected = crypto.createHmac('sha256', task.webhook_secret).update(rawBody).digest('hex');
        if (signature !== expected) {
          return res.status(401).json({ error: 'Invalid signature' });
        }
      } else {
        return res.status(401).json({ error: 'Missing or invalid secret' });
      }
    }
  }

  const agent = getOne('SELECT * FROM agents WHERE id = ?', [task.agent_id]);
  if (!agent || !agent.enabled) return res.status(400).json({ error: 'Agent is disabled' });

  // Build prompt with webhook payload
  const payload = JSON.stringify(req.body, null, 2);
  const headers = JSON.stringify({
    event: req.headers['x-gitea-event'] || req.headers['x-github-event'] || req.headers['x-event-type'] || 'unknown',
    delivery: req.headers['x-gitea-delivery'] || req.headers['x-github-delivery'] || '',
  });

  const fullPrompt = `${task.prompt}

--- Webhook Event ---
Event headers: ${headers}
Payload:
\`\`\`json
${payload.slice(0, 10000)}
\`\`\``;

  res.json({ ok: true, message: 'Webhook received, task enqueued' });

  await executeTask(task, agent, fullPrompt, { source: 'webhook' });
});

export default router;
