import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Set up temp DATA_DIR before importing registry (which imports db.js indirectly)
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-registry-test-'));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = 'test';
process.env.NEBULA_ENCRYPTION_KEY ||=
  '0000000000000000000000000000000000000000000000000000000000000001';

// Import base class and registry directly (not from index.js which auto-detects)
const { ExecutionBackend } = await import('../src/backends/base.js');
const { CLIRegistry } = await import('../src/backends/cli-registry.js').then(m => {
  // We need to test a fresh instance, not the singleton
  return { CLIRegistry: m.registry.constructor };
});

// Minimal mock adapter for testing
class MockAdapter extends ExecutionBackend {
  constructor(id, opts = {}) {
    super(id);
    this.cliId = id;
    this.displayName = opts.displayName || id;
    this.binaryNames = opts.binaryNames || [];
    this.fallbackPaths = opts.fallbackPaths || [];
    this.skillInjection = opts.skillInjection || 'disk';
    this.hasBuiltinWebTools = opts.hasBuiltinWebTools || false;
    this.requiresApiKey = opts.requiresApiKey || false;
    this.supportedModelPrefixes = opts.supportedModelPrefixes || [];
    // Allow tests to control availability
    this._forceAvailable = opts.available ?? false;
  }

  detectBinary() {
    if (this._forceAvailable) {
      this.isAvailable = true;
      this.binaryPath = `/usr/local/bin/${this.cliId}`;
      return this.binaryPath;
    }
    this.isAvailable = false;
    this.binaryPath = null;
    return null;
  }

  listModels() {
    return [];
  }
}

// Fresh registry for each test
function createRegistry() {
  // Can't import the class directly since it's not exported, so replicate
  const mod = { _adapters: new Map() };
  // Re-create by constructing via the prototype
  const { registry } = await_import_sync();
  return registry;
}

// Since we can't easily get a fresh registry from the module (it's a singleton),
// we'll test using a manually-constructed registry-like object that has the same methods.
// Actually, let's just re-import and construct fresh instances.

describe('CLI Registry', () => {
  let registry;

  beforeEach(() => {
    // Create a fresh registry instance for each test
    // We manually create a new instance with the same API
    registry = new (class extends Object {
      constructor() {
        super();
        this._adapters = new Map();
      }
    })();
    // Copy methods from the real registry prototype
    const proto = Object.getPrototypeOf(
      (() => { const { registry: r } = require_sync(); return r; })()
    );
    // Instead, let's just test with a simulated registry
  });

  // Since we can't easily instantiate CLIRegistry (not exported as class),
  // let's test the individual components
});

// Simpler approach: test through the actual registry by registering/unregistering
// Actually let's re-approach this. The CLIRegistry class isn't exported,
// but the singleton is. Let's test adapter properties and registry behavior
// through integration-style tests.

