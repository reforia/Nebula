import { getOrgSetting } from '../db.js';

/**
 * CLI Runtime Registry.
 * Manages available CLI adapters, auto-detection, and resolution logic.
 * No CLI is special — all are equal entries in the registry.
 */
class CLIRegistry {
  constructor() {
    this._adapters = new Map(); // cliId -> ExecutionBackend instance
  }

  /**
   * Register a CLI adapter.
   * @param {import('./base.js').ExecutionBackend} adapter
   */
  register(adapter) {
    this._adapters.set(adapter.cliId, adapter);
  }

  /**
   * Scan for all registered CLI binaries on the system.
   * Updates each adapter's isAvailable and binaryPath.
   */
  detect() {
    for (const adapter of this._adapters.values()) {
      const result = adapter.detectBinary();
      if (result) {
        console.log(`[cli-registry] ${adapter.displayName} detected at: ${result}`);
      }
    }
  }

  /**
   * Get all adapters where the binary was found.
   * @returns {import('./base.js').ExecutionBackend[]}
   */
  getAvailable() {
    return [...this._adapters.values()].filter(a => a.isAvailable);
  }

  /**
   * Get all registered adapters (regardless of availability).
   * @returns {import('./base.js').ExecutionBackend[]}
   */
  getAll() {
    return [...this._adapters.values()];
  }

  /**
   * Get adapter by cliId. Throws if not found.
   * @param {string} id
   * @returns {import('./base.js').ExecutionBackend}
   */
  get(id) {
    const adapter = this._adapters.get(id);
    if (!adapter) {
      throw new Error(`Unknown CLI runtime: "${id}". Available: ${[...this._adapters.keys()].join(', ')}`);
    }
    return adapter;
  }

  /**
   * Determine the default runtime for an org.
   * Priority: org setting > single available > first available > null
   * @param {string} [orgId]
   * @returns {import('./base.js').ExecutionBackend|null}
   */
  getDefault(orgId) {
    // Check org-level setting
    if (orgId) {
      const setting = getOrgSetting(orgId, 'default_runtime');
      if (setting && this._adapters.has(setting)) {
        const adapter = this._adapters.get(setting);
        if (adapter.isAvailable) return adapter;
      }
    }

    const available = this.getAvailable();
    if (available.length === 1) return available[0];
    if (available.length > 0) return available[0];
    return null;
  }

  /**
   * Resolve which CLI to use for a specific agent execution.
   *
   * Resolution order:
   * 1. agent.backend if that CLI is available and can run the model
   * 2. org default if it can run the model
   * 3. any available CLI that can run the model
   * 4. throw if nothing works
   *
   * @param {Object} agent - Agent DB row (needs .backend, .model)
   * @param {string} [orgId]
   * @returns {import('./base.js').ExecutionBackend}
   */
  resolveForAgent(agent, orgId) {
    const model = agent.model || 'claude-sonnet-4-6';

    // Try agent's configured backend
    if (agent.backend && this._adapters.has(agent.backend)) {
      const preferred = this._adapters.get(agent.backend);
      if (preferred.isAvailable && preferred.canRunModel(model)) {
        return preferred;
      }
    }

    // Fall back to org default
    const orgDefault = this.getDefault(orgId);
    if (orgDefault && orgDefault.canRunModel(model)) {
      return orgDefault;
    }

    // Fall back to any available CLI that supports the model
    const available = this.getAvailable();
    for (const adapter of available) {
      if (adapter.canRunModel(model)) {
        return adapter;
      }
    }

    // Nothing can run this model
    if (available.length === 0) {
      throw new Error('No CLI runtime available — place a supported CLI binary in the runtimes volume');
    }
    throw new Error(`No CLI runtime can execute model "${model}". Available runtimes: ${available.map(a => `${a.displayName} (${a.supportedModelPrefixes.join(', ') || 'any'})`).join(', ')}`);
  }
}

// Singleton
export const registry = new CLIRegistry();
