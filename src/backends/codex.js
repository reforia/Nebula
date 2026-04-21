import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { ExecutionBackend } from './base.js';
import { processJsonLines } from './parse-helpers.js';

export class CodexBackend extends ExecutionBackend {
  constructor() {
    super('codex');

    this.cliId = 'codex';
    this.displayName = 'Codex CLI';
    this.binaryNames = ['codex'];
    this.fallbackPaths = [
      path.join(process.env.HOME || '', '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
      path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
    ];
    this.skillInjection = 'systemprompt'; // uses --append-system-prompt, not disk
    this.hasBuiltinWebTools = true;
    this.requiresApiKey = false; // uses `codex login` (ChatGPT OAuth or API key)
    this.supportedModelPrefixes = ['gpt-', 'o3-', 'o4-'];

    this.installCommand = 'npm install -g @openai/codex';
    this.installUrl = 'https://developers.openai.com/codex/cli';
    this.authCommand = 'codex login';
    this.authDescription = 'OAuth via ChatGPT account, or pipe API key: printenv OPENAI_API_KEY | codex login --with-api-key';
  }

  listModels() {
    return [
      { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai', backend: 'codex' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai', backend: 'codex' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', provider: 'openai', backend: 'codex' },
      { id: 'o4-mini', name: 'o4 Mini', provider: 'openai', backend: 'codex' },
    ];
  }

  checkAuth() {
    if (!this.binaryPath) return { ok: false, error: 'Not installed' };
    try {
      execSync(`"${this.binaryPath}" --version`, { timeout: 10000, stdio: 'pipe' });
      return { ok: true };
    } catch {
      return { ok: false, error: 'Auth may be needed — run: codex login' };
    }
  }

  buildArgs({ prompt, agent, conversation, options }) {
    // System prompt is written to AGENTS.md in the working dir by
    // prepareEnvironment — Codex has no --system-prompt flag.
    // Verified against codex-cli 0.118.0.
    const flags = [
      '--json',
      '--model', agent.model || 'gpt-5.4',
      '--dangerously-bypass-approvals-and-sandbox',
    ];

    for (const img of (options.images || [])) {
      flags.push('-i', img);
    }

    // Resume is a sub-subcommand of exec (`codex exec resume <id> [PROMPT]`).
    // Flags bind to the innermost subcommand — put them after `resume`.
    if (conversation.session_initialized && conversation.session_id) {
      return ['exec', 'resume', ...flags, conversation.session_id, prompt];
    }
    return ['exec', ...flags, prompt];
  }

  prepareEnvironment({ systemPrompt, agentDir }) {
    // Codex reads its system prompt from AGENTS.md in the working directory.
    // No dedicated CLI flag (confirmed in codex-cli 0.118.0).
    if (systemPrompt) {
      fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), systemPrompt);
    }
  }

  parseOutput(rawOutput, startTime) {
    let resultText = '';
    let usage = { input_tokens: 0, output_tokens: 0 };
    let cliSessionId = null;
    const toolHistory = [];
    const duration = startTime ? Date.now() - startTime : 0;

    const processEvent = (event) => {
      // Capture thread_id from first event
      if (event.type === 'thread.started' && event.thread_id) {
        cliSessionId = event.thread_id;
      }

      // codex-cli 0.118.0: agent messages arrive as
      //   { type: "item.completed", item: { type: "agent_message", text: "..." } }
      // Earlier versions used a content-block array — keep that path as fallback.
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        resultText += event.item.text;
      }
      if (event.type?.startsWith('item.') && event.item?.content) {
        for (const block of (Array.isArray(event.item.content) ? event.item.content : [])) {
          if (block.type === 'text' || block.type === 'output_text') {
            resultText = block.text || block.content || resultText;
          }
        }
      }

      // Turn completed — may have usage stats
      if (event.type === 'turn.completed' && event.usage) {
        usage.input_tokens += event.usage.input_tokens || 0;
        usage.output_tokens += event.usage.output_tokens || 0;
      }
    };

    processJsonLines(rawOutput, processEvent);

    if (!resultText) resultText = rawOutput.trim();
    return { result: resultText, duration_ms: duration, total_cost_usd: 0, usage, tool_history: toolHistory, cli_session_id: cliSessionId };
  }

  async execute({ prompt, systemPrompt, agent, agentDir, conversation, options }) {
    const binary = this.binaryPath || this.binaryNames[0];
    const startTime = Date.now();

    this.prepareEnvironment({ systemPrompt, agentDir });
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
          throw new Error(`Codex parse failed: ${e.message}\nRaw output (last 1000 chars): ${clean.slice(-1000)}`);
        }
      },
    });
  }
}