describe('ExecutionBackend base', () => {
  it('canRunModel returns true when supportedModelPrefixes is empty', () => {
    const adapter = new MockAdapter('test', { supportedModelPrefixes: [] });
    assert.equal(adapter.canRunModel('gpt-4o'), true);
    assert.equal(adapter.canRunModel('claude-sonnet-4-6'), true);
    assert.equal(adapter.canRunModel('anything'), true);
  });

  it('canRunModel checks prefixes when set', () => {
    const adapter = new MockAdapter('test', { supportedModelPrefixes: ['claude-'] });
    assert.equal(adapter.canRunModel('claude-sonnet-4-6'), true);
    assert.equal(adapter.canRunModel('claude-opus-4-6'), true);
    assert.equal(adapter.canRunModel('gpt-4o'), false);
    assert.equal(adapter.canRunModel('openai/gpt-4o'), false);
  });

  it('detectBinary returns null when binary not found', () => {
    const adapter = new MockAdapter('nonexistent', { binaryNames: ['no-such-binary-xyz'] });
    const result = adapter.detectBinary();
    assert.equal(result, null);
    assert.equal(adapter.isAvailable, false);
    assert.equal(adapter.binaryPath, null);
  });

  it('detectBinary finds binary via fallback paths', () => {
    // Use a file we know exists — use base class detectBinary (not MockAdapter override)
    const tmpFile = path.join(TEST_DATA_DIR, 'mock-cli');
    fs.writeFileSync(tmpFile, '#!/bin/sh\n');
    const adapter = new ExecutionBackend('test');
    adapter.binaryNames = ['no-such-binary-xyz'];
    adapter.fallbackPaths = [tmpFile];
    const result = adapter.detectBinary();
    assert.equal(result, tmpFile);
    assert.equal(adapter.isAvailable, true);
    assert.equal(adapter.binaryPath, tmpFile);
  });

  it('declarative properties are accessible', () => {
    const adapter = new MockAdapter('test-cli', {
      displayName: 'Test CLI',
      skillInjection: 'systemprompt',
      hasBuiltinWebTools: true,
      requiresApiKey: true,
    });
    assert.equal(adapter.cliId, 'test-cli');
    assert.equal(adapter.displayName, 'Test CLI');
    assert.equal(adapter.skillInjection, 'systemprompt');
    assert.equal(adapter.hasBuiltinWebTools, true);
    assert.equal(adapter.requiresApiKey, true);
  });
});

describe('ClaudeCLIBackend adapter properties', async () => {
  const { ClaudeCLIBackend } = await import('../src/backends/claude-cli.js');
  const cc = new ClaudeCLIBackend();

  it('has correct cliId', () => {
    assert.equal(cc.cliId, 'claude-cli');
  });

  it('has disk skill injection', () => {
    assert.equal(cc.skillInjection, 'disk');
  });

  it('has built-in web tools', () => {
    assert.equal(cc.hasBuiltinWebTools, true);
  });

  it('does not require API key', () => {
    assert.equal(cc.requiresApiKey, false);
  });

  it('only supports claude models', () => {
    assert.equal(cc.canRunModel('claude-sonnet-4-6'), true);
    assert.equal(cc.canRunModel('claude-opus-4-6'), true);
    assert.equal(cc.canRunModel('gpt-4o'), false);
    assert.equal(cc.canRunModel('openai/gpt-4o'), false);
  });

  it('lists 3 models', () => {
    const models = cc.listModels();
    assert.equal(models.length, 3);
    assert.ok(models.some(m => m.id === 'claude-sonnet-4-6'));
  });

  it('parseOutput extracts result event', () => {
    const output = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      '{"type":"result","subtype":"success","result":"hello world","total_cost_usd":0.01,"usage":{"input_tokens":100,"output_tokens":50}}',
    ].join('\n');
    const result = cc.parseOutput(output);
    assert.equal(result.result, 'hello world');
    assert.equal(result.total_cost_usd, 0.01);
    assert.deepStrictEqual(result.tool_history, []);
  });

  it('parseOutput extracts tool history', () => {
    const output = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"path":"/tmp/x"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"file contents"}]}}',
      '{"type":"result","subtype":"success","result":"done","total_cost_usd":0,"usage":{}}',
    ].join('\n');
    const result = cc.parseOutput(output);
    assert.equal(result.tool_history.length, 1);
    assert.equal(result.tool_history[0].name, 'Read');
    assert.equal(result.tool_history[0].output, 'file contents');
  });

  it('parseOutput throws when no result event', () => {
    assert.throws(() => cc.parseOutput('{"type":"text"}'), /No result event/);
  });
});

