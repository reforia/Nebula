# Adding a New CLI Runtime

Nebula uses a CLI Registry pattern where each coding assistant CLI (Claude Code, OpenCode, Codex, Gemini CLI, Aider, etc.) is represented as an adapter. Adding support for a new CLI requires **one file** and **one line of registration**.

## Quick Start

1. Create `src/backends/your-cli.js` implementing the adapter interface
2. Add `registry.register(new YourCLIBackend())` in `src/backends/index.js`

No executor changes. No frontend changes. No migration. The registry auto-detects the binary, the frontend dynamically shows it.

## Adapter Interface

Every adapter extends `ExecutionBackend` from `src/backends/base.js` and sets these properties:

### Required Properties

| Property | Type | Description | Example |
|----------|------|-------------|---------|
| `cliId` | `string` | Unique ID for this runtime | `'codex'` |
| `displayName` | `string` | Human-readable name for UI | `'Codex CLI'` |
| `binaryNames` | `string[]` | Binary names to find via `which` | `['codex']` |
| `fallbackPaths` | `string[]` | Absolute paths to check if `which` fails | `['/usr/local/bin/codex']` |
| `skillInjection` | `'disk' \| 'systemprompt'` | How skills are delivered (see below) | `'systemprompt'` |
| `hasBuiltinWebTools` | `boolean` | Does the CLI have native web search/fetch? | `false` |
| `requiresApiKey` | `boolean` | Does the CLI need API keys from Nebula? | `true` |
| `supportedModelPrefixes` | `string[]` | Model ID prefixes this CLI can run. `[]` = any model | `['codex-']` |

### Required Methods

| Method | Description |
|--------|-------------|
| `buildArgs(params)` | Build the CLI argument array from prompt, agent, conversation, options |
| `execute(params)` | Full execution flow: prepare env, build args, spawn, parse output |
| `parseOutput(rawOutput, startTime)` | Parse CLI output into `{ result, duration_ms, total_cost_usd, usage, tool_history, cli_session_id }` |

### Optional Methods

| Method | Default | Override when... |
|--------|---------|-----------------|
| `prepareEnvironment(params)` | no-op | CLI needs config files written before execution |
| `mapModelId(model)` | passthrough | CLI uses different model ID format |
| `mapToolNames(tools)` | passthrough | CLI uses different tool names |
| `checkAuth()` | `{ ok: true }` | CLI has a way to verify auth before execution |
| `listModels()` | `[]` | CLI provides a static list of supported models |
| `detectBinary()` | auto (which + fallbacks) | Custom binary detection logic |

### Inherited from Base Class

These are provided by `ExecutionBackend` — don't override unless necessary:

- `detectBinary()` — Scans `binaryNames` via `which`, then `fallbackPaths` via `fs.existsSync`
- `canRunModel(modelId)` — Checks `supportedModelPrefixes` (empty = any model)
- `_spawn({ binary, args, cwd, timeoutMs, agentId, orgId, signal, secretEnvVars, handleExit })` — PTY spawn with timeout, abort, output capture, and log writing. Returns test stub in `NODE_ENV=test`.

## Skill Injection Modes

### `'disk'` (like Claude Code)
Skills are written to `.claude/skills/{name}/SKILL.md` before execution. The CLI discovers and reads them from disk. Skills are NOT inlined into the system prompt.

### `'systemprompt'` (like OpenCode)
Skills are inlined into the system prompt as a `## Skills` section. The CLI doesn't read from `.claude/skills/`. Use this when the CLI doesn't support a skills directory convention.

## Example: Adding Codex CLI

