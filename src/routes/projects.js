import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Router } from 'express';
import { getAll, getOne, run, getOrgSetting, orgPath } from '../db.js';
import { generateId } from '../utils/uuid.js';
import executor from '../services/executor.js';
import { broadcastToOrg, broadcastUnreadCounts } from '../services/websocket.js';
import * as git from '../services/git.js';
import { getGitProvider } from '../services/git-providers.js';
import { redactSecrets } from '../utils/redact.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { upsertSecret } from '../utils/secret-upsert.js';
import { enrichReplyTo } from '../services/message-service.js';
import { registerCron, unregisterCron, fireTask, validateCron } from '../services/scheduler.js';
import { buildUpdate } from '../utils/update-builder.js';
import { evaluateReadiness, updateProjectReadiness } from '../services/readiness.js';
import { getGitProviderAccount } from '../services/git-providers.js';
import { catchError, sendError } from '../utils/response.js';

const router = Router();

// --- Helper: verify project belongs to org ---
function getProject(projectId, orgId) {
  return getOne('SELECT * FROM projects WHERE id = ? AND org_id = ?', [projectId, orgId]);
}

// ==================== Wizard Endpoints (before /:id routes to avoid param capture) ====================

// POST /api/projects/validate-provider — test git provider token and report capabilities
router.post('/validate-provider', async (req, res) => {
  const { provider, api_url, token, insecure_ssl } = req.body;
  if (!provider || !token) return sendError(res, 400, 'Provider and token are required');
  if (provider === 'gitea' && !api_url) return sendError(res, 400, 'API URL is required for Gitea');

  try {
    const account = getGitProviderAccount(provider, token, { apiUrl: api_url, insecure: !!insecure_ssl });
    const user = await account.getUser();
    const capabilities = await account.checkPermissions();
    res.json({ valid: true, username: user.username, capabilities, errors: [] });
  } catch (err) {
    catchError(res, 500, 'Provider validation failed', err);
  }
});

// POST /api/projects/list-repos — list repos accessible to the token
router.post('/list-repos', async (req, res) => {
  const { provider, api_url, token, page, per_page, search, insecure_ssl } = req.body;
  if (!provider || !token) return sendError(res, 400, 'Provider and token are required');

  try {
    const account = getGitProviderAccount(provider, token, { apiUrl: api_url, insecure: !!insecure_ssl });
    const result = await account.listRepos({ page: page || 1, perPage: per_page || 50, search: search || '' });
    res.json(result);
  } catch (err) {
    catchError(res, 500, 'Failed to list repositories', err);
  }
});

// ==================== Projects ====================

// GET /api/projects — list org projects
router.get('/', (req, res) => {
  const projects = getAll(`
    SELECT p.*,
      a.name as coordinator_name, a.emoji as coordinator_emoji,
      (SELECT COUNT(*) FROM project_milestones m WHERE m.project_id = p.id) as milestone_count,
      (SELECT COUNT(*) FROM project_milestones m WHERE m.project_id = p.id AND m.status = 'done') as milestones_done,
      (SELECT COUNT(*) FROM project_agents pa WHERE pa.project_id = p.id) as agent_count,
      (SELECT COUNT(*) FROM project_deliverables d JOIN project_milestones m2 ON d.milestone_id = m2.id WHERE m2.project_id = p.id) as deliverable_count,
      (SELECT COUNT(*) FROM project_deliverables d2 JOIN project_milestones m3 ON d2.milestone_id = m3.id WHERE m3.project_id = p.id AND d2.status = 'done') as deliverables_done,
      (SELECT COUNT(*) FROM messages msg JOIN conversations conv ON msg.conversation_id = conv.id WHERE conv.project_id = p.id AND msg.is_read = 0 AND msg.role = 'assistant') as unread_count
    FROM projects p
    LEFT JOIN agents a ON p.coordinator_agent_id = a.id
    WHERE p.org_id = ?
    ORDER BY p.created_at DESC
  `, [req.orgId]);
  res.json(projects);
});

