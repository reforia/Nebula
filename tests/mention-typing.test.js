import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser } from './setup.js';

const executor = (await import('../src/services/executor.js')).default;

const flush = () => new Promise(r => setImmediate(r));
async function drain(times = 6) {
  for (let i = 0; i < times; i++) await flush();
}

/**
 * Replaces executor._execute while preserving the typing-state emit so tests
 * can assert which conversation the bubble is routed to. This is a narrower
 * mock than executor.test.js uses — the typing contract is what we verify.
 */
function mockExecutorWithTyping() {
  const calls = [];
  const original = executor._execute.bind(executor);

  executor._execute = (job) => {
    const contextKey = executor._contextKey(job.agentId, job.options.projectId, job.options.branchName);
    const abortController = new AbortController();
    executor.abortControllers.set(contextKey, abortController);

    // Mirror the real emit: prefer displayConversationId so the bubble lands
    // where the user is looking for @mention flows, fall back to the execution
    // conversation for normal sends and @notify.
    const typingConversationId = job.options.displayConversationId || job.options.conversationId || null;
    const typingInfo = {
      agentId: job.agentId, orgId: job.options.orgId || null,
      conversationId: typingConversationId,
      projectId: job.options.projectId || null,
      branchName: job.options.branchName || null,
    };
    executor.typingState.set(contextKey, typingInfo);
    executor.emit('agent_typing', { ...typingInfo, active: true });

    return new Promise((resolve, reject) => {
      calls.push({ job, resolve, reject, abortController });
      abortController.signal.addEventListener('abort', () => reject(new Error('Aborted')));
    }).finally(() => {
      executor.abortControllers.delete(contextKey);
      executor.typingState.delete(contextKey);
      executor.emit('agent_typing', { ...typingInfo, active: false });
    });
  };

  return {
    calls,
    complete(index, result = {}) {
      const def = { result: 'mock-response', duration_ms: 1, total_cost_usd: 0, usage: {} };
      calls[index].resolve({ ...def, ...result });
    },
    restore() { executor._execute = original; },
  };
}

function resetExecutor() {
  executor.queues.clear();
  executor.activeKeys.clear();
  executor.abortControllers.clear();
  executor.typingState.clear();
  executor.processing = false;
  executor.removeAllListeners();
}

async function createAgent(app, cookie, name) {
  const res = await request(app, 'POST', '/api/agents', { cookie, body: { name } });
  return res.body;
}

describe('@mention typing bubble routing', () => {
  let app, cookie;
  let primary, alice;
  let mock;

  beforeEach(async () => {
    resetDb();
    resetExecutor();
    app = createApp();
    ({ cookie } = registerTestUser(app));
    primary = await createAgent(app, cookie, 'Primary');
    alice = await createAgent(app, cookie, 'Alice');
    mock = mockExecutorWithTyping();
  });

  afterEach(() => {
    mock.restore();
    resetExecutor();
  });

  it('routes @mention typing bubble to the initiator\'s conversation', async () => {
    // Regression: before the fix, the executor emitted conversation_id =
    // target's own conversation (where the CLI session lives), so the typing
    // bubble showed up in Alice's private chat instead of Primary's. The fix
    // switches the emit to displayConversationId when the route passes one —
    // which messages.js does for every @mention path.
    const typingEvents = [];
    const listener = (ev) => typingEvents.push(ev);
    executor.on('agent_typing', listener);

    try {
      const post = await request(app, 'POST', `/api/agents/${primary.id}/messages`, {
        cookie,
        body: { content: '@Alice take a look' },
      });
      assert.equal(post.status, 201);
      const userMsg = post.body;

      await drain();
      const aliceStart = typingEvents.find(e => e.agentId === alice.id && e.active === true);
      assert.ok(aliceStart, 'Alice typing start event should fire');
      assert.equal(
        aliceStart.conversationId,
        userMsg.conversation_id,
        'Alice typing bubble must route to the initiator\'s conversation, not her own'
      );

      mock.complete(0, { result: 'alice done' });
      await drain();

      const aliceStop = typingEvents.find(e => e.agentId === alice.id && e.active === false);
      assert.ok(aliceStop, 'Alice typing stop event should fire');
      assert.equal(aliceStop.conversationId, userMsg.conversation_id, 'stop event must match start');

      mock.complete(1, { result: 'primary done' });
      await drain();
    } finally {
      executor.off('agent_typing', listener);
    }
  });

  it('routes @notify typing bubble to the target\'s own conversation', async () => {
    // @notify is the other half of the contract: the target responds in
    // its OWN conversation, so its typing bubble must render there.
    // messages.js does NOT pass displayConversationId for @notify, so the
    // executor falls back to conversation.id — the target's conversation.
    const typingEvents = [];
    const listener = (ev) => typingEvents.push(ev);
    executor.on('agent_typing', listener);

    try {
      const post = await request(app, 'POST', `/api/agents/${primary.id}/messages`, {
        cookie,
        body: { content: '@notify Alice heads up' },
      });
      assert.equal(post.status, 201);
      const userMsg = post.body;

      await drain();
      const aliceStart = typingEvents.find(e => e.agentId === alice.id && e.active === true);
      assert.ok(aliceStart, 'Alice typing start should fire for @notify');
      assert.notEqual(
        aliceStart.conversationId,
        userMsg.conversation_id,
        '@notify bubble must NOT render in the initiator\'s conversation'
      );

      for (let i = 0; i < mock.calls.length; i++) mock.complete(i, { result: 'ok' });
      await drain();
    } finally {
      executor.off('agent_typing', listener);
    }
  });
});
