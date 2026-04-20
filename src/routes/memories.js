import { Router } from 'express';
import { getAll, getOne, run, getOrgSetting } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { rebuildIndex, search } from '../services/memory-search.js';
import { searchExternalKBs } from '../services/kb-search.js';
import { sendError } from '../utils/response.js';

const router = Router();

// --- Helpers ---

function getAgentForOrg(agentId, orgId) {
  return getOne('SELECT id FROM agents WHERE id = ? AND org_id = ?', [agentId, orgId]);
}

function getProjectForOrg(projectId, orgId) {
  return getOne('SELECT id, name FROM projects WHERE id = ? AND org_id = ?', [projectId, orgId]);
}

/**
 * Partial-update field resolver. Distinguishes three states:
 *   - field omitted from body → undefined → keep old value
 *   - field present but empty/whitespace → { error } (caller should 400)
 *   - field present and non-empty → trimmed new value
 * Prevents silent data loss from the old `body.x?.trim() || current` pattern,
 * which treated a deliberate empty string the same as "not sent".
 */
function resolveTextField(value, current) {
  if (value === undefined) return { value: current };
  if (typeof value !== 'string' || !value.trim()) return { error: true };
  return { value: value.trim() };
}

// --- Agent Memory CRUD: /api/agents/:agentId/memory ---

const agentMemoryRouter = Router();

// List all memory metadata (titles + descriptions)
agentMemoryRouter.get('/:agentId/memory', (req, res) => {
  if (!getAgentForOrg(req.params.agentId, req.orgId)) {
    return sendError(res, 404, 'Agent not found');
  }
  const memories = getAll(
    'SELECT id, title, description, created_at, updated_at FROM memories WHERE owner_type = ? AND owner_id = ? ORDER BY updated_at DESC',
    ['agent', req.params.agentId]
  );
  res.json(memories);
});

// Read full memory content
agentMemoryRouter.get('/:agentId/memory/:memoryId', (req, res) => {
  if (!getAgentForOrg(req.params.agentId, req.orgId)) {
    return sendError(res, 404, 'Agent not found');
  }
  const memory = getOne(
    'SELECT * FROM memories WHERE id = ? AND owner_type = ? AND owner_id = ?',
    [req.params.memoryId, 'agent', req.params.agentId]
  );
  if (!memory) return sendError(res, 404, 'Memory not found');
  res.json(memory);
});

// Create memory
agentMemoryRouter.post('/:agentId/memory', (req, res) => {
  if (!getAgentForOrg(req.params.agentId, req.orgId)) {
    return sendError(res, 404, 'Agent not found');
  }
  const { title, description, content } = req.body;
  if (!title?.trim() || !description?.trim() || !content?.trim()) {
    return sendError(res, 400, 'Title, description, and content are required');
  }

  // Check title uniqueness within scope
  const existing = getOne(
    'SELECT id FROM memories WHERE owner_type = ? AND owner_id = ? AND title = ? COLLATE NOCASE',
    ['agent', req.params.agentId, title.trim()]
  );
  if (existing) {
    return res.status(409).json({ ok: false, error: 'A memory with this title already exists', existing_id: existing.id });
  }

  const id = generateId();
  run(
    'INSERT INTO memories (id, owner_type, owner_id, title, description, content) VALUES (?, ?, ?, ?, ?, ?)',
    [id, 'agent', req.params.agentId, title.trim(), description.trim(), content.trim()]
  );
  rebuildIndex('agent', req.params.agentId);

  const memory = getOne('SELECT * FROM memories WHERE id = ?', [id]);
  res.status(201).json(memory);
});

