import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { getAll, getOne, run, getOrgSetting, setOrgSetting, orgPath } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { resetTransporter } from '../services/email.js';
import { encrypt } from '../utils/crypto.js';
import { createBackup, listBackups, restoreBackup } from '../services/backup.js';
import { getReferencedSecrets, checkSecretDeletable } from '../services/secret-refs.js';
import { rescheduleCleanup, runCleanupNow, getCleanupStatus } from '../services/cleanup.js';
import { registry } from '../backends/index.js';

const router = Router();

const isDocker = (() => {
  try { return fs.existsSync('/.dockerenv'); } catch { return false; }
})();

// GET /api/settings — org-scoped settings
router.get('/settings', (req, res) => {
  const orgKeys = [
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from',
    'notify_email_to', 'notifications_enabled',
    'imap_host', 'imap_port', 'imap_user', 'imap_pass', 'mail_enabled',
    'default_timeout_ms',
    'task_stagger_ms',
    'cron_enabled',
    'default_runtime',
    'recovery_token_budget',
    'mention_context_messages', 'mention_context_chars',
    'cleanup_enabled', 'cleanup_cron', 'cleanup_sessions', 'cleanup_worktrees', 'cleanup_dreaming',
  ];

  const secretKeys = ['smtp_pass', 'imap_pass'];

  const settings = {};

  // Org-level settings
  for (const key of orgKeys) {
    const val = getOrgSetting(req.orgId, key);
    if (secretKeys.includes(key) && val) {
      settings[key] = '********';
    } else {
      settings[key] = val || '';
    }
  }

  res.json(settings);
});

// PUT /api/settings
router.put('/settings', (req, res) => {
  const orgKeys = [
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from',
    'notify_email_to', 'notifications_enabled',
    'imap_host', 'imap_port', 'imap_user', 'imap_pass', 'mail_enabled',
    'default_timeout_ms',
    'task_stagger_ms',
    'cron_enabled',
    'default_runtime',
    'recovery_token_budget',
    'mention_context_messages', 'mention_context_chars',
    'cleanup_enabled', 'cleanup_cron', 'cleanup_sessions', 'cleanup_worktrees', 'cleanup_dreaming',
  ];

  const settingSecretKeys = ['smtp_pass', 'imap_pass'];

  let cleanupChanged = false;
  for (const [key, value] of Object.entries(req.body)) {
    if (settingSecretKeys.includes(key) && value === '********') continue;

    if (orgKeys.includes(key)) {
      const val = settingSecretKeys.includes(key) ? encrypt(String(value)) : String(value);
      setOrgSetting(req.orgId, key, val);
      if (key.startsWith('cleanup_')) cleanupChanged = true;
    }
  }

  resetTransporter();

  // Reschedule cleanup if settings changed
  if (cleanupChanged) {
    rescheduleCleanup(req.orgId);
  }

  res.json({ ok: true });
});

// GET /api/models — available models from registered CLI runtimes
router.get('/models', (req, res) => {
  // registry imported at top
  const models = [];
  for (const adapter of registry.getAll()) {
    models.push(...adapter.listModels());
  }
  res.json(models);
});

// --- Runtimes ---

// GET /api/runtimes — detected CLI runtimes, versions, auth status, org default
router.get('/runtimes', (req, res) => {
  // registry imported at top
  const orgDefault = getOrgSetting(req.orgId, 'default_runtime') || '';

  const runtimes = registry.getAll().map(adapter => {
    return {
      id: adapter.cliId,
      name: adapter.displayName,
      binaryName: adapter.binaryNames[0] || adapter.cliId,
      available: adapter.isAvailable,
      binaryPath: adapter.binaryPath,
      version: adapter.getVersion(),
      skillInjection: adapter.skillInjection,
      hasBuiltinWebTools: adapter.hasBuiltinWebTools,
      requiresApiKey: adapter.requiresApiKey,
      supportedModelPrefixes: adapter.supportedModelPrefixes,
      models: adapter.listModels(),
      auth: adapter.getAuth(),
      install: {
        command: adapter.installCommand,
        url: adapter.installUrl,
      },
      authGuide: {
        command: adapter.authCommand,
        dockerCommand: isDocker && adapter.authCommand
          ? `docker exec -it nebula ${adapter.authCommand}`
          : null,
        description: adapter.authDescription,
      },
    };
  });

  const available = runtimes.filter(r => r.available);
  const resolvedDefault = orgDefault && available.some(r => r.id === orgDefault)
    ? orgDefault
    : (available.length === 1 ? available[0].id : (available[0]?.id || ''));

  res.json({ runtimes, default: resolvedDefault });
});

// POST /api/runtimes/detect — re-scan for CLI binaries
router.post('/runtimes/detect', (req, res) => {
  registry.detect();

  const runtimes = registry.getAll().map(adapter => ({
    id: adapter.cliId,
    name: adapter.displayName,
    available: adapter.isAvailable,
    binaryPath: adapter.binaryPath,
  }));

  res.json({ runtimes });
});

