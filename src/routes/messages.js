import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { getAll, getOne, run, orgPath, getOrgSetting } from '../db.js';
import { generateId } from '../utils/uuid.js';
import executor from '../services/executor.js';
import { broadcastToOrg, broadcastUnreadCounts, hasActiveClients } from '../services/websocket.js';
import { sendNotification } from '../services/email.js';
import { redactSecrets } from '../utils/redact.js';
import { enrichReplyTo } from '../services/message-service.js';

const router = Router();

/**
 * Build recent conversation context string for mentioned agents.
 * @param {string} conversationId
 * @param {object} [opts] - { maxMessages, maxCharsPerMessage }
 */
function buildConversationContext(conversationId, opts = {}) {
  if (!conversationId) return '';
  const maxMessages = opts.maxMessages || 10;
  const maxChars = opts.maxCharsPerMessage || 0; // 0 = no truncation
  const recent = getAll(
    `SELECT role, content, agent_id FROM messages
     WHERE conversation_id = ? AND message_type IN ('chat', 'agent')
     ORDER BY created_at DESC LIMIT ?`,
    [conversationId, maxMessages]
  ).reverse();
  if (recent.length === 0) return '';
  const lines = recent.map(m => {
    const author = m.role === 'user' ? 'User' : (getOne('SELECT name FROM agents WHERE id = ?', [m.agent_id])?.name || 'Agent');
    const content = maxChars > 0 ? m.content.slice(0, maxChars) : m.content;
    return `[${author}]: ${content}`;
  });
  return `\n\n--- Recent conversation context ---\n${lines.join('\n')}\n--- End context ---\n`;
}

/** Resolve mention context settings: mentioned agent override > org setting > defaults */
function resolveMentionContext(mentionedAgent, orgId) {
  return {
    maxMessages: mentionedAgent.mention_context_messages
      || parseInt(getOrgSetting(orgId, 'mention_context_messages')) || 10,
    maxCharsPerMessage: mentionedAgent.mention_context_chars
      || parseInt(getOrgSetting(orgId, 'mention_context_chars')) || 0,
  };
}

/**
 * Process @mentions and @notify in text, routing to the appropriate agents.
 *
 * @AgentName — pull agent into the current conversation (responds here)
 * @notify AgentName message — push a task to agent's own conversation (fire-and-forget)
 *
 * Works for both user messages and agent responses.
 */
