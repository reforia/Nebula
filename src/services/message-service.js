import { getAll, getOne, run } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { broadcastToOrg, broadcastUnreadCounts } from './websocket.js';

/** Enrich messages with reply_to data (quoted message preview) */
export function enrichReplyTo(messages) {
  const replyIds = messages.filter(m => m.reply_to_id).map(m => m.reply_to_id);
  if (replyIds.length === 0) return;
  const placeholders = replyIds.map(() => '?').join(',');
  const quoted = getAll(`SELECT id, role, agent_id, substr(content, 1, 200) as content FROM messages WHERE id IN (${placeholders})`, replyIds);
  const map = Object.fromEntries(quoted.map(q => [q.id, q]));
  for (const msg of messages) {
    if (msg.reply_to_id && map[msg.reply_to_id]) {
      msg.reply_to = map[msg.reply_to_id];
    }
  }
}

/**
 * Insert a message into the database, update conversation timestamp,
 * broadcast via WebSocket, and update unread counts.
 *
 * @param {Object} opts
 * @param {string} opts.agentId - Agent ID
 * @param {string|null} opts.conversationId - Conversation ID
 * @param {'user'|'assistant'} opts.role
 * @param {string} opts.content
 * @param {string} opts.orgId - For broadcasting
 * @param {string} [opts.messageType='chat'] - chat, task, error, system, agent, integration
 * @param {string} [opts.taskName] - For task messages
 * @param {string} [opts.metadata] - JSON string of metadata
 * @param {string} [opts.replyToId] - Reply-to message ID
 * @param {boolean} [opts.isRead=false] - Mark as read on insert
 * @param {Object} [opts.broadcastExtra] - Extra fields for the broadcast (e.g. { project_id })
 * @param {boolean} [opts.broadcast=true] - Whether to broadcast
 * @param {boolean} [opts.updateUnread=true] - Whether to broadcast unread counts
 * @returns {Object} The inserted message row
 */
export function insertMessage({
  agentId, conversationId, role, content, orgId,
  messageType = 'chat', taskName = null, metadata = null, replyToId = null,
  isRead = false, broadcastExtra = {}, broadcast = true, updateUnread = true,
}) {
  const id = generateId();

  run(
    `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, task_name, metadata, reply_to_id, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [id, agentId, conversationId, role, content, messageType, taskName, metadata, replyToId, isRead ? 1 : 0]
  );

  if (conversationId) {
    run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [conversationId]);
  }

  const msg = getOne('SELECT * FROM messages WHERE id = ?', [id]);
  if (replyToId) enrichReplyTo([msg]);

  if (broadcast) {
    broadcastToOrg(orgId, {
      type: 'new_message',
      ...broadcastExtra,
      agent_id: agentId,
      message: msg,
    });
  }

  if (updateUnread) {
    broadcastUnreadCounts(orgId);
  }

  return msg;
}

/**
 * Resolve the conversation for an agent, optionally in project context.
 * Returns { conversationId, broadcastExtra }.
 */
export function resolveConversation(agentId, projectId = null) {
  if (projectId) {
    const projConv = getOne('SELECT id FROM conversations WHERE project_id = ?', [projectId]);
    return {
      conversationId: projConv?.id || null,
      broadcastExtra: { project_id: projectId },
    };
  }
  const conv = getOne(
    'SELECT id FROM conversations WHERE agent_id = ? AND project_id IS NULL ORDER BY created_at DESC LIMIT 1',
    [agentId]
  );
  return {
    conversationId: conv?.id || null,
    broadcastExtra: {},
  };
}
