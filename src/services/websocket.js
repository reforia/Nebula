import { WebSocketServer } from 'ws';
import { getAll, run } from '../db.js';
import { verifyAccessToken } from '../utils/jwt.js';
import executor from './executor.js';

let wss = null;
const clients = new Map(); // ws -> { userId, orgId }

export function initWebSocket() {
  wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'mark_read' && msg.agent_id) {
          const clientInfo = clients.get(ws);
          if (clientInfo) {
            run(
              `UPDATE messages SET is_read = 1
               WHERE agent_id = ? AND is_read = 0
               AND agent_id IN (SELECT id FROM agents WHERE org_id = ?)`,
              [msg.agent_id, clientInfo.orgId]
            );
            broadcastUnreadCounts(clientInfo.orgId);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });
}

// Parse cookies from raw header string
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  }
  return cookies;
}

export function handleUpgrade(req, socket, head) {
  // Authenticate via JWT cookie in upgrade request
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.nebula_access;

  if (!token) {
    socket.destroy();
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, { userId: payload.userId, orgId: payload.orgId });
      wss.emit('connection', ws, req);

      // Send current typing state so refreshed clients see active agents
      const typing = executor.getTypingAgents(payload.orgId);
      for (const info of typing) {
        ws.send(JSON.stringify({
          type: 'agent_typing',
          agent_id: info.agentId,
          conversation_id: info.conversationId,
          active: true,
          project_id: info.projectId || undefined,
          branch_name: info.branchName || undefined,
        }));
      }

      // Send current unread counts so reconnected/refreshed clients see correct badges
      sendUnreadCounts(ws, payload.orgId);
    });
  } catch {
    socket.destroy();
  }
}

export function broadcastToOrg(orgId, payload) {
  const data = JSON.stringify(payload);
  for (const [ws, info] of clients) {
    if (ws.readyState === 1 && info.orgId === orgId) {
      ws.send(data);
    }
  }
}

export function hasActiveClients(orgId) {
  for (const [ws, info] of clients) {
    if (ws.readyState === 1 && info.orgId === orgId) return true;
  }
  return false;
}

function sendUnreadCounts(ws, orgId) {
  const rows = getAll(
    `SELECT m.agent_id, COUNT(*) as count
     FROM messages m
     JOIN agents a ON m.agent_id = a.id
     JOIN conversations c ON m.conversation_id = c.id AND c.agent_id = m.agent_id
     WHERE m.is_read = 0 AND m.role = 'assistant' AND a.org_id = ? AND c.project_id IS NULL
     GROUP BY m.agent_id`,
    [orgId]
  );
  const counts = {};
  for (const row of rows) counts[row.agent_id] = row.count;

  const projectRows = getAll(
    `SELECT c.project_id, COUNT(*) as count
     FROM messages m
     JOIN conversations c ON m.conversation_id = c.id
     JOIN projects p ON c.project_id = p.id
     WHERE m.is_read = 0 AND m.role = 'assistant' AND p.org_id = ? AND c.project_id IS NOT NULL
     GROUP BY c.project_id`,
    [orgId]
  );
  const projectCounts = {};
  for (const row of projectRows) projectCounts[row.project_id] = row.count;

  ws.send(JSON.stringify({ type: 'unread_update', counts, projectCounts }));
}

export function broadcastUnreadCounts(orgId) {
  // Get unread counts for agents in this org.
  // Only count messages in the agent's OWN conversations — @mention responses
  // stored in other agents' conversations should not show as unread for the responder.
  const rows = getAll(
    `SELECT m.agent_id, COUNT(*) as count
     FROM messages m
     JOIN agents a ON m.agent_id = a.id
     JOIN conversations c ON m.conversation_id = c.id AND c.agent_id = m.agent_id
     WHERE m.is_read = 0 AND m.role = 'assistant' AND a.org_id = ? AND c.project_id IS NULL
     GROUP BY m.agent_id`,
    [orgId]
  );
  const counts = {};
  for (const row of rows) {
    counts[row.agent_id] = row.count;
  }

  // Get unread counts for projects in this org
  const projectRows = getAll(
    `SELECT c.project_id, COUNT(*) as count
     FROM messages m
     JOIN conversations c ON m.conversation_id = c.id
     JOIN projects p ON c.project_id = p.id
     WHERE m.is_read = 0 AND m.role = 'assistant' AND p.org_id = ? AND c.project_id IS NOT NULL
     GROUP BY c.project_id`,
    [orgId]
  );
  const projectCounts = {};
  for (const row of projectRows) {
    projectCounts[row.project_id] = row.count;
  }

  broadcastToOrg(orgId, { type: 'unread_update', counts, projectCounts });
}

// Keep old name as alias for backward compat in imports
export const broadcast = broadcastToOrg;
