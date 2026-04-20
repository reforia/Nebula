import { getOne, run, orgPath } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { registry } from '../backends/index.js';
import fs from 'fs';
import path from 'path';

const WELCOME_MESSAGE = `Welcome! This agent needs some initial setup before it can work effectively.\n\nPlease provide:\n1. **Role** — What is this agent's primary responsibility? (set in agent settings)\n2. **Access** — What tools, APIs, or repos will it need?\n3. **Context** — Any domain knowledge or guidelines it should follow?\n\nOnce you share this, the agent will set up its working environment — guidelines, org profile, and memory.`;

export function createAgent(orgId, agentDef) {
  const agentId = agentDef.id || generateId();
  const sessionId = generateId();

  const columns = ['id', 'org_id', 'name', 'role', 'session_id', 'allowed_tools', 'model', 'backend'];
  const values = [
    agentId, orgId,
    String(agentDef.name || '').slice(0, 100),
    String(agentDef.role || '').slice(0, 2000),
    sessionId,
    agentDef.allowed_tools || 'Read,Grep,Glob,WebFetch,Bash',
    agentDef.model || 'claude-sonnet-4-6',
    agentDef.backend || registry.getDefault(orgId)?.cliId || '',
  ];

  const optional = {
    emoji: agentDef.emoji,
    timeout_ms: agentDef.timeout_ms,
    execution_mode: agentDef.execution_mode,
    security_tier: agentDef.security_tier,
    notify_email: agentDef.notify_email,
  };

  for (const [key, val] of Object.entries(optional)) {
    if (val !== undefined && val !== null) {
      columns.push(key);
      if (['notify_email'].includes(key)) {
        values.push(val ? 1 : 0);
      } else {
        values.push(val);
      }
    }
  }

  const placeholders = columns.map(() => '?').join(', ');
  run(`INSERT INTO agents (${columns.join(', ')}) VALUES (${placeholders})`, values);

  const convId = generateId();
  run(
    `INSERT INTO conversations (id, agent_id, title, session_id, session_initialized)
     VALUES (?, ?, 'General', ?, 0)`,
    [convId, agentId, sessionId]
  );

  if (agentDef.skip_welcome !== true) {
    const welcomeMsgId = generateId();
    run(
      `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
       VALUES (?, ?, ?, 'system', ?, 'system', 1, datetime('now'))`,
      [welcomeMsgId, agentId, convId, WELCOME_MESSAGE]
    );
  }

  const agentDir = orgPath(orgId, 'agents', agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'workspace'), { recursive: true });

  return { agentId, sessionId, convId };
}
