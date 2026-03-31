/**
 * Automatic SQLite database backup service.
 *
 * Runs on a schedule (default: every 6 hours) and keeps the last N backups.
 * Uses better-sqlite3's backup() API which is safe to run while the DB is
 * active in WAL mode — no downtime, no locks.
 */

import path from 'path';
import fs from 'fs';
import { Cron } from 'croner';
import { db, DATA_DIR } from '../db.js';

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 20;          // Keep last 20 backups
const BACKUP_CRON = '0 */6 * * *'; // Every 6 hours

let backupTask = null;

/**
 * Create a backup of the database.
 * Returns the backup file path on success, null on failure.
 */
export function createBackup(label = '') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = label
    ? `nebula-${timestamp}-${label}.db`
    : `nebula-${timestamp}.db`;
  const backupPath = path.join(BACKUP_DIR, filename);

  try {
    db.backup(backupPath);
    console.log(`[backup] Created: ${filename}`);
    rotateBackups();
    return backupPath;
  } catch (err) {
    console.error(`[backup] Failed: ${err.message}`);
    return null;
  }
}

/**
 * Delete oldest backups beyond MAX_BACKUPS.
 */
function rotateBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('nebula-') && f.endsWith('.db'))
      .sort(); // Lexicographic sort = chronological due to timestamp format

    while (files.length > MAX_BACKUPS) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(BACKUP_DIR, oldest));
      console.log(`[backup] Rotated out: ${oldest}`);
    }
  } catch (err) {
    console.error(`[backup] Rotation failed: ${err.message}`);
  }
}

/**
 * List existing backups.
 */
export function listBackups() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('nebula-') && f.endsWith('.db'))
    .sort()
    .reverse()
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size: stat.size, created: stat.mtime.toISOString() };
    });
}

/**
 * Restore from a backup file. Requires server restart after.
 */
export function restoreBackup(filename) {
  const backupPath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(backupPath)) throw new Error(`Backup not found: ${filename}`);
  if (filename.includes('..') || filename.includes('/')) throw new Error('Invalid filename');

  const dbPath = path.join(DATA_DIR, 'nebula.db');

  // Create a safety backup before restoring
  createBackup('pre-restore');

  // Close WAL checkpoint before copying
  db.pragma('wal_checkpoint(TRUNCATE)');

  // Copy backup over the current DB
  fs.copyFileSync(backupPath, dbPath);
  console.log(`[backup] Restored from: ${filename} — restart required`);
}

/**
 * Start the automatic backup scheduler.
 */
export function initBackupScheduler() {
  // Create initial backup on startup
  createBackup('startup');

  backupTask = new Cron(BACKUP_CRON, () => {
    createBackup();
  });

  console.log(`[backup] Scheduler started — every 6 hours, keeping last ${MAX_BACKUPS} backups`);
}

/**
 * Stop the backup scheduler.
 */
export function stopBackupScheduler() {
  if (backupTask) {
    backupTask.stop();
    backupTask = null;
  }
}
