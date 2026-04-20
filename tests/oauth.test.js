import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { generateAuthUrl, getClientId, setClientId, getRedirectUri } from '../src/services/oauth.js';

describe('oauth service', () => {
  let origClientId;

  beforeEach(() => { origClientId = getClientId(); });
  afterEach(() => { setClientId(origClientId); });

  describe('generateAuthUrl (PKCE)', () => {
    it('throws if no client_id is registered', () => {
      setClientId(null);
      assert.throws(() => generateAuthUrl('https://example.com/cb'),
        /OAuth client not registered/);
    });

    it('returns url, state, and codeVerifier when client registered', () => {
      setClientId('test-client');
      const out = generateAuthUrl('https://example.com/cb');
      assert.ok(out.url.startsWith('http'));
      assert.ok(out.state);
      assert.ok(out.codeVerifier);
      assert.equal(out.state.length, 32, 'state should be 16 bytes hex');
    });

    it('includes required OAuth params in url', () => {
      setClientId('client-xyz');
      const { url } = generateAuthUrl('https://example.com/cb');
      const qs = new URL(url).searchParams;
      assert.equal(qs.get('client_id'), 'client-xyz');
      assert.equal(qs.get('redirect_uri'), 'https://example.com/cb');
      assert.equal(qs.get('response_type'), 'code');
      assert.equal(qs.get('code_challenge_method'), 'S256');
      assert.ok(qs.get('code_challenge'));
      assert.ok(qs.get('state'));
    });

    it('code_challenge is a valid SHA-256 of the code_verifier', () => {
      setClientId('c');
      const { url, codeVerifier } = generateAuthUrl('https://example.com/cb');
      const challenge = new URL(url).searchParams.get('code_challenge');
      const expected = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      assert.equal(challenge, expected);
    });

    it('generates fresh verifier and state on every call', () => {
      setClientId('c');
      const a = generateAuthUrl('https://example.com/cb');
      const b = generateAuthUrl('https://example.com/cb');
      assert.notEqual(a.codeVerifier, b.codeVerifier);
      assert.notEqual(a.state, b.state);
    });

    it('code_verifier has high enough entropy (>=32 bytes base64url)', () => {
      setClientId('c');
      const { codeVerifier } = generateAuthUrl('https://example.com/cb');
      // 32 bytes base64url ≈ 43 chars
      assert.ok(codeVerifier.length >= 43, `codeVerifier too short: ${codeVerifier.length}`);
    });
  });

  describe('getRedirectUri', () => {
    it('returns OAUTH_REDIRECT_URI env when set', () => {
      const prev = process.env.OAUTH_REDIRECT_URI;
      process.env.OAUTH_REDIRECT_URI = 'https://override.example/cb';
      try {
        const uri = getRedirectUri({ headers: {}, protocol: 'http', get: () => 'x' });
        assert.equal(uri, 'https://override.example/cb');
      } finally {
        if (prev) process.env.OAUTH_REDIRECT_URI = prev;
        else delete process.env.OAUTH_REDIRECT_URI;
      }
    });

    it('derives from request protocol + host when env unset', () => {
      delete process.env.OAUTH_REDIRECT_URI;
      const req = { headers: {}, protocol: 'https', get: () => 'nebula.example' };
      assert.equal(getRedirectUri(req), 'https://nebula.example/api/auth/callback');
    });

    it('honors x-forwarded-proto and x-forwarded-host (proxy)', () => {
      delete process.env.OAUTH_REDIRECT_URI;
      const req = {
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example' },
        protocol: 'http',
        get: () => 'internal',
      };
      assert.equal(getRedirectUri(req), 'https://public.example/api/auth/callback');
    });
  });

  describe('setClientId / getClientId', () => {
    it('round-trips', () => {
      setClientId('abc-123');
      assert.equal(getClientId(), 'abc-123');
      setClientId(null);
      assert.equal(getClientId(), null);
    });
  });
});