// PUT /api/runtimes/default — set org default runtime
router.put('/runtimes/default', (req, res) => {
  const { runtime } = req.body;
  if (!runtime) return res.status(400).json({ error: 'runtime is required' });

  // registry imported at top
  try {
    registry.get(runtime); // throws if unknown
  } catch {
    return res.status(400).json({ error: `Unknown runtime: ${runtime}` });
  }

  setOrgSetting(req.orgId, 'default_runtime', runtime);
  res.json({ ok: true, default: runtime });
});


// GET /api/tasks/all — all tasks across agents in the org (for calendar view)
router.get('/tasks/all', (req, res) => {
  const tasks = getAll(
    `SELECT t.*, a.name as agent_name, a.emoji as agent_emoji,
       p.name as project_name
     FROM tasks t
     JOIN agents a ON t.agent_id = a.id
     LEFT JOIN projects p ON t.project_id = p.id
     WHERE a.org_id = ?
     ORDER BY a.sort_order ASC, a.name ASC, t.created_at ASC`,
    [req.orgId]
  );
  res.json(tasks);
});

// GET /api/status — org-scoped stats
router.get('/status', (req, res) => {
  const agentCount = getOne(
    'SELECT COUNT(*) as count FROM agents WHERE org_id = ?', [req.orgId]
  ).count;
  const taskCount = getOne(
    'SELECT COUNT(*) as count FROM tasks t JOIN agents a ON t.agent_id = a.id WHERE t.enabled = 1 AND a.org_id = ?',
    [req.orgId]
  ).count;
  const messageCount = getOne(
    'SELECT COUNT(*) as count FROM messages m JOIN agents a ON m.agent_id = a.id WHERE a.org_id = ?',
    [req.orgId]
  ).count;

  // Usage stats
  const usage = getOne(
    `SELECT
       COUNT(*) as total_executions,
       COALESCE(SUM(tokens_in), 0) as total_tokens_in,
       COALESCE(SUM(tokens_out), 0) as total_tokens_out,
       COALESCE(SUM(total_cost), 0) as total_cost,
       COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count
     FROM usage_events WHERE org_id = ?`,
    [req.orgId]
  );

  const usage30d = getOne(
    `SELECT
       COUNT(*) as executions,
       COALESCE(SUM(tokens_in), 0) as tokens_in,
       COALESCE(SUM(tokens_out), 0) as tokens_out,
       COALESCE(SUM(total_cost), 0) as cost
     FROM usage_events
     WHERE org_id = ? AND created_at >= datetime('now', '-30 days')`,
    [req.orgId]
  );

  const topModels = getAll(
    `SELECT model, COUNT(*) as executions, COALESCE(SUM(total_cost), 0) as cost
     FROM usage_events WHERE org_id = ? AND model IS NOT NULL
     GROUP BY model ORDER BY executions DESC LIMIT 5`,
    [req.orgId]
  );

  const topAgents = getAll(
    `SELECT u.agent_id, a.name as agent_name, a.emoji as agent_emoji,
       COUNT(*) as executions, COALESCE(SUM(u.total_cost), 0) as cost
     FROM usage_events u
     JOIN agents a ON u.agent_id = a.id
     WHERE u.org_id = ?
     GROUP BY u.agent_id ORDER BY executions DESC LIMIT 5`,
    [req.orgId]
  );

  res.json({
    ok: true,
    agents: agentCount,
    active_tasks: taskCount,
    total_messages: messageCount,
    uptime: process.uptime(),
    usage: {
      total: {
        executions: usage.total_executions,
        tokens_in: usage.total_tokens_in,
        tokens_out: usage.total_tokens_out,
        cost: usage.total_cost,
        errors: usage.error_count,
      },
      last_30d: {
        executions: usage30d.executions,
        tokens_in: usage30d.tokens_in,
        tokens_out: usage30d.tokens_out,
        cost: usage30d.cost,
      },
      top_models: topModels,
      top_agents: topAgents,
    },
  });
});

// GET /api/errors — recent execution errors for the org
router.get('/errors', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const errors = getAll(
    `SELECT u.id, u.agent_id, u.conversation_id, u.backend, u.model, u.error_message, u.created_at,
            a.name as agent_name, a.emoji as agent_emoji
     FROM usage_events u
     LEFT JOIN agents a ON u.agent_id = a.id
     WHERE u.org_id = ? AND u.status = 'error'
     ORDER BY u.created_at DESC
     LIMIT ?`,
    [req.orgId, limit]
  );
  res.json(errors);
});