function processAgentMentions(text, sourceAgentId, conversationId, orgId, notifyOnly = false) {
  if (!text) return;

  // @notify AgentName — push to agent's own conversation
  const notifyPattern = /@notify\s+(\S+)/gi;
  const notifies = [...text.matchAll(notifyPattern)].map(m => m[1]);
  if (notifies.length > 0) console.log(`[@notify] Detected notifications to: ${notifies.join(', ')}`);

  for (const notifyName of [...new Set(notifies)]) {
    const target = getOne(
      'SELECT * FROM agents WHERE name = ? AND org_id = ? AND id != ? AND enabled = 1',
      [notifyName, orgId, sourceAgentId]
    );
    if (!target) {
      console.log(`[@notify] Agent "${notifyName}" not found in org ${orgId} (source: ${sourceAgentId})`);
      continue;
    }

    const sourceAgent = getOne('SELECT name, emoji FROM agents WHERE id = ?', [sourceAgentId]);
    const prompt = `[Notification from ${sourceAgent?.emoji || ''} ${sourceAgent?.name || 'unknown'}]\n\n${text}`;

    // Execute in target's OWN conversation (exclude project conversations)
    const targetConv = getOne(
      'SELECT id FROM conversations WHERE agent_id = ? AND project_id IS NULL ORDER BY created_at DESC LIMIT 1',
      [target.id]
    );
    if (!targetConv) {
      console.log(`[@notify] No conversation found for target agent "${target.name}" (${target.id})`);
      continue;
    }

    console.log(`[@notify] Sending notification to "${target.name}" (${target.id}, mode: ${target.execution_mode}) from "${sourceAgent?.name}"`);


    // Store the notification as a user message in the target's conversation
    const notifyMsgId = generateId();
    const notifyMeta = JSON.stringify({ from_agent_id: sourceAgentId, from_agent_name: sourceAgent?.name, from_agent_emoji: sourceAgent?.emoji });
    run(
      `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, metadata, is_read, created_at)
       VALUES (?, ?, ?, 'user', ?, 'agent', ?, 0, datetime('now'))`,
      [notifyMsgId, target.id, targetConv.id, prompt, notifyMeta]
    );
    run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [targetConv.id]);
    const notifyMsg = getOne('SELECT * FROM messages WHERE id = ?', [notifyMsgId]);
    broadcastToOrg(orgId, { type: 'new_message', agent_id: target.id, message: notifyMsg });
    broadcastUnreadCounts(orgId);

    executor
      .enqueue(target.id, prompt, { priority: false, maxTurns: 50, conversationId: targetConv.id })
      .then((result) => {
        console.log(`[@notify] "${target.name}" completed (${result.duration_ms}ms)`);

        const msgId = generateId();
        let resultText = result.result || '';
        if (!resultText.trim()) resultText = '*Agent completed execution with no text response.*';
        const metadata = JSON.stringify({ duration_ms: result.duration_ms, total_cost_usd: result.total_cost_usd, usage: result.usage, ...(result.tool_history?.length > 0 && { tool_history: result.tool_history }) });

        run(
          `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, metadata, is_read, created_at)
           VALUES (?, ?, ?, 'assistant', ?, 'chat', ?, 0, datetime('now'))`,
          [msgId, target.id, targetConv.id, resultText, metadata]
        );
        run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [targetConv.id]);
        const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
        broadcastToOrg(orgId, { type: 'new_message', agent_id: target.id, message: msg });
        broadcastUnreadCounts(orgId);
      })
      .catch((err) => {
        console.error(`[@notify] Execution failed for "${target.name}":`, err.message);
        const errMsgId = generateId();
        run(
          `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
           VALUES (?, ?, ?, 'assistant', ?, 'error', 0, datetime('now'))`,
          [errMsgId, target.id, targetConv.id, `@notify failed: ${err.message}`]
        );
        const errMsg = getOne('SELECT * FROM messages WHERE id = ?', [errMsgId]);
        broadcastToOrg(orgId, { type: 'new_message', agent_id: target.id, message: errMsg });
        broadcastUnreadCounts(orgId);
      });
  }

  // If notifyOnly, skip @AgentName handling (caller handles it with wait-for-response)
  if (notifyOnly) return;

  // @AgentName — pull into current conversation (responds here)
  const mentionPattern = /@(\S+)/g;
  const mentions = [...text.matchAll(mentionPattern)]
    .map(m => m[1])
    .filter(name => name !== 'notify') // skip @notify (handled above)
    .filter(name => !notifies.includes(name)); // skip names already handled by @notify

  const sourceAgent = getOne('SELECT name, emoji FROM agents WHERE id = ?', [sourceAgentId]);
  const uniqueMentions = [...new Set(mentions)];

  for (const mentionedName of uniqueMentions) {
    const mentioned = getOne(
      'SELECT * FROM agents WHERE name = ? AND org_id = ? AND id != ? AND enabled = 1',
      [mentionedName, orgId, sourceAgentId]
    );
    if (!mentioned) continue;

    // Build conversation context per mentioned agent (settings may differ per agent)
    const ctxOpts = resolveMentionContext(mentioned, orgId);
    const conversationContext = conversationId ? buildConversationContext(conversationId, ctxOpts) : '';

    const prompt = sourceAgent
      ? `[You were pulled into a conversation by ${sourceAgent.emoji} ${sourceAgent.name}]${conversationContext}\n\nLatest message:\n${text}`
      : text;

    // Execute in target's session, respond in CURRENT conversation (exclude project conversations)
    const targetConv = getOne(
      'SELECT id FROM conversations WHERE agent_id = ? AND project_id IS NULL ORDER BY created_at DESC LIMIT 1',
      [mentioned.id]
    );

    executor
      .enqueue(mentioned.id, prompt, {
        priority: true, maxTurns: 50,
        conversationId: targetConv?.id || conversationId,
        displayConversationId: conversationId,
      })
      .then((result) => {
        const msgId = generateId();
        let resultText = result.result || '';
        if (!resultText.trim()) resultText = '*Agent completed execution with no text response.*';
        const metadata = JSON.stringify({ duration_ms: result.duration_ms, total_cost_usd: result.total_cost_usd, usage: result.usage, ...(result.tool_history?.length > 0 && { tool_history: result.tool_history }) });

        run(
          `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, metadata, is_read, created_at)
           VALUES (?, ?, ?, 'assistant', ?, 'chat', ?, 0, datetime('now'))`,
          [msgId, mentioned.id, conversationId, resultText, metadata]
        );
        if (conversationId) run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [conversationId]);
        const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
        const convOwner = getOne('SELECT agent_id FROM conversations WHERE id = ?', [conversationId]);
        broadcastToOrg(orgId, { type: 'new_message', agent_id: mentioned.id, message: msg, conversation_owner: convOwner?.agent_id });
        broadcastUnreadCounts(orgId);
      })
      .catch((err) => {
        const msgId = generateId();
        run(
          `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
           VALUES (?, ?, ?, 'assistant', ?, 'error', 0, datetime('now'))`,
          [msgId, mentioned.id, conversationId, `Error: ${err.message}`]
        );
        const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
        const convOwner = getOne('SELECT agent_id FROM conversations WHERE id = ?', [conversationId]);
        broadcastToOrg(orgId, { type: 'new_message', agent_id: mentioned.id, message: msg, conversation_owner: convOwner?.agent_id });
        broadcastUnreadCounts(orgId);
      });
  }
}

