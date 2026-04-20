import { getAll } from '../db.js';
import { decrypt } from './crypto.js';

/**
 * Redact all known secret values from text.
 * Scans org + agent secrets and replaces any occurrence of the plaintext value with [REDACTED].
 * Only redacts values that are at least 4 characters long to avoid false positives.
 */
export function redactSecrets(text, orgId, agentId) {
  if (!text) return text;

  const orgSecrets = getAll(
    'SELECT key, value FROM org_secrets WHERE org_id = ?',
    [orgId]
  );
  const agentSecrets = agentId ? getAll(
    'SELECT key, value FROM agent_secrets WHERE agent_id = ?',
    [agentId]
  ) : [];

  const allSecrets = [...orgSecrets, ...agentSecrets];
  let redacted = text;

  for (const s of allSecrets) {
    try {
      const plaintext = decrypt(s.value);
      if (plaintext && plaintext.length >= 4 && !'[REDACTED]'.includes(plaintext)) {
        redacted = redacted.split(plaintext).join('[REDACTED]');
      }
    } catch {
      // Skip if decryption fails
    }
  }

  return redacted;
}
