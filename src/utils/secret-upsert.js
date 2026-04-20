import { getOne, run } from '../db.js';
import { generateId } from './uuid.js';
import { encrypt } from './crypto.js';

export function upsertSecret(table, scopeColumn, scopeValue, key, value) {
  const cleanKey = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const encryptedValue = encrypt(value.trim());

  const query = scopeValue
    ? `SELECT id FROM ${table} WHERE ${scopeColumn} = ? AND key = ?`
    : `SELECT id FROM ${table} WHERE ${scopeColumn} IS NULL AND key = ?`;
  const params = scopeValue ? [scopeValue, cleanKey] : [cleanKey];

  const existing = getOne(query, params);

  if (existing) {
    run(
      `UPDATE ${table} SET value = ?, updated_at = datetime('now') WHERE id = ?`,
      [encryptedValue, existing.id]
    );
  } else {
    const id = generateId();
    if (scopeValue) {
      run(
        `INSERT INTO ${table} (id, ${scopeColumn}, key, value) VALUES (?, ?, ?, ?)`,
        [id, scopeValue, cleanKey, encryptedValue]
      );
    } else {
      run(
        `INSERT INTO ${table} (id, key, value) VALUES (?, ?, ?)`,
        [id, cleanKey, encryptedValue]
      );
    }
  }

  return cleanKey;
}