// POST /api/projects — create project (supports full scaffold in one call)
router.post('/', async (req, res) => {
  const { name, description, git_remote_url, git_clone_url, git_api_url, git_provider, git_insecure_ssl, coordinator_agent_id, auto_merge, agents, milestones,
    git_token, repo_mode, repo_full_name, repo_name, repo_private } = req.body;

  if (!name || !name.trim()) return sendError(res, 400, 'Name is required');
  if (repo_mode !== 'create_new' && (!git_remote_url || !git_remote_url.trim())) {
    return sendError(res, 400, 'Git remote URL is required');
  }
  if (repo_mode === 'create_new' && (!repo_name || !repo_name.trim())) {
    return sendError(res, 400, 'Repository name is required');
  }
  if (repo_mode === 'create_new' && !git_token) {
    return sendError(res, 400, 'API token is required to create a repository');
  }

  const existingName = getOne('SELECT id FROM projects WHERE name = ? AND org_id = ?', [name.trim(), req.orgId]);
  if (existingName) return sendError(res, 400, 'A project with this name already exists');

  if (git_remote_url) {
    const existingRepo = getOne('SELECT id, name FROM projects WHERE git_remote_url = ? AND org_id = ?', [git_remote_url.trim(), req.orgId]);
    if (existingRepo) return sendError(res, 400, `A project already exists for this repository: "${existingRepo.name}"`);
  }

  if (!coordinator_agent_id) return sendError(res, 400, 'Coordinator agent is required');
  const coordinatorAgent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [coordinator_agent_id, req.orgId]);
  if (!coordinatorAgent) return sendError(res, 400, 'Coordinator agent not found');

  const id = generateId();
  run(
    `INSERT INTO projects (id, org_id, name, description, git_remote_url, git_api_url, git_provider, git_insecure_ssl, coordinator_agent_id, auto_merge, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_ready')`,
    [id, req.orgId, name.trim(), description || '', git_remote_url?.trim() || '',
     git_api_url?.trim() || null, git_provider || 'gitea', git_insecure_ssl ? 1 : 0, coordinator_agent_id || null, auto_merge ? 1 : 0]
  );

  // Auto-add coordinator as project agent
  if (coordinator_agent_id) {
    run(
      'INSERT INTO project_agents (project_id, agent_id, role) VALUES (?, ?, ?)',
      [id, coordinator_agent_id, 'coordinator']
    );
  }

  // Add contributor agents
  if (Array.isArray(agents)) {
    for (const agentEntry of agents) {
      const agentId = typeof agentEntry === 'string' ? agentEntry : agentEntry.agent_id;
      const role = (typeof agentEntry === 'object' && agentEntry.role) || 'contributor';
      if (agentId === coordinator_agent_id) continue; // Already added as coordinator
      const exists = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [agentId, req.orgId]);
      if (!exists) continue;
      run(
        'INSERT INTO project_agents (project_id, agent_id, role) VALUES (?, ?, ?)',
        [id, agentId, role]
      );
    }
  }

  // Create milestones with nested deliverables
  if (Array.isArray(milestones)) {
    for (let mi = 0; mi < milestones.length; mi++) {
      const ms = milestones[mi];
      if (!ms.name) continue;
      const msId = generateId();
      run(
        'INSERT INTO project_milestones (id, project_id, name, description, sort_order) VALUES (?, ?, ?, ?, ?)',
        [msId, id, ms.name.trim(), ms.description || '', mi]
      );
      if (Array.isArray(ms.deliverables)) {
        for (let di = 0; di < ms.deliverables.length; di++) {
          const del = ms.deliverables[di];
          if (!del.name) continue;
          run(
            'INSERT INTO project_deliverables (id, milestone_id, name, pass_criteria, branch_name, assigned_agent_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [generateId(), msId, del.name.trim(), del.pass_criteria || '', del.branch_name || null, del.assigned_agent_id || null, di]
          );
        }
      }
    }
  }

  // Initialize git repo — clone existing or scaffold new
  const repoGitPath = orgPath(req.orgId, 'projects', id, 'repo.git');
  try {
    if (repo_mode === 'create_new' && git_token) {
      // Create the repo on the remote provider, then scaffold locally and push
      const account = getGitProviderAccount(git_provider || 'gitea', git_token, {
        apiUrl: git_api_url?.trim(), insecure: !!git_insecure_ssl,
      });
      const created = await account.createRepo(repo_name.trim(), { private: repo_private !== false });
      // Update project record with the actual URLs from the provider
      run('UPDATE projects SET git_remote_url = ? WHERE id = ?', [created.ssh_url, id]);
      git.initProjectRepo(repoGitPath, created.ssh_url, {
        name: name.trim(), description: description || '',
        cloneUrl: created.clone_url, token: git_token, insecureSsl: !!git_insecure_ssl,
      });
    } else if (repo_mode === 'link_existing' && git_remote_url) {
      // Clone existing repo — use HTTPS+token for auth (validated by wizard), fall back to SSH
      git.cloneRepo(repoGitPath, git_remote_url.trim(), {
        cloneUrl: git_clone_url?.trim(),
        token: git_token,
        insecureSsl: !!git_insecure_ssl,
      });
      git.ensureScaffold(repoGitPath, { name: name.trim() });
    } else {
      // Backwards compat: scaffold locally (no remote push)
      git.initProjectRepo(repoGitPath, git_remote_url?.trim(), { name: name.trim(), description: description || '' });
    }
  } catch (e) {
    console.error(`[projects] Git init failed for project ${id}: ${e.message}`);
    // Roll back — project is unusable without a repo (vault writes, worktrees, etc.)
    run('DELETE FROM project_deliverables WHERE milestone_id IN (SELECT id FROM project_milestones WHERE project_id = ?)', [id]);
    run('DELETE FROM project_milestones WHERE project_id = ?', [id]);
    run('DELETE FROM project_agents WHERE project_id = ?', [id]);
    run('DELETE FROM projects WHERE id = ?', [id]);
    // Clean up any partial repo dir
    try { fs.rmSync(repoGitPath, { recursive: true, force: true }); } catch {}
    return catchError(res, 500, 'Git repository initialization failed', e);
  }

  // Store git token as project secret if provided
  if (git_token) {
    const tokenKey = 'GIT_TOKEN';
    run('INSERT INTO project_secrets (id, project_id, key, value) VALUES (?, ?, ?, ?)',
      [generateId(), id, tokenKey, encrypt(git_token)]);
    run('UPDATE projects SET git_token_key = ? WHERE id = ?', [tokenKey, id]);

    // Try to auto-register webhook
    try {
      const project = getOne('SELECT * FROM projects WHERE id = ?', [id]);
      const provider = getProviderForProject(project, req.orgId);
      const webhookSecret = generateId();
      const webhookUrl = `${req.protocol}://${req.get('host')}/api/project-webhooks/${id}/ci`;
      await provider.createWebhook(webhookUrl, webhookSecret, ['push', 'pull_request']);
      // Store webhook secret on a CI link for verification
      run('INSERT INTO project_links (id, project_id, type, provider, url, webhook_secret) VALUES (?, ?, ?, ?, ?, ?)',
        [generateId(), id, 'ci', git_provider || 'gitea', webhookUrl, webhookSecret]);
      run("UPDATE projects SET webhook_verified_at = datetime('now') WHERE id = ?", [id]);
    } catch (e) {
      console.log(`[projects] Webhook auto-registration failed for ${id}: ${e.message} — user can configure manually`);
    }
  }

  // Create project conversation — owned by coordinator so executor knows which agent to run as
  const convId = generateId();
  const sessionId = generateId();
  run(
    `INSERT INTO conversations (id, agent_id, project_id, title, session_id, session_initialized)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [convId, coordinator_agent_id || null, id, `${name.trim()} — Project`, sessionId]
  );

  const project = getOne('SELECT * FROM projects WHERE id = ?', [id]);
  res.status(201).json(project);
});

// GET /api/projects/:id — project detail
router.get('/:id', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  project.agents = getAll(`
    SELECT pa.*, a.name as agent_name, a.emoji as agent_emoji
    FROM project_agents pa
    JOIN agents a ON pa.agent_id = a.id
    WHERE pa.project_id = ?
  `, [project.id]);

  project.milestone_count = getOne(
    'SELECT COUNT(*) as count FROM project_milestones WHERE project_id = ?', [project.id]
  ).count;
  project.milestones_done = getOne(
    "SELECT COUNT(*) as count FROM project_milestones WHERE project_id = ? AND status = 'done'", [project.id]
  ).count;
  const projConv = getOne('SELECT id FROM conversations WHERE project_id = ?', [project.id]);
  project.unread_count = projConv ? getOne(
    "SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND is_read = 0 AND role = 'assistant'", [projConv.id]
  ).count : 0;

  // Evaluate readiness on read — updates project status if needed
  const readiness = updateProjectReadiness(project.id);
  project.readiness = readiness;
  // Re-read status in case it changed
  project.status = getOne('SELECT status FROM projects WHERE id = ?', [project.id]).status;

  res.json(project);
});

// PUT /api/projects/:id — update project
router.put('/:id', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  // Pre-validation for specific fields
  if (req.body.name !== undefined) {
    if (!req.body.name || !req.body.name.trim()) return sendError(res, 400, 'Name is required');
    const dup = getOne('SELECT id FROM projects WHERE name = ? AND org_id = ? AND id != ?', [req.body.name.trim(), req.orgId, project.id]);
    if (dup) return sendError(res, 400, 'A project with this name already exists');
  }
  if (req.body.coordinator_agent_id) {
    const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [req.body.coordinator_agent_id, req.orgId]);
    if (!agent) return sendError(res, 400, 'Coordinator agent not found');
  }

  const { updates, params } = buildUpdate(req.body,
    ['name', 'description', 'git_remote_url', 'git_api_url', 'git_provider', 'coordinator_agent_id', 'auto_merge', 'status', 'timeout_ms'],
    { name: 'trim', auto_merge: 'boolean' }
  );

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(project.id);
    run(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  updateProjectReadiness(project.id);
  const updated = getOne('SELECT * FROM projects WHERE id = ?', [project.id]);
  res.json(updated);
});

// DELETE /api/projects/:id
router.delete('/:id', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  run('DELETE FROM projects WHERE id = ?', [project.id]);
  res.json({ ok: true });
});

// ==================== Dashboard ====================

// GET /api/projects/:id/dashboard — aggregated project overview
router.get('/:id/dashboard', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  // Milestone progress
  const milestones = getAll(
    'SELECT * FROM project_milestones WHERE project_id = ? ORDER BY sort_order, created_at',
    [project.id]
  );
  const milestoneProgress = milestones.map(m => {
    const deliverables = getAll('SELECT status FROM project_deliverables WHERE milestone_id = ?', [m.id]);
    const total = deliverables.length;
    const done = deliverables.filter(d => d.status === 'done').length;
    const inProgress = deliverables.filter(d => d.status === 'in_progress').length;
    const blocked = deliverables.filter(d => d.status === 'blocked').length;
    return {
      id: m.id, name: m.name, status: m.status,
      deliverables: { total, done, in_progress: inProgress, blocked, pending: total - done - inProgress - blocked },
      progress: total > 0 ? Math.round((done / total) * 100) : 0,
    };
  });

  // Overall progress
  const allDeliverables = getAll(`
    SELECT d.status FROM project_deliverables d
    JOIN project_milestones m ON d.milestone_id = m.id
    WHERE m.project_id = ?
  `, [project.id]);
  const totalDeliverables = allDeliverables.length;
  const doneDeliverables = allDeliverables.filter(d => d.status === 'done').length;

  // Agent activity — recent usage events per agent in this project's conversations
  const conversation = getOne('SELECT id FROM conversations WHERE project_id = ?', [project.id]);
  let agentActivity = [];
  if (conversation) {
    agentActivity = getAll(`
      SELECT m.agent_id, a.name as agent_name, a.emoji as agent_emoji,
        COUNT(*) as message_count,
        MAX(m.created_at) as last_active
      FROM messages m
      JOIN agents a ON m.agent_id = a.id
      WHERE m.conversation_id = ? AND m.role = 'assistant'
      GROUP BY m.agent_id
      ORDER BY last_active DESC
    `, [conversation.id]);
  }

  // Assigned agents with their deliverable counts
  const agents = getAll(`
    SELECT pa.agent_id, pa.role, pa.max_concurrent,
      a.name as agent_name, a.emoji as agent_emoji,
      (SELECT COUNT(*) FROM project_deliverables d
       JOIN project_milestones m ON d.milestone_id = m.id
       WHERE d.assigned_agent_id = pa.agent_id AND m.project_id = pa.project_id) as assigned_deliverables,
      (SELECT COUNT(*) FROM project_deliverables d
       JOIN project_milestones m ON d.milestone_id = m.id
       WHERE d.assigned_agent_id = pa.agent_id AND m.project_id = pa.project_id AND d.status = 'done') as completed_deliverables
    FROM project_agents pa
    JOIN agents a ON pa.agent_id = a.id
    WHERE pa.project_id = ?
  `, [project.id]);

  res.json({
    project: { id: project.id, name: project.name, status: project.status, auto_merge: project.auto_merge },
    progress: {
      total_deliverables: totalDeliverables,
      done_deliverables: doneDeliverables,
      percent: totalDeliverables > 0 ? Math.round((doneDeliverables / totalDeliverables) * 100) : 0,
    },
    milestones: milestoneProgress,
    agents,
    agent_activity: agentActivity,
  });
});

// ==================== Milestones ====================

// GET /api/projects/:id/milestones — list with nested deliverables
router.get('/:id/milestones', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const milestones = getAll(
    'SELECT * FROM project_milestones WHERE project_id = ? ORDER BY sort_order, created_at',
    [project.id]
  );

  for (const m of milestones) {
    m.deliverables = getAll(
      'SELECT * FROM project_deliverables WHERE milestone_id = ? ORDER BY sort_order, created_at',
      [m.id]
    );
  }

  res.json(milestones);
});

// POST /api/projects/:id/milestones
router.post('/:id/milestones', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const { name, description, sort_order } = req.body;
  if (!name || !name.trim()) return sendError(res, 400, 'Name is required');

  const id = generateId();
  run(
    'INSERT INTO project_milestones (id, project_id, name, description, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, project.id, name.trim(), description || '', sort_order || 0]
  );

  const milestone = getOne('SELECT * FROM project_milestones WHERE id = ?', [id]);
  updateProjectReadiness(project.id);
  res.status(201).json(milestone);
});

// PUT /api/projects/milestones/:id
router.put('/milestones/:id', (req, res) => {
  const milestone = getOne(`
    SELECT m.* FROM project_milestones m
    JOIN projects p ON m.project_id = p.id
    WHERE m.id = ? AND p.org_id = ?
  `, [req.params.id, req.orgId]);
  if (!milestone) return sendError(res, 404, 'Milestone not found');

  if (req.body.name !== undefined && (!req.body.name || !req.body.name.trim())) {
    return sendError(res, 400, 'Name is required');
  }

  const { updates, params } = buildUpdate(req.body,
    ['name', 'description', 'sort_order', 'status'],
    { name: 'trim' }
  );

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(milestone.id);
    run(`UPDATE project_milestones SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const updated = getOne('SELECT * FROM project_milestones WHERE id = ?', [milestone.id]);
  res.json(updated);
});

