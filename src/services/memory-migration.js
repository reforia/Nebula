/**
 * One-time migration: file-based memory → DB memories table.
 * Scans each agent's memory/ directory, parses markdown files,
 * inserts into memories table, renames memory/ to memory.bak/.
 *
 * Safe to run multiple times — skips agents that already have memory.bak/.
 */

import fs from 'fs';
import path from 'path';
import { getAll, getOne, run } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { rebuildIndex } from './memory-search.js';

const DATA_DIR = process.env.DATA_DIR || '/data';

/** Parse frontmatter from a markdown file */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length > 0) {
      frontmatter[key.trim().toLowerCase()] = rest.join(':').trim();
    }
  }
  return { meta: frontmatter, body: match[2].trim() };
}

/** Migrate a single agent's file-based memory to DB */
function migrateAgent(agentId, memoryDir) {
  const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  let count = 0;

  for (const file of files) {
    const filePath = path.join(memoryDir, file);
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) continue;

    let title, description, content;

    const parsed = parseFrontmatter(raw);
    if (parsed && parsed.meta.name) {
      // Has frontmatter with name/description
      title = parsed.meta.name;
      description = parsed.meta.description || title;
      content = parsed.body;
    } else {
      // No frontmatter — use filename as title, first line as description
      title = file.replace(/\.md$/, '').replace(/[-_]/g, ' ');
      const lines = raw.split('\n').filter(l => l.trim());
      // Skip markdown header if first line is one
      const firstContentLine = lines.find(l => !l.startsWith('#')) || lines[0] || title;
      description = firstContentLine.slice(0, 150);
      content = raw;
    }

    // Skip if a memory with this title already exists (idempotent)
    const existing = getOne(
      "SELECT id FROM memories WHERE owner_type = 'agent' AND owner_id = ? AND title = ? COLLATE NOCASE",
      [agentId, title]
    );
    if (existing) continue;

    const id = generateId();
    run(
      'INSERT INTO memories (id, owner_type, owner_id, title, description, content) VALUES (?, ?, ?, ?, ?, ?)',
      [id, 'agent', agentId, title, description, content]
    );
    count++;
  }

  return count;
}

/** Run migration for all agents that still have memory/ directories */
export function migrateFileMemories() {
  const orgsDir = path.join(DATA_DIR, 'orgs');
  if (!fs.existsSync(orgsDir)) return;

  let totalMigrated = 0;
  let agentsMigrated = 0;

  for (const orgId of fs.readdirSync(orgsDir)) {
    const agentsDir = path.join(orgsDir, orgId, 'agents');
    if (!fs.existsSync(agentsDir)) continue;

    for (const agentId of fs.readdirSync(agentsDir)) {
      const agentDir = path.join(agentsDir, agentId);
      const memoryDir = path.join(agentDir, 'memory');
      const backupDir = path.join(agentDir, 'memory.bak');

      // Skip if already migrated or no memory dir
      if (!fs.existsSync(memoryDir) || fs.existsSync(backupDir)) continue;

      // Verify agent exists in DB
      const agent = getOne('SELECT id FROM agents WHERE id = ?', [agentId]);
      if (!agent) continue;

      const count = migrateAgent(agentId, memoryDir);
      if (count > 0) {
        rebuildIndex('agent', agentId);
        totalMigrated += count;
        agentsMigrated++;
      }

      // Rename memory/ to memory.bak/ (preserve but stop using)
      try {
        fs.renameSync(memoryDir, backupDir);
      } catch (e) {
        console.warn(`[memory-migration] Failed to rename ${memoryDir}: ${e.message}`);
      }
    }
  }

  if (totalMigrated > 0) {
    console.log(`[memory-migration] Migrated ${totalMigrated} memories from ${agentsMigrated} agent(s)`);
  }
}