describe('OpenCodeBackend adapter properties', async () => {
  const { OpenCodeBackend } = await import('../src/backends/opencode.js');
  const oc = new OpenCodeBackend();

  it('has correct cliId', () => {
    assert.equal(oc.cliId, 'opencode');
  });

  it('has systemprompt skill injection', () => {
    assert.equal(oc.skillInjection, 'systemprompt');
  });

  it('has built-in web tools', () => {
    assert.equal(oc.hasBuiltinWebTools, true);
  });

  it('requires API key', () => {
    assert.equal(oc.requiresApiKey, true);
  });

  it('accepts any model', () => {
    assert.equal(oc.canRunModel('claude-sonnet-4-6'), true);
    assert.equal(oc.canRunModel('gpt-4o'), true);
    assert.equal(oc.canRunModel('anything/at/all'), true);
  });

  it('mapModelId adds provider prefix for bare Claude models', () => {
    assert.equal(oc.mapModelId('claude-sonnet-4-6'), 'anthropic/claude-sonnet-4-6');
  });

  it('mapModelId adds provider prefix for bare GPT models', () => {
    assert.equal(oc.mapModelId('gpt-4o'), 'openai/gpt-4o');
    assert.equal(oc.mapModelId('o3-mini'), 'openai/o3-mini');
    assert.equal(oc.mapModelId('o4-mini'), 'openai/o4-mini');
  });

  it('mapModelId passes through already-qualified models', () => {
    assert.equal(oc.mapModelId('openrouter/anthropic/claude-sonnet-4'), 'openrouter/anthropic/claude-sonnet-4');
    assert.equal(oc.mapModelId('openai/gpt-4o'), 'openai/gpt-4o');
  });

  it('returns empty model list (user enters OpenCode model IDs directly)', () => {
    const models = oc.listModels();
    assert.strictEqual(models.length, 0);
  });

  it('_writeConfig registers 2-part model under provider.models (bypasses stale catalog)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-oc-cfg-'));
    oc._writeConfig({ model: 'claude-sonnet-4-6', allowed_tools: '' }, tmp, []);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'opencode.json'), 'utf8'));
    assert.ok(cfg.provider?.anthropic?.models?.['claude-sonnet-4-6']);
  });

  it('_writeConfig registers 3-part OpenRouter model under its provider slug', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-oc-cfg-'));
    oc._writeConfig({ model: 'openrouter/deepseek/deepseek-v3.2', allowed_tools: '' }, tmp, []);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'opencode.json'), 'utf8'));
    assert.ok(cfg.provider?.openrouter?.models?.['deepseek/deepseek-v3.2']);
  });

  it('_writeConfig leaves provider block out when model has no slash', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-oc-cfg-'));
    oc._writeConfig({ model: 'bare-model', allowed_tools: '' }, tmp, []);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'opencode.json'), 'utf8'));
    assert.strictEqual(cfg.provider, undefined);
  });

  it('parseOutput extracts text, usage and cost from OpenCode 1.4.x nested "part" events (tested against 1.4.3)', () => {
    const stream = [
      '{"type":"step_start","timestamp":1,"sessionID":"ses_abc","part":{"id":"prt_1","messageID":"msg_1","sessionID":"ses_abc","type":"step-start"}}',
      '{"type":"text","timestamp":2,"sessionID":"ses_abc","part":{"id":"prt_2","messageID":"msg_1","sessionID":"ses_abc","type":"text","text":"Hi there — I\'m back online."}}',
      '{"type":"step_finish","timestamp":3,"sessionID":"ses_abc","part":{"id":"prt_3","reason":"stop","messageID":"msg_1","sessionID":"ses_abc","type":"step-finish","tokens":{"total":20543,"input":18571,"output":116,"reasoning":0,"cache":{"write":0,"read":1856}},"cost":0.00524628}}',
    ].join('\n');
    const out = oc.parseOutput(stream, Date.now());
    assert.equal(out.result, "Hi there — I'm back online.");
    assert.equal(out.usage.input_tokens, 18571);
    assert.equal(out.usage.output_tokens, 116);
    assert.equal(out.total_cost_usd, 0.00524628);
    assert.equal(out.cli_session_id, 'ses_abc');
  });
});

