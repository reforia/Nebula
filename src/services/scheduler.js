import { Cron } from 'croner';
import { getAll, getOne } from '../db.js';
import { executeTask } from './task-executor.js';

const activeCrons = new Map(); // taskId -> Cron instance

export function validateCron(expression) {
  try {
    new Cron(expression);
    return true;
  } catch {
    return false;
  }
}

export function initScheduler() {
  const tasks = getAll("SELECT * FROM tasks WHERE enabled = 1 AND trigger_type = 'cron'");
  for (const task of tasks) {
    registerCron(task);
  }
  console.log(`[scheduler] Loaded ${tasks.length} cron tasks`);
}

export function registerCron(task) {
  unregisterCron(task.id);

  if (!task.enabled || task.trigger_type !== 'cron' || process.env.NODE_ENV === 'test') return;

  if (!validateCron(task.cron_expression)) {
    console.error(`[scheduler] Invalid cron expression for task ${task.id}: ${task.cron_expression}`);
    return;
  }

  const job = new Cron(task.cron_expression, () => {
    fireTask(task.id).catch(err => {
      console.error(`[scheduler] Unhandled error in task ${task.id}:`, err.message);
    });
  });

  activeCrons.set(task.id, job);
}

export function unregisterCron(taskId) {
  const existing = activeCrons.get(taskId);
  if (existing) {
    existing.stop();
    activeCrons.delete(taskId);
  }
}

export async function fireTask(taskId) {
  const task = getOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task || !task.enabled) {
    if (task) console.warn(`[scheduler] Task "${task.name}" is disabled, skipping`);
    return;
  }

  const agent = getOne('SELECT * FROM agents WHERE id = ?', [task.agent_id]);
  if (!agent || !agent.enabled) {
    console.warn(`[scheduler] Agent for task "${task.name}" is ${agent ? 'disabled' : 'missing'}, skipping`);
    return;
  }

  await executeTask(task, agent, task.prompt, { source: 'scheduler' });
}

export function stopAll() {
  for (const [, job] of activeCrons) {
    job.stop();
  }
  activeCrons.clear();
}