// DELETE /api/projects/milestones/:id
router.delete('/milestones/:id', (req, res) => {
  const milestone = getOne(`
    SELECT m.* FROM project_milestones m
    JOIN projects p ON m.project_id = p.id
    WHERE m.id = ? AND p.org_id = ?
  `, [req.params.id, req.orgId]);
  if (!milestone) return sendError(res, 404, 'Milestone not found');

  run('DELETE FROM project_milestones WHERE id = ?', [milestone.id]);
  updateProjectReadiness(milestone.project_id);
  res.json({ ok: true });
});

// ==================== Deliverables ====================

// POST /api/projects/milestones/:id/deliverables
router.post('/milestones/:id/deliverables', (req, res) => {
  const milestone = getOne(`
    SELECT m.* FROM project_milestones m
    JOIN projects p ON m.project_id = p.id
    WHERE m.id = ? AND p.org_id = ?
  `, [req.params.id, req.orgId]);
  if (!milestone) return sendError(res, 404, 'Milestone not found');

  const { name, pass_criteria, branch_name, assigned_agent_id, sort_order } = req.body;
  if (!name || !name.trim()) return sendError(res, 400, 'Name is required');

  if (assigned_agent_id) {
    const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [assigned_agent_id, req.orgId]);
    if (!agent) return sendError(res, 400, 'Assigned agent not found');
  }

  const id = generateId();
  run(
    `INSERT INTO project_deliverables (id, milestone_id, name, pass_criteria, branch_name, assigned_agent_id, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, milestone.id, name.trim(), pass_criteria || '', branch_name || null, assigned_agent_id || null, sort_order || 0]
  );

  const deliverable = getOne('SELECT * FROM project_deliverables WHERE id = ?', [id]);
  updateProjectReadiness(milestone.project_id);
  res.status(201).json(deliverable);
});

// PUT /api/projects/deliverables/:id
router.put('/deliverables/:id', (req, res) => {
  const deliverable = getOne(`
    SELECT d.*, m.project_id FROM project_deliverables d
    JOIN project_milestones m ON d.milestone_id = m.id
    JOIN projects p ON m.project_id = p.id
    WHERE d.id = ? AND p.org_id = ?
  `, [req.params.id, req.orgId]);
  if (!deliverable) return sendError(res, 404, 'Deliverable not found');

  if (req.body.name !== undefined && (!req.body.name || !req.body.name.trim())) {
    return sendError(res, 400, 'Name is required');
  }
  if (req.body.assigned_agent_id) {
    const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [req.body.assigned_agent_id, req.orgId]);
    if (!agent) return sendError(res, 400, 'Assigned agent not found');
  }

  const { updates, params } = buildUpdate(req.body,
    ['name', 'pass_criteria', 'branch_name', 'assigned_agent_id', 'status', 'sort_order'],
    { name: 'trim' }
  );

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(deliverable.id);
    run(`UPDATE project_deliverables SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const updated = getOne('SELECT * FROM project_deliverables WHERE id = ?', [deliverable.id]);

  // Auto-promote/demote milestone based on deliverable status
  if (req.body.status) {
    const pending = getOne(
      "SELECT COUNT(*) as count FROM project_deliverables WHERE milestone_id = ? AND status != 'done'",
      [deliverable.milestone_id]
    );
    if (pending.count === 0) {
      // All deliverables done → milestone done
      run("UPDATE project_milestones SET status = 'done', updated_at = datetime('now') WHERE id = ?",
        [deliverable.milestone_id]);
    } else {
      // Some deliverables not done → milestone in_progress (if it was done, revert)
      const milestone = getOne('SELECT status FROM project_milestones WHERE id = ?', [deliverable.milestone_id]);
      if (milestone?.status === 'done') {
        run("UPDATE project_milestones SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?",
          [deliverable.milestone_id]);
      } else if (milestone?.status === 'pending' && req.body.status === 'in_progress') {
        run("UPDATE project_milestones SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?",
          [deliverable.milestone_id]);
      }
    }
  }

  updateProjectReadiness(deliverable.project_id);
  res.json(updated);
});

