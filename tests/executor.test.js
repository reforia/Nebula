import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Set up temp DATA_DIR before importing executor (which imports db.js)
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-executor-test-'));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = 'test';

const executor = (await import('../src/services/executor.js')).default;

const flush = () => new Promise(r => setImmediate(r));

// Controllable mock: replaces _execute with promises resolved by test code
function mockExecutor() {
  const calls = [];
  const original = executor._execute.bind(executor);

  executor._execute = (job) => {
    // Set up abort controller like the real _execute does
    const contextKey = executor._contextKey(job.agentId, job.options.projectId, job.options.branchName);
    const abortController = new AbortController();
    executor.abortControllers.set(contextKey, abortController);

    return new Promise((resolve, reject) => {
      const entry = { job, resolve, reject, abortController };
      calls.push(entry);

      // Listen for abort signal so cancel() works
      abortController.signal.addEventListener('abort', () => {
        reject(new Error('Aborted'));
      });
    }).finally(() => {
      executor.abortControllers.delete(contextKey);
    });
  };

  return {
    calls,
    complete(index, result = { result: 'ok', duration_ms: 0 }) {
      calls[index].resolve(result);
    },
    fail(index, error = new Error('fail')) {
      calls[index].reject(error);
    },
    restore() {
      executor._execute = original;
    },
  };
}

function resetExecutor() {
  executor.queues.clear();
  executor.activeKeys.clear();
  executor.abortControllers.clear();
  executor.processing = false;
  executor.removeAllListeners();
}