```js
// src/backends/codex.js
import path from 'path';
import fs from 'fs';
import { ExecutionBackend } from './base.js';

export class CodexBackend extends ExecutionBackend {
  constructor() {
    super('codex');

    this.cliId = 'codex';
    this.displayName = 'Codex CLI';
    this.binaryNames = ['codex'];
    this.fallbackPaths = [
      '/usr/local/bin/codex',
      path.join(process.env.HOME || '', '.npm-global', 'bin', 'codex'),
    ];
    this.skillInjection = 'systemprompt';
    this.hasBuiltinWebTools = false;
    this.requiresApiKey = true;
    this.supportedModelPrefixes = []; // accepts any model
  }

  mapModelId(model) {
    // Codex expects bare model names
    if (model.includes('/')) return model.split('/').pop();
    return model;
  }

  buildArgs({ prompt, agent, conversation, options }) {
    const args = [
      'run',
      '--model', this.mapModelId(agent.model),
      '--format', 'json',
    ];

    // Session resume — CLI generates its own ID on first run (captured in parseOutput)
    if (conversation.session_initialized && conversation.session_id) {
      args.push('--resume', conversation.session_id);
    }

    // Append image references if present
    let fullPrompt = prompt;
    if (options.images?.length > 0) {
      const refs = options.images.map(img => `  - ${img}`).join('\n');
      fullPrompt += `\n\n[Attached images]\n${refs}`;
    }

    args.push(fullPrompt);
    return args;
  }

  prepareEnvironment({ systemPrompt, agent, agentDir, options }) {
    // Write system prompt as rules file
    const rulesDir = path.join(agentDir, '.codex');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'rules.md'), systemPrompt || '');
  }

  parseOutput(rawOutput, startTime) {
    // Parse CLI's JSON output — extract result text, usage, and session ID
    const lines = rawOutput.split('\n').filter(l => l.trim().startsWith('{'));
    let resultText = '';
    let cliSessionId = null;
    let usage = { input_tokens: 0, output_tokens: 0 };
    const duration = startTime ? Date.now() - startTime : 0;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'result') resultText = event.result || event.text;
        if (event.usage) {
          usage.input_tokens += event.usage.input_tokens || 0;
          usage.output_tokens += event.usage.output_tokens || 0;
        }
        // IMPORTANT: capture the CLI's session ID for resume support
        // Each CLI uses a different field — check your CLI's output format
        if (!cliSessionId && (event.session_id || event.thread_id)) {
          cliSessionId = event.session_id || event.thread_id;
        }
      } catch {}
    }

    if (!resultText) resultText = rawOutput.trim();
    return { result: resultText, duration_ms: duration, total_cost_usd: 0, usage, tool_history: [], cli_session_id: cliSessionId };
  }

  async execute({ prompt, systemPrompt, agent, agentDir, conversation, options }) {
    const binary = this.binaryPath || this.binaryNames[0];
    const startTime = Date.now();

    this.prepareEnvironment({ systemPrompt, agent, agentDir, options });
    const args = this.buildArgs({ prompt, agent, conversation, options });

    return this._spawn({
      binary,
      args,
      cwd: agentDir,
      timeoutMs: options.timeoutMs || 600000,
      agentId: agent.id,
      orgId: agent.org_id,
      signal: options.signal,
      secretEnvVars: options.secretEnvVars,
      handleExit: (exitCode, clean, logDir) => {
        if (exitCode !== 0 && exitCode !== null) {
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(path.join(logDir, `codex-error-${Date.now()}.log`), clean);
          throw new Error(`Codex exit code ${exitCode}: ${clean.slice(-500)}`);
        }
        try {
          return this.parseOutput(clean, startTime);
        } catch (e) {
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(path.join(logDir, `codex-parse-error-${Date.now()}.log`), clean);
          throw new Error(`Codex parse failed: ${e.message}`);
        }
      },
    });
  }
}
```

Then register it:

```js
// src/backends/index.js — add these two lines:
import { CodexBackend } from './codex.js';
registry.register(new CodexBackend());
```

## How the Executor Uses Adapters

The executor never checks CLI names — it reads adapter properties:

| Executor behavior | Adapter property checked |
|---|---|
| Write skills to disk vs. inline | `backend.skillInjection === 'disk'` |
| Inject nebula-web MCP server | `!backend.hasBuiltinWebTools` |
| Inline skills into system prompt | `backend.skillInjection === 'systemprompt'` |
| Runtime resolution for agent | `registry.resolveForAgent(agent, orgId)` |
| Model compatibility fallback | `backend.canRunModel(model)` |

## Testing Your Adapter

Add tests in `tests/cli-registry.test.js`:

```js
describe('CodexBackend adapter properties', async () => {
  const { CodexBackend } = await import('../src/backends/codex.js');
  const codex = new CodexBackend();

  it('has correct cliId', () => {
    assert.equal(codex.cliId, 'codex');
  });

  it('accepts any model', () => {
    assert.equal(codex.canRunModel('gpt-4o'), true);
  });

  it('parseOutput handles codex format', () => {
    const output = '{"type":"result","result":"hello"}\n';
    const result = codex.parseOutput(output, Date.now());
    assert.equal(result.result, 'hello');
  });
});
```

The `_spawn()` method returns a test stub when `NODE_ENV=test`, so you don't need a real binary for unit tests.

## Checklist

- [ ] Adapter file created in `src/backends/`
- [ ] Registered in `src/backends/index.js`
- [ ] All required properties set in constructor
- [ ] `buildArgs()` produces correct CLI arguments
- [ ] `parseOutput()` handles the CLI's JSON output format
- [ ] `execute()` orchestrates prepare → build → spawn → parse
- [ ] Tests added and passing
- [ ] If `requiresApiKey: true` — ensure `prepareEnvironment()` writes necessary config
- [ ] If `skillInjection: 'systemprompt'` — ensure `prepareEnvironment()` writes rules file