// DELETE /api/projects/deliverables/:id
router.delete('/deliverables/:id', (req, res) => {
  const deliverable = getOne(`
    SELECT d.*, m.project_id FROM project_deliverables d
    JOIN project_milestones m ON d.milestone_id = m.id
    JOIN projects p ON m.project_id = p.id
    WHERE d.id = ? AND p.org_id = ?
  `, [req.params.id, req.orgId]);
  if (!deliverable) return sendError(res, 404, 'Deliverable not found');

  run('DELETE FROM project_deliverables WHERE id = ?', [deliverable.id]);
  updateProjectReadiness(deliverable.project_id);
  res.json({ ok: true });
});

// ==================== Agent Assignments ====================

// GET /api/projects/:id/agents
router.get('/:id/agents', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const agents = getAll(`
    SELECT pa.*, a.name as agent_name, a.emoji as agent_emoji, a.role as agent_role, a.enabled as agent_enabled
    FROM project_agents pa
    JOIN agents a ON pa.agent_id = a.id
    WHERE pa.project_id = ?
  `, [project.id]);
  res.json(agents);
});

// POST /api/projects/:id/agents — assign agent
router.post('/:id/agents', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const { agent_id, role, max_concurrent } = req.body;
  if (!agent_id) return sendError(res, 400, 'agent_id is required');

  const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [agent_id, req.orgId]);
  if (!agent) return sendError(res, 400, 'Agent not found');

  const existing = getOne('SELECT * FROM project_agents WHERE project_id = ? AND agent_id = ?', [project.id, agent_id]);
  if (existing) return sendError(res, 400, 'Agent already assigned to this project');

  const assignRole = role || 'contributor';
  if (assignRole === 'coordinator') {
    const existingCoord = getOne(
      "SELECT * FROM project_agents WHERE project_id = ? AND role = 'coordinator'",
      [project.id]
    );
    if (existingCoord) return sendError(res, 400, 'Project already has a coordinator');
  }

  run(
    'INSERT INTO project_agents (project_id, agent_id, role, max_concurrent) VALUES (?, ?, ?, ?)',
    [project.id, agent_id, assignRole, max_concurrent || 3]
  );

  const assignment = getOne(`
    SELECT pa.*, a.name as agent_name, a.emoji as agent_emoji
    FROM project_agents pa
    JOIN agents a ON pa.agent_id = a.id
    WHERE pa.project_id = ? AND pa.agent_id = ?
  `, [project.id, agent_id]);
  updateProjectReadiness(project.id);
  res.status(201).json(assignment);
});

// PUT /api/projects/:id/agents/:agentId — update assignment
router.put('/:id/agents/:agentId', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const assignment = getOne(
    'SELECT * FROM project_agents WHERE project_id = ? AND agent_id = ?',
    [project.id, req.params.agentId]
  );
  if (!assignment) return sendError(res, 404, 'Agent assignment not found');

  const { role, max_concurrent } = req.body;
  const updates = [];
  const params = [];

  if (role !== undefined) {
    if (role === 'coordinator') {
      const existingCoord = getOne(
        "SELECT * FROM project_agents WHERE project_id = ? AND role = 'coordinator' AND agent_id != ?",
        [project.id, req.params.agentId]
      );
      if (existingCoord) return sendError(res, 400, 'Project already has a coordinator');
    }
    updates.push('role = ?');
    params.push(role);
  }
  if (max_concurrent !== undefined) {
    updates.push('max_concurrent = ?');
    params.push(max_concurrent);
  }

  if (updates.length > 0) {
    params.push(project.id, req.params.agentId);
    run(`UPDATE project_agents SET ${updates.join(', ')} WHERE project_id = ? AND agent_id = ?`, params);
  }

  const updated = getOne(`
    SELECT pa.*, a.name as agent_name, a.emoji as agent_emoji
    FROM project_agents pa
    JOIN agents a ON pa.agent_id = a.id
    WHERE pa.project_id = ? AND pa.agent_id = ?
  `, [project.id, req.params.agentId]);
  res.json(updated);
});

// DELETE /api/projects/:id/agents/:agentId
router.delete('/:id/agents/:agentId', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const assignment = getOne(
    'SELECT * FROM project_agents WHERE project_id = ? AND agent_id = ?',
    [project.id, req.params.agentId]
  );
  if (!assignment) return sendError(res, 404, 'Agent assignment not found');

  run('DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?', [project.id, req.params.agentId]);
  updateProjectReadiness(project.id);
  res.json({ ok: true });
});

// ==================== External Links ====================

// GET /api/projects/:id/links
router.get('/:id/links', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const links = getAll('SELECT * FROM project_links WHERE project_id = ? ORDER BY created_at', [project.id]);
  res.json(links);
});

// POST /api/projects/:id/links
router.post('/:id/links', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const { type, provider, url, config } = req.body;
  const validTypes = ['issue_tracker', 'knowledge_base', 'ci'];
  if (!type || !validTypes.includes(type)) return sendError(res, 400, `Type must be one of: ${validTypes.join(', ')}`);
  if (!provider || !provider.trim()) return sendError(res, 400, 'Provider is required');
  if (!url || !url.trim()) return sendError(res, 400, 'URL is required');

  const id = generateId();
  run(
    'INSERT INTO project_links (id, project_id, type, provider, url, config) VALUES (?, ?, ?, ?, ?, ?)',
    [id, project.id, type, provider.trim(), url.trim(), config ? JSON.stringify(config) : '{}']
  );

  const link = getOne('SELECT * FROM project_links WHERE id = ?', [id]);
  res.status(201).json(link);
});

