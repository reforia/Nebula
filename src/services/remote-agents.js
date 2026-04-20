import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getOne, run } from '../db.js';
import { broadcastToOrg } from './websocket.js';
import { generateId } from '../utils/uuid.js';

// Constant-time token comparison. Returns false on type mismatch or length
// mismatch so timing cannot leak either the stored token's length or content.
function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Connected remote clients: agentId -> { ws, pendingRequests, device }
const remoteClients = new Map();

let remoteWss = null;

export function initRemoteWebSocket() {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  remoteWss = wss;

  wss.on('connection', (ws) => {
    let authenticatedAgentId = null;
    let authenticatedOrgId = null;
    let authTimeout = setTimeout(() => {
      ws.close(4001, 'Auth timeout');
    }, 10000);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      // First message must be auth
      if (!authenticatedAgentId) {
        if (msg.type !== 'auth') {
          ws.send(JSON.stringify({ type: 'auth_failed', error: 'First message must be auth' }));
          ws.close(4002, 'No auth');
          return;
        }

        clearTimeout(authTimeout);

        const agent = getOne('SELECT * FROM agents WHERE id = ?', [msg.agent_id]);
        if (!agent || agent.execution_mode !== 'remote' || !agent.remote_token || !safeTokenEqual(agent.remote_token, msg.token)) {
          ws.send(JSON.stringify({ type: 'auth_failed', error: 'Invalid agent ID or token' }));
          ws.close(4003, 'Auth failed');
          return;
        }

        authenticatedAgentId = agent.id;
        authenticatedOrgId = agent.org_id;

        // Disconnect existing client for this agent
        const existing = remoteClients.get(agent.id);
        if (existing) {
          existing.ws.close(4004, 'Replaced by new connection');
          rejectAllPending(agent.id, 'Client reconnected');
        }

        const device = msg.device || {};
        const availableRuntimes = msg.available_runtimes || [];
        remoteClients.set(agent.id, { ws, pendingRequests: new Map(), device, availableRuntimes });
        run(
          "UPDATE agents SET remote_last_seen = datetime('now'), remote_device = ? WHERE id = ?",
          [JSON.stringify(device), agent.id]
        );

        ws.send(JSON.stringify({
          type: 'auth_ok',
          agent: { id: agent.id, name: agent.name, model: agent.model },
        }));

        console.log(`[remote] Agent "${agent.name}" connected from ${device.hostname || 'unknown'} (${device.platform || '?'}/${device.arch || '?'})`);
        broadcastToOrg(authenticatedOrgId, { type: 'remote_agent_status', agent_id: agent.id, connected: true, device });
        return;
      }

      // Authenticated messages
      if (msg.type === 'heartbeat') {
        run("UPDATE agents SET remote_last_seen = datetime('now') WHERE id = ?", [authenticatedAgentId]);
        ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
        return;
      }

      if (msg.type === 'result' && msg.request_id) {
        const client = remoteClients.get(authenticatedAgentId);
        const pending = client?.pendingRequests.get(msg.request_id);
        if (pending) {
          clearTimeout(pending.timer);
          client.pendingRequests.delete(msg.request_id);
          pending.resolve(msg.result);
        }
        return;
      }

      if (msg.type === 'error' && msg.request_id) {
        const client = remoteClients.get(authenticatedAgentId);
        const pending = client?.pendingRequests.get(msg.request_id);
        if (pending) {
          clearTimeout(pending.timer);
          client.pendingRequests.delete(msg.request_id);
          pending.reject(new Error(msg.error || 'Remote execution failed'));
        }
        return;
      }
    });

    ws.on('close', () => {
      if (authenticatedAgentId) {
        rejectAllPending(authenticatedAgentId, 'Remote client disconnected');
        remoteClients.delete(authenticatedAgentId);
        console.log(`[remote] Agent ${authenticatedAgentId} disconnected`);
        if (authenticatedOrgId) {
          broadcastToOrg(authenticatedOrgId, { type: 'remote_agent_status', agent_id: authenticatedAgentId, connected: false });
        }
      }
      clearTimeout(authTimeout);
    });

    ws.on('error', () => {
      ws.close();
    });
  });
}

function rejectAllPending(agentId, reason) {
  const client = remoteClients.get(agentId);
  if (!client) return;
  for (const [, pending] of client.pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  client.pendingRequests.clear();
}

export function handleRemoteUpgrade(req, socket, head) {
  remoteWss.handleUpgrade(req, socket, head, (ws) => {
    remoteWss.emit('connection', ws, req);
  });
}

export function isRemoteConnected(agentId) {
  const client = remoteClients.get(agentId);
  return client?.ws?.readyState === 1;
}

export function getConnectedRemoteAgents() {
  return [...remoteClients.keys()].filter(id => isRemoteConnected(id));
}

export function getRemoteDevice(agentId) {
  return remoteClients.get(agentId)?.device || null;
}

export function getRemoteRuntimes(agentId) {
  return remoteClients.get(agentId)?.availableRuntimes || [];
}

export function cancelRemote(agentId) {
  const client = remoteClients.get(agentId);
  if (!client || client.ws.readyState !== 1) return false;

  // Cancel all pending requests on the server side
  for (const [requestId, pending] of client.pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Cancelled by user'));
  }
  client.pendingRequests.clear();

  // Tell the remote client to kill its running process
  client.ws.send(JSON.stringify({ type: 'cancel' }));
  return true;
}

export function executeRemote(agentId, prompt, systemPrompt, agent, conversation, options) {
  return new Promise((resolve, reject) => {
    const client = remoteClients.get(agentId);
    if (!client || client.ws.readyState !== 1) {
      return reject(new Error('Remote agent is not connected'));
    }

    const runtime = options.runtime || agent.backend || '';
    if (client.availableRuntimes.length > 0 && !client.availableRuntimes.includes(runtime)) {
      return reject(new Error(`Remote agent does not have "${runtime}" installed. Available: ${client.availableRuntimes.join(', ')}. Update the remote client or change the agent's runtime.`));
    }

    const requestId = generateId();
    const timeoutMs = options.timeoutMs || 600000;

    const timer = setTimeout(() => {
      client.pendingRequests.delete(requestId);
      reject(new Error(`Remote execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    client.pendingRequests.set(requestId, { resolve, reject, timer });

    // Encode images as base64 for transfer to remote agent
    const remoteImages = (options.images || []).map(imgPath => ({
      filename: path.basename(imgPath),
      data: fs.readFileSync(imgPath).toString('base64'),
    }));

    client.ws.send(JSON.stringify({
      type: 'execute',
      request_id: requestId,
      prompt,
      system_prompt: systemPrompt,
      session_id: conversation.session_id,
      session_initialized: conversation.session_initialized,
      allowed_tools: agent.allowed_tools,
      model: agent.model,
      runtime: options.runtime || agent.backend || '',
      max_turns: options.maxTurns || 50,
      timeout_ms: timeoutMs,
      images: remoteImages,
      skills: options.skills || [],
      mcp_servers: options.mcpServers || [],
    }));
  });
}
