/**
 * Base class for CLI runtime adapters.
 * Each adapter declares its capabilities via properties and implements
 * methods for binary detection, argument building, environment preparation,
 * and output parsing. The executor uses these properties instead of
 * string-checking runtime names.
 */
import pty from 'node-pty';
import stripAnsi from 'strip-ansi';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { orgPath } from '../db.js';

export class ExecutionBackend {
  constructor(name) {
    this.name = name;

    // --- Declarative properties (override in subclass) ---
    /** Unique identifier for this CLI runtime */
    this.cliId = name;
    /** Human-readable name for UI display */
    this.displayName = name;
    /** Binary names to search for via `which` */
    this.binaryNames = [];
    /** Absolute fallback paths to check if `which` fails */
    this.fallbackPaths = [];
    /** How skills are delivered: 'disk' (written to .claude/skills/) or 'systemprompt' (inlined) */
    this.skillInjection = 'disk';
    /** Whether this CLI has built-in web tools (WebFetch/WebSearch) */
    this.hasBuiltinWebTools = false;
    /** Whether this CLI requires API keys (vs own login mechanism) */
    this.requiresApiKey = false;
    /** Model ID prefixes this CLI can execute. Empty = any model. */
    this.supportedModelPrefixes = [];

    // --- Install / auth guidance (override in subclass) ---
    /** Shell command to install this CLI */
    this.installCommand = '';
    /** URL for installation docs */
    this.installUrl = '';
    /** Shell command or instructions to authenticate */
    this.authCommand = '';
    /** Brief description of auth method for UI */
    this.authDescription = '';
    // --- Cached state (set by detectBinary) ---
    this.isAvailable = false;
    this.binaryPath = null;
    this._cachedVersion = null;
    this._cachedAuth = null;
  }

  /**
   * Detect and cache the binary path for this CLI.
   * Tries `which` for each binaryName, then checks fallbackPaths.
   * @returns {string|null} The resolved binary path, or null if not found
   */
  detectBinary() {
    for (const bin of this.binaryNames) {
      try {
        const resolved = execSync(`which ${bin}`, { encoding: 'utf-8' }).trim();
        if (resolved) {
          this.binaryPath = resolved;
          this.isAvailable = true;
          return resolved;
        }
      } catch {}
    }
    // Check user-provided runtimes volume, then adapter-specific fallbacks
    const dataDir = process.env.DATA_DIR || '/data';
    const allFallbacks = [
      ...this.binaryNames.map(bin => path.join(dataDir, 'runtimes', 'bin', bin)),
      ...this.fallbackPaths,
    ];
    for (const p of allFallbacks) {
      if (fs.existsSync(p)) {
        this.binaryPath = p;
        this.isAvailable = true;
        return p;
      }
    }
    this.binaryPath = null;
    this.isAvailable = false;
    this._cachedVersion = null;
    this._cachedAuth = null;
    return null;
  }

  /** Refresh cached version and auth status. Called after detectBinary finds a binary. */
  _refreshCache() {
    this._cachedVersion = this._fetchVersion();
    this._cachedAuth = this.checkAuth();
  }

