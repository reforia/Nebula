import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:';

// Master key: from env var or derive from a stable machine-specific value
function getMasterKey() {
  const envKey = process.env.NEBULA_ENCRYPTION_KEY;
  if (envKey) {
    // Use provided key (must be 32 bytes / 64 hex chars)
    return Buffer.from(envKey, 'hex');
  }
  // Fallback: derive from DATA_DIR path + hardcoded salt (stable across restarts)
  const seed = (process.env.DATA_DIR || '/data') + ':nebula-secrets-key';
  return crypto.createHash('sha256').update(seed).digest();
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
