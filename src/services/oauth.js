import crypto from 'crypto';

const PLATFORM_URL = process.env.PLATFORM_URL || 'https://dev.enigmaetmt.com:9443';
const TIMEOUT_MS = 15000;

// Dynamic client_id — set by registerOAuthClient() on startup
let clientId = null;

/**
 * Register this Nebula instance as an OAuth client on the Platform.
 * Called on startup after license validation. Idempotent — same license
 * always returns the same client_id, just updates the redirect_uri.
 *
 * @param {string} licenseKey - The instance's license key
 * @param {string} redirectUri - This instance's OAuth callback URL
 * @returns {{ client_id: string, redirect_origin: string } | null}
 */
export async function registerOAuthClient(licenseKey, redirectUri) {
  try {
    const resp = await fetch(`${PLATFORM_URL}/api/v1/oauth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Key': licenseKey,
      },
      body: JSON.stringify({ redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`[oauth] Client registration failed (${resp.status}): ${body.slice(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    clientId = data.client_id;
    console.log(`[oauth] Registered OAuth client: ${clientId}`);
    return data;
  } catch (err) {
    console.error('[oauth] Client registration failed:', err.message);
    return null;
  }
}

/**
 * Get the current OAuth client_id. Returns null if not yet registered.
 */
export function getClientId() {
  return clientId;
}

/**
 * Set client_id directly (for tests or manual override).
 */
export function setClientId(id) {
  clientId = id;
}

/**
 * Generate OAuth2 authorization URL with PKCE.
 */
export function generateAuthUrl(redirectUri) {
  if (!clientId) {
    throw new Error('OAuth client not registered — check license and Platform connectivity');
  }

  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  return {
    url: `${PLATFORM_URL}/oauth/authorize?${params}`,
    state,
    codeVerifier,
  };
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(code, codeVerifier, redirectUri) {
  const resp = await fetch(`${PLATFORM_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: clientId,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed (${resp.status}): ${body.slice(0, 200)}`);
  }

  return resp.json();
}

/**
 * Fetch user profile + licenses from the Platform.
 */
export async function getUserInfo(accessToken) {
  const resp = await fetch(`${PLATFORM_URL}/oauth/userinfo`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`Userinfo failed (${resp.status})`);
  }

  return resp.json();
}

/**
 * Refresh a Platform access token.
 */
export async function refreshPlatformToken(refreshToken) {
  const resp = await fetch(`${PLATFORM_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`Token refresh failed (${resp.status})`);
  }

  return resp.json();
}

/**
 * Build the callback redirect URI from the current request.
 */
export function getRedirectUri(req) {
  if (process.env.OAUTH_REDIRECT_URI) return process.env.OAUTH_REDIRECT_URI;
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/api/auth/callback`;
}

/** Expose PLATFORM_URL for frontend to link to registration */
export { PLATFORM_URL };
