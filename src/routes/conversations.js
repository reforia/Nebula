import { Router } from 'express';
import { getAll, getOne, run } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { requireAgentInOrg } from '../utils/route-guards.js';
import { sendError } from '../utils/response.js';

// Agent-scoped routes: mounted at /api/agents
export const agentConversationsRouter = Router();

// GET /api/agents/:id/conversations
agentConversationsRouter.get('/:id/conversations', requireAgentInOrg(), (req, res) => {
  const conversations = getAll(`
    SELECT c.*,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.is_read = 0 AND m.role = 'assistant') as unread_count,
      (SELECT content FROM messages m2 WHERE m2.conversation_id = c.id ORDER BY m2.created_at DESC LIMIT 1) as last_message,
      (SELECT created_at FROM messages m3 WHERE m3.conversation_id = c.id ORDER BY m3.created_at DESC LIMIT 1) as last_message_at
    FROM conversations c
    WHERE c.agent_id = ? AND c.project_id IS NULL
    ORDER BY c.created_at DESC
  `, [req.params.id]);

  res.json(conversations);
});

// POST /api/agents/:id/conversations
agentConversationsRouter.post('/:id/conversations', requireAgentInOrg(), (req, res) => {
  const agent = req.agent;
  const { title } = req.body;
  const id = generateId();
  const sessionId = generateId();

  run(
    `INSERT INTO conversations (id, agent_id, title, session_id, session_initialized)
     VALUES (?, ?, ?, ?, 0)`,
    [id, agent.id, title || 'New conversation', sessionId]
  );

  const conversation = getOne('SELECT * FROM conversations WHERE id = ?', [id]);
  res.status(201).json(conversation);
});

// Conversation-level routes: mounted at /api/conversations
const conversationsRouter = Router();

// PUT /api/conversations/:id — rename
conversationsRouter.put('/:id', (req, res) => {
  // Verify conversation belongs to an agent in the user's org
  const conversation = getOne(
    `SELECT c.* FROM conversations c
     JOIN agents a ON c.agent_id = a.id
     WHERE c.id = ? AND a.org_id = ?`,
    [req.params.id, req.orgId]
  );
  if (!conversation) return sendError(res, 404, 'Conversation not found');

  const { title } = req.body;
  if (!title || !title.trim()) return sendError(res, 400, 'Title is required');

  run(
    "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?",
    [title.trim(), req.params.id]
  );

  const updated = getOne('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
  res.json(updated);
});

// DELETE /api/conversations/:id
conversationsRouter.delete('/:id', (req, res) => {
  const conversation = getOne(
    `SELECT c.* FROM conversations c
     JOIN agents a ON c.agent_id = a.id
     WHERE c.id = ? AND a.org_id = ?`,
    [req.params.id, req.orgId]
  );
  if (!conversation) return sendError(res, 404, 'Conversation not found');

  const count = getOne(
    'SELECT COUNT(*) as count FROM conversations WHERE agent_id = ?',
    [conversation.agent_id]
  );
  if (count.count <= 1) {
    return sendError(res, 400, 'Cannot delete the last conversation');
  }

  run('DELETE FROM conversations WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

export default conversationsRouter;
