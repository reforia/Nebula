/**
 * Periodic cleanup service for orphaned resources.
 *
 * Configurable via org settings:
 *   cleanup_enabled   — '1' or '0' (default: '1')
 *   cleanup_cron      — cron expression (default: '0 3 * * *')
 *   cleanup_sessions  — clean stale CLI sessions (default: '1')
 *   cleanup_worktrees — clean stale project worktrees (default: '1')
 *
 * 1. CLI session files — delegates to each adapter's cleanStaleSessions()
 *    to delete session state not matching any active conversation.
 * 2. Project worktrees — removes worktree directories for branches that
 *    no longer exist in the project's git repo.
 */

import fs from 'fs';
import path from 'path';
import { Cron } from 'croner';
import { getAll, getOne, orgPath, getOrgSetting } from '../db.js';
import { listBranches, removeWorktree } from './git.js';
import { executeTask } from './task-executor.js';
import { generateId } from '../utils/uuid.js';
import { registry } from '../backends/cli-registry.js';

const DEFAULT_CRON = '0 3 * * *';
const SYS_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

let cleanupTask = null;
let lastResult = null;

/** Read cleanup settings from the first org (single-tenant). */
function getCleanupSettings(orgId) {
  const oid = orgId || getOne('SELECT id FROM organizations LIMIT 1')?.id;
  if (!oid) return { enabled: true, cron: DEFAULT_CRON, sessions: true, worktrees: true, dreaming: true };
  return {
    enabled: (getOrgSetting(oid, 'cleanup_enabled') || '1') === '1',
    cron: getOrgSetting(oid, 'cleanup_cron') || DEFAULT_CRON,
    sessions: (getOrgSetting(oid, 'cleanup_sessions') || '1') === '1',
    worktrees: (getOrgSetting(oid, 'cleanup_worktrees') || '1') === '1',
    dreaming: (getOrgSetting(oid, 'cleanup_dreaming') || '1') === '1',
  };
}

/**
 * Delete stale session files across all installed CLI runtimes.
 * Delegates to each adapter's cleanStaleSessions() method.
 */
function cleanStaleSessions() {
  const activeIds = new Set(
    getAll('SELECT session_id FROM conversations').map(c => c.session_id)
  );

  let totalDeleted = 0;
  let totalScanned = 0;

  for (const adapter of registry.getAvailable()) {
    try {
      const { deleted, scanned } = adapter.cleanStaleSessions(activeIds);
      totalDeleted += deleted;
      totalScanned += scanned;
    } catch (err) {
      console.warn(`[cleanup] Session cleanup failed for ${adapter.displayName}: ${err.message}`);
    }
  }

  return { deleted: totalDeleted, scanned: totalScanned };
}

/**
 * Remove worktree directories for branches that no longer exist.
 */
function cleanStaleWorktrees() {
  const projects = getAll('SELECT id, org_id FROM projects');
  let deleted = 0;
  const removed = [];

  for (const project of projects) {
    const repo = orgPath(project.org_id, 'projects', project.id, 'repo.git');
    if (!fs.existsSync(repo)) continue;

    let branchNames;
    try {
      branchNames = new Set(listBranches(repo).map(b => b.name));
    } catch {
      continue;
    }

    const agents = getAll('SELECT agent_id FROM project_agents WHERE project_id = ?', [project.id]);

    for (const { agent_id } of agents) {
      const projectWorktreeBase = orgPath(project.org_id, 'agents', agent_id, 'projects', project.id);
      if (!fs.existsSync(projectWorktreeBase)) continue;

      const worktreeDirs = findWorktreeDirs(projectWorktreeBase);

      for (const { dir, branchName } of worktreeDirs) {
        if (!branchNames.has(branchName)) {
          try {
            removeWorktree(repo, dir);
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
            deleted++;
            removed.push(branchName);
            console.log(`[cleanup] Removed stale worktree: ${branchName} (agent ${agent_id})`);
          } catch (err) {
            console.warn(`[cleanup] Failed to remove worktree ${dir}: ${err.message}`);
          }
        }
      }

      cleanEmptyDirs(projectWorktreeBase);
    }
  }

  if (deleted > 0) console.log(`[cleanup] Removed ${deleted} stale worktree(s)`);
  return { deleted, removed };
}

function findWorktreeDirs(basePath) {
  const results = [];
  function walk(dir, relativeParts) {
    if (!fs.existsSync(dir)) return;
    const gitMarker = path.join(dir, '.git');
    if (fs.existsSync(gitMarker) && fs.statSync(gitMarker).isFile()) {
      results.push({ dir, branchName: relativeParts.join('/') });
      return;
    }
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === '#recycle') continue;
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).isDirectory()) {
          walk(full, [...relativeParts, entry]);
        }
      } catch {}
    }
  }
  walk(basePath, []);
  return results;
}

function cleanEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) cleanEmptyDirs(full);
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {}
}