// PUT /api/projects/:id/links/:linkId
router.put('/:id/links/:linkId', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const link = getOne('SELECT * FROM project_links WHERE id = ? AND project_id = ?', [req.params.linkId, project.id]);
  if (!link) return sendError(res, 404, 'Link not found');

  const fields = ['type', 'provider', 'url', 'config'];
  const updates = [];
  const params = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      let val = req.body[field];
      if (field === 'type') {
        const validTypes = ['issue_tracker', 'knowledge_base', 'ci'];
        if (!validTypes.includes(val)) return sendError(res, 400, `Type must be one of: ${validTypes.join(', ')}`);
      }
      if (field === 'config' && typeof val === 'object') val = JSON.stringify(val);
      updates.push(`${field} = ?`);
      params.push(val);
    }
  }

  if (updates.length > 0) {
    params.push(link.id);
    run(`UPDATE project_links SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const updated = getOne('SELECT * FROM project_links WHERE id = ?', [link.id]);
  res.json(updated);
});

// DELETE /api/projects/:id/links/:linkId
router.delete('/:id/links/:linkId', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const link = getOne('SELECT * FROM project_links WHERE id = ? AND project_id = ?', [req.params.linkId, project.id]);
  if (!link) return sendError(res, 404, 'Link not found');

  run('DELETE FROM project_links WHERE id = ?', [link.id]);
  res.json({ ok: true });
});

// ==================== Project Conversation ====================

// GET /api/projects/:id/messages — list messages in project conversation
router.get('/:id/messages', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const conversation = getOne('SELECT * FROM conversations WHERE project_id = ?', [project.id]);
  if (!conversation) return res.json([]);

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = req.query.before;

  let messages;
  if (before) {
    messages = getAll(
      `SELECT * FROM messages
       WHERE conversation_id = ? AND created_at < (SELECT created_at FROM messages WHERE id = ?)
       ORDER BY created_at DESC LIMIT ?`,
      [conversation.id, before, limit]
    );
  } else {
    messages = getAll(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
      [conversation.id, limit]
    );
  }

  messages.reverse();
  enrichReplyTo(messages);
  res.json(messages);
});

// POST /api/projects/:id/messages/read — mark all project messages as read
router.post('/:id/messages/read', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const conversation = getOne('SELECT id FROM conversations WHERE project_id = ?', [project.id]);
  if (conversation) {
    run('UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND is_read = 0', [conversation.id]);
  }
  res.json({ ok: true });
});

// Cap recursive mention chains so a loop like `@Alice` → response contains `@Bob`
// → response contains `@Alice` → ... cannot run forever. Three hops matches the
// coordinator-dispatch-follow-up depth we actually design for.
const MAX_PROJECT_MENTION_DEPTH = 3;

/**
 * Process @mentions in project conversation text.
 * @notify is intentionally NOT supported in projects — all mentions route responses
 * back to the project conversation so the coordinator can synthesize results.
 * Returns a promise that resolves with an array of { agentName, agentEmoji, text } for each
 * dispatched agent, allowing the caller to trigger coordinator follow-up.
 * @param {string} text - message text to scan
 * @param {string} excludeAgentId - agent to exclude (the author)
 * @param {Object} project - project DB row
 * @param {Object} conversation - conversation DB row
 * @param {string} orgId - org ID
 * @param {number} [depth=0] - recursion depth; capped at MAX_PROJECT_MENTION_DEPTH
 * @returns {Promise<Array<{ agentName: string, agentEmoji: string, text: string }>>}
 */
function processProjectMentions(text, excludeAgentId, project, conversation, orgId, depth = 0) {
  if (!text) return Promise.resolve([]);
  if (depth >= MAX_PROJECT_MENTION_DEPTH) {
    console.warn(`[project ${project.id}] mention recursion capped at depth ${depth}`);
    return Promise.resolve([]);
  }

  const mentionRe = /@(\S+)/g;
  const mentions = [...text.matchAll(mentionRe)]
    .map(m => m[1])
    .filter(name => name.toLowerCase() !== 'notify'); // skip @notify keyword

  const uniqueMentions = [...new Set(mentions)].slice(0, 3);
  const promises = [];

  for (const mentionedName of uniqueMentions) {
    const mentioned = getOne(
      'SELECT a.* FROM agents a JOIN project_agents pa ON a.id = pa.agent_id WHERE a.name = ? AND a.org_id = ? AND pa.project_id = ? AND a.enabled = 1',
      [mentionedName, orgId, project.id]
    );
    if (!mentioned || mentioned.id === excludeAgentId) continue;

    const mentionedDeliverable = getOne(
      "SELECT branch_name FROM project_deliverables WHERE assigned_agent_id = ? AND branch_name IS NOT NULL AND status IN ('pending', 'in_progress') LIMIT 1",
      [mentioned.id]
    );

    // Execute with a project-scoped session (executor finds/creates one per agent+project).
    // Response is stored in the project conversation via the .then() callback below.
    const promise = executor
      .enqueue(mentioned.id, text, {
        priority: true, maxTurns: 50,
        displayConversationId: conversation.id,
        projectId: project.id,
        branchName: mentionedDeliverable?.branch_name || null,
      })
      .then((result) => {
        const msgId = generateId();
        let resultText = result.result || '';
        if (!resultText.trim()) {
          resultText = result.subtype === 'error_max_turns'
            ? '*Agent reached the maximum number of turns without producing a final response.*'
            : '*Agent completed execution but produced no text response.*';
        }
        const metadata = JSON.stringify({
          duration_ms: result.duration_ms, total_cost_usd: result.total_cost_usd,
          usage: result.usage, subtype: result.subtype,
          ...(result.tool_history?.length > 0 && { tool_history: result.tool_history }),
        });

        const safeText = redactSecrets(resultText, orgId, mentioned.id);
        run(
          `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, metadata, is_read, created_at)
           VALUES (?, ?, ?, 'assistant', ?, 'chat', ?, 0, datetime('now'))`,
          [msgId, mentioned.id, conversation.id, safeText, metadata]
        );
        run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [conversation.id]);

        const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
        broadcastToOrg(orgId, { type: 'new_message', project_id: project.id, message: msg });
        broadcastUnreadCounts(orgId);

        // Recursively process mentions in the mentioned agent's response (fire-and-forget)
        processProjectMentions(safeText, mentioned.id, project, conversation, orgId, depth + 1);

        return { agentName: mentioned.name, agentEmoji: mentioned.emoji, text: safeText };
      })
      .catch((err) => {
        const msgId = generateId();
        console.error('[project] Agent mention execution failed:', err);
        run(
          `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
           VALUES (?, ?, ?, 'assistant', ?, 'error', 0, datetime('now'))`,
          [msgId, mentioned.id, conversation.id, 'Execution failed']
        );
        const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
        broadcastToOrg(orgId, { type: 'new_message', project_id: project.id, message: msg });
        broadcastUnreadCounts(orgId);

        return { agentName: mentioned.name, agentEmoji: mentioned.emoji, text: 'Execution failed', error: true };
      });

    promises.push(promise);
  }

  return Promise.all(promises);
}

// POST /api/projects/:id/messages — post to project conversation, trigger agent execution
router.post('/:id/messages', async (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const { content, agent_id, reply_to_id } = req.body;
  if (!content || !content.trim()) return sendError(res, 400, 'Message content is required');

  const conversation = getOne('SELECT * FROM conversations WHERE project_id = ?', [project.id]);
  if (!conversation) return sendError(res, 404, 'Project conversation not found');

  // Determine which agent responds: explicit agent_id, or coordinator by default
  let targetAgentId = agent_id;
  if (!targetAgentId && project.coordinator_agent_id) {
    targetAgentId = project.coordinator_agent_id;
  }

  // Verify agent is assigned to project (if specified)
  let targetAgent = null;
  if (targetAgentId) {
    const assignment = getOne(
      'SELECT * FROM project_agents WHERE project_id = ? AND agent_id = ?',
      [project.id, targetAgentId]
    );
    if (!assignment) return sendError(res, 400, 'Agent is not assigned to this project');
    targetAgent = getOne('SELECT * FROM agents WHERE id = ? AND enabled = 1', [targetAgentId]);
    if (!targetAgent) return sendError(res, 400, 'Agent not found or disabled');
  }

  // Store user message
  const userMsgId = generateId();
  run(
    `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, reply_to_id, is_read, created_at)
     VALUES (?, ?, ?, 'user', ?, 'chat', ?, 1, datetime('now'))`,
    [userMsgId, targetAgentId, conversation.id, content.trim(), reply_to_id || null]
  );
  run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [conversation.id]);

  const userMsg = getOne('SELECT * FROM messages WHERE id = ?', [userMsgId]);
  enrichReplyTo([userMsg]);
  broadcastToOrg(req.orgId, { type: 'new_message', project_id: project.id, message: userMsg });

  res.status(201).json(userMsg);

  if (!targetAgent) return; // No agent to execute

  const orgId = req.orgId;

  // Determine branch context — find agent's active deliverable branch
  const deliverable = getOne(
    "SELECT branch_name FROM project_deliverables WHERE assigned_agent_id = ? AND branch_name IS NOT NULL AND status IN ('pending', 'in_progress') LIMIT 1",
    [targetAgentId]
  );

  // Execute in project context
  executor
    .enqueue(targetAgentId, content.trim(), {
      priority: true, maxTurns: 50,
      conversationId: conversation.id,
      projectId: project.id,
      branchName: deliverable?.branch_name || null,
    })
    .then((result) => {
      const msgId = generateId();
      let resultText = result.result || '';
      if (!resultText.trim()) {
        resultText = result.subtype === 'error_max_turns'
          ? '*Agent reached the maximum number of turns without producing a final response.*'
          : '*Agent completed execution but produced no text response.*';
      }
      const metadata = JSON.stringify({
        duration_ms: result.duration_ms,
        total_cost_usd: result.total_cost_usd,
        usage: result.usage,
        subtype: result.subtype,
        ...(result.tool_history?.length > 0 && { tool_history: result.tool_history }),
      });

      const safeText = redactSecrets(resultText, orgId, targetAgentId);
      run(
        `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, metadata, is_read, created_at)
         VALUES (?, ?, ?, 'assistant', ?, 'chat', ?, 0, datetime('now'))`,
        [msgId, targetAgentId, conversation.id, safeText, metadata]
      );
      run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [conversation.id]);

      const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
      broadcastToOrg(orgId, { type: 'new_message', project_id: project.id, message: msg });
      broadcastUnreadCounts(orgId);

      // Scan coordinator's response for @mentions — route to project agents
      // When all mentioned agents complete, trigger coordinator follow-up to synthesize.
      // depth starts at 0 because this is a fresh dispatch chain from the coordinator's
      // own reasoning, not a recursive hop inside an existing chain. The chain that
      // fans out from here is bounded by MAX_PROJECT_MENTION_DEPTH via processProjectMentions.
      processProjectMentions(safeText, targetAgentId, project, conversation, orgId)
        .then(responses => {
          if (responses.length === 0) return;
          if (targetAgentId !== project.coordinator_agent_id) return;

          const followUpContext = responses
            .map(r => `[${r.agentEmoji} ${r.agentName}]: ${r.text}`)
            .join('\n\n');

          const followUpPrompt = `[The agents you dispatched have completed their work. Review their responses and provide a summary with any follow-up actions needed.]\n\n${followUpContext}`;

          const coordDeliverable = getOne(
            "SELECT branch_name FROM project_deliverables WHERE assigned_agent_id = ? AND branch_name IS NOT NULL AND status IN ('pending', 'in_progress') LIMIT 1",
            [targetAgentId]
          );

          executor
            .enqueue(targetAgentId, followUpPrompt, {
              priority: true, maxTurns: 50,
              conversationId: conversation.id,
              projectId: project.id,
              branchName: coordDeliverable?.branch_name || null,
            })
            .then((followUpResult) => {
              const followUpMsgId = generateId();
              let followUpText = followUpResult.result || '*Coordinator completed follow-up with no text response.*';
              const followUpMeta = JSON.stringify({
                duration_ms: followUpResult.duration_ms, total_cost_usd: followUpResult.total_cost_usd,
                usage: followUpResult.usage, subtype: followUpResult.subtype,
                ...(followUpResult.tool_history?.length > 0 && { tool_history: followUpResult.tool_history }),
              });

              const safeFollowUp = redactSecrets(followUpText, orgId, targetAgentId);
              run(
                `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, metadata, is_read, created_at)
                 VALUES (?, ?, ?, 'assistant', ?, 'chat', ?, 0, datetime('now'))`,
                [followUpMsgId, targetAgentId, conversation.id, safeFollowUp, followUpMeta]
              );
              run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [conversation.id]);

              const followUpMsg = getOne('SELECT * FROM messages WHERE id = ?', [followUpMsgId]);
              broadcastToOrg(orgId, { type: 'new_message', project_id: project.id, message: followUpMsg });
              broadcastUnreadCounts(orgId);

              // Process mentions in follow-up (fire-and-forget, no further follow-up chaining).
              // depth=0 is safe because the outer .then(responses => ...) only fires follow-up
              // once (line ~1013 guard), so this can't compound across repeated follow-ups.
              // If that guard ever changes, pass through a budget here.
              processProjectMentions(safeFollowUp, targetAgentId, project, conversation, orgId);
            })
            .catch((err) => {
              console.error('[project] Coordinator follow-up failed:', err.message);
            });
        });
    })
    .catch((err) => {
      const msgId = generateId();
      console.error('[project] Agent execution failed:', err);
      run(
        `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
         VALUES (?, ?, ?, 'assistant', ?, 'error', 0, datetime('now'))`,
        [msgId, targetAgentId, conversation.id, 'Task execution error']
      );
      const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
      broadcastToOrg(orgId, { type: 'new_message', project_id: project.id, message: msg });
      broadcastUnreadCounts(orgId);
    });

  // Process @mentions in user message — but skip when the coordinator is the target.
  // The coordinator is expected to dispatch via its own response (see line ~1000),
  // so firing user-mentions here would double-dispatch every @mention alongside it.
  if (targetAgentId !== project.coordinator_agent_id) {
    processProjectMentions(content.trim(), targetAgentId, project, conversation, orgId);
  }
});

// ==================== Project Tasks ====================

// GET /api/projects/:id/tasks — list tasks scoped to this project
router.get('/:id/tasks', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const tasks = getAll(
    `SELECT t.*, a.name as agent_name, a.emoji as agent_emoji
     FROM tasks t
     JOIN agents a ON t.agent_id = a.id
     WHERE t.project_id = ?
     ORDER BY t.created_at ASC`,
    [project.id]
  );
  res.json(tasks);
});

// POST /api/projects/:id/tasks — create a project-scoped task
router.post('/:id/tasks', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const { name, prompt, cron_expression, trigger_type, enabled, max_turns, timeout_ms, agent_id } = req.body;
  const type = trigger_type || 'cron';

  if (!name || !name.trim()) return sendError(res, 400, 'Name is required');
  if (!prompt || !prompt.trim()) return sendError(res, 400, 'Prompt is required');

  // Default to coordinator agent if no agent_id specified
  const targetAgentId = agent_id || project.coordinator_agent_id;
  if (!targetAgentId) return sendError(res, 400, 'No agent specified and project has no coordinator');

  const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [targetAgentId, req.orgId]);
  if (!agent) return sendError(res, 400, 'Agent not found');

  if (type === 'cron') {
    if (!cron_expression) return sendError(res, 400, 'Cron expression is required for cron triggers');
    if (!validateCron(cron_expression)) return sendError(res, 400, 'Invalid cron expression');
  }

  const id = generateId();
  const webhookSecret = type === 'webhook' ? generateId() : null;

  run(
    `INSERT INTO tasks (id, agent_id, project_id, name, prompt, trigger_type, cron_expression, webhook_secret, enabled, max_turns, timeout_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, targetAgentId, project.id, name.trim(), prompt.trim(), type,
     type === 'cron' ? cron_expression : null, webhookSecret,
     enabled !== undefined ? (enabled ? 1 : 0) : 1, max_turns || 50, timeout_ms || null]
  );

  const task = getOne('SELECT * FROM tasks WHERE id = ?', [id]);
  if (task.enabled && task.trigger_type === 'cron' && task.cron_expression) registerCron(task);

  if (task.trigger_type === 'webhook') {
    task.webhook_url = `/api/webhooks/${task.id}`;
  }

  res.status(201).json(task);
});

