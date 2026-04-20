import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { run, getOne } from './setup.js';
import { rebuildAllIndices, rebuildIndex, search } from '../src/services/memory-search.js';

function uid() { return crypto.randomUUID().slice(0, 12); }

function makeOrg(label) {
  const userId = `${label}-u-${uid()}`;
  run("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, 'h')",
    [userId, `${label}-${uid()}@t.com`, label]);
  const orgId = `${label}-o-${uid()}`;
  run('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)',
    [orgId, `${label} Org`, userId]);
  return orgId;
}

function makeAgent(orgId, label = 'a') {
  const id = `${label}-${uid()}`;
  run('INSERT INTO agents (id, org_id, name, session_id) VALUES (?, ?, ?, ?)',
    [id, orgId, `${label}-${uid()}`, `s-${uid()}`]);
  return id;
}

function addMemory(orgId, ownerType, ownerId, title, description, content) {
  const id = uid();
  run(
    'INSERT INTO memories (id, org_id, owner_type, owner_id, title, description, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, orgId, ownerType, ownerId, title, description, content]
  );
  return id;
}

describe('memory-search (BM25)', () => {
  let orgId, agentId;

  beforeEach(() => {
    orgId = makeOrg('ms');
    agentId = makeAgent(orgId, 'searchbot');
  });

  it('returns empty for unindexed scope', () => {
    const results = search('agent', agentId, 'anything');
    assert.deepStrictEqual(results, []);
  });

  it('returns empty for empty query', () => {
    addMemory(orgId, 'agent', agentId, 'Auth flow', 'desc', 'content about auth');
    rebuildIndex('agent', agentId);
    assert.deepStrictEqual(search('agent', agentId, '   '), []);
  });

  it('ranks exact title match above body match', () => {
    addMemory(orgId, 'agent', agentId, 'Deployment guide', 'How to deploy', 'pipeline pushes to NAS');
    addMemory(orgId, 'agent', agentId, 'Random note', 'Just stuff', 'We sometimes also mention deployment in passing here.');
    rebuildIndex('agent', agentId);

    const results = search('agent', agentId, 'deployment');
    assert.ok(results.length >= 1, 'should find results');
    assert.equal(results[0].title, 'Deployment guide', 'title match should rank first');
  });

  it('title boost outranks content-only match', () => {
    addMemory(orgId, 'agent', agentId, 'Kubernetes cluster', 'k8s ops', 'unrelated body');
    addMemory(orgId, 'agent', agentId, 'Daily standup', 'meetings', 'Kubernetes was mentioned once');
    rebuildIndex('agent', agentId);

    const results = search('agent', agentId, 'kubernetes');
    assert.equal(results[0].title, 'Kubernetes cluster');
  });

  it('ignores tokens of length <= 1', () => {
    addMemory(orgId, 'agent', agentId, 'Important X', 'desc', 'content');
    rebuildIndex('agent', agentId);
    assert.deepStrictEqual(search('agent', agentId, 'x'), []);
  });

  it('is scoped — cross-agent memories do not leak', () => {
    const otherAgent = makeAgent(orgId, 'other');
    addMemory(orgId, 'agent', otherAgent, 'Secret sauce', 'desc', 'confidential content');
    addMemory(orgId, 'agent', agentId, 'Unrelated', 'desc', 'nothing interesting');
    rebuildIndex('agent', otherAgent);
    rebuildIndex('agent', agentId);

    const mine = search('agent', agentId, 'secret');
    assert.equal(mine.length, 0, 'must not see other agent memories');
    const theirs = search('agent', otherAgent, 'secret');
    assert.equal(theirs.length, 1);
  });

  it('returns a snippet around matched terms', () => {
    const longBody = 'x'.repeat(500) + ' needle in the middle ' + 'y'.repeat(500);
    addMemory(orgId, 'agent', agentId, 'Find the needle', 'desc', longBody);
    rebuildIndex('agent', agentId);
    const [hit] = search('agent', agentId, 'needle');
    assert.ok(hit, 'should find memory');
    assert.ok(hit.snippet.includes('needle'), 'snippet should contain matched term');
    assert.ok(hit.snippet.length < longBody.length, 'snippet should be shorter than full body');
  });

  it('rebuildIndex picks up new memories without full rebuild', () => {
    rebuildIndex('agent', agentId);
    assert.equal(search('agent', agentId, 'dragon').length, 0);
    addMemory(orgId, 'agent', agentId, 'Dragon', 'desc', 'fire-breathing lizard');
    rebuildIndex('agent', agentId);
    assert.equal(search('agent', agentId, 'dragon').length, 1);
  });

  it('rebuildIndex drops empty scope from cache', () => {
    addMemory(orgId, 'agent', agentId, 'Placeholder', 'desc', 'body');
    rebuildIndex('agent', agentId);
    assert.equal(search('agent', agentId, 'placeholder').length, 1);
    run('DELETE FROM memories WHERE owner_id = ?', [agentId]);
    rebuildIndex('agent', agentId);
    assert.deepStrictEqual(search('agent', agentId, 'placeholder'), []);
  });

  it('rebuildAllIndices scans every scope in DB', () => {
    const agent2 = makeAgent(orgId, 'second');
    addMemory(orgId, 'agent', agentId,  'Foo widget', 'desc', 'content a');
    addMemory(orgId, 'agent', agent2,   'Foo gadget', 'desc', 'content b');
    rebuildAllIndices();
    assert.equal(search('agent', agentId, 'foo').length, 1);
    assert.equal(search('agent', agent2,  'foo').length, 1);
  });

  it('respects limit param', () => {
    for (let i = 0; i < 10; i++) {
      addMemory(orgId, 'agent', agentId, `Note ${i}`, 'desc', 'alpha bravo charlie');
    }
    rebuildIndex('agent', agentId);
    const results = search('agent', agentId, 'alpha', 3);
    assert.equal(results.length, 3);
  });

  it('search result includes id, title, description, snippet, score', () => {
    addMemory(orgId, 'agent', agentId, 'Benchmarks', 'perf notes', 'latency improved');
    rebuildIndex('agent', agentId);
    const [hit] = search('agent', agentId, 'latency');
    assert.ok(hit);
    assert.ok(hit.id);
    assert.equal(hit.title, 'Benchmarks');
    assert.equal(hit.description, 'perf notes');
    assert.ok(hit.snippet);
    assert.ok(hit.score > 0);
  });
});