const DREAMING_PROMPT = `You are running a scheduled maintenance cycle. Review and clean up your persistent state:

1. **CLAUDE.md** — Read your CLAUDE.md. Remove entries that are resolved, outdated, or no longer relevant. Consolidate duplicates. Keep it concise and current.

2. **Memories** — Use the /nebula-memory skill to search and review your memories. Delete memories that are stale, resolved, or superseded. Update any with outdated details.

3. **Working directory** — Check for temporary files, logs, or artifacts that are no longer needed and clean them up.

Be conservative — only remove things you are confident are stale. Summarize what you cleaned up.`;

/**
 * Trigger dreaming (self-maintenance) for all enabled agents in an org.
 * Each agent is fired with a stagger delay to avoid rate limits.
 * Returns immediately — executions run in the background.
 */
function triggerDreaming(orgId) {
  const oid = orgId || getOne('SELECT id FROM organizations LIMIT 1')?.id;
  if (!oid) return { triggered: 0 };

  const agents = getAll('SELECT * FROM agents WHERE org_id = ? AND enabled = 1', [oid]);
  if (agents.length === 0) return { triggered: 0 };

  const staggerMs = parseInt(getOrgSetting(oid, 'task_stagger_ms')) || 0;

  console.log(`[cleanup] Triggering dreaming for ${agents.length} agent(s)${staggerMs ? ` (stagger ${staggerMs}ms)` : ''}`);

  // Fire agents sequentially with stagger, but don't await completion
  (async () => {
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const syntheticTask = {
        id: generateId(), name: 'Dreaming', max_turns: 25,
        timeout_ms: parseInt(getOrgSetting(oid, 'default_timeout_ms')) || 600000,
        project_id: null,
      };

      executeTask(syntheticTask, agent, DREAMING_PROMPT, { source: 'dreaming' }).catch(err => {
        console.error(`[cleanup] Dreaming failed for agent "${agent.name}":`, err.message);
      });

      if (staggerMs > 0 && i < agents.length - 1) {
        await new Promise(r => setTimeout(r, staggerMs));
      }
    }
  })();

  return { triggered: agents.length };
}

/**
 * Run cleanup across all orgs. Sessions and worktrees are global;
 * dreaming runs per-org based on each org's settings.
 */
function performCleanup() {
  const result = { timestamp: new Date().toISOString(), sessions: null, worktrees: null, dreaming: {} };

  // Sessions and worktrees are global (not org-scoped)
  try { result.sessions = cleanStaleSessions(); }
  catch (err) { console.error('[cleanup] Session cleanup failed:', err.message); }

  try { result.worktrees = cleanStaleWorktrees(); }
  catch (err) { console.error('[cleanup] Worktree cleanup failed:', err.message); }

  // Dreaming runs per-org
  const orgs = getAll('SELECT id, name FROM organizations');
  for (const org of orgs) {
    const settings = getCleanupSettings(org.id);
    if (settings.dreaming) {
      try { result.dreaming[org.id] = triggerDreaming(org.id); }
      catch (err) { console.error(`[cleanup] Dreaming trigger failed for org "${org.name}":`, err.message); }
    }
  }

  lastResult = result;
  return result;
}

/**
 * Schedule the cleanup cron. Uses the earliest (most frequent) cron
 * across all orgs, or falls back to the default.
 */
function schedule() {
  if (cleanupTask) { cleanupTask.stop(); cleanupTask = null; }

  // Check if any org has cleanup enabled
  const orgs = getAll('SELECT id FROM organizations');
  const anyEnabled = orgs.some(o => getCleanupSettings(o.id).enabled);
  if (!anyEnabled) {
    console.log('[cleanup] Service disabled (no org has cleanup enabled)');
    return;
  }

  // Use the first org's cron that has cleanup enabled, or default
  const firstEnabled = orgs.find(o => getCleanupSettings(o.id).enabled);
  const cron = firstEnabled ? getCleanupSettings(firstEnabled.id).cron : DEFAULT_CRON;

  try {
    cleanupTask = new Cron(cron, { timezone: SYS_TZ }, () => performCleanup());
    console.log(`[cleanup] Scheduled — ${cron} (${SYS_TZ})`);
  } catch (err) {
    console.error(`[cleanup] Invalid cron "${cron}", falling back to default`);
    cleanupTask = new Cron(DEFAULT_CRON, { timezone: SYS_TZ }, () => performCleanup());
  }
}

/** Start the cleanup service. */
export function initCleanupService() {
  schedule();
}

/** Reschedule after settings change. */
export function rescheduleCleanup() {
  schedule();
}

/** Trigger cleanup manually. Returns result. */
export function runCleanupNow() {
  return performCleanup() || { timestamp: new Date().toISOString(), disabled: true };
}

/** Get last result and current schedule. */
export function getCleanupStatus(orgId) {
  const settings = getCleanupSettings(orgId);
  return {
    ...settings,
    nextRun: cleanupTask?.nextRun()?.toISOString() || null,
    lastResult,
  };
}

/** Stop the cleanup service. */
export function stopCleanupService() {
  if (cleanupTask) { cleanupTask.stop(); cleanupTask = null; }
}