// ==================== Project Readiness ====================

// GET /api/projects/:id/readiness — evaluate and return readiness state
router.get('/:id/readiness', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const result = updateProjectReadiness(project.id);
  res.json(result);
});

// GET /api/projects/:id/checklist — list agent-created checklist items
router.get('/:id/checklist', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const items = getAll(
    'SELECT * FROM project_checklist WHERE project_id = ? ORDER BY created_at ASC',
    [project.id]
  );
  res.json(items);
});

// POST /api/projects/:id/checklist — add a custom prerequisite
router.post('/:id/checklist', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const { label } = req.body;
  if (!label || !label.trim()) return sendError(res, 400, 'Label is required');

  const id = generateId();
  run('INSERT INTO project_checklist (id, project_id, label) VALUES (?, ?, ?)',
    [id, project.id, label.trim()]);

  updateProjectReadiness(project.id);
  const item = getOne('SELECT * FROM project_checklist WHERE id = ?', [id]);
  res.status(201).json(item);
});

// PUT /api/projects/:id/checklist/:itemId — mark met/unmet
router.put('/:id/checklist/:itemId', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const item = getOne('SELECT * FROM project_checklist WHERE id = ? AND project_id = ?',
    [req.params.itemId, project.id]);
  if (!item) return sendError(res, 404, 'Checklist item not found');

  const { met } = req.body;
  run('UPDATE project_checklist SET met = ? WHERE id = ?', [met ? 1 : 0, req.params.itemId]);

  updateProjectReadiness(project.id);
  res.json({ ok: true });
});