// Update memory
agentMemoryRouter.put('/:agentId/memory/:memoryId', (req, res) => {
  if (!getAgentForOrg(req.params.agentId, req.orgId)) {
    return sendError(res, 404, 'Agent not found');
  }
  const memory = getOne(
    'SELECT * FROM memories WHERE id = ? AND owner_type = ? AND owner_id = ?',
    [req.params.memoryId, 'agent', req.params.agentId]
  );
  if (!memory) return sendError(res, 404, 'Memory not found');

  const { title, description, content } = req.body;
  const t = resolveTextField(title, memory.title);
  const d = resolveTextField(description, memory.description);
  const c = resolveTextField(content, memory.content);
  if (t.error || d.error || c.error) {
    return sendError(res, 400, 'Title, description, and content cannot be empty');
  }

  // If title changed, check uniqueness
  if (t.value.toLowerCase() !== memory.title.toLowerCase()) {
    const dup = getOne(
      'SELECT id FROM memories WHERE owner_type = ? AND owner_id = ? AND title = ? COLLATE NOCASE AND id != ?',
      ['agent', req.params.agentId, t.value, memory.id]
    );
    if (dup) return sendError(res, 409, 'A memory with this title already exists');
  }

  run(
    `UPDATE memories SET title = ?, description = ?, content = ?, updated_at = datetime('now') WHERE id = ?`,
    [t.value, d.value, c.value, memory.id]
  );
  rebuildIndex('agent', req.params.agentId);

  const updated = getOne('SELECT * FROM memories WHERE id = ?', [memory.id]);
  res.json(updated);
});

// Delete memory
agentMemoryRouter.delete('/:agentId/memory/:memoryId', (req, res) => {
  if (!getAgentForOrg(req.params.agentId, req.orgId)) {
    return sendError(res, 404, 'Agent not found');
  }
  const memory = getOne(
    'SELECT id FROM memories WHERE id = ? AND owner_type = ? AND owner_id = ?',
    [req.params.memoryId, 'agent', req.params.agentId]
  );
  if (!memory) return sendError(res, 404, 'Memory not found');

  run('DELETE FROM memories WHERE id = ?', [memory.id]);
  rebuildIndex('agent', req.params.agentId);

  res.json({ ok: true });
});


// --- Project Memory CRUD: /api/projects/:projectId/memory ---

const projectMemoryRouter = Router();

// List project memory metadata
projectMemoryRouter.get('/:projectId/memory', (req, res) => {
  if (!getProjectForOrg(req.params.projectId, req.orgId)) {
    return sendError(res, 404, 'Project not found');
  }
  const memories = getAll(
    'SELECT id, title, description, created_at, updated_at FROM memories WHERE owner_type = ? AND owner_id = ? ORDER BY updated_at DESC',
    ['project', req.params.projectId]
  );
  res.json(memories);
});

// Read full project memory content
projectMemoryRouter.get('/:projectId/memory/:memoryId', (req, res) => {
  if (!getProjectForOrg(req.params.projectId, req.orgId)) {
    return sendError(res, 404, 'Project not found');
  }
  const memory = getOne(
    'SELECT * FROM memories WHERE id = ? AND owner_type = ? AND owner_id = ?',
    [req.params.memoryId, 'project', req.params.projectId]
  );
  if (!memory) return sendError(res, 404, 'Memory not found');
  res.json(memory);
});

// Create project memory
projectMemoryRouter.post('/:projectId/memory', (req, res) => {
  if (!getProjectForOrg(req.params.projectId, req.orgId)) {
    return sendError(res, 404, 'Project not found');
  }
  const { title, description, content } = req.body;
  if (!title?.trim() || !description?.trim() || !content?.trim()) {
    return sendError(res, 400, 'Title, description, and content are required');
  }

  const existing = getOne(
    'SELECT id FROM memories WHERE owner_type = ? AND owner_id = ? AND title = ? COLLATE NOCASE',
    ['project', req.params.projectId, title.trim()]
  );
  if (existing) {
    return res.status(409).json({ ok: false, error: 'A memory with this title already exists', existing_id: existing.id });
  }

  const id = generateId();
  run(
    'INSERT INTO memories (id, owner_type, owner_id, title, description, content) VALUES (?, ?, ?, ?, ?, ?)',
    [id, 'project', req.params.projectId, title.trim(), description.trim(), content.trim()]
  );
  rebuildIndex('project', req.params.projectId);

  const memory = getOne('SELECT * FROM memories WHERE id = ?', [id]);
  res.status(201).json(memory);
});

