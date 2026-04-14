import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { getOne } from '../db.js';
import { registerOAuthClient } from './oauth.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const INSTANCE_FILE = path.join(DATA_DIR, '.instance_id');
const LICENSE_FILE = path.join(DATA_DIR, '.license');
const PLATFORM_URL = process.env.PLATFORM_URL || 'https://dev.enigmaetmt.com:9443';
const GRACE_PERIOD_DAYS = 7;
const VALIDATE_TIMEOUT_MS = 10000;

// Read version from package.json at startup
let NEBULA_VERSION = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json'), 'utf-8'));
  NEBULA_VERSION = pkg.version || '0.0.0';
} catch {}

/**
 * Get or create a stable instance fingerprint.
 * Persisted in /data/.instance_id — survives container recreation as long as /data volume persists.
 */
export function getInstanceId() {
  if (fs.existsSync(INSTANCE_FILE)) {
    return fs.readFileSync(INSTANCE_FILE, 'utf-8').trim();
  }

  const raw = `${os.hostname()}-${DATA_DIR}-${Date.now()}`;
  const id = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);

  fs.mkdirSync(path.dirname(INSTANCE_FILE), { recursive: true });
  fs.writeFileSync(INSTANCE_FILE, id);
  return id;
}

/**
 * Read cached license state from /data/.license
 */
export function getLicenseStatus() {
  if (!fs.existsSync(LICENSE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Store license state to /data/.license (atomic write via temp file + rename)
 */
export function saveLicenseStatus(data) {
  fs.mkdirSync(path.dirname(LICENSE_FILE), { recursive: true });
  const tmpFile = LICENSE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, LICENSE_FILE);
}

/**
 * Extract the first active Nebula license from Platform userinfo and cache it.
 * Called after OAuth callback to sync license state from the user's Platform account.
 * Returns the license object or null if none found.
 */
export function extractAndSaveLicenseFromUserinfo(userinfo) {
  if (!userinfo?.licenses?.length) return null;

  const license = userinfo.licenses.find(l => l.status === 'active');
  if (!license) {
    console.warn('[license] User has no active Nebula license');
    return null;
  }

  saveLicenseStatus({
    key: license.key,
    instance_id: getInstanceId(),
    plan: license.plan || license.plan_slug,
    plan_name: license.plan_name,
    max_seats: license.max_seats,
    max_agents: license.max_agents,
    max_instances: license.max_instances,
    features: license.features || {},
    expires_at: license.expires_at,
    last_validated_at: new Date().toISOString(),
    grace_deadline: null,
  });

  console.log(`[license] License synced from Platform: ${license.key?.slice(0, 8)}... (${license.plan || license.plan_slug})`);
  return license;
}

/**
 * Validate a license key against the Enigma Platform.
 */
export async function validateLicense(key) {
  if (!key || !key.match(/^[A-Z]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)) {
    return { valid: false, reason: 'invalid_format' };
  }

  try {
    const resp = await fetch(`${PLATFORM_URL}/api/v1/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Key': key,
      },
      body: JSON.stringify({
        instance_id: getInstanceId(),
        version: NEBULA_VERSION,
      }),
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });

    const data = await resp.json();
    return data;
  } catch (err) {
    console.error('[license] Platform unreachable:', err.message);
    return { valid: false, reason: 'platform_unreachable', error: err.message };
  }
}

/**
 * Send telemetry to the Enigma Platform.
 * Called alongside periodic license validation. Non-critical — failures are logged but ignored.
 */
async function sendTelemetry(licenseKey) {
  try {
    const userCount = getOne('SELECT COUNT(*) as count FROM users')?.count || 0;
    const agentCount = getOne('SELECT COUNT(*) as count FROM agents')?.count || 0;
    const messageCount = getOne('SELECT COUNT(*) as count FROM messages')?.count || 0;

    await fetch(`${PLATFORM_URL}/api/v1/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Key': licenseKey,
      },
      body: JSON.stringify({
        instance_id: getInstanceId(),
        event_type: 'heartbeat',
        version: NEBULA_VERSION,
        user_count: userCount,
        agent_count: agentCount,
        total_messages: messageCount,
        uptime_hours: Math.round(process.uptime() / 3600),
      }),
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('[license] Telemetry send failed:', err.message);
  }
}

/**
 * Re-validate the cached license. Handles grace period when platform is unreachable.
 */
async function revalidate() {
  const license = getLicenseStatus();
  if (!license?.key) return;

  try {
    const result = await validateLicense(license.key);

    if (result.valid) {
      // Valid — update cache, clear grace period
      saveLicenseStatus({
        ...license,
        plan: result.plan,
        plan_name: result.plan_name,
        max_seats: result.max_seats,
        max_agents: result.max_agents,
        max_instances: result.max_instances,
        features: result.features,
        expires_at: result.expires_at,
        last_validated_at: new Date().toISOString(),
        grace_deadline: null,
      });

      // Re-register OAuth client + send telemetry
      await registerOAuth(license.key);
      await sendTelemetry(license.key);
      return;
    }

    if (result.reason === 'platform_unreachable') {
      // Network failure — enter or continue grace period
      if (!license.grace_deadline) {
        const deadline = new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
        saveLicenseStatus({ ...license, grace_deadline: deadline.toISOString() });
        console.warn(`[license] Platform unreachable, grace period until ${deadline.toISOString()}`);
      } else if (new Date() > new Date(license.grace_deadline)) {
        console.error('[license] Grace period expired — platform still unreachable');
      }
      return;
    }

    // Explicit rejection (expired, revoked, etc.)
    saveLicenseStatus({
      ...license,
      status: result.reason,
      last_validated_at: new Date().toISOString(),
      grace_deadline: null,
    });
    console.warn(`[license] License ${result.reason}: ${license.key.slice(0, 8)}...`);
  } catch (err) {
    console.error('[license] Revalidation error:', err.message);
  }
}

/**
 * Register this instance as an OAuth client on the Platform.
 * Uses OAUTH_REDIRECT_URI env var or builds from PORT.
 */
async function registerOAuth(licenseKey) {
  const redirectUri = process.env.OAUTH_REDIRECT_URI
    || `http://localhost:${process.env.PORT || 8080}/api/auth/callback`;
  await registerOAuthClient(licenseKey, redirectUri);
}

/**
 * Start periodic license re-validation.
 * Checks immediately on startup, then every 6 hours.
 * No-op when AUTH_PROVIDER=local (no license needed).
 */
export function startLicenseChecker() {
  if ((process.env.AUTH_PROVIDER || 'local') !== 'enigma') {
    console.log('[license] Local auth mode — license validation disabled');
    return;
  }

  const license = getLicenseStatus();
  if (!license?.key) return;

  console.log(`[license] License loaded: ${license.key.slice(0, 8)}... (${license.plan || 'unknown'})`);

  // Register OAuth client + validate on startup (non-blocking)
  registerOAuth(license.key).catch(err => console.error('[oauth] Startup registration failed:', err.message));
  revalidate().catch(err => console.error('[license] Startup validation failed:', err.message));

  // Periodic re-validation every 6 hours
  setInterval(() => {
    revalidate().catch(err => console.error('[license] Periodic validation failed:', err.message));
  }, 6 * 60 * 60 * 1000);
}