// DELETE /api/projects/:id/checklist/:itemId — remove custom prerequisite
router.delete('/:id/checklist/:itemId', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const item = getOne('SELECT * FROM project_checklist WHERE id = ? AND project_id = ?',
    [req.params.itemId, project.id]);
  if (!item) return sendError(res, 404, 'Checklist item not found');

  run('DELETE FROM project_checklist WHERE id = ?', [req.params.itemId]);

  updateProjectReadiness(project.id);
  res.json({ ok: true });
});

// POST /api/projects/:id/launch — explicit activation gate
router.post('/:id/launch', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');
  if (project.status !== 'not_ready') return sendError(res, 400, `Project is already ${project.status}`);

  const readiness = evaluateReadiness(project.id);
  if (!readiness.ready) {
    return res.status(400).json({ ok: false, error: 'Project is not ready', readiness });
  }

  run("UPDATE projects SET status = 'active', launched_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [project.id]);
  const updated = getOne('SELECT * FROM projects WHERE id = ?', [project.id]);
  res.json({ ok: true, project: updated });
});

// PUT /api/projects/:id/vault/:path(*) — edit vault files (only during not_ready)
router.put('/:id/vault/:path(*)', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');
  if (project.status !== 'not_ready') return sendError(res, 403, 'Vault editing is only available during setup phase');

  const { content } = req.body;
  if (content === undefined) return sendError(res, 400, 'Content is required');

  const filePath = req.params.path;
  if (!filePath || filePath.includes('..') || filePath.startsWith('/')) {
    return sendError(res, 400, 'Invalid file path');
  }

  const repo = repoPath(req.orgId, project.id);
  if (!fs.existsSync(repo)) {
    return sendError(res, 500, 'Project git repository not initialized — try deleting and recreating the project');
  }
  try {
    git.writeVaultFile(repo, filePath, content);
    updateProjectReadiness(project.id);
    res.json({ ok: true });
  } catch (e) {
    catchError(res, 500, 'Failed to write vault file', e);
  }
});

// ==================== Project Secrets ====================

// GET /api/projects/:id/secrets — list keys only (never values)
router.get('/:id/secrets', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const secrets = getAll(
    'SELECT id, key, created_at, updated_at FROM project_secrets WHERE project_id = ? ORDER BY key ASC',
    [project.id]
  );
  res.json(secrets);
});

// POST /api/projects/:id/secrets — create or update
router.post('/:id/secrets', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const { key, value } = req.body;
  if (!key || !key.trim()) return sendError(res, 400, 'Key is required');
  if (!value || !value.trim()) return sendError(res, 400, 'Value is required');

  const cleanKey = upsertSecret('project_secrets', 'project_id', project.id, key, value);
  res.json({ ok: true, key: cleanKey });
});

// DELETE /api/projects/:id/secrets/:secretId
router.delete('/:id/secrets/:secretId', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const secret = getOne(
    'SELECT id FROM project_secrets WHERE id = ? AND project_id = ?',
    [req.params.secretId, project.id]
  );
  if (!secret) return sendError(res, 404, 'Secret not found');

  run('DELETE FROM project_secrets WHERE id = ?', [req.params.secretId]);
  res.json({ ok: true });
});

// ==================== Git Branches ====================

function repoPath(orgId, projectId) {
  return orgPath(orgId, 'projects', projectId, 'repo.git');
}

// GET /api/projects/:id/branches
router.get('/:id/branches', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  try {
    const branches = git.listBranches(repoPath(req.orgId, project.id));
    res.json(branches);
  } catch (e) {
    catchError(res, 500, 'Failed to list branches', e);
  }
});

// POST /api/projects/:id/branches — create feature branch
router.post('/:id/branches', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const { name: branchName, agent_id } = req.body;
  if (!branchName || !branchName.trim()) return sendError(res, 400, 'Branch name is required');

  const repo = repoPath(req.orgId, project.id);
  try {
    git.createBranch(repo, branchName.trim());

    // If agent specified, create worktree for them
    if (agent_id) {
      const agent = getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [agent_id, req.orgId]);
      if (agent) {
        const worktreePath = orgPath(req.orgId, 'agents', agent_id, 'projects', project.id, branchName.trim());
        git.createWorktree(repo, worktreePath, branchName.trim());
      }
    }

    res.status(201).json({ ok: true, branch: branchName.trim() });
  } catch (e) {
    catchError(res, 500, 'Failed to create branch', e);
  }
});

// DELETE /api/projects/:id/branches/:name
router.delete('/:id/branches/:name(*)', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const branchName = req.params.name;
  const repo = repoPath(req.orgId, project.id);

  try {
    // Clean up any worktrees for this branch
    const agents = getAll('SELECT agent_id FROM project_agents WHERE project_id = ?', [project.id]);
    for (const { agent_id } of agents) {
      const worktreePath = orgPath(req.orgId, 'agents', agent_id, 'projects', project.id, branchName);
      git.removeWorktree(repo, worktreePath);
    }

    git.deleteBranch(repo, branchName);
    res.json({ ok: true });
  } catch (e) {
    catchError(res, 500, 'Failed to delete branch', e);
  }
});

// GET /api/projects/:id/diff/:branch
router.get('/:id/diff/:branch(*)', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  try {
    const diff = git.diffBranch(repoPath(req.orgId, project.id), req.params.branch);
    res.json(diff);
  } catch (e) {
    catchError(res, 500, 'Failed to get diff', e);
  }
});

// ==================== PR Operations ====================

function getProviderForProject(project, orgId) {
  // Prefer project-scoped token from project secrets
  let token;
  if (project.git_token_key) {
    const secretRow = getOne(
      'SELECT value FROM project_secrets WHERE project_id = ? AND key = ?',
      [project.id, project.git_token_key]
    );
    if (secretRow) token = decrypt(secretRow.value);
  }
  // Fallback to org-level token
  if (!token) {
    const providerKey = `${project.git_provider}_api_token`;
    token = getOrgSetting(orgId, providerKey);
  }
  const apiUrl = project.git_api_url || getOrgSetting(orgId, `${project.git_provider}_api_url`);
  return getGitProvider(project, token, { apiUrl: apiUrl || undefined, insecure: !!project.git_insecure_ssl });
}

// POST /api/projects/:id/pr — create PR
router.post('/:id/pr', async (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const { branch, title, body } = req.body;
  if (!branch) return sendError(res, 400, 'Branch is required');
  if (!title) return sendError(res, 400, 'Title is required');

  try {
    const provider = getProviderForProject(project, req.orgId);
    const pr = await provider.createPR(branch, title, body || '');
    res.status(201).json(pr);
  } catch (e) {
    catchError(res, 500, 'Failed to create PR', e);
  }
});

