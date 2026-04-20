import { Router } from 'express';
import crypto from 'crypto';
import { getOne, getOrgSetting } from '../db.js';
import { sendError } from '../utils/response.js';
import { executeTask } from '../services/task-executor.js';

const router = Router();

// POST /api/webhooks/:taskId — receive webhook, fire the task
// Public endpoint — no session auth. Verified via webhook_secret.
router.post('/:taskId', async (req, res) => {
  const task = getOne('SELECT * FROM tasks WHERE id = ?', [req.params.taskId]);
  if (!task) return sendError(res, 404, 'Task not found');
  if (!task.enabled) return sendError(res, 400, 'Task is disabled');
  if (task.trigger_type !== 'webhook') return sendError(res, 400, 'Task is not a webhook trigger');

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
          return sendError(res, 401, 'Invalid signature');
        }
      } else {
        return sendError(res, 401, 'Missing or invalid secret');
      }
    }
  }

  const agent = getOne('SELECT * FROM agents WHERE id = ?', [task.agent_id]);
  if (!agent || !agent.enabled) return sendError(res, 400, 'Agent is disabled');

  if (getOrgSetting(agent.org_id, 'cron_enabled') === '0') {
    return sendError(res, 503, 'Task execution is paused for this organization');
  }

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
