import { ExecutionBackend } from './base.js';
import path from 'path';
import fs from 'fs';

export class OpenCodeBackend extends ExecutionBackend {
  constructor() {
    super('opencode');

    // Declarative properties
    this.cliId = 'opencode';
    this.displayName = 'OpenCode';
    this.binaryNames = ['opencode'];
    this.fallbackPaths = [
      '/usr/local/bin/opencode',
      path.join(process.env.HOME || '', '.npm-global', 'bin', 'opencode'),
      path.join(process.env.HOME || '', '.bun', 'bin', 'opencode'),
    ];
    this.skillInjection = 'systemprompt';
    this.hasBuiltinWebTools = true;
    this.requiresApiKey = true;
    this.supportedModelPrefixes = []; // any model

    // Install / auth guidance
    this.installCommand = 'npm install -g opencode-ai';
    this.installUrl = 'https://opencode.ai';
    this.authCommand = 'Set provider API keys in opencode.json or environment variables';
    this.authDescription = 'API key-based. Each provider (Anthropic, OpenAI, OpenRouter) needs its own key configured in the CLI.';
  }

  /**
   * CC CLI tool name → OpenCode tool name mapping.
   */
  static TOOL_MAP = {
    'Read': 'read', 'Write': 'write', 'Edit': 'edit',
    'Glob': 'glob', 'Grep': 'grep', 'Bash': 'bash',
    'NotebookEdit': 'patch',
  };

  listModels() {
    // OpenCode manages its own providers and model list — user enters the full
    // OpenCode model ID (e.g. openrouter/deepseek/deepseek-v3.2) via text input.
    return [];
  }

  /**
   * Map CC CLI model IDs to OpenCode provider/model format.
   * CC CLI uses bare model names (e.g. "claude-sonnet-4-6"),
   * while OpenCode requires "provider/model" format.
   */
  mapModelId(model) {
    if (model.includes('/')) return model;
    if (model.startsWith('claude-')) return `anthropic/${model}`;
    if (model.startsWith('gpt-') || model.startsWith('o3-') || model.startsWith('o4-')) return `openai/${model}`;
    return model;
  }

  /**
   * Map CC-convention tool names to OpenCode permission names.
   */
  mapToolNames(ccTools) {
    const result = {};
    for (const [ccName, ocName] of Object.entries(OpenCodeBackend.TOOL_MAP)) {
      result[ccName] = ocName;
    }
    return result;
  }

  buildArgs({ prompt, agent, conversation, options }) {
    const ocModel = this.mapModelId(agent.model);
    const args = ['run', '--format', 'json', '--model', ocModel, '--dangerously-skip-permissions'];

    // Resume existing session; first run gets no session flag — CLI generates its own
    if (conversation.session_initialized && conversation.session_id) {
      args.push('--session', conversation.session_id);
    }

    // If images are attached, append file references
    let fullPrompt = prompt;
    if (options.images && options.images.length > 0) {
      const refs = options.images.map(img => `  - ${img}`).join('\n');
      fullPrompt += `\n\n[Attached images — use the Read tool to view them]\n${refs}`;
    }

    args.push(fullPrompt);
    return args;
  }