// GET /api/projects/:id/pr — list PRs
router.get('/:id/pr', async (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  try {
    const provider = getProviderForProject(project, req.orgId);
    const prs = await provider.listPRs(req.query.state || 'open');
    res.json(prs);
  } catch (e) {
    catchError(res, 500, 'Failed to list PRs', e);
  }
});

// POST /api/projects/:id/pr/:number/merge — merge PR
// Query param ?delete_branch=true to delete the source branch after merge
router.post('/:id/pr/:number/merge', async (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const deleteBranch = req.query.delete_branch === 'true' || req.body?.delete_branch === true;

  try {
    const provider = getProviderForProject(project, req.orgId);
    const result = await provider.mergePR(parseInt(req.params.number), { deleteBranch });
    res.json(result);
  } catch (e) {
    catchError(res, 500, 'Failed to merge PR', e);
  }
});

// POST /api/projects/:id/webhook-test — verify webhook communication
// Lists webhooks on the git provider, finds one pointing to our URL, and triggers a test delivery.
router.post('/:id/webhook-test', async (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  try {
    const provider = getProviderForProject(project, req.orgId);
    const hooks = await provider.listWebhooks();

    // Find a webhook that points to our project webhook URL
    const ourUrlPattern = `/api/project-webhooks/${project.id}/`;
    const matchingHook = hooks.find(h => {
      const url = h.config?.url || h.url || '';
      return url.includes(ourUrlPattern) || url.includes(`project-webhooks/${project.id}`);
    });

    if (!matchingHook) {
      return sendError(res, 400, 'No webhook found pointing to this project. Configure a webhook on the git repo pointing to: ' +
        `<your-nebula-url>/api/project-webhooks/${project.id}/ci`);
    }

    // Trigger test delivery
    await provider.testWebhook(matchingHook.id);

    // Give it a moment, then check if webhook_verified_at was updated
    // (the test delivery hits our webhook endpoint which stamps it)
    await new Promise(resolve => setTimeout(resolve, 2000));

    const updated = getOne('SELECT webhook_verified_at FROM projects WHERE id = ?', [project.id]);
    if (updated?.webhook_verified_at) {
      updateProjectReadiness(project.id);
      res.json({ ok: true, message: 'Webhook test delivery received successfully' });
    } else {
      res.json({ ok: false, message: 'Test delivery sent but not yet received. The webhook may need a few seconds — try again.' });
    }
  } catch (e) {
    catchError(res, 500, 'Webhook test failed', e);
  }
});

// ==================== Vault (read-only from git) ====================

// GET /api/projects/:id/vault — list files in vault/ on default branch
router.get('/:id/vault', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  try {
    const files = git.listVault(repoPath(req.orgId, project.id));
    res.json(files);
  } catch (e) {
    res.json([]); // Empty vault or repo not initialized yet
  }
});

// GET /api/projects/:id/vault/* — read file from vault/
router.get('/:id/vault/:path(*)', (req, res) => {
  const project = getProject(req.params.id, req.orgId);
  if (!project) return sendError(res, 404, 'Project not found');

  const filePath = req.params.path;
  if (!filePath || filePath.includes('..') || filePath.startsWith('/')) {
    return sendError(res, 400, 'Invalid file path');
  }

  const content = git.readVaultFile(repoPath(req.orgId, project.id), filePath);
  if (content === null) return sendError(res, 404, 'File not found');

  // Detect binary vs text by checking for null bytes
  if (content.includes('\0')) {
    res.setHeader('Content-Type', 'application/octet-stream');
    const safeName = path.basename(filePath).replace(/["\r\n]/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  } else {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  }
  res.send(content);
});

// ==================== Public Integration Webhooks ====================
// Mounted separately without requireAuth — verified via webhook_secret

export const projectWebhooksRouter = Router();

// POST /api/project-webhooks/:projectId/:type
projectWebhooksRouter.post('/:projectId/:type', (req, res) => {
  const project = getOne('SELECT * FROM projects WHERE id = ?', [req.params.projectId]);
  if (!project) return sendError(res, 404, 'Project not found');

  const link = getOne(
    'SELECT * FROM project_links WHERE project_id = ? AND type = ?',
    [project.id, req.params.type]
  );
  if (!link) return sendError(res, 404, `No ${req.params.type} integration linked`);

  // Verify webhook secret
  if (link.webhook_secret) {
    const simpleSecret = req.query.secret || req.headers['x-webhook-secret'];
    if (simpleSecret === link.webhook_secret) {
      // Authorized via plain secret
    } else {
      const signature = req.headers['x-gitea-signature']
        || req.headers['x-hub-signature-256']?.replace('sha256=', '');

      if (signature) {
        const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
        const expected = crypto.createHmac('sha256', link.webhook_secret).update(rawBody).digest('hex');
        if (signature !== expected) {
          return sendError(res, 401, 'Invalid signature');
        }
      } else {
        return sendError(res, 401, 'Missing or invalid secret');
      }
    }
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') return sendError(res, 400, 'Invalid payload');

  // Stamp webhook_verified_at on every valid webhook receipt
  run("UPDATE projects SET webhook_verified_at = datetime('now') WHERE id = ?", [project.id]);

  // Sync bare repo on push events (keeps Nebula in sync with remote after PR merges)
  const event = req.headers['x-gitea-event'] || req.headers['x-github-event'] || '';
  if (event === 'push') {
    try {
      git.syncRemote(repoPath(project.org_id, project.id));
      console.log(`[webhook] Synced bare repo for project "${project.name}"`);
    } catch (e) {
      console.error(`[webhook] Failed to sync bare repo for project "${project.name}":`, e.message);
    }
  }

  const conversation = getOne('SELECT * FROM conversations WHERE project_id = ?', [project.id]);
  const coordId = project.coordinator_agent_id;

  // Issue tracker webhooks
  if (req.params.type === 'issue_tracker' && payload.issue_id) {
    const status = payload.status || payload.state;
    if (status && conversation && coordId) {
      const msgId = generateId();
      run(
        `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
         VALUES (?, ?, ?, 'system', ?, 'integration', 0, datetime('now'))`,
        [msgId, coordId, conversation.id,
         `[Integration] Issue ${payload.issue_id} status changed to **${status}**${payload.summary ? `: ${payload.summary}` : ''}`]
      );
    }
  }

  // CI webhooks + auto-merge
  if (req.params.type === 'ci' && (payload.build_id || payload.run_id)) {
    const status = payload.status || payload.conclusion || 'unknown';
    const buildRef = payload.build_id || payload.run_id;

    if (conversation && coordId) {
      const msgId = generateId();
      run(
        `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
         VALUES (?, ?, ?, 'system', ?, 'integration', 0, datetime('now'))`,
        [msgId, coordId, conversation.id,
         `[CI] Build #${buildRef} ${status}${payload.branch ? ` on \`${payload.branch}\`` : ''}`]
      );
    }

    if (project.auto_merge && payload.pr_number && ['success', 'completed'].includes(status.toLowerCase())) {
      try {
        const provider = getProviderForProject(project, project.org_id);
        provider.mergePR(parseInt(payload.pr_number)).then(() => {
          if (conversation && coordId) {
            const mergeMsg = generateId();
            run(
              `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
               VALUES (?, ?, ?, 'system', ?, 'integration', 0, datetime('now'))`,
              [mergeMsg, coordId, conversation.id,
               `[Auto-merge] PR #${payload.pr_number} merged after successful build #${buildRef}`]
            );
          }
        }).catch(() => {});
      } catch {}
    }
  }

  // Re-evaluate readiness on any webhook (git push may add/remove vault files)
  updateProjectReadiness(project.id);

  res.json({ ok: true });
});

export default router;