// GET /api/agents/search/messages — global message search across org
router.get('/search/messages', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const pattern = `%${q}%`;

  const results = getAll(
    `SELECT m.id, m.content, m.role, m.created_at, m.conversation_id, m.agent_id, m.message_type,
            a.name AS agent_name, a.emoji AS agent_emoji,
            c.title AS conversation_title,
            c.project_id,
            p.name AS project_name
     FROM messages m
     JOIN agents a ON a.id = m.agent_id AND a.org_id = ?
     LEFT JOIN conversations c ON c.id = m.conversation_id
     LEFT JOIN projects p ON p.id = c.project_id
     WHERE m.content LIKE ? AND m.message_type IN ('chat', 'agent')
     ORDER BY m.created_at DESC
     LIMIT ?`,
    [req.orgId, pattern, limit]
  );

  // Return snippet around match
  const lcq = q.toLowerCase();
  res.json(results.map(r => {
    const idx = r.content.toLowerCase().indexOf(lcq);
    const start = Math.max(0, idx - 40);
    const end = Math.min(r.content.length, idx + q.length + 80);
    const snippet = (start > 0 ? '...' : '') + r.content.slice(start, end) + (end < r.content.length ? '...' : '');
    return {
      id: r.id,
      snippet,
      role: r.role,
      created_at: r.created_at,
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      agent_emoji: r.agent_emoji,
      conversation_id: r.conversation_id,
      conversation_title: r.conversation_title,
      project_id: r.project_id,
      project_name: r.project_name,
    };
  }));
});

