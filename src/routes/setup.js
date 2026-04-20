import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getOne, getAll, run, setOrgSetting, getSetting, setSetting, initOrgDirectories, seedDefaultOrgSettings, orgPath, db } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { encrypt } from '../utils/crypto.js';
import { getInstanceId } from '../services/license.js';
import { registry } from '../backends/index.js';
import { initScheduler } from '../services/scheduler.js';
import { requireAuth } from './auth.js';
import { generateAccessToken, generateRefreshToken, setTokenCookies } from '../utils/jwt.js';
import { createAgent } from '../services/agent-creation.js';
import { sendError } from '../utils/response.js';

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
    return sendError(res, 403, 'Admin already exists');
  }
  if ((process.env.AUTH_PROVIDER || 'local') !== 'local') {
    return sendError(res, 400, 'Local registration not available with this auth provider');
  }

  const { email, password, name, orgName } = req.body;
  if (!email?.trim() || !password) {
    return sendError(res, 400, 'Email and password are required');
  }
  if (password.length < 8) {
    return sendError(res, 400, 'Password must be at least 8 characters');
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
    const orgDisplayName = orgName?.trim() || `${displayName}'s Organization`;
    run('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)',
      [orgId, orgDisplayName, userId]);

    initOrgDirectories(orgId);
    seedDefaultOrgSettings(orgId);

    db.exec('COMMIT');

    const accessToken = generateAccessToken({ userId, orgId, email: normalizedEmail });
    const refreshToken = generateRefreshToken({ userId, email: normalizedEmail });
    setTokenCookies(res, accessToken, refreshToken);

    res.json({
      user: { id: userId, email: normalizedEmail, name: displayName },
      orgs: [{ id: orgId, name: orgDisplayName, owner_id: userId }],
      currentOrgId: orgId,
    });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('[setup] Create admin error:', err);
    sendError(res, 500, 'Failed to create admin account');
  }
});

/**
 * POST /api/setup/complete — authenticated, applies backends + starter template.
 * Called after the user has authenticated (via OAuth or local admin creation).
 */
router.post('/complete', requireAuth, (req, res) => {
  if (isSetupComplete()) {
    return sendError(res, 403, 'Setup already completed');
  }

  const { settings, templateId } = req.body;

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

    // Load template — user-selected or fallback to starter
    const DATA_DIR = process.env.DATA_DIR || '/data';
    const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
    const builtinDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'templates');

    let template = null;
    const templateFile = (templateId || 'starter') + '.json';
    // Try /data/templates first, then built-in
    for (const dir of [TEMPLATES_DIR, builtinDir]) {
      const p = path.join(dir, templateFile);
      try {
        template = JSON.parse(fs.readFileSync(p, 'utf8'));
        break;
      } catch {}
    }
    if (!template) {
      console.warn(`[setup] Template "${templateFile}" not found, trying starter`);
      for (const dir of [TEMPLATES_DIR, builtinDir]) {
        try { template = JSON.parse(fs.readFileSync(path.join(dir, 'starter.json'), 'utf8')); break; } catch {}
      }
    }

    if (template?.agents?.length > 0) {
      for (const agentDef of template.agents) {
        if (!agentDef.name) continue;

        const existing = getOne('SELECT id FROM agents WHERE org_id = ? AND name = ?', [req.orgId, agentDef.name]);
        if (existing) continue;

        const { agentId } = createAgent(req.orgId, {
          name: agentDef.name,
          role: agentDef.role || '',
          model: agentDef.model || 'claude-sonnet-4-6',
          backend: agentDef.backend || registry.getDefault(req.orgId)?.cliId || '',
          allowed_tools: agentDef.allowed_tools || 'Read,Grep,Glob,WebFetch,Bash',
          timeout_ms: agentDef.timeout_ms || null,
          execution_mode: agentDef.execution_mode || 'local',
        });

        if (Array.isArray(agentDef.tasks)) {
          for (const taskDef of agentDef.tasks) {
            if (!taskDef.name) continue;
            run(
              `INSERT INTO tasks (id, agent_id, name, cron_expression, prompt, enabled)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [generateId(), agentId, taskDef.name, taskDef.cron || null, taskDef.prompt || '', taskDef.enabled ? 1 : 0]
            );
          }
        }

        if (Array.isArray(agentDef.skills)) {
          for (const skillDef of agentDef.skills) {
            if (!skillDef.name) continue;
            run(
              `INSERT INTO custom_skills (id, org_id, agent_id, name, description, content, enabled)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [generateId(), req.orgId, agentId, skillDef.name, skillDef.description || '', skillDef.content || '', skillDef.enabled ? 1 : 0]
            );
          }
        }

        if (Array.isArray(agentDef.mcp_servers)) {
          for (const mcpDef of agentDef.mcp_servers) {
            if (!mcpDef.name) continue;
            run(
              `INSERT INTO mcp_servers (id, org_id, agent_id, name, transport, config, enabled)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [generateId(), req.orgId, agentId, mcpDef.name, mcpDef.transport || 'stdio', JSON.stringify(mcpDef.config || {}), mcpDef.enabled ? 1 : 0]
            );
          }
        }
      }
    }

    // Org-wide skills
    if (Array.isArray(template?.skills)) {
      for (const skillDef of template.skills) {
        if (!skillDef.name) continue;
        run(
          `INSERT INTO custom_skills (id, org_id, agent_id, name, description, content, enabled)
           VALUES (?, ?, NULL, ?, ?, ?, ?)`,
          [generateId(), req.orgId, skillDef.name, skillDef.description || '', skillDef.content || '', skillDef.enabled ? 1 : 0]
        );
      }
    }

    // Org-wide MCP servers
    if (Array.isArray(template?.mcp_servers)) {
      for (const mcpDef of template.mcp_servers) {
        if (!mcpDef.name) continue;
        run(
          `INSERT INTO mcp_servers (id, org_id, agent_id, name, transport, config, enabled)
           VALUES (?, ?, NULL, ?, ?, ?, ?)`,
          [generateId(), req.orgId, null, mcpDef.name, mcpDef.transport || 'stdio', JSON.stringify(mcpDef.config || {}), mcpDef.enabled ? 1 : 0]
        );
      }
    }

    // Mark setup as complete
    setSetting('setup_completed', '1');

    // Re-initialize scheduler
    initScheduler();

    res.json({ ok: true });
  } catch (err) {
    console.error('[setup] Complete error:', err);
    sendError(res, 500, 'Setup failed');
  }
});

export default router;
