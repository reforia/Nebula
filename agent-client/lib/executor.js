import pty from 'node-pty';
import stripAnsi from 'strip-ansi';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Spawn a CLI runtime for execution.
 * Dispatches to the correct arg builder / parser based on runtime ID.
 */
export function spawnCLI(binary, runtime, msg, workDir, signal) {
  fs.mkdirSync(workDir, { recursive: true });

  switch (runtime) {
    case 'claude-cli':
      return _spawnClaudeCLI(binary, msg, workDir, signal);
    case 'opencode':
      return _spawnOpenCode(binary, msg, workDir, signal);
    case 'codex':
      return _spawnCodex(binary, msg, workDir, signal);
    case 'gemini':
      return _spawnGemini(binary, msg, workDir, signal);
    default:
      return Promise.reject(new Error(`Unknown runtime: ${runtime}`));
  }
}

// ---- Claude Code CLI ----

function _spawnClaudeCLI(binary, msg, workDir, signal) {
  return new Promise((resolve, reject) => {
    // Write skill files from server
    if (msg.skills && msg.skills.length > 0) {
      for (const skill of msg.skills) {
        const skillDir = path.join(workDir, '.claude', 'skills', skill.name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.content);
      }
    }

    // Write MCP config from server
    _writeMcpConfig(workDir, msg.mcp_servers, 'claude');

    const args = [
      '-p', msg.prompt,
      '--allowedTools', msg.allowed_tools || 'Read,Grep,Glob,WebFetch,Bash',
      '--model', msg.model || 'claude-sonnet-4-6',
      '--max-turns', String(msg.max_turns || 10),
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ];

    const mcpConfigPath = path.join(workDir, '.nebula-mcp-config.json');
    if (fs.existsSync(mcpConfigPath)) {
      args.push('--mcp-config', mcpConfigPath);
    }

    if (msg.system_prompt) {
      args.push('--append-system-prompt', msg.system_prompt);
    }

    if (msg.session_initialized) {
      args.push('--resume', msg.session_id);
    } else {
      args.push('--session-id', msg.session_id);
    }

    // Clear stale session lock
    if (msg.session_id) {
      const lockPath = path.join(os.homedir(), '.claude', 'tasks', msg.session_id, '.lock');
      try { fs.unlinkSync(lockPath); } catch {}
    }

    _spawn(binary, args, workDir, msg.timeout_ms, signal, (exitCode, clean) => {
      if (exitCode === 2) throw new Error('Claude Code auth expired — run "claude login" on this machine');
      if (exitCode !== 0) throw new Error(`CC exit code ${exitCode}: ${clean.slice(-500)}`);

      const jsonStart = clean.indexOf('{');
      const jsonEnd = clean.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON object found in output');
      return JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
    }).then(resolve, reject);
  });
}

// ---- OpenCode ----