// GET /api/agents/:id/messages — paginated, optionally filtered by conversation
router.get('/:id/messages', (req, res) => {
  const agent = getOne('SELECT id, org_id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = req.query.before;
  const conversationId = req.query.conversation_id;

  let messages;
  if (conversationId) {
    // Load ALL messages in this conversation — includes responses from
    // other agents pulled in via @AgentName, not just the conversation owner
    if (before) {
      messages = getAll(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND created_at < (SELECT created_at FROM messages WHERE id = ?)
         ORDER BY created_at DESC LIMIT ?`,
        [conversationId, before, limit]
      );
    } else {
      messages = getAll(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
        [conversationId, limit]
      );
    }
  } else {
    // Fallback: load messages for the agent, excluding @mention responses
    // stored in other agents' conversations.
    if (before) {
      messages = getAll(
        `SELECT m.* FROM messages m
         LEFT JOIN conversations c ON m.conversation_id = c.id
         WHERE m.agent_id = ? AND (c.agent_id = ? OR m.conversation_id IS NULL)
           AND m.created_at < (SELECT created_at FROM messages WHERE id = ?)
         ORDER BY m.created_at DESC LIMIT ?`,
        [req.params.id, req.params.id, before, limit]
      );
    } else {
      messages = getAll(
        `SELECT m.* FROM messages m
         LEFT JOIN conversations c ON m.conversation_id = c.id
         WHERE m.agent_id = ? AND (c.agent_id = ? OR m.conversation_id IS NULL)
         ORDER BY m.created_at DESC LIMIT ?`,
        [req.params.id, req.params.id, limit]
      );
    }
  }

  messages.reverse();
  enrichReplyTo(messages);
  res.json(messages);
});

// POST /api/agents/:id/messages — send message
router.post('/:id/messages', async (req, res) => {
  const agent = getOne('SELECT * FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (!agent.enabled) return res.status(400).json({ error: 'Agent is disabled' });

  const { content, conversation_id, from_agent_id, image_ids, reply_to_id } = req.body;
  if ((!content || !content.trim()) && (!image_ids || image_ids.length === 0)) {
    return res.status(400).json({ error: 'Message content or images required' });
  }

  // Resolve image paths from uploaded IDs
  const images = [];
  const imagesMeta = [];
  if (image_ids && Array.isArray(image_ids)) {
    const uploadsDir = orgPath(req.orgId, 'agents', req.params.id, 'uploads');
    for (const imgId of image_ids.slice(0, 5)) {
      const files = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
      const match = files.find(f => f.startsWith(imgId));
      if (match) {
        images.push(path.join(uploadsDir, match));
        imagesMeta.push({ id: imgId, filename: match });
      }
    }
  }

  // Detect inter-agent messages (sent via internal API token)
  const isAgentToAgent = req.user?.id === '__internal__';
  let sourceAgent = null;
  if (isAgentToAgent && from_agent_id) {
    sourceAgent = getOne('SELECT name, emoji FROM agents WHERE id = ? AND org_id = ?', [from_agent_id, req.orgId]);
  }

  // Build the prompt — prefix with source agent context for inter-agent messages
  const rawContent = content.trim();

  // If replying to a message, prepend truncated quote for agent context
  let replyPrefix = '';
  if (reply_to_id) {
    const quoted = getOne('SELECT content, role, agent_id FROM messages WHERE id = ?', [reply_to_id]);
    if (quoted) {
      const quotedContent = (quoted.content || '').slice(0, 300);
      replyPrefix = `[In reply to: "${quotedContent}${quoted.content?.length > 300 ? '...' : ''}"]\n\n`;
    }
  }

  const executorPrompt = sourceAgent
    ? `[Inter-agent message from ${sourceAgent.emoji} ${sourceAgent.name}]\n\n${replyPrefix}${rawContent}`
    : `${replyPrefix}${rawContent}`;

  // For inter-agent messages: display in source conversation, execute in target agent's own conversation
  // For user messages: same conversation for both
  let displayConversationId = conversation_id;
  if (!displayConversationId) {
    const latest = getOne(
      'SELECT id FROM conversations WHERE agent_id = ? AND project_id IS NULL ORDER BY created_at DESC LIMIT 1',
      [agent.id]
    );
    displayConversationId = latest?.id || null;
  }

  // Execution conversation is always the target agent's own (has the right CLI session)
  let execConversationId = displayConversationId;
  if (isAgentToAgent && conversation_id) {
    // Source conversation belongs to another agent — use target's own conversation for execution (exclude project conversations)
    const targetConv = getOne(
      'SELECT id FROM conversations WHERE agent_id = ? AND project_id IS NULL ORDER BY created_at DESC LIMIT 1',
      [agent.id]
    );
    execConversationId = targetConv?.id || displayConversationId;
  }

  // Store the message in the display conversation
  const userMsgId = generateId();
  const msgType = sourceAgent ? 'agent' : 'chat';
  const metaObj = {};
  if (sourceAgent) { metaObj.from_agent_id = from_agent_id; metaObj.from_agent_name = sourceAgent.name; metaObj.from_agent_emoji = sourceAgent.emoji; }
  if (imagesMeta.length > 0) { metaObj.images = imagesMeta; }
  const msgMeta = Object.keys(metaObj).length > 0 ? JSON.stringify(metaObj) : null;
  run(
    `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, metadata, reply_to_id, is_read, created_at)
     VALUES (?, ?, ?, 'user', ?, ?, ?, ?, 1, datetime('now'))`,
    [userMsgId, agent.id, displayConversationId, rawContent, msgType, msgMeta, reply_to_id || null]
  );

  if (displayConversationId) {
    run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [displayConversationId]);
  }

  const userMsg = getOne('SELECT * FROM messages WHERE id = ?', [userMsgId]);
  enrichReplyTo([userMsg]);
  broadcastToOrg(req.orgId, { type: 'new_message', agent_id: agent.id, message: userMsg });

  res.status(201).json(userMsg);

  const orgId = req.orgId;

  // Check for @mentions in user message — if present, execute mentioned agents FIRST,
  // wait for their responses, then execute the primary agent with that context
  const mentionRe = /@(\S+)/g;
  const userMentions = [...rawContent.matchAll(mentionRe)]
    .map(m => m[1])
    .filter(name => name !== 'notify' && name !== agent.name);
  const uniqueUserMentions = [...new Set(userMentions)];

  // Resolve which mentions are valid agents
  const mentionedAgents = uniqueUserMentions
    .map(name => getOne('SELECT * FROM agents WHERE name = ? AND org_id = ? AND id != ? AND enabled = 1', [name, orgId, agent.id]))
    .filter(Boolean);

  // Fire @notify (fire-and-forget, doesn't block primary agent)
  processAgentMentions(rawContent, agent.id, displayConversationId, orgId, true); // notifyOnly=true

  // Execute flow: mentioned agents first, then primary agent
  const executePrimaryAgent = (mentionContext = '') => {
    const enrichedPrompt = mentionContext
      ? `${executorPrompt}\n\n--- Responses from mentioned agents ---\n${mentionContext}\n--- End responses ---`
      : executorPrompt;

    executor
      .enqueue(agent.id, enrichedPrompt, { priority: true, maxTurns: 50, conversationId: execConversationId, displayConversationId, images })
      .then((result) => {
        const msgId = generateId();
        let resultText = result.result || '';
        if (!resultText.trim()) {
          resultText = result.subtype === 'error_max_turns'
            ? '*Agent reached the maximum number of turns without producing a final response.*'
            : '*Agent completed execution but produced no text response.*';
        }
        const metadata = JSON.stringify({
          duration_ms: result.duration_ms, total_cost_usd: result.total_cost_usd,
          usage: result.usage, subtype: result.subtype,
          ...(result.tool_history?.length > 0 && { tool_history: result.tool_history }),
        });

        const safeText = redactSecrets(resultText, orgId, agent.id);
        run(
          `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, metadata, is_read, created_at)
           VALUES (?, ?, ?, 'assistant', ?, 'chat', ?, 0, datetime('now'))`,
          [msgId, agent.id, displayConversationId, safeText, metadata]
        );
        if (displayConversationId) {
          run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [displayConversationId]);
          // Auto-title: if conversation still has default title, set it from the user's first message
          const conv = getOne('SELECT title FROM conversations WHERE id = ?', [displayConversationId]);
          if (conv && (conv.title === 'New conversation' || conv.title === 'General')) {
            const firstUserMsg = getOne(
              "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND message_type = 'chat' ORDER BY created_at ASC LIMIT 1",
              [displayConversationId]
            );
            if (firstUserMsg) {
              const autoTitle = firstUserMsg.content.slice(0, 60).replace(/\n/g, ' ').trim() + (firstUserMsg.content.length > 60 ? '...' : '');
              run('UPDATE conversations SET title = ? WHERE id = ?', [autoTitle, displayConversationId]);
            }
          }
        }

        const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
        broadcastToOrg(orgId, { type: 'new_message', agent_id: agent.id, message: msg });
        broadcastUnreadCounts(orgId);

        if (agent.notify_email && !hasActiveClients(orgId)) {
          sendNotification(orgId, `${agent.name} responded`, `Agent "${agent.name}" replied:\n\n${(safeText).slice(0, 500)}`);
        }

        // Scan agent response for @mentions — route to other agents
        processAgentMentions(safeText, agent.id, displayConversationId, orgId);
      })
      .catch((err) => {
        const msgId = generateId();
        run(
          `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
           VALUES (?, ?, ?, 'assistant', ?, 'error', 0, datetime('now'))`,
          [msgId, agent.id, displayConversationId, `Error: ${err.message}`]
        );
        const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
        broadcastToOrg(orgId, { type: 'new_message', agent_id: agent.id, message: msg });
        broadcastToOrg(orgId, { type: 'agent_error', agent_id: agent.id, error: err.message });
        // Surface auth errors as a dedicated event so the UI can show a persistent banner
        if (/auth expired/i.test(err.message)) {
          const runtime = err.message.match(/^(\S+\s+\S+)/)?.[0] || 'CLI runtime';
          broadcastToOrg(orgId, { type: 'runtime_auth_error', runtime, message: err.message });
        }
        broadcastUnreadCounts(orgId);
      });
  };

  if (mentionedAgents.length > 0) {
    // Execute mentioned agents first, collect responses, then run primary agent
    const mentionPromises = mentionedAgents.map(mentioned => {
      const ctxOpts = resolveMentionContext(mentioned, orgId);
      const convContext = buildConversationContext(displayConversationId, ctxOpts);

      const mentionPrompt = `[You were pulled into a conversation by ${agent.emoji} ${agent.name}]${convContext}\n\nLatest message:\n${rawContent}`;

      const targetConv = getOne('SELECT id FROM conversations WHERE agent_id = ? AND project_id IS NULL ORDER BY created_at DESC LIMIT 1', [mentioned.id]);

      return executor
        .enqueue(mentioned.id, mentionPrompt, {
          priority: true, maxTurns: 50,
          conversationId: targetConv?.id || displayConversationId,
          displayConversationId,
        })
        .then((result) => {
          let resultText = result.result || '*No text response.*';
          const safeText = redactSecrets(resultText, orgId, mentioned.id);
          const metadata = JSON.stringify({ duration_ms: result.duration_ms, total_cost_usd: result.total_cost_usd, usage: result.usage, ...(result.tool_history?.length > 0 && { tool_history: result.tool_history }) });

          // Store mentioned agent's response in the display conversation
          const msgId = generateId();
          run(
            `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, metadata, is_read, created_at)
             VALUES (?, ?, ?, 'assistant', ?, 'chat', ?, 0, datetime('now'))`,
            [msgId, mentioned.id, displayConversationId, safeText, metadata]
          );
          if (displayConversationId) run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [displayConversationId]);
          const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
          const convOwner = getOne('SELECT agent_id FROM conversations WHERE id = ?', [displayConversationId]);
          broadcastToOrg(orgId, { type: 'new_message', agent_id: mentioned.id, message: msg, conversation_owner: convOwner?.agent_id });
          broadcastUnreadCounts(orgId);

          return `[${mentioned.emoji} ${mentioned.name}]: ${safeText}`;
        })
        .catch((err) => {
          const msgId = generateId();
          run(
            `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
             VALUES (?, ?, ?, 'assistant', ?, 'error', 0, datetime('now'))`,
            [msgId, mentioned.id, displayConversationId, `Error: ${err.message}`]
          );
          const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
          broadcastToOrg(orgId, { type: 'new_message', agent_id: mentioned.id, message: msg });
          broadcastUnreadCounts(orgId);
          return `[${mentioned.name}]: (error: ${err.message})`;
        });
    });

    // Wait for all mentioned agents, then execute primary agent with their responses
    Promise.all(mentionPromises).then(responses => {
      executePrimaryAgent(responses.join('\n\n'));
    });
  } else {
    // No mentions — execute primary agent immediately
    executePrimaryAgent();
  }
});

// POST /api/agents/:id/cancel — cancel running execution
router.post('/:id/cancel', (req, res) => {
  const agent = getOne('SELECT id, org_id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const cancelled = executor.cancel(req.params.id);
  res.json({ ok: true, cancelled });
});

// PUT /api/agents/:id/read — mark all as read
router.put('/:id/read', (req, res) => {
  const agent = getOne('SELECT id, org_id FROM agents WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const conversationId = req.query.conversation_id;
  if (conversationId) {
    run(
      'UPDATE messages SET is_read = 1 WHERE agent_id = ? AND conversation_id = ? AND is_read = 0',
      [req.params.id, conversationId]
    );
  } else {
    run(
      'UPDATE messages SET is_read = 1 WHERE agent_id = ? AND is_read = 0',
      [req.params.id]
    );
  }
  broadcastUnreadCounts(req.orgId);
  res.json({ ok: true });
});

export default router;
