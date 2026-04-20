import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { runMigrations } from './migrations.js';
import { decrypt } from './utils/crypto.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = path.join(DATA_DIR, 'nebula.db');

// Ensure top-level data directory exists
fs.mkdirSync(path.join(DATA_DIR, 'orgs'), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode and foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run migrations
runMigrations(db);

// Query helpers
export function getAll(sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function getOne(sql, params = []) {
  return db.prepare(sql).get(...params);
}

export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

export function getSetting(key) {
  const row = getOne('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

export function getOrgSetting(orgId, key) {
  const row = getOne('SELECT value FROM org_settings WHERE org_id = ? AND key = ?', [orgId, key]);
  if (!row) return null;
  // Transparently decrypt encrypted values (secrets stored with "enc:" prefix)
  return decrypt(row.value);
}

export function setOrgSetting(orgId, key, value) {
  run('INSERT OR REPLACE INTO org_settings (org_id, key, value) VALUES (?, ?, ?)', [orgId, key, value]);
}

// Helper to create org directories and default files
export function initOrgDirectories(orgId) {
  const orgDir = path.join(DATA_DIR, 'orgs', orgId);
  for (const dir of ['global', 'agents', 'logs']) {
    fs.mkdirSync(path.join(orgDir, dir), { recursive: true });
  }

  const globalClaudeMd = path.join(orgDir, 'global', 'CLAUDE.md');
  if (!fs.existsSync(globalClaudeMd)) {
    fs.writeFileSync(globalClaudeMd, `# Global Knowledge

Shared context available to all agents in this organization.

## Available Services
Configure your service connections here. All agents can use curl/git/ssh via the Bash tool.
`);
  }
}

// Seed the standard blank-slate org_settings row set for a newly created org.
// Keep this as the single source of truth for what a fresh org starts with —
// route handlers (auth register/OAuth callback, setup wizard, create-org) all
// call this instead of repeating the object literal.
export function seedDefaultOrgSettings(orgId) {
  const defaults = {
    internal_api_token: crypto.randomUUID(),
    smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', smtp_from: '',
    notify_email_to: '', notifications_enabled: '0',
    imap_host: '', imap_port: '993', imap_user: '', imap_pass: '', mail_enabled: '0',
  };
  for (const [key, value] of Object.entries(defaults)) {
    setOrgSetting(orgId, key, value);
  }
}

// Helper to get org-scoped filesystem path
export function orgPath(orgId, ...parts) {
  return path.join(DATA_DIR, 'orgs', orgId, ...parts);
}

export { db, DATA_DIR };
export default db;
