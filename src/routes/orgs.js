import { Router } from 'express';
import fs from 'fs';
import { getAll, getOne, run, initOrgDirectories, seedDefaultOrgSettings, orgPath } from '../db.js';
import { generateId } from '../utils/uuid.js';

const router = Router();

// GET /api/orgs — list user's organizations
router.get('/', (req, res) => {
  const orgs = getAll(
    'SELECT id, name, owner_id, created_at, updated_at FROM organizations WHERE owner_id = ? ORDER BY created_at ASC',
    [req.user.id]
  );
  res.json(orgs);
});

// POST /api/orgs — create a new organization
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const orgId = generateId();
  run(
    'INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)',
    [orgId, name.trim(), req.user.id]
  );

  // Initialize directories and default settings
  initOrgDirectories(orgId);
  seedDefaultOrgSettings(orgId);

  const org = getOne('SELECT id, name, owner_id, created_at, updated_at FROM organizations WHERE id = ?', [orgId]);
  res.status(201).json(org);
});

// PUT /api/orgs/:id — rename organization
router.put('/:id', (req, res) => {
  const org = getOne('SELECT * FROM organizations WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  run("UPDATE organizations SET name = ?, updated_at = datetime('now') WHERE id = ?", [name.trim(), req.params.id]);
  const updated = getOne('SELECT id, name, owner_id, created_at, updated_at FROM organizations WHERE id = ?', [req.params.id]);
  res.json(updated);
});

// DELETE /api/orgs/:id — delete organization and all its data
router.delete('/:id', (req, res) => {
  const org = getOne('SELECT * FROM organizations WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  // Don't allow deleting the last org
  const count = getOne('SELECT COUNT(*) as count FROM organizations WHERE owner_id = ?', [req.user.id]);
  if (count.count <= 1) {
    return res.status(400).json({ error: 'Cannot delete your last organization' });
  }

  // Delete from DB (cascades to agents, messages, tasks, conversations, org_settings)
  run('DELETE FROM organizations WHERE id = ?', [req.params.id]);

  // Clean up filesystem
  const orgDir = orgPath(req.params.id);
  if (fs.existsSync(orgDir)) {
    fs.rmSync(orgDir, { recursive: true, force: true });
  }

  res.json({ ok: true });
});

export default router;
