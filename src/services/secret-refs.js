import { getAll, getOne } from '../db.js';
import { decrypt } from '../utils/crypto.js';

/**
 * Extract {{KEY}} references from text.
 * @param {string} text - Skill content, MCP config JSON, etc.
 * @returns {string[]} Deduplicated list of secret key names.
 */
export function extractSecretRefs(text) {
  if (!text) return [];
  const matches = text.matchAll(/\{\{([A-Z0-9_]+)\}\}/g);
  const keys = new Set();
  for (const m of matches) keys.add(m[1]);
  return [...keys];
}

/**
 * Get all secret references for an org or agent scope.
 * Scans skills and MCP configs for {{KEY}} patterns, checks if configured.
 *
 * @param {string} orgId
 * @param {string} [agentId] - If provided, includes agent-scoped items
 * @returns {Array<{ key: string, sources: Array<{ name: string, type: 'skill'|'mcp', scope: 'org'|'agent', id: string }>, configured: boolean }>}
 */
export function getReferencedSecrets(orgId, agentId) {
  // Collect all sources to scan
  const sources = [];

  // Org-wide skills
  const orgSkills = getAll(
    'SELECT id, name, content FROM custom_skills WHERE org_id = ? AND agent_id IS NULL',
    [orgId]
  );
  for (const s of orgSkills) {
    for (const key of extractSecretRefs(s.content)) {
      sources.push({ key, name: s.name, type: 'skill', scope: 'org', id: s.id });
    }
  }

  // Org-wide MCP servers
  const orgMcps = getAll(
    'SELECT id, name, config FROM mcp_servers WHERE org_id = ? AND agent_id IS NULL',
    [orgId]
  );
  for (const m of orgMcps) {
    for (const key of extractSecretRefs(m.config)) {
      sources.push({ key, name: m.name, type: 'mcp', scope: 'org', id: m.id });
    }
  }

  // Agent-specific items (if agentId provided)
  if (agentId) {
    const agentSkills = getAll(
      'SELECT id, name, content FROM custom_skills WHERE agent_id = ?',
      [agentId]
    );
    for (const s of agentSkills) {
      for (const key of extractSecretRefs(s.content)) {
        sources.push({ key, name: s.name, type: 'skill', scope: 'agent', id: s.id });
      }
    }

    const agentMcps = getAll(
      'SELECT id, name, config FROM mcp_servers WHERE agent_id = ?',
      [agentId]
    );
    for (const m of agentMcps) {
      for (const key of extractSecretRefs(m.config)) {
        sources.push({ key, name: m.name, type: 'mcp', scope: 'agent', id: m.id });
      }
    }
  }

  // Group by key
  const refMap = new Map();
  for (const s of sources) {
    if (!refMap.has(s.key)) refMap.set(s.key, []);
    refMap.get(s.key).push({ name: s.name, type: s.type, scope: s.scope, id: s.id });
  }

  // Check which keys are configured
  const results = [];
  for (const [key, srcs] of refMap) {
    let configured = false;

    // Check org secrets
    const orgSecret = getOne(
      'SELECT value FROM org_secrets WHERE org_id = ? AND key = ?',
      [orgId, key]
    );
    if (orgSecret) configured = true;

    // Check agent secrets (override)
    if (agentId && !configured) {
      const agentSecret = getOne(
        'SELECT value FROM agent_secrets WHERE agent_id = ? AND key = ?',
        [agentId, key]
      );
      if (agentSecret) configured = true;
    }

    results.push({ key, sources: srcs, configured });
  }

  return results;
}

/**
 * Check if all secret refs in a piece of content are configured.
 * Used as a guard when enabling skills/MCP servers.
 *
 * @param {string} orgId
 * @param {string|null} agentId
 * @param {string} content - Skill content or MCP config to scan
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkSecretsForEnable(orgId, agentId, content) {
  const refs = extractSecretRefs(content);
  if (refs.length === 0) return { ok: true, missing: [] };

  const missing = [];
  for (const key of refs) {
    let found = false;

    // Check org secrets
    const orgSecret = getOne(
      'SELECT id FROM org_secrets WHERE org_id = ? AND key = ?',
      [orgId, key]
    );
    if (orgSecret) found = true;

    // Check agent secrets
    if (!found && agentId) {
      const agentSecret = getOne(
        'SELECT id FROM agent_secrets WHERE agent_id = ? AND key = ?',
        [agentId, key]
      );
      if (agentSecret) found = true;
    }

    if (!found) missing.push(key);
  }

  return { ok: missing.length === 0, missing };
}

/**
 * Check if a secret can be safely deleted (not referenced by enabled items).
 *
 * @param {string} orgId
 * @param {string} key - Secret key name
 * @param {'org'|'agent'} scope
 * @param {string} [agentId]
 * @returns {{ deletable: boolean, references: Array<{ name: string, type: string }> }}
 */
export function checkSecretDeletable(orgId, key, scope, agentId) {
  const pattern = `%{{${key}}}%`;
  const references = [];

  if (scope === 'org') {
    // Check org-wide skills
    const orgSkills = getAll(
      'SELECT name FROM custom_skills WHERE org_id = ? AND agent_id IS NULL AND enabled = 1 AND content LIKE ?',
      [orgId, pattern]
    );
    for (const s of orgSkills) references.push({ name: s.name, type: 'skill' });

    // Check org-wide MCP servers
    const orgMcps = getAll(
      'SELECT name FROM mcp_servers WHERE org_id = ? AND agent_id IS NULL AND enabled = 1 AND config LIKE ?',
      [orgId, pattern]
    );
    for (const m of orgMcps) references.push({ name: m.name, type: 'mcp' });

    // Also check all agent skills/MCPs that inherit this org secret
    // (only if no agent-level override exists for the same key)
    const agentSkills = getAll(
      `SELECT cs.name, cs.agent_id FROM custom_skills cs
       WHERE cs.org_id = ? AND cs.agent_id IS NOT NULL AND cs.enabled = 1 AND cs.content LIKE ?
       AND NOT EXISTS (SELECT 1 FROM agent_secrets WHERE agent_id = cs.agent_id AND key = ?)`,
      [orgId, pattern, key]
    );
    for (const s of agentSkills) references.push({ name: s.name, type: 'skill (agent)' });

    const agentMcps = getAll(
      `SELECT ms.name, ms.agent_id FROM mcp_servers ms
       WHERE ms.org_id = ? AND ms.agent_id IS NOT NULL AND ms.enabled = 1 AND ms.config LIKE ?
       AND NOT EXISTS (SELECT 1 FROM agent_secrets WHERE agent_id = ms.agent_id AND key = ?)`,
      [orgId, pattern, key]
    );
    for (const m of agentMcps) references.push({ name: m.name, type: 'mcp (agent)' });
  } else if (scope === 'agent' && agentId) {
    // Check agent-specific skills
    const skills = getAll(
      'SELECT name FROM custom_skills WHERE agent_id = ? AND enabled = 1 AND content LIKE ?',
      [agentId, pattern]
    );
    for (const s of skills) references.push({ name: s.name, type: 'skill' });

    // Check agent-specific MCP servers
    const mcps = getAll(
      'SELECT name FROM mcp_servers WHERE agent_id = ? AND enabled = 1 AND config LIKE ?',
      [agentId, pattern]
    );
    for (const m of mcps) references.push({ name: m.name, type: 'mcp' });
  }

  return { deletable: references.length === 0, references };
}
