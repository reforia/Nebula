import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * CLI runtime definitions.
 * Each entry: binary names to try via which, then fallback absolute paths.
 */
const CLI_DEFS = {
  'claude-cli': {
    displayName: 'Claude Code',
    bins: ['claude'],
    fallbacks: [
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
      path.join(process.env.APPDATA || '', 'npm', 'claude'),
    ],
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  'opencode': {
    displayName: 'OpenCode',
    bins: ['opencode'],
    fallbacks: [
      '/usr/local/bin/opencode',
      path.join(os.homedir(), '.npm-global', 'bin', 'opencode'),
      path.join(os.homedir(), '.bun', 'bin', 'opencode'),
      path.join(process.env.APPDATA || '', 'npm', 'opencode.cmd'),
      path.join(process.env.APPDATA || '', 'npm', 'opencode'),
    ],
    installHint: 'npm install -g opencode-ai',
  },
  'codex': {
    displayName: 'Codex CLI',
    bins: ['codex'],
    fallbacks: [
      path.join(os.homedir(), '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
      path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
    ],
    installHint: 'npm install -g @openai/codex',
  },
  'gemini': {
    displayName: 'Gemini CLI',
    bins: ['gemini'],
    fallbacks: [
      path.join(os.homedir(), '.local', 'bin', 'gemini'),
      '/usr/local/bin/gemini',
      '/opt/homebrew/bin/gemini',
      path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd'),
    ],
    installHint: 'npm install -g @google/gemini-cli',
  },
};

function findBinary(def) {
  for (const bin of def.bins) {
    try {
      const cmd = os.platform() === 'win32' ? `where ${bin}` : `which ${bin}`;
      const result = execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0];
      if (result && fs.existsSync(result)) return result;
    } catch {}
  }
  for (const p of def.fallbacks) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Detect all available CLI runtimes on this machine.
 * @returns {{ id: string, name: string, path: string }[]}
 */
export function detectAll() {
  const available = [];
  for (const [id, def] of Object.entries(CLI_DEFS)) {
    const binPath = findBinary(def);
    if (binPath) {
      available.push({ id, name: def.displayName, path: binPath });
      console.log(`[cli] ${def.displayName} detected: ${binPath}`);
    }
  }
  return available;
}

/**
 * Get binary path for a specific runtime. Throws if not found.
 * @param {string} runtimeId
 * @param {{ id: string, path: string }[]} detected - Result from detectAll()
 * @returns {string}
 */
export function getBinary(runtimeId, detected) {
  const entry = detected.find(d => d.id === runtimeId);
  if (!entry) {
    const def = CLI_DEFS[runtimeId];
    const hint = def ? ` Install it: ${def.installHint}` : '';
    throw new Error(`Runtime "${runtimeId}" is not available on this machine.${hint}`);
  }
  return entry.path;
}