// DELETE /api/errors/:id — dismiss a single error
router.delete('/errors/:id', (req, res) => {
  const event = getOne(
    'SELECT id FROM usage_events WHERE id = ? AND org_id = ? AND status = ?',
    [req.params.id, req.orgId, 'error']
  );
  if (!event) return res.status(404).json({ error: 'Error not found' });
  run('DELETE FROM usage_events WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// DELETE /api/errors — dismiss all errors
router.delete('/errors', (req, res) => {
  run('DELETE FROM usage_events WHERE org_id = ? AND status = ?', [req.orgId, 'error']);
  res.json({ ok: true });
});

// GET /api/global-knowledge — org-scoped
router.get('/global-knowledge', (req, res) => {
  const filePath = orgPath(req.orgId, 'global', 'CLAUDE.md');
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  res.json({ content });
});

// PUT /api/global-knowledge — org-scoped
router.put('/global-knowledge', (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'Content is required' });

  const filePath = orgPath(req.orgId, 'global', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  res.json({ ok: true });
});

// --- Org Secrets Vault ---

// GET /api/secrets — list keys only (never values)
router.get('/secrets', (req, res) => {
  const secrets = getAll(
    'SELECT id, key, created_at, updated_at FROM org_secrets WHERE org_id = ? ORDER BY key ASC',
    [req.orgId]
  );
  res.json(secrets);
});

// POST /api/secrets — create or update a secret
router.post('/secrets', (req, res) => {
  const { key, value } = req.body;
  if (!key || !key.trim()) return res.status(400).json({ error: 'Key is required' });
  if (!value || !value.trim()) return res.status(400).json({ error: 'Value is required' });

  const cleanKey = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');

  const existing = getOne(
    'SELECT id FROM org_secrets WHERE org_id = ? AND key = ?',
    [req.orgId, cleanKey]
  );

  const encryptedValue = encrypt(value.trim());

  if (existing) {
    run(
      "UPDATE org_secrets SET value = ?, updated_at = datetime('now') WHERE id = ?",
      [encryptedValue, existing.id]
    );
  } else {
    const id = generateId();
    run(
      'INSERT INTO org_secrets (id, org_id, key, value) VALUES (?, ?, ?, ?)',
      [id, req.orgId, cleanKey, encryptedValue]
    );
  }

  res.json({ ok: true, key: cleanKey });
});

// DELETE /api/secrets/:id
router.delete('/secrets/:id', (req, res) => {
  const secret = getOne(
    'SELECT id, key FROM org_secrets WHERE id = ? AND org_id = ?',
    [req.params.id, req.orgId]
  );
  if (!secret) return res.status(404).json({ error: 'Secret not found' });

  // Guard: can't delete a secret referenced by enabled skills/MCP
  const { deletable, references } = checkSecretDeletable(req.orgId, secret.key, 'org');
  if (!deletable) {
    const names = references.map(r => `${r.name} (${r.type})`).join(', ');
    return res.status(400).json({ error: `Secret is referenced by: ${names}. Disable them first.` });
  }

  run('DELETE FROM org_secrets WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// GET /api/secret-refs — discover secret references from skills/MCP configs
router.get('/secret-refs', (req, res) => {
  const { scope, agent_id } = req.query;
  const refs = getReferencedSecrets(req.orgId, scope === 'agent' ? agent_id : undefined);
  res.json({ refs });
});

// ==================== Backups ====================

// GET /api/backups — list backups
router.get('/backups', (req, res) => {
  res.json(listBackups());
});

// POST /api/backups — create backup now
router.post('/backups', (req, res) => {
  const backupPath = createBackup(req.body?.label || 'manual');
  if (backupPath) {
    res.status(201).json({ ok: true, filename: path.basename(backupPath) });
  } else {
    res.status(500).json({ error: 'Backup failed' });
  }
});

// POST /api/backups/:filename/restore — restore from backup (requires restart)
router.post('/backups/:filename/restore', (req, res) => {
  try {
    restoreBackup(req.params.filename);
    res.json({ ok: true, message: 'Restored. Server restart required.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==================== Feedback ====================
import { getLicenseStatus, getInstanceId } from '../services/license.js';
import { PLATFORM_URL } from '../services/oauth.js';

let NEBULA_VERSION = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json'), 'utf-8'));
  NEBULA_VERSION = pkg.version || '0.0.0';
} catch {}

// POST /api/feedback — proxy to Platform feedback endpoint
router.post('/feedback', async (req, res) => {
  const { type, subject, message, metadata } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

  const license = getLicenseStatus();
  const licenseKey = license?.key;
  if (!licenseKey) return res.status(400).json({ error: 'No license configured' });

  try {
    const resp = await fetch(`${PLATFORM_URL}/api/v1/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Key': licenseKey,
      },
      body: JSON.stringify({
        type: type || 'feedback',
        subject: subject?.trim() || undefined,
        message: message.trim(),
        instance_id: getInstanceId(),
        metadata: {
          version: NEBULA_VERSION,
          user_email: req.user?.email,
          ...metadata,
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return res.status(resp.status).json({ error: body || 'Feedback submission failed' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[feedback] Submission error:', err.message);
    res.status(500).json({ error: 'Could not reach the feedback service' });
  }
});

// POST /api/cleanup/run — trigger cleanup manually
router.post('/cleanup/run', (req, res) => {
  try {
    const result = runCleanupNow();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cleanup/status — get last cleanup result and schedule
router.get('/cleanup/status', (req, res) => {
  try {
    res.json(getCleanupStatus(req.orgId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