  prepareEnvironment({ systemPrompt, agent, agentDir, options }) {
    // Write opencode.json config with provider credentials + MCP servers
    this._writeConfig(agent, agentDir, options.mcpServers || []);

    // Write system prompt (including inlined skills) as rules file
    const rulesDir = path.join(agentDir, '.opencode');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'rules.md'), systemPrompt || '');
  }

  _writeConfig(agent, agentDir, mcpServers = []) {
    const config = {
      '$schema': 'https://opencode.ai/config.json',
    };

    // MCP servers (user-configured only — no auto-injection)
    if (mcpServers.length > 0) {
      config.mcp = {};
      for (const server of mcpServers) {
        if (server.transport === 'stdio') {
          const args = server.config.args || [];
          config.mcp[server.name] = {
            type: 'local',
            command: [server.config.command, ...args],
            enabled: true,
            ...(server.config.env && Object.keys(server.config.env).length > 0
              ? { environment: server.config.env } : {}),
          };
        } else {
          config.mcp[server.name] = {
            type: 'remote',
            url: server.config.url,
            enabled: true,
            ...(server.config.headers && Object.keys(server.config.headers).length > 0
              ? { headers: server.config.headers } : {}),
          };
        }
      }
    }

    // Map Nebula allowed_tools to OpenCode permissions
    config.permission = {};
    const allowedTools = (agent.allowed_tools || '').split(',').map(t => t.trim()).filter(Boolean);
    if (allowedTools.length > 0) {
      for (const [ccName, ocName] of Object.entries(OpenCodeBackend.TOOL_MAP)) {
        if (!allowedTools.includes(ccName)) {
          config.permission[ocName] = 'deny';
        }
      }
    }

    fs.writeFileSync(path.join(agentDir, 'opencode.json'), JSON.stringify(config, null, 2));
  }

  parseOutput(rawOutput, startTime) {
    const lines = rawOutput.split('\n').filter(l => l.trim().startsWith('{'));
    let resultText = '';
    let usage = { input_tokens: 0, output_tokens: 0 };
    let cost = 0;
    let cliSessionId = null;
    const toolHistory = [];
    const pendingTools = new Map();
    const duration = startTime ? Date.now() - startTime : 0;

    const processEvent = (event) => {
      if (event.type === 'tool_use' || (event.type === 'content_block' && event.content_block?.type === 'tool_use')) {
        const block = event.content_block || event;
        pendingTools.set(block.id, { name: block.name, input: block.input || {} });
      }

      if (event.type === 'tool_result') {
        const tool = pendingTools.get(event.tool_use_id);
        if (tool) {
          pendingTools.delete(event.tool_use_id);
          toolHistory.push({
            name: tool.name,
            input: tool.input,
            output: (typeof event.content === 'string' ? event.content : JSON.stringify(event.content))?.slice(0, 2000) || '',
            error: event.is_error || false,
          });
        }
      }

      if (event.type === 'message' && event.role === 'assistant' && Array.isArray(event.content)) {
        for (const block of event.content) {
          if (block.type === 'tool_use') {
            pendingTools.set(block.id, { name: block.name, input: block.input || {} });
          }
          if (block.type === 'text') resultText = block.text;
        }
      }

      if (event.type === 'text' && event.content) resultText += event.content;
      if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
        resultText = event.content;
      }
      if (event.usage) {
        usage.input_tokens += event.usage.input_tokens || event.usage.prompt_tokens || 0;
        usage.output_tokens += event.usage.output_tokens || event.usage.completion_tokens || 0;
      }
      if (event.cost !== undefined) cost = event.cost;
      // Capture session ID from any event that has one
      if (!cliSessionId && (event.session_id || event.session)) {
        cliSessionId = event.session_id || event.session;
      }
    };

    for (const line of lines) {
      try {
        processEvent(JSON.parse(line));
      } catch {
        const parts = line.split(/(?<=\})\s*(?=\{)/);
        if (parts.length > 1) {
          for (const part of parts) {
            try { processEvent(JSON.parse(part)); } catch {}
          }
        }
      }
    }

    if (!resultText) resultText = rawOutput.trim();

    return { result: resultText, duration_ms: duration, total_cost_usd: cost, usage, tool_history: toolHistory, cli_session_id: cliSessionId };
  }

  async execute({ prompt, systemPrompt, agent, agentDir, conversation, options }) {
    const binary = this.binaryPath || this.binaryNames[0];
    const startTime = Date.now();

    // Prepare environment (config files, rules)
    this.prepareEnvironment({ systemPrompt, agent, agentDir, options });

    // Build args
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
          fs.writeFileSync(path.join(logDir, `opencode-error-${Date.now()}.log`), clean);
          throw new Error(`OpenCode exit code ${exitCode}: ${clean.slice(-500)}`);
        }

        try {
          return this.parseOutput(clean, startTime);
        } catch (e) {
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(path.join(logDir, `opencode-parse-error-${Date.now()}.log`), clean);
          throw new Error(`OpenCode JSON parse failed: ${e.message}\nRaw output (last 1000 chars): ${clean.slice(-1000)}`);
        }
      },
    });
  }
}