  _fetchVersion() {
    if (!this.binaryPath) return null;
    try {
      return execSync(`"${this.binaryPath}" --version`, { encoding: 'utf-8', timeout: 10000 }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Get the installed version of this CLI (cached).
   * @returns {string|null} Version string, or null if not available
   */
  getVersion() {
    return this._cachedVersion;
  }

  /**
   * Check whether this CLI can run a given model ID.
   * Empty supportedModelPrefixes means any model is accepted.
   */
  canRunModel(modelId) {
    if (this.supportedModelPrefixes.length === 0) return true;
    return this.supportedModelPrefixes.some(prefix => modelId.startsWith(prefix));
  }

  /**
   * Transform a model ID for this CLI's expected format.
   * Override in subclass if the CLI uses a different naming convention.
   */
  mapModelId(model) {
    return model;
  }

  /**
   * Map CC-convention tool names to this CLI's tool names.
   * Override in subclass if tool names differ.
   */
  mapToolNames(tools) {
    return tools;
  }

  /**
   * Build the CLI argument array for execution.
   * @param {Object} params
   * @param {string} params.prompt - Full prompt text
   * @param {string} params.systemPrompt - Assembled system prompt
   * @param {Object} params.agent - Agent DB row
   * @param {Object} params.conversation - Conversation DB row
   * @param {Object} params.options - Execution options
   * @returns {string[]} CLI arguments
   */
  buildArgs(params) {
    throw new Error(`${this.cliId}: buildArgs() not implemented`);
  }

  /**
   * Prepare the environment before execution (write config files, rules, etc.)
   * @param {Object} params - Same as buildArgs params plus agentDir
   */
  prepareEnvironment(params) {
    // Optional — override in subclass if needed
  }

  /**
   * Parse raw CLI output into a normalized result object.
   * @param {string} rawOutput - Cleaned (strip-ansi) output from the CLI process
   * @param {number} startTime - Timestamp when process started
   * @returns {Object} { result, duration_ms, total_cost_usd, usage, tool_history }
   */
  parseOutput(rawOutput, startTime) {
    throw new Error(`${this.cliId}: parseOutput() not implemented`);
  }

  /**
   * Check whether a session file/state exists for the given session ID.
   * Override in subclass if the runtime persists sessions to disk.
   * @param {string} sessionId
   * @returns {boolean}
   */
  sessionExists(sessionId) {
    // Default: assume session exists (stateless runtimes don't track sessions)
    return true;
  }

  /**
   * Delete session files not in the active set.
   * Override in subclass if the runtime persists sessions to disk.
   * @param {Set<string>} activeSessionIds - Session IDs still in use
   * @returns {{ deleted: number, scanned: number }}
   */
  cleanStaleSessions(activeSessionIds) {
    return { deleted: 0, scanned: 0 };
  }

  /**
   * Perform any startup recovery (e.g. restoring config from backups).
   * Override in subclass if needed. Called once at server boot.
   */
  startupRecover() {
    // No-op by default
  }

  /**
   * Check if the CLI is authenticated / ready to execute.
   * Override in subclass for runtime-specific checks.
   * @returns {{ ok: boolean, error?: string }}
   */
  checkAuth() {
    return { ok: true };
  }

  /**
   * Get cached auth status (from last detect/refresh).
   * @returns {{ ok: boolean, error?: string }}
   */
  getAuth() {
    return this._cachedAuth || this.checkAuth();
  }

  /**
   * Return available models for this backend.
   * @returns {{ id: string, name: string, backend: string }[]}
   */
  listModels() {
    return [];
  }

  /**
   * Execute a prompt against the backend.
   * Orchestrates prepareEnvironment → buildArgs → _spawn → parseOutput.
   * @param {Object} params
   * @param {string} params.prompt - The user prompt
   * @param {string} params.systemPrompt - Assembled system prompt
   * @param {Object} params.agent - Agent DB row
   * @param {string} params.agentDir - Agent working directory path
   * @param {Object} params.conversation - Conversation DB row
   * @param {Object} params.options - { maxTurns, timeoutMs, signal, images, mcpServers, secretEnvVars }
   * @returns {Promise<{ result: string, duration_ms: number, total_cost_usd: number, usage: Object, tool_history: Array }>}
   */
  async execute({ prompt, systemPrompt, agent, agentDir, conversation, options }) {
    throw new Error(`Backend "${this.name}" has not implemented execute()`);
  }

  /**
   * Shared PTY spawn for CLI execution.
   * Handles timeout, abort signal, output capture, and log writing.
   *
   * @param {Object} params
   * @param {string} params.binary - Path to CLI binary
   * @param {string[]} params.args - CLI arguments
   * @param {string} params.cwd - Working directory
   * @param {number} params.timeoutMs - Execution timeout
   * @param {string} params.agentId - For log file paths
   * @param {string} params.orgId - For log file paths
   * @param {AbortSignal} [params.signal] - Abort signal for cancellation
   * @param {Object} [params.secretEnvVars] - Additional env vars (secrets)
   * @param {function} params.handleExit - Called with (exitCode, cleanOutput) to produce result or throw
   * @returns {Promise<Object>} Resolved result from handleExit
   */
  _spawn({ binary, args, cwd, timeoutMs, agentId, orgId, signal, secretEnvVars, handleExit }) {
    if (process.env.NODE_ENV === 'test') {
      return Promise.resolve({
        type: 'result', subtype: 'success',
        result: `[test mode — ${this.cliId} not spawned]`,
        duration_ms: 0, total_cost_usd: 0, usage: {}, tool_history: [],
      });
    }

    return new Promise((resolve, reject) => {
      let output = '';

      const proc = pty.spawn(binary, args, {
        cwd,
        cols: 200,
        rows: 50,
        env: {
          ...process.env,
          HOME: process.env.HOME || '/home/node',
          ...(secretEnvVars || {}),
        },
      });

      // Abort signal — kill process when cancelled
      if (signal) {
        signal.addEventListener('abort', () => {
          proc.kill();
          reject(new Error('Cancelled by user'));
        }, { once: true });
      }

      const timer = setTimeout(() => {
        proc.kill();
        // Save output on timeout for debugging
        try {
          const logDir = orgPath(orgId, 'logs', agentId);
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(path.join(logDir, `timeout-${Date.now()}.log`), stripAnsi(output));
          // Rotate — keep last 10 timeout logs
          const timeoutLogs = fs.readdirSync(logDir).filter(f => f.startsWith('timeout-')).sort();
          while (timeoutLogs.length > 10) {
            try { fs.unlinkSync(path.join(logDir, timeoutLogs.shift())); } catch {}
          }
        } catch {}
        reject(new Error(`Timeout: ${this.displayName} execution exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      proc.onData((data) => {
        output += data;
      });

      proc.onExit(({ exitCode }) => {
        clearTimeout(timer);
        const clean = stripAnsi(output);
        const logDir = orgPath(orgId, 'logs', agentId);

        // Always save last execution log
        try {
          fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(path.join(logDir, 'last-execution.log'), clean);
        } catch {}

        try {
          const result = handleExit(exitCode, clean, logDir);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
  }
}
