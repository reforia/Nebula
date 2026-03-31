import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { ExecutionBackend } from './base.js';

export class GeminiBackend extends ExecutionBackend {
  constructor() {
    super('gemini');

    this.cliId = 'gemini';
    this.displayName = 'Gemini CLI';
    this.binaryNames = ['gemini'];
    this.fallbackPaths = [
      path.join(process.env.HOME || '', '.local', 'bin', 'gemini'),
      '/usr/local/bin/gemini',
      '/opt/homebrew/bin/gemini',
      path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd'),
    ];
    this.skillInjection = 'systemprompt'; // via --system-instruction file
    this.hasBuiltinWebTools = true;
    this.requiresApiKey = false; // uses Google OAuth by default (free tier)
    this.supportedModelPrefixes = ['gemini-'];

    this.installCommand = 'npm install -g @google/gemini-cli';
    this.installUrl = 'https://github.com/google-gemini/gemini-cli';
    this.authCommand = 'gemini (first run prompts Google OAuth)';
    this.authDescription = 'Google OAuth on first run (free: 1000 req/day), or set GEMINI_API_KEY env var.';
  }

  listModels() {
    return [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', backend: 'gemini' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', backend: 'gemini' },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'google', backend: 'gemini' },
    ];
  }

  checkAuth() {
    if (!this.binaryPath) return { ok: false, error: 'Not installed' };
    try {
      execSync(`"${this.binaryPath}" --version`, { timeout: 10000, stdio: 'pipe' });
      return { ok: true };
    } catch {
      return { ok: false, error: 'May need auth — run gemini once to trigger OAuth' };
    }
  }

  buildArgs({ prompt, agent, conversation, options }) {
    const args = [
      '--output-format', 'stream-json',
      '-m', agent.model || 'gemini-2.5-flash',
      '-y', // auto-approve tool calls
    ];

    // Resume with CLI's own session_id if available
    if (conversation.session_initialized && conversation.session_id) {
      args.push('--resume', conversation.session_id);
    }

    args.push('-p', prompt);

    return args;
  }

  prepareEnvironment({ systemPrompt, agentDir }) {
    // Gemini uses --system-instruction <path> for system prompt injection
    // Write system prompt (with inlined skills) to a file
    const geminiDir = path.join(agentDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(path.join(geminiDir, 'system.md'), systemPrompt || '');
  }

  parseOutput(rawOutput, startTime) {
    const lines = rawOutput.split('\n').filter(l => l.trim().startsWith('{'));
    let resultText = '';
    let usage = { input_tokens: 0, output_tokens: 0 };
    let cliSessionId = null;
    const toolHistory = [];
    const pendingTools = new Map();
    const duration = startTime ? Date.now() - startTime : 0;

    const processEvent = (event) => {
      // Capture session_id from init event
      if (event.type === 'init' && event.session_id) {
        cliSessionId = event.session_id;
      }

      // Message events (assistant text)
      if (event.type === 'message' && event.role === 'assistant') {
        if (typeof event.content === 'string') resultText = event.content;
        else if (Array.isArray(event.content)) {
          for (const b of event.content) {
            if (b.type === 'text') resultText = b.text;
          }
        }
      }

      // Tool use / tool result tracking
      if (event.type === 'tool_use') {
        pendingTools.set(event.id, { name: event.name, input: event.input || {} });
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

      // Result event — final stats
      if (event.type === 'result') {
        if (event.response) resultText = event.response;
        if (event.stats) {
          usage.input_tokens += event.stats.input_tokens || 0;
          usage.output_tokens += event.stats.output_tokens || 0;
        }
      }

      // Standalone usage
      if (event.usage) {
        usage.input_tokens += event.usage.input_tokens || 0;
        usage.output_tokens += event.usage.output_tokens || 0;
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
    return { result: resultText, duration_ms: duration, total_cost_usd: 0, usage, tool_history: toolHistory, cli_session_id: cliSessionId };
  }

  async execute({ prompt, systemPrompt, agent, agentDir, conversation, options }) {
    const binary = this.binaryPath || this.binaryNames[0];
    const startTime = Date.now();

    this.prepareEnvironment({ systemPrompt, agentDir });
    const args = this.buildArgs({ prompt, agent, conversation, options });

    // Add system instruction file path
    const systemFile = path.join(agentDir, '.gemini', 'system.md');
    if (fs.existsSync(systemFile)) {
      args.unshift('--system-instruction', systemFile);
    }

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
        // Exit code 42 = input error, 53 = turn limit exceeded
        if (exitCode !== 0 && exitCode !== null) {
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(path.join(logDir, `gemini-error-${Date.now()}.log`), clean);
          const label = exitCode === 42 ? 'Input error' : exitCode === 53 ? 'Turn limit exceeded' : `Exit code ${exitCode}`;
          throw new Error(`Gemini CLI ${label}: ${clean.slice(-500)}`);
        }
        try {
          return this.parseOutput(clean, startTime);
        } catch (e) {
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(path.join(logDir, `gemini-parse-error-${Date.now()}.log`), clean);
          throw new Error(`Gemini parse failed: ${e.message}\nRaw output (last 1000 chars): ${clean.slice(-1000)}`);
        }
      },
    });
  }
}