describe('Executor Concurrency', () => {
  let mock;

  beforeEach(() => {
    resetExecutor();
    mock = mockExecutor();
  });

  afterEach(() => {
    mock.restore();
    resetExecutor();
  });

  it('executes two jobs on different branches concurrently', async () => {
    const p1 = executor.enqueue('a1', 'task1', { projectId: 'p1', branchName: 'feature/auth' });
    const p2 = executor.enqueue('a1', 'task2', { projectId: 'p1', branchName: 'feature/docs' });

    await flush();
    assert.equal(mock.calls.length, 2, 'both jobs should start concurrently');

    mock.complete(0);
    mock.complete(1);
    await Promise.all([p1, p2]);
  });

  it('serializes two jobs on the same branch', async () => {
    const p1 = executor.enqueue('a1', 'task1', { projectId: 'p1', branchName: 'feature/auth' });
    const p2 = executor.enqueue('a1', 'task2', { projectId: 'p1', branchName: 'feature/auth' });

    await flush();
    assert.equal(mock.calls.length, 1, 'only first job should start');

    mock.complete(0);
    await flush();
    assert.equal(mock.calls.length, 2, 'second job should start after first completes');

    mock.complete(1);
    await Promise.all([p1, p2]);
  });

  it('global context does not block project context', async () => {
    const p1 = executor.enqueue('a1', 'global-task');
    const p2 = executor.enqueue('a1', 'project-task', { projectId: 'p1', branchName: 'feature/auth' });

    await flush();
    assert.equal(mock.calls.length, 2, 'global and project jobs should run concurrently');

    mock.complete(0);
    mock.complete(1);
    await Promise.all([p1, p2]);
  });

  it('backward compat: no projectId serializes per agent', async () => {
    const p1 = executor.enqueue('a1', 'task1');
    const p2 = executor.enqueue('a1', 'task2');

    await flush();
    assert.equal(mock.calls.length, 1, 'should serialize like old behavior');

    mock.complete(0);
    await flush();
    assert.equal(mock.calls.length, 2);

    mock.complete(1);
    await Promise.all([p1, p2]);
  });

  it('enforces concurrency cap within a project', async () => {
    const opts = (branch) => ({ projectId: 'p1', branchName: branch, maxConcurrent: 3 });
    const p1 = executor.enqueue('a1', 't1', opts('b1'));
    const p2 = executor.enqueue('a1', 't2', opts('b2'));
    const p3 = executor.enqueue('a1', 't3', opts('b3'));
    const p4 = executor.enqueue('a1', 't4', opts('b4'));

    await flush();
    assert.equal(mock.calls.length, 3, '4th job should be held by concurrency cap');

    mock.complete(0);
    await flush();
    assert.equal(mock.calls.length, 4, '4th job should start after one completes');

    mock.complete(1);
    mock.complete(2);
    mock.complete(3);
    await Promise.all([p1, p2, p3, p4]);
  });

  it('cancels specific context only', async () => {
    const p1 = executor.enqueue('a1', 't1', { projectId: 'p1', branchName: 'feature/auth' }).catch(() => 'cancelled');
    const p2 = executor.enqueue('a1', 't2', { projectId: 'p1', branchName: 'feature/docs' }).catch(() => 'cancelled');

    await flush();
    assert.equal(mock.calls.length, 2);

    const cancelled = executor.cancel('a1', 'p1', 'feature/auth');
    assert.equal(cancelled, true);

    // Wait for abort rejection to propagate and .finally() to clean up
    await flush();

    // feature/docs should still have its controller
    assert.equal(executor.abortControllers.size, 1);
    const remainingKey = [...executor.abortControllers.keys()][0];
    assert.ok(remainingKey.includes('feature/docs'));

    const r1 = await p1;
    assert.equal(r1, 'cancelled');

    mock.complete(1);
    await p2;
  });

  it('cancels all contexts in a project', async () => {
    const p1 = executor.enqueue('a1', 't1', { projectId: 'p1', branchName: 'feature/auth' }).catch(() => 'cancelled');
    const p2 = executor.enqueue('a1', 't2', { projectId: 'p1', branchName: 'feature/docs' }).catch(() => 'cancelled');
    const pGlobal = executor.enqueue('a1', 'global');

    await flush();
    assert.equal(mock.calls.length, 3);

    const cancelled = executor.cancel('a1', 'p1');
    assert.equal(cancelled, true);

    await flush();

    // Global context should still have its controller
    assert.equal(executor.abortControllers.size, 1);
    const remainingKey = [...executor.abortControllers.keys()][0];
    assert.ok(remainingKey.includes('global'));

    assert.equal(await p1, 'cancelled');
    assert.equal(await p2, 'cancelled');

    mock.complete(2);
    await pGlobal;
  });

  it('cancels all contexts for agent', async () => {
    const p1 = executor.enqueue('a1', 'global').catch(() => 'cancelled');
    const p2 = executor.enqueue('a1', 't2', { projectId: 'p1', branchName: 'feature/auth' }).catch(() => 'cancelled');

    await flush();
    assert.equal(mock.calls.length, 2);

    const cancelled = executor.cancel('a1');
    assert.equal(cancelled, true);

    await flush();
    assert.equal(executor.abortControllers.size, 0);

    assert.equal(await p1, 'cancelled');
    assert.equal(await p2, 'cancelled');
  });

  it('drains correctly after concurrent completions', async () => {
    const opts = (branch) => ({ projectId: 'p1', branchName: branch, maxConcurrent: 2 });
    const promises = [
      executor.enqueue('a1', 't1', opts('b1')),
      executor.enqueue('a1', 't2', opts('b2')),
      executor.enqueue('a1', 't3', opts('b3')),
      executor.enqueue('a1', 't4', opts('b4')),
    ];

    await flush();
    assert.equal(mock.calls.length, 2, 'first 2 should start');

    mock.complete(0);
    mock.complete(1);
    await flush();
    assert.equal(mock.calls.length, 4, 'remaining 2 should start');

    mock.complete(2);
    mock.complete(3);
    const results = await Promise.all(promises);
    assert.equal(results.length, 4);
  });

  it('respects priority ordering within same context', async () => {
    // Start a job to occupy the global context
    const p1 = executor.enqueue('a1', 'first');
    await flush();
    assert.equal(mock.calls.length, 1);

    // Queue two more — one normal, one priority
    const p2 = executor.enqueue('a1', 'normal');
    const p3 = executor.enqueue('a1', 'priority', { priority: true });

    // Complete first job — priority should start next
    mock.complete(0);
    await flush();
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[1].job.prompt, 'priority', 'priority job should start before normal');

    mock.complete(1);
    await flush();
    assert.equal(mock.calls.length, 3);
    assert.equal(mock.calls[2].job.prompt, 'normal');

    mock.complete(2);
    await Promise.all([p1, p2, p3]);
  });

  it('agent_typing event includes project and branch fields', async () => {
    const events = [];
    executor.on('agent_typing', (evt) => events.push(evt));

    // Override _execute to emit typing events like the real one
    mock.restore();
    executor._execute = (job) => {
      executor.emit('agent_typing', {
        agentId: job.agentId, orgId: 'test-org', conversationId: 'test-conv', active: true,
        projectId: job.options.projectId || null, branchName: job.options.branchName || null,
      });
      return Promise.resolve({ result: 'ok', duration_ms: 0 });
    };

    await executor.enqueue('a1', 'test', { projectId: 'p1', branchName: 'feature/auth' });
    assert.ok(events.length >= 1);
    const typingEvent = events[0];
    assert.equal(typingEvent.projectId, 'p1');
    assert.equal(typingEvent.branchName, 'feature/auth');
    assert.equal(typingEvent.active, true);
  });

  it('cancel drains queued jobs', async () => {
    // Start a job to occupy the global context
    const p1 = executor.enqueue('a1', 'active');
    await flush();

    // Queue another
    const p2 = executor.enqueue('a1', 'queued');

    // Cancel all — active gets aborted, queued gets rejected
    executor.cancel('a1');

    const err2 = await p2.catch(e => e);
    assert.ok(err2 instanceof Error);
    assert.match(err2.message, /cancelled/i);

    // p1 will also reject/complete due to abort
    await p1.catch(() => {});
  });

  it('different agents execute concurrently (unchanged behavior)', async () => {
    const p1 = executor.enqueue('a1', 'task1');
    const p2 = executor.enqueue('a2', 'task2');

    await flush();
    assert.equal(mock.calls.length, 2, 'different agents should run concurrently');

    mock.complete(0);
    mock.complete(1);
    await Promise.all([p1, p2]);
  });
});