describe('Registry integration (via backends/index.js)', async () => {
  const { registry, getBackend, listBackends, listAllModels } = await import('../src/backends/index.js');

  it('has claude-cli registered', () => {
    const cc = registry.get('claude-cli');
    assert.equal(cc.cliId, 'claude-cli');
  });

  it('has opencode registered', () => {
    const oc = registry.get('opencode');
    assert.equal(oc.cliId, 'opencode');
  });

  it('get() throws for unknown CLI', () => {
    assert.throws(() => registry.get('nonexistent'), /Unknown CLI runtime/);
  });

  it('getAll() returns both adapters', () => {
    const all = registry.getAll();
    assert.ok(all.length >= 2);
    const ids = all.map(a => a.cliId);
    assert.ok(ids.includes('claude-cli'));
    assert.ok(ids.includes('opencode'));
  });

  it('listBackends() returns CLI IDs', () => {
    const backends = listBackends();
    assert.ok(backends.includes('claude-cli'));
    assert.ok(backends.includes('opencode'));
  });

  it('getBackend() returns adapter by name', () => {
    const cc = getBackend('claude-cli');
    assert.equal(cc.cliId, 'claude-cli');
  });

  it('getBackend() falls back gracefully for unknown name', () => {
    const fallback = getBackend('nonexistent');
    assert.ok(fallback); // Should not throw
  });

  it('resolveForAgent uses agent.backend when available', () => {
    // Mock an agent with claude-cli backend
    const agent = { backend: 'claude-cli', model: 'claude-sonnet-4-6' };
    const cc = registry.get('claude-cli');
    // Only works if claude-cli is detected; if not, it falls back
    if (cc.isAvailable) {
      const resolved = registry.resolveForAgent(agent);
      assert.equal(resolved.cliId, 'claude-cli');
    }
  });

  it('resolveForAgent falls back when agent CLI cannot run model', () => {
    // claude-cli can't run gpt-4o, should fall back to opencode
    const agent = { backend: 'claude-cli', model: 'gpt-4o' };
    const oc = registry.get('opencode');
    if (oc.isAvailable) {
      const resolved = registry.resolveForAgent(agent);
      assert.equal(resolved.cliId, 'opencode');
    }
  });

  it('resolveForAgent throws when no CLI can run the model and none available', () => {
    // Save availability state
    const adapters = registry.getAll();
    const origStates = adapters.map(a => ({ a, was: a.isAvailable }));
    // Temporarily make all unavailable
    adapters.forEach(a => { a.isAvailable = false; });
    try {
      assert.throws(() => {
        registry.resolveForAgent({ backend: 'claude-cli', model: 'claude-sonnet-4-6' });
      }, /No CLI runtime available/);
    } finally {
      origStates.forEach(({ a, was }) => { a.isAvailable = was; });
    }
  });

  it('listAllModels includes claude-cli models', () => {
    const models = listAllModels();
    assert.ok(models.some(m => m.id === 'claude-sonnet-4-6'));
  });
});

describe('Adding a third CLI', async () => {
  const { registry } = await import('../src/backends/index.js');

  it('can register and retrieve a new adapter', () => {
    const codex = new MockAdapter('codex', {
      displayName: 'Codex CLI',
      supportedModelPrefixes: ['codex-'],
      available: true,
    });
    registry.register(codex);
    codex.detectBinary(); // trigger availability

    const retrieved = registry.get('codex');
    assert.equal(retrieved.cliId, 'codex');
    assert.equal(retrieved.displayName, 'Codex CLI');
    assert.equal(retrieved.isAvailable, true);

    // Appears in getAll
    const all = registry.getAll();
    assert.ok(all.some(a => a.cliId === 'codex'));

    // Agent can select it
    const agent = { backend: 'codex', model: 'codex-large' };
    const resolved = registry.resolveForAgent(agent);
    assert.equal(resolved.cliId, 'codex');

    // Clean up — remove from registry to not affect other tests
    registry._adapters.delete('codex');
  });
});