function _spawnOpenCode(binary, msg, workDir, signal) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    // Write system prompt as rules file
    const rulesDir = path.join(workDir, '.opencode');
    fs.mkdirSync(rulesDir, { recursive: true });

    let systemPrompt = msg.system_prompt || '';
    // Inline skills into system prompt (OpenCode doesn't read .claude/skills/)
    if (msg.skills && msg.skills.length > 0) {
      const skillsBlock = msg.skills.map(s => s.content).join('\n\n---\n\n');
      systemPrompt += `\n\n## Skills\n\n${skillsBlock}`;
    }
    fs.writeFileSync(path.join(rulesDir, 'rules.md'), systemPrompt);

    // Write MCP config as opencode.json
    _writeMcpConfig(workDir, msg.mcp_servers, 'opencode');

    // Map bare model names to OpenCode's provider/model format.
    // Models with slashes are passed through — user specifies the full OpenCode model ID.
    let ocModel = msg.model || 'claude-sonnet-4-6';
    if (!ocModel.includes('/')) {
      if (ocModel.startsWith('claude-')) ocModel = `anthropic/${ocModel}`;
      else if (ocModel.startsWith('gpt-') || ocModel.startsWith('o3-') || ocModel.startsWith('o4-')) ocModel = `openai/${ocModel}`;
    }

    const args = ['run', '--format', 'json', '--model', ocModel];

    const locallyInit = _isLocallyInitialized(workDir, msg.session_id);
    if (locallyInit) {
      args.push('--session', msg.session_id);
    } else {
      args.push('--title', msg.session_id);
    }

    args.push(msg.prompt);

    _spawn(binary, args, workDir, msg.timeout_ms, signal, (exitCode, clean) => {
      if (exitCode !== 0 && exitCode !== null) {
        throw new Error(`OpenCode exit code ${exitCode}: ${clean.slice(-500)}`);
      }

      const lines = clean.split('\n').filter(l => l.trim().startsWith('{'));
      let resultText = '';
      let usage = { input_tokens: 0, output_tokens: 0 };
      let cost = 0;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'text') {
            // OpenCode format: part.text
            if (event.part?.text) resultText = event.part.text;
            else if (event.content) resultText = event.content;
          }
          if (event.type === 'message' && event.role === 'assistant') {
            if (typeof event.content === 'string') resultText = event.content;
            else if (Array.isArray(event.content)) {
              for (const b of event.content) { if (b.type === 'text') resultText = b.text; }
            }
          }
          if (event.type === 'step_finish' && event.part) {
            if (event.part.tokens) {
              usage.input_tokens += event.part.tokens.input || 0;
              usage.output_tokens += event.part.tokens.output || 0;
            }
            if (event.part.cost !== undefined) cost = event.part.cost;
          }
          if (event.usage) {
            usage.input_tokens += event.usage.input_tokens || event.usage.prompt_tokens || 0;
            usage.output_tokens += event.usage.output_tokens || event.usage.completion_tokens || 0;
          }
          if (event.cost !== undefined) cost = event.cost;
        } catch {}
      }

      if (!resultText) resultText = clean.trim();
      _markLocallyInitialized(workDir, msg.session_id);
      return { result: resultText, duration_ms: Date.now() - startTime, total_cost_usd: cost, usage };
    }).then(resolve, reject);
  });
}

// ---- Codex CLI ----

function _spawnCodex(binary, msg, workDir, signal) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    let systemPrompt = msg.system_prompt || '';
    if (msg.skills && msg.skills.length > 0) {
      const skillsBlock = msg.skills.map(s => s.content).join('\n\n---\n\n');
      systemPrompt += `\n\n## Skills\n\n${skillsBlock}`;
    }

    const args = [
      'exec', '--json',
      '--model', msg.model || 'gpt-5.4',
      '--dangerously-bypass-approvals-and-sandbox',
    ];

    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    const codexLocalInit = _isLocallyInitialized(workDir, msg.session_id);
    if (codexLocalInit) {
      args.push('resume', msg.session_id);
    } else {
      args.push('--ephemeral');
    }
    if (msg.images?.length > 0) args.push('--images', msg.images.join(','));
    args.push(msg.prompt);

    _spawn(binary, args, workDir, msg.timeout_ms, signal, (exitCode, clean) => {
      if (exitCode !== 0 && exitCode !== null) {
        throw new Error(`Codex exit code ${exitCode}: ${clean.slice(-500)}`);
      }
      const lines = clean.split('\n').filter(l => l.trim().startsWith('{'));
      let resultText = '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type?.startsWith('item.') && event.item?.content) {
            for (const b of (Array.isArray(event.item.content) ? event.item.content : [])) {
              if (b.type === 'text' || b.type === 'output_text') resultText = b.text || b.content || resultText;
            }
          }
        } catch {}
      }
      if (!resultText) resultText = clean.trim();
      _markLocallyInitialized(workDir, msg.session_id);
      return { result: resultText, duration_ms: Date.now() - startTime, total_cost_usd: 0, usage: {} };
    }).then(resolve, reject);
  });
}

// ---- Gemini CLI ----

