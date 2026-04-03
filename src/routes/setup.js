import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getOne, getAll, run, setOrgSetting, getSetting, setSetting, initOrgDirectories, orgPath, db } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { encrypt } from '../utils/crypto.js';
import { getInstanceId } from '../services/license.js';
import { registry } from '../backends/index.js';
import { initScheduler } from '../services/scheduler.js';
import { requireAuth } from './auth.js';
import { generateAccessToken, generateRefreshToken, setTokenCookies } from '../utils/jwt.js';

const router = Router();

const ALLOWED_SETTING_KEYS = [
  'default_runtime',
];
const SECRET_SETTING_KEYS = [];

function hasUsers() {
  return getOne('SELECT COUNT(*) as count FROM users').count > 0;
}

function isSetupComplete() {
  return getSetting('setup_completed') === '1';
}

/**
 * GET /api/setup/status — public, tells frontend which state the instance is in.
 */
router.get('/status', (req, res) => {
  const users = hasUsers();
  res.json({
    needsSetup: !users,
    setupIncomplete: users && !isSetupComplete(),
    instanceId: getInstanceId(),
    authProvider: process.env.AUTH_PROVIDER || 'local',
  });
});

/**
 * POST /api/setup/create-admin — public, only allowed during first boot (no users exist).
 * Creates admin user + org, issues JWT cookies. Used by local auth setup wizard.
 */
router.post('/create-admin', (req, res) => {
  if (hasUsers()) {
    return res.status(403).json({ error: 'Admin already exists' });
  }
  if ((process.env.AUTH_PROVIDER || 'local') !== 'local') {
    return res.status(400).json({ error: 'Local registration not available with this auth provider' });
  }

  const { email, password, name } = req.body;
  if (!email?.trim() || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const userId = generateId();
  const passwordHash = bcrypt.hashSync(password, 10);

  db.exec('BEGIN IMMEDIATE');
  try {
    run(
      'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)',
      [userId, normalizedEmail, (name || '').trim() || normalizedEmail, passwordHash]
    );

    const orgId = generateId();
    const displayName = (name || normalizedEmail).trim();
    run('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)',
      [orgId, `${displayName}'s Workspace`, userId]);

    initOrgDirectories(orgId);
    const defaultOrgSettings = {
      internal_api_token: crypto.randomUUID(),
      smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', smtp_from: '',
      notify_email_to: '', notifications_enabled: '0',
      imap_host: '', imap_port: '993', imap_user: '', imap_pass: '', mail_enabled: '0',
    };
    for (const [key, value] of Object.entries(defaultOrgSettings)) {
      setOrgSetting(orgId, key, value);
    }

    db.exec('COMMIT');

    const accessToken = generateAccessToken({ userId, orgId, email: normalizedEmail });
    const refreshToken = generateRefreshToken({ userId, email: normalizedEmail });
    setTokenCookies(res, accessToken, refreshToken);

    res.json({
      user: { id: userId, email: normalizedEmail, name: displayName },
      orgs: [{ id: orgId, name: `${displayName}'s Workspace`, owner_id: userId }],
      currentOrgId: orgId,
    });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('[setup] Create admin error:', err);
    res.status(500).json({ error: 'Failed to create admin account' });
  }
});

/**
 * POST /api/setup/complete — authenticated, applies backends + starter template.
 * Called after the user has authenticated (via OAuth or local admin creation).
 */
router.post('/complete', requireAuth, (req, res) => {
  if (isSetupComplete()) {
    return res.status(403).json({ error: 'Setup already completed' });
  }

  const { settings } = req.body;

  try {
    // Apply backend API keys — whitelist only
    if (settings && typeof settings === 'object') {
      for (const [key, value] of Object.entries(settings)) {
        if (!ALLOWED_SETTING_KEYS.includes(key)) continue;
        if (!value || value === '********') continue;
        const val = SECRET_SETTING_KEYS.includes(key) ? encrypt(String(value)) : String(value);
        setOrgSetting(req.orgId, key, val);
      }
    }

    // Apply starter template
    const starterTemplatePath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname), '..', '..', 'templates', 'starter.json'
    );
    let template = null;
    try {
      template = JSON.parse(fs.readFileSync(starterTemplatePath, 'utf8'));
    } catch {
      const DATA_DIR = process.env.DATA_DIR || './data';
      const fallback = path.join(DATA_DIR, 'templates', 'starter.json');
      try {
        template = JSON.parse(fs.readFileSync(fallback, 'utf8'));
      } catch {
        console.warn('[setup] Starter template not found');
      }
    }

    if (template?.agents?.length > 0) {
      for (const agentDef of template.agents) {
        if (!agentDef.name) continue;

        // Skip if agent already exists in org (idempotent)
        const existing = getOne('SELECT id FROM agents WHERE org_id = ? AND name = ?', [req.orgId, agentDef.name]);
        if (existing) continue;

        const agentId = generateId();
        const sessionId = generateId();

        run(
          `INSERT INTO agents (id, org_id, name, role, session_id, allowed_tools, model, backend, timeout_ms, execution_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            agentId, req.orgId,
            String(agentDef.name).slice(0, 100),
            String(agentDef.role || '').slice(0, 2000),
            sessionId,
            agentDef.allowed_tools || 'Read,Grep,Glob,WebFetch,Bash',
            agentDef.model || 'claude-sonnet-4-6',
            agentDef.backend || registry.getDefault(req.orgId)?.cliId || '',
            agentDef.timeout_ms || null,
            agentDef.execution_mode || 'local',
          ]
        );

        const convId = generateId();
        run(
          `INSERT INTO conversations (id, agent_id, title, session_id, session_initialized)
           VALUES (?, ?, 'General', ?, 0)`,
          [convId, agentId, sessionId]
        );

        // Create agent directory
        const agentDir = orgPath(req.orgId, 'agents', agentId);
        fs.mkdirSync(agentDir, { recursive: true });
        fs.mkdirSync(path.join(agentDir, 'workspace'), { recursive: true });
      }
    }

    // Mark setup as complete
    setSetting('setup_completed', '1');

    // Re-initialize scheduler
    initScheduler();

    res.json({ ok: true });
  } catch (err) {
    console.error('[setup] Complete error:', err);
    res.status(500).json({ error: 'Setup failed' });
  }
});

export default router;