// Update project memory
projectMemoryRouter.put('/:projectId/memory/:memoryId', (req, res) => {
  if (!getProjectForOrg(req.params.projectId, req.orgId)) {
    return sendError(res, 404, 'Project not found');
  }
  const memory = getOne(
    'SELECT * FROM memories WHERE id = ? AND owner_type = ? AND owner_id = ?',
    [req.params.memoryId, 'project', req.params.projectId]
  );
  if (!memory) return sendError(res, 404, 'Memory not found');

  const { title, description, content } = req.body;
  const t = resolveTextField(title, memory.title);
  const d = resolveTextField(description, memory.description);
  const c = resolveTextField(content, memory.content);
  if (t.error || d.error || c.error) {
    return sendError(res, 400, 'Title, description, and content cannot be empty');
  }

  if (t.value.toLowerCase() !== memory.title.toLowerCase()) {
    const dup = getOne(
      'SELECT id FROM memories WHERE owner_type = ? AND owner_id = ? AND title = ? COLLATE NOCASE AND id != ?',
      ['project', req.params.projectId, t.value, memory.id]
    );
    if (dup) return sendError(res, 409, 'A memory with this title already exists');
  }

  run(
    `UPDATE memories SET title = ?, description = ?, content = ?, updated_at = datetime('now') WHERE id = ?`,
    [t.value, d.value, c.value, memory.id]
  );
  rebuildIndex('project', req.params.projectId);

  const updated = getOne('SELECT * FROM memories WHERE id = ?', [memory.id]);
  res.json(updated);
});

// Delete project memory
projectMemoryRouter.delete('/:projectId/memory/:memoryId', (req, res) => {
  if (!getProjectForOrg(req.params.projectId, req.orgId)) {
    return sendError(res, 404, 'Project not found');
  }
  const memory = getOne(
    'SELECT id FROM memories WHERE id = ? AND owner_type = ? AND owner_id = ?',
    [req.params.memoryId, 'project', req.params.projectId]
  );
  if (!memory) return sendError(res, 404, 'Memory not found');

  run('DELETE FROM memories WHERE id = ?', [memory.id]);
  rebuildIndex('project', req.params.projectId);

  res.json({ ok: true });
});


// --- Unified Search: /api/memory/search ---

router.post('/search', async (req, res) => {
  const { query, agent_id, project_id } = req.body;
  if (!query?.trim()) return sendError(res, 400, 'Query is required');
  if (!agent_id) return sendError(res, 400, 'agent_id is required');

  // Verify agent belongs to org
  if (!getAgentForOrg(agent_id, req.orgId)) {
    return sendError(res, 404, 'Agent not found');
  }

  const results = [];
  const trimmedQuery = query.trim();

  // Search agent memories
  const agentResults = search('agent', agent_id, trimmedQuery);
  for (const r of agentResults) {
    results.push({ ...r, source: 'agent' });
  }

  // Search project memories + external KBs if project provided
  if (project_id) {
    if (!getProjectForOrg(project_id, req.orgId)) {
      return sendError(res, 404, 'Project not found');
    }
    const projectResults = search('project', project_id, trimmedQuery);
    for (const r of projectResults) {
      results.push({ ...r, source: 'project' });
    }

    // Fan out to external KBs linked to this project (best-effort, 5s timeout)
    const kbLinks = getAll(
      "SELECT * FROM project_links WHERE project_id = ? AND type = 'knowledge_base'",
      [project_id]
    );
    if (kbLinks.length > 0) {
      try {
        const orgId = req.orgId;
        const externalResults = await searchExternalKBs(kbLinks, (link) => {
          const config = typeof link.config === 'string' ? JSON.parse(link.config) : (link.config || {});
          return config.token || getOrgSetting(orgId, `${link.provider}_api_token`);
        }, trimmedQuery);
        results.push(...externalResults);
      } catch (err) {
        // External KB failure should never block local results
        console.warn(`[memory-search] External KB query failed: ${err.message}`);
      }
    }
  }

  // Merge and sort by score
  results.sort((a, b) => b.score - a.score);

  res.json(results);
});

export { agentMemoryRouter, projectMemoryRouter };
export default router;
