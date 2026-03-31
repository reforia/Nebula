import { ClaudeCLIBackend } from './claude-cli.js';
import { OpenCodeBackend } from './opencode.js';
import { CodexBackend } from './codex.js';
import { GeminiBackend } from './gemini.js';
import { registry } from './cli-registry.js';

// Register all CLI adapters
registry.register(new ClaudeCLIBackend());
registry.register(new OpenCodeBackend());
registry.register(new CodexBackend());
registry.register(new GeminiBackend());

// Detect available binaries at startup
registry.detect();

export { registry };

/**
 * Get a backend by cliId.
 * Falls back to claude-cli for backward compatibility with existing code
 * that passes unknown/null names.
 */
export function getBackend(name) {
  try {
    return registry.get(name);
  } catch {
    // Backward compat: fall back to first available or claude-cli
    const def = registry.getDefault();
    if (def) return def;
    return registry.get('claude-cli');
  }
}

export function listBackends() {
  return registry.getAll().map(a => a.cliId);
}

export function listAllModels() {
  const models = [];
  for (const adapter of registry.getAll()) {
    models.push(...adapter.listModels());
  }
  return models;
}
