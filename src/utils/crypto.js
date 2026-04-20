import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:';

// NEBULA_ENCRYPTION_KEY is a hard prerequisite — see README "Quick Start".
// Generate once with: openssl rand -hex 32
// Set it in .env (loaded automatically by `npm start` / `npm run dev` via
// --env-file-if-exists) or export it in your shell. Docker/NAS deploys are
// additionally gated by scripts/entrypoint.sh and scripts/deploy.sh.
// Tests inject a deterministic key in tests/setup.js before importing modules.
function getMasterKey() {
  const envKey = process.env.NEBULA_ENCRYPTION_KEY;
  if (!envKey) {
    throw new Error(
      'NEBULA_ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` ' +
      'and add it to .env. See README "Quick Start" for details.'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
    throw new Error(
      'NEBULA_ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
      'Regenerate with `openssl rand -hex 32`.'
    );
  }
  return Buffer.from(envKey, 'hex');
}

const KEY = getMasterKey();

/**
 * Encrypt a plaintext string. Returns "enc:<iv>:<authTag>:<ciphertext>" (all hex).
 */
export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a value. If it doesn't have the "enc:" prefix, returns as-is (plaintext migration).
 */
export function decrypt(value) {
  if (!value || !value.startsWith(PREFIX)) {
    return value; // Plaintext — not yet encrypted
  }
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return value;

  const [ivHex, authTagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Check if a value is already encrypted.
 */
export function isEncrypted(value) {
  return value && value.startsWith(PREFIX);
}