function _spawnGemini(binary, msg, workDir, signal) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    let systemPrompt = msg.system_prompt || '';
    if (msg.skills && msg.skills.length > 0) {
      const skillsBlock = msg.skills.map(s => s.content).join('\n\n---\n\n');
      systemPrompt += `\n\n## Skills\n\n${skillsBlock}`;
    }

    // Write system prompt to file
    const geminiDir = path.join(workDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const systemFile = path.join(geminiDir, 'system.md');
    fs.writeFileSync(systemFile, systemPrompt);

    const args = [
      '--output-format', 'stream-json',
      '-m', msg.model || 'gemini-2.5-flash',
      '-y',
      '--system-instruction', systemFile,
    ];

    if (_isLocallyInitialized(workDir, msg.session_id)) args.push('--resume', msg.session_id);
    args.push('-p', msg.prompt);

    _spawn(binary, args, workDir, msg.timeout_ms, signal, (exitCode, clean) => {
      if (exitCode !== 0 && exitCode !== null) {
        const label = exitCode === 42 ? 'Input error' : exitCode === 53 ? 'Turn limit' : `Exit ${exitCode}`;
        throw new Error(`Gemini ${label}: ${clean.slice(-500)}`);
      }
      const lines = clean.split('\n').filter(l => l.trim().startsWith('{'));
      let resultText = '';
      let usage = { input_tokens: 0, output_tokens: 0 };
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'result' && event.response) resultText = event.response;
          if (event.type === 'message' && event.role === 'assistant') {
            if (typeof event.content === 'string') resultText = event.content;
            else if (Array.isArray(event.content)) {
              for (const b of event.content) { if (b.type === 'text') resultText = b.text; }
            }
          }
          if (event.usage || event.stats) {
            const u = event.usage || event.stats;
            usage.input_tokens += u.input_tokens || u.input || 0;
            usage.output_tokens += u.output_tokens || u.output || 0;
          }
        } catch {}
      }
      if (!resultText) resultText = clean.trim();
      _markLocallyInitialized(workDir, msg.session_id);
      return { result: resultText, duration_ms: Date.now() - startTime, total_cost_usd: 0, usage };
    }).then(resolve, reject);
  });
}

// ---- Shared helpers ----

function _spawn(binary, args, cwd, timeoutMs, signal, parseExit) {
  return new Promise((resolve, reject) => {
    timeoutMs = timeoutMs || 600000;
    let output = '';

    const proc = pty.spawn(binary, args, {
      cwd,
      cols: 200,
      rows: 50,
      env: { ...process.env, HOME: os.homedir() },
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        proc.kill();
        reject(new Error('Cancelled by user'));
      }, { once: true });
    }

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timeout: execution exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    proc.onData((data) => { output += data; });

    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      const clean = stripAnsi(output);
      try {
        resolve(parseExit(exitCode, clean));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Track whether a CLI session has been initialized locally on this machine.
// The server's session_initialized flag reflects server-side state which may not
// exist on the remote machine yet.
function _isLocallyInitialized(workDir, sessionId) {
  return fs.existsSync(path.join(workDir, `.session-${sessionId}`));
}

function _markLocallyInitialized(workDir, sessionId) {
  fs.writeFileSync(path.join(workDir, `.session-${sessionId}`), '');
}

function _writeMcpConfig(workDir, mcpServers, format) {
  if (!mcpServers || mcpServers.length === 0) return;

  if (format === 'claude') {
    const mcpConfig = { mcpServers: {} };
    for (const server of mcpServers) {
      if (server.transport === 'stdio') {
        mcpConfig.mcpServers[server.name] = {
          type: 'stdio',
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
    fs.writeFileSync(path.join(workDir, '.nebula-mcp-config.json'), JSON.stringify(mcpConfig, null, 2));
  } else if (format === 'opencode') {
    const config = { '$schema': 'https://opencode.ai/config.json', mcp: {} };
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
    fs.writeFileSync(path.join(workDir, 'opencode.json'), JSON.stringify(config, null, 2));
  }
}
