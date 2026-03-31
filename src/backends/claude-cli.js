import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { ExecutionBackend } from './base.js';
import { orgPath } from '../db.js';

export class ClaudeCLIBackend extends ExecutionBackend {
  constructor() {
    super('claude-cli');

    // Declarative properties
    this.cliId = 'claude-cli';
    this.displayName = 'Claude Code';
    this.binaryNames = ['claude'];
    this.fallbackPaths = [
      path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];
    this.skillInjection = 'disk';
    this.hasBuiltinWebTools = true;
    this.requiresApiKey = false;
    this.supportedModelPrefixes = ['claude-'];

    // Install / auth guidance
    this.installCommand = 'npm install -g @anthropic-ai/claude-code';
    this.installUrl = 'https://docs.anthropic.com/en/docs/claude-code/overview';
    this.authCommand = 'claude login';
    this.authDescription = 'Interactive login via Anthropic account. Run once per machine.';
  }

  listModels() {
    return [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', backend: 'claude-cli' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', backend: 'claude-cli' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', backend: 'claude-cli' },
    ];
  }

  buildArgs({ prompt, systemPrompt, agent, conversation, options }) {
    // If images are attached, append file references to the prompt
    let fullPrompt = prompt;
    if (options.images && options.images.length > 0) {
      const refs = options.images.map(img => `  - ${img}`).join('\n');
      fullPrompt += `\n\n[Attached images — use the Read tool to view them]\n${refs}`;
    }

    const args = [
      '-p', fullPrompt,
      '--allowedTools', agent.allowed_tools,
      '--model', agent.model,
      '--max-turns', String(options.maxTurns || 50),
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    // Resume existing session; first run gets no session flag — CLI generates its own ID
    if (conversation.session_initialized && conversation.session_id) {
      args.push('--resume', conversation.session_id);
    }

    return args;
  }

  prepareEnvironment({ agentDir, conversation, options }) {
    // MCP servers — write config file
    if (options.mcpServers && options.mcpServers.length > 0) {
      const mcpConfig = { mcpServers: {} };
      for (const server of options.mcpServers) {
        if (server.transport === 'stdio') {
          mcpConfig.mcpServers[server.name] = {
            command: server.config.command,
            args: server.config.args || [],
            env: server.config.env || {},
          };
        } else {
          mcpConfig.mcpServers[server.name] = {
            url: server.config.url,
            ...(server.config.headers && Object.keys(server.config.headers).length > 0
              ? { headers: server.config.headers } : {}),
          };
        }
      }
      const mcpConfigPath = path.join(agentDir, '.nebula-mcp-config.json');
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
      // Return path so buildArgs can reference it (caller appends --mcp-config)
      return { mcpConfigPath };
    }
    return {};
  }

  parseOutput(rawOutput) {
    const lines = rawOutput.split('\n').filter(l => l.trim().startsWith('{'));
    let resultEvent = null;
    let cliSessionId = null;
    const toolHistory = [];
    const pendingTools = new Map();

    const processEvent = (event) => {
      // Track tool_use events from assistant messages
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            pendingTools.set(block.id, {
              name: block.name,
              input: block.input || {},
            });
          }
        }
      }

      // Match tool_result events back to tool_use
      if (event.type === 'user' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'tool_result' && pendingTools.has(block.tool_use_id)) {
            const tool = pendingTools.get(block.tool_use_id);
            pendingTools.delete(block.tool_use_id);
            const resultContent = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            toolHistory.push({
              name: tool.name,
              input: tool.input,
              output: resultContent?.slice(0, 2000) || '',
              error: block.is_error || false,
            });
          }
        }
      }

      // Capture session_id from any event (CC CLI includes it on every event)
      if (event.session_id && !cliSessionId) {
        cliSessionId = event.session_id;
      }

      // Capture the final result event
      if (event.type === 'result') {
        resultEvent = event;
      }
    };

    for (const line of lines) {
      try {
        processEvent(JSON.parse(line));
      } catch {
        // PTY may concatenate multiple JSON objects on one line without newline separators.
        // Try splitting at top-level object boundaries: }{ or } {
        const parts = line.split(/(?<=\})\s*(?=\{)/);
        if (parts.length > 1) {
          for (const part of parts) {
            try { processEvent(JSON.parse(part)); } catch {}
          }
        }
      }
    }

    if (!resultEvent) {
      throw new Error('No result event found in stream-json output');
    }

    resultEvent.tool_history = toolHistory;
    resultEvent.cli_session_id = cliSessionId;
    return resultEvent;
  }

  checkAuth() {
    if (!this.binaryPath) return { ok: false, error: 'Not installed' };
    try {
      execSync(`"${this.binaryPath}" --version`, { timeout: 10000, stdio: 'pipe' });
      return { ok: true };
    } catch (err) {
      if (err.status === 2) return { ok: false, error: 'Auth expired — run: claude login' };
      return { ok: true };
    }
  }

  async execute({ prompt, systemPrompt, agent, agentDir, conversation, options }) {
    const binary = this.binaryPath || this.binaryNames[0];

    // Prepare environment (MCP config)
    const envResult = this.prepareEnvironment({ agentDir, conversation, options });

    // Build args
    const args = this.buildArgs({ prompt, systemPrompt, agent, conversation, options });

    // Append MCP config path if prepared
    if (envResult.mcpConfigPath) {
      args.push('--mcp-config', envResult.mcpConfigPath);
    }

    // Clear stale session lock from previous runs
    const home = process.env.HOME || '/home/node';
    const lockPath = path.join(home, '.claude', 'tasks', conversation.session_id, '.lock');
    try { fs.unlinkSync(lockPath); } catch {}

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
        if (exitCode === 2) {
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(path.join(logDir, `auth-error-${Date.now()}.log`), clean);
          throw new Error('Claude Code auth expired — re-authenticate');
        }

        if (exitCode !== 0) {
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(path.join(logDir, `error-${Date.now()}.log`), clean);
          throw new Error(`CC exit code ${exitCode}: ${clean.slice(-500)}`);
        }

        try {
          return this.parseOutput(clean);
        } catch (e) {
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(path.join(logDir, `parse-error-${Date.now()}.log`), clean);
          throw new Error(`Stream-json parse failed: ${e.message}\nRaw output (last 1000 chars): ${clean.slice(-1000)}`);
        }
      },
    });
  }
}
