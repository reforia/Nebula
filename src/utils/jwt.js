import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getSetting, setSetting } from '../db.js';

let cachedSecret = null;

function getSecret() {
  if (cachedSecret) return cachedSecret;

  // Prefer env var, fallback to DB-stored secret
  cachedSecret = process.env.JWT_SECRET || getSetting('jwt_secret');
  if (!cachedSecret) {
    cachedSecret = crypto.randomBytes(64).toString('hex');
    setSetting('jwt_secret', cachedSecret);
  }
  return cachedSecret;
}

export function generateAccessToken({ userId, orgId, email }) {
  return jwt.sign({ userId, orgId, email }, getSecret(), { expiresIn: '15m' });
}

export function generateRefreshToken({ userId, email }) {
  return jwt.sign({ userId, email, type: 'refresh' }, getSecret(), { expiresIn: '30d' });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, getSecret());
}

export function verifyRefreshToken(token) {
  const payload = jwt.verify(token, getSecret());
  if (payload.type !== 'refresh') throw new Error('Not a refresh token');
  return payload;
}

export function setTokenCookies(res, accessToken, refreshToken) {
  res.cookie('nebula_access', accessToken, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000, // 15 minutes
  });
  res.cookie('nebula_refresh', refreshToken, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

export function clearTokenCookies(res) {
  res.clearCookie('nebula_access');
  res.clearCookie('nebula_refresh', { path: '/api/auth' });
}
