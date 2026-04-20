import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resetDb, request, registerTestUser, run, getAll } from './setup.js';

const executor = (await import('../src/services/executor.js')).default;

const flush = () => new Promise(r => setImmediate(r));
// Some paths hop through two microtask queues (executor → messages route
// .then → executor again). Drain by pumping setImmediate a handful of times
// rather than sleeping on a timer.
async function drain(times = 6) {
  for (let i = 0; i < times; i++) await flush();
}

/**
 * Replace executor._execute so tests can observe enqueue traffic and resolve
 * individual calls on command. Mirrors the pattern used in executor.test.js.
 */
function mockExecutor() {
  const calls = [];
  const original = executor._execute.bind(executor);

  executor._execute = (job) => {
    const contextKey = executor._contextKey(job.agentId, job.options.projectId, job.options.branchName);
    const abortController = new AbortController();
    executor.abortControllers.set(contextKey, abortController);

    // Mirror the real _execute's typing emit so tests can assert on bubble
    // routing (displayConversationId vs. conversation.id). The real method
    // resolves conversation.id from the agent's default conversation; we
    // approximate by preferring displayConversationId (that's the whole
    // behavior under test) and falling back to the job's explicit
    // conversationId option, which is what messages.js passes.
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

async function createAgent(app, cookie, name) {
  const res = await request(app, 'POST', '/api/agents', { cookie, body: { name } });
  return res.body;
}

describe('@mention fan-out concurrency', () => {
  let app, cookie, orgId;
  let primary, alice, bob, carol, dave;
  let mock;

  beforeEach(async () => {
    resetDb();
    resetExecutor();
    app = createApp();
    ({ cookie, orgId } = registerTestUser(app));

    primary = await createAgent(app, cookie, 'Primary');
    alice = await createAgent(app, cookie, 'Alice');
    bob = await createAgent(app, cookie, 'Bob');
    carol = await createAgent(app, cookie, 'Carol');
    dave = await createAgent(app, cookie, 'Dave');

    mock = mockExecutor();
  });

  afterEach(() => {
    mock.restore();
    resetExecutor();
  });

  it('dispatches all mentioned agents concurrently before running the primary agent', async () => {
    // Two mentions → the route spins up Alice + Bob in parallel, waits for
    // both, then runs Primary with their responses stitched in.
    const post = await request(app, 'POST', `/api/agents/${primary.id}/messages`, {
      cookie,
      body: { content: '@Alice @Bob please review' },
    });
    assert.equal(post.status, 201);

    await drain();
    // Alice + Bob are mentioned, Primary is held back waiting on them.
    assert.equal(mock.calls.length, 2, 'both mentioned agents should start concurrently');
    const firstRoundAgents = new Set(mock.calls.map(c => c.job.agentId));
    assert.ok(firstRoundAgents.has(alice.id), 'Alice should be dispatched');
    assert.ok(firstRoundAgents.has(bob.id), 'Bob should be dispatched');
    assert.ok(!firstRoundAgents.has(primary.id), 'Primary should NOT run until mentions complete');

    mock.complete(0, { result: 'alice says hi' });
    mock.complete(1, { result: 'bob says hi' });
    await drain();

    // Primary now fires with a prompt enriched by the mentioned agents' replies.
    assert.equal(mock.calls.length, 3, 'Primary should run after mentions complete');
    assert.equal(mock.calls[2].job.agentId, primary.id);
    assert.match(
      mock.calls[2].job.prompt,
      /Responses from mentioned agents/,
      'Primary prompt should include the mention fan-out responses'
    );

    mock.complete(2, { result: 'primary synthesis' });
    await drain();

    // Each agent's reply (plus the primary's) should be persisted as a
    // message on the display conversation.
    const msgs = getAll('SELECT agent_id, role, message_type, content FROM messages ORDER BY created_at ASC');
    const assistantReplies = msgs.filter(m => m.role === 'assistant' && m.message_type === 'chat');
    assert.ok(assistantReplies.some(m => m.agent_id === alice.id), 'Alice reply persisted');
    assert.ok(assistantReplies.some(m => m.agent_id === bob.id), 'Bob reply persisted');
    assert.ok(assistantReplies.some(m => m.agent_id === primary.id), 'Primary reply persisted');
  });

  it('falls back to primary execution if a mentioned agent fails', async () => {
    const post = await request(app, 'POST', `/api/agents/${primary.id}/messages`, {
      cookie,
      body: { content: '@Alice help me out' },
    });
    assert.equal(post.status, 201);

    await drain();
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].job.agentId, alice.id);

    // Alice fails — route catches it, records an error message, and still
    // runs Primary so the user gets a response.
    mock.calls[0].reject(new Error('alice blew up'));
    await drain();

    assert.equal(mock.calls.length, 2, 'Primary should still run after mention failure');
    assert.equal(mock.calls[1].job.agentId, primary.id);
    mock.complete(1, { result: 'primary coped' });
    await drain();

    const errs = getAll("SELECT * FROM messages WHERE message_type = 'error' AND agent_id = ?", [alice.id]);
    assert.equal(errs.length, 1, 'Alice failure recorded as error message');
  });

  it('ignores unknown @mentions and self-mentions without blocking primary', async () => {
    // @Primary is the sender — must be filtered. @Nobody doesn't exist —
    // resolved to null and dropped. Result: no mentions dispatched, Primary
    // runs immediately.
    const post = await request(app, 'POST', `/api/agents/${primary.id}/messages`, {
      cookie,
      body: { content: '@Primary @Nobody talking to myself' },
    });
    assert.equal(post.status, 201);

    await drain();
    assert.equal(mock.calls.length, 1, 'only Primary should run');
    assert.equal(mock.calls[0].job.agentId, primary.id);
    mock.complete(0, { result: 'ok' });
    await drain();
  });

  it('caps recursive agent-response mentions at 3 (MAX_MENTIONS)', async () => {
    // User pings Primary normally. Primary's response contains 4 @mentions —
    // the processAgentMentions guard on the response path should only dispatch
    // the first 3. This is the cap that protects against a runaway agent.
    const post = await request(app, 'POST', `/api/agents/${primary.id}/messages`, {
      cookie,
      body: { content: 'hello' },
    });
    assert.equal(post.status, 201);

    await drain();
    assert.equal(mock.calls.length, 1, 'only Primary runs first');
    assert.equal(mock.calls[0].job.agentId, primary.id);

    // Primary's output mentions 4 agents. The response path should dispatch
    // 3 (Alice, Bob, Carol) and drop Dave.
    mock.complete(0, { result: '@Alice @Bob @Carol @Dave over to you' });
    await drain();

    const responseAgents = new Set(mock.calls.slice(1).map(c => c.job.agentId));
    assert.equal(responseAgents.size, 3, 'cap should allow exactly 3 mention dispatches');
    assert.ok(!responseAgents.has(dave.id), 'Dave (4th mention) should be dropped');

    for (let i = 1; i < mock.calls.length; i++) mock.complete(i, { result: 'ack' });
    await drain();
  });
});
