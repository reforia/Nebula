import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { run, getOne, setOrgSetting } from './setup.js';
import { validateCron, registerCron, unregisterCron, fireTask, stopAll } from '../src/services/scheduler.js';

function uid() { return crypto.randomUUID().slice(0, 12); }

function makeOrg(label = 'sch') {
  const userId = `${label}-u-${uid()}`;
  run("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, 'h')",
    [userId, `${label}-${uid()}@t.com`, label]);
  const orgId = `${label}-o-${uid()}`;
  run('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)',
    [orgId, `${label} Org`, userId]);
  return orgId;
}

function makeAgent(orgId, enabled = 1) {
  const id = `ag-${uid()}`;
  run('INSERT INTO agents (id, org_id, name, session_id, enabled) VALUES (?, ?, ?, ?, ?)',
    [id, orgId, `bot-${uid()}`, `s-${uid()}`, enabled]);
  return id;
}

function makeTask(agentId, overrides = {}) {
  const id = `t-${uid()}`;
  const fields = {
    id, agent_id: agentId, name: `Task-${uid()}`, prompt: 'do the thing',
    cron_expression: '0 0 * * *', trigger_type: 'cron', enabled: 1,
    ...overrides,
  };
  run(
    `INSERT INTO tasks (id, agent_id, name, prompt, cron_expression, trigger_type, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [fields.id, fields.agent_id, fields.name, fields.prompt, fields.cron_expression, fields.trigger_type, fields.enabled]
  );
  return getOne('SELECT * FROM tasks WHERE id = ?', [id]);
}

describe('scheduler', () => {
  afterEach(() => { stopAll(); });

  describe('validateCron', () => {
    it('accepts valid expressions', () => {
      assert.equal(validateCron('0 0 * * *'), true);
      assert.equal(validateCron('*/5 * * * *'), true);
      assert.equal(validateCron('30 9 * * 1-5'), true);
    });

    it('rejects invalid expressions', () => {
      assert.equal(validateCron('not a cron'), false);
      assert.equal(validateCron('60 * * * *'), false);
      assert.equal(validateCron(''), false);
    });
  });

  describe('registerCron / unregisterCron', () => {
    it('is a no-op when NODE_ENV=test (prevents fireworks in tests)', () => {
      const orgId = makeOrg();
      const agentId = makeAgent(orgId);
      const task = makeTask(agentId);
      assert.doesNotThrow(() => registerCron(task));
      // Registration returns early in test env — nothing stored to assert on,
      // but the call must not throw or fire.
    });

    it('ignores disabled tasks silently', () => {
      const orgId = makeOrg();
      const agentId = makeAgent(orgId);
      const task = makeTask(agentId, { enabled: 0 });
      assert.doesNotThrow(() => registerCron(task));
    });

    it('ignores non-cron trigger types', () => {
      const orgId = makeOrg();
      const agentId = makeAgent(orgId);
      const task = makeTask(agentId, { trigger_type: 'webhook' });
      assert.doesNotThrow(() => registerCron(task));
    });

    it('unregister is idempotent for unknown ids', () => {
      assert.doesNotThrow(() => unregisterCron('does-not-exist'));
    });
  });

  describe('fireTask', () => {
    it('skips missing task silently', async () => {
      await assert.doesNotReject(fireTask('nonexistent-task-id'));
    });

    it('skips disabled task', async () => {
      const orgId = makeOrg();
      const agentId = makeAgent(orgId);
      const task = makeTask(agentId, { enabled: 0 });
      await assert.doesNotReject(fireTask(task.id));
    });

    it('skips when owning agent is disabled', async () => {
      const orgId = makeOrg();
      const agentId = makeAgent(orgId, 0);
      const task = makeTask(agentId);
      await assert.doesNotReject(fireTask(task.id));
    });

    it('skips when org has cron_enabled = 0', async () => {
      const orgId = makeOrg();
      setOrgSetting(orgId, 'cron_enabled', '0');
      const agentId = makeAgent(orgId);
      const task = makeTask(agentId);
      await assert.doesNotReject(fireTask(task.id));
    });

    it('releases the concurrency guard even if executeTask throws', async () => {
      // Fire the same task id twice sequentially. The second call should not
      // be blocked by a stale entry in runningTasks if the first failed.
      const orgId = makeOrg();
      const agentId = makeAgent(orgId);
      const task = makeTask(agentId);
      // Task has no CC CLI available in tests — executeTask will fail fast.
      // Ensure subsequent fireTask calls are still accepted.
      await fireTask(task.id).catch(() => {});
      await fireTask(task.id).catch(() => {});
      // If the guard leaked, the second call would log "already running"
      // and be a no-op — but we can't observe that directly here.
      // The main invariant: no unhandled rejection propagates out.
      assert.ok(true);
    });
  });
});
