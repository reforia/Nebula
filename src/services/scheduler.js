import { Cron } from 'croner';
import { getAll, getOne, getOrgSetting } from '../db.js';
import { executeTask } from './task-executor.js';

const SYS_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const activeCrons = new Map(); // taskId -> Cron instance

// Stagger queue — when multiple cron tasks fire at the same time,
// space them out by `task_stagger_ms` to avoid rate limit exhaustion.
const staggerQueue = [];
let staggerRunning = false;

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

  const job = new Cron(task.cron_expression, { timezone: SYS_TZ }, () => {
    enqueueFire(task.id);
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

function enqueueFire(taskId) {
  staggerQueue.push(taskId);
  if (!staggerRunning) processStaggerQueue();
}

async function processStaggerQueue() {
  staggerRunning = true;

  while (staggerQueue.length > 0) {
    const taskId = staggerQueue.shift();

    // Fire-and-forget — don't wait for task completion before starting the next
    fireTask(taskId).catch(err => {
      console.error(`[scheduler] Unhandled error in task ${taskId}:`, err.message);
    });

    // If more tasks are queued, wait the stagger interval before firing the next
    if (staggerQueue.length > 0) {
      const staggerMs = getStaggerMs();
      if (staggerMs > 0) {
        console.log(`[scheduler] Staggering next task by ${staggerMs}ms (${staggerQueue.length} remaining)`);
        await new Promise(r => setTimeout(r, staggerMs));
      }
    }
  }

  staggerRunning = false;
}

function getStaggerMs() {
  // Check all orgs for a stagger setting — in practice there's usually one active org.
  // Use the first non-zero value found.
  const row = getOne("SELECT value FROM org_settings WHERE key = 'task_stagger_ms' AND CAST(value AS INTEGER) > 0 LIMIT 1");
  return parseInt(row?.value) || 0;
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

  if (getOrgSetting(agent.org_id, 'cron_enabled') === '0') {
    console.warn(`[scheduler] Cron tasks paused for org ${agent.org_id}, skipping task "${task.name}"`);
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
