import { getAll, getOne, run, orgPath } from '../db.js';
import * as git from './git.js';

/**
 * Evaluate project readiness. Returns system checks (derived) + agent checks (from DB).
 * Project can only be 'active' when all checks pass.
 *
 * @param {string} projectId
 * @returns {{ systemChecks: Array<{key, label, met}>, agentChecks: Array<{id, label, met}>, ready: boolean }}
 */
export function evaluateReadiness(projectId) {
  const project = getOne('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!project) return { systemChecks: [], agentChecks: [], ready: false };

  const repoPath = orgPath(project.org_id, 'projects', projectId, 'repo.git');

  // Vault file listing (cached for this evaluation)
  let vaultFiles = [];
  try { vaultFiles = git.listVault(repoPath); } catch {}

  const milestoneCount = getOne(
    'SELECT COUNT(*) as count FROM project_milestones WHERE project_id = ?', [projectId]
  ).count;

  const milestonesWithoutDeliverables = getOne(
    `SELECT COUNT(*) as count FROM project_milestones m
     WHERE m.project_id = ? AND NOT EXISTS (
       SELECT 1 FROM project_deliverables d WHERE d.milestone_id = m.id
     )`, [projectId]
  ).count;

  // System checks — derived from project state, not stored in DB
  const systemChecks = [
    {
      key: 'git_remote',
      label: 'Git remote configured',
      met: !!project.git_remote_url,
    },
    {
      key: 'webhook',
      label: 'Webhook communication verified',
      met: !!project.webhook_verified_at,
    },
    {
      key: 'coordinator',
      label: 'Coordinator assigned',
      met: !!project.coordinator_agent_id,
    },
    {
      key: 'design_spec',
      label: 'Design spec exists (vault/design-spec.md)',
      met: vaultFiles.some(f => f === 'design-spec.md' || f.toLowerCase().includes('design-spec')),
    },
    {
      key: 'tech_spec',
      label: 'Tech spec exists (vault/tech-spec.md)',
      met: vaultFiles.some(f => f === 'tech-spec.md' || f.toLowerCase().includes('tech-spec')),
    },
    {
      key: 'milestones',
      label: 'At least one milestone',
      met: milestoneCount > 0,
    },
    {
      key: 'milestone_deliverables',
      label: 'All milestones have deliverables',
      met: milestoneCount > 0 && milestonesWithoutDeliverables === 0,
    },
  ];

  // Agent checks — stored in DB, not re-evaluated mechanically
  const agentChecks = getAll(
    'SELECT id, label, met, created_at FROM project_checklist WHERE project_id = ? ORDER BY created_at ASC',
    [projectId]
  );

  const ready = systemChecks.every(c => c.met) && agentChecks.every(c => c.met);

  return { systemChecks, agentChecks, ready };
}

/**
 * Evaluate readiness and update project status accordingly.
 * Transitions: not_ready ↔ active (but not from complete/archived).
 * Returns the updated readiness result.
 */
export function updateProjectReadiness(projectId) {
  const result = evaluateReadiness(projectId);
  const project = getOne('SELECT status, launched_at FROM projects WHERE id = ?', [projectId]);
  if (!project) return result;

  // Auto-demotion: active → not_ready when prerequisites fail (post-launch safety)
  // Auto-promotion: NEVER — requires explicit POST /api/projects/:id/launch
  if (project.status === 'active' && !result.ready) {
    run("UPDATE projects SET status = 'not_ready', updated_at = datetime('now') WHERE id = ?", [projectId]);
  }

  return result;
}
