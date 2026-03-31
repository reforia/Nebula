/**
 * Periodic cleanup service for orphaned resources.
 *
 * Configurable via org settings:
 *   cleanup_enabled   — '1' or '0' (default: '1')
 *   cleanup_cron      — cron expression (default: '0 3 * * *')
 *   cleanup_sessions  — clean stale CC CLI sessions (default: '1')
 *   cleanup_worktrees — clean stale project worktrees (default: '1')
 *
 * 1. CC CLI session files — deletes JSONL files whose session ID no longer
 *    matches any active conversation.
 * 2. Project worktrees — removes worktree directories for branches that
 *    no longer exist in the project's git repo.
 */

import fs from 'fs';
import path from 'path';
import { Cron } from 'croner';
import { getAll, getOne, orgPath, getOrgSetting } from '../db.js';
import { listBranches, removeWorktree } from './git.js';

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '/home/node', '.claude');
const SESSIONS_DIR = path.join(CLAUDE_HOME, 'projects');
const DEFAULT_CRON = '0 3 * * *';

let cleanupTask = null;
let lastResult = null;

/** Read cleanup settings from the first org (single-tenant). */
function getCleanupSettings(orgId) {
  const oid = orgId || getOne('SELECT id FROM organizations LIMIT 1')?.id;
  if (!oid) return { enabled: true, cron: DEFAULT_CRON, sessions: true, worktrees: true };
  return {
    enabled: (getOrgSetting(oid, 'cleanup_enabled') ?? '1') === '1',
    cron: getOrgSetting(oid, 'cleanup_cron') || DEFAULT_CRON,
    sessions: (getOrgSetting(oid, 'cleanup_sessions') ?? '1') === '1',
    worktrees: (getOrgSetting(oid, 'cleanup_worktrees') ?? '1') === '1',
  };
}

/**
 * Delete CC CLI session files that don't match any active conversation.
 */
function cleanStaleSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return { deleted: 0, scanned: 0 };

  const activeIds = new Set(
    getAll('SELECT session_id FROM conversations').map(c => c.session_id)
  );

  let deleted = 0;
  let scanned = 0;

  for (const projectDir of fs.readdirSync(SESSIONS_DIR)) {
    const fullDir = path.join(SESSIONS_DIR, projectDir);
    if (!fs.statSync(fullDir).isDirectory()) continue;

    for (const file of fs.readdirSync(fullDir)) {
      if (!file.endsWith('.jsonl')) continue;
      scanned++;

      const sessionId = file.replace('.jsonl', '');
      if (!activeIds.has(sessionId)) {
        try {
          fs.unlinkSync(path.join(fullDir, file));
          const companionDir = path.join(fullDir, sessionId);
          if (fs.existsSync(companionDir) && fs.statSync(companionDir).isDirectory()) {
            fs.rmSync(companionDir, { recursive: true });
          }
          deleted++;
        } catch {}
      }
    }

    try {
      if (fs.readdirSync(fullDir).length === 0) fs.rmdirSync(fullDir);
    } catch {}
  }

  if (deleted > 0) console.log(`[cleanup] Deleted ${deleted} stale CC session(s) (scanned ${scanned})`);
  return { deleted, scanned };
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

/**
 * Run cleanup with current settings. Returns result summary.
 */
function performCleanup(orgId) {
  const settings = getCleanupSettings(orgId);
  if (!settings.enabled) return null;

  const result = { timestamp: new Date().toISOString(), sessions: null, worktrees: null };

  if (settings.sessions) {
    try { result.sessions = cleanStaleSessions(); }
    catch (err) { console.error('[cleanup] Session cleanup failed:', err.message); }
  }
  if (settings.worktrees) {
    try { result.worktrees = cleanStaleWorktrees(); }
    catch (err) { console.error('[cleanup] Worktree cleanup failed:', err.message); }
  }

  lastResult = result;
  return result;
}

/**
 * Schedule the cron task based on current settings.
 */
function schedule(orgId) {
  if (cleanupTask) { cleanupTask.stop(); cleanupTask = null; }

  const settings = getCleanupSettings(orgId);
  if (!settings.enabled) {
    console.log('[cleanup] Service disabled');
    return;
  }

  try {
    cleanupTask = new Cron(settings.cron, () => performCleanup(orgId));
    console.log(`[cleanup] Scheduled — ${settings.cron}`);
  } catch (err) {
    console.error(`[cleanup] Invalid cron "${settings.cron}", falling back to default`);
    cleanupTask = new Cron(DEFAULT_CRON, () => performCleanup(orgId));
  }
}

/** Start the cleanup service. */
export function initCleanupService() {
  // Run on startup after a short delay
  setTimeout(() => performCleanup(), 60_000);
  schedule();
}

/** Reschedule after settings change. */
export function rescheduleCleanup(orgId) {
  schedule(orgId);
}

/** Trigger cleanup manually. Returns result. */
export function runCleanupNow(orgId) {
  return performCleanup(orgId) || { timestamp: new Date().toISOString(), disabled: true };
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
