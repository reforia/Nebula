import { getOne, run } from '../db.js';
import executor from './executor.js';
import { generateId } from '../utils/uuid.js';
import { broadcastToOrg } from './websocket.js';
import { sendNotification } from './email.js';
import { redactSecrets } from '../utils/redact.js';
import { insertMessage, resolveConversation } from './message-service.js';

/**
 * Execute a task (cron or webhook). Handles the full lifecycle:
 * resolve conversation, insert prompt message, enqueue execution,
 * save result/error, update task status, broadcast, notify.
 *
 * Tasks run in the agent's main conversation (or project conversation),
 * resuming the existing CC CLI session so the agent has full context.
 *
 * @param {Object} task - Task row from DB
 * @param {Object} agent - Agent row from DB
 * @param {string} prompt - The prompt to send (task.prompt or webhook-enriched prompt)
 * @param {Object} [opts]
 * @param {string} [opts.source='scheduler'] - For logging ('scheduler' or 'webhook')
 */
export async function executeTask(task, agent, prompt, opts = {}) {
  const { source = 'scheduler' } = opts;
  const orgId = agent.org_id;
  const isProjectTask = !!task.project_id;

  console.log(`[${source}] Firing task "${task.name}" for agent "${agent.name}"${isProjectTask ? ` (project ${task.project_id})` : ''}`);

  // Resolve the agent's conversation (main or project-scoped).
  // The executor will create one if none exists yet.
  const { conversationId, broadcastExtra } = resolveConversation(agent.id, task.project_id);

  broadcastToOrg(orgId, { type: 'task_fired', agent_id: agent.id, task_name: task.name, ...broadcastExtra });

  // Insert prompt into the conversation
  if (conversationId) {
    insertMessage({
      agentId: agent.id, conversationId, role: 'user', content: prompt, orgId,
      messageType: 'task', taskName: task.name, isRead: true,
      broadcastExtra, updateUnread: false,
    });
  }

  // Build executor options
  const execOptions = {
    maxTurns: task.max_turns,
    priority: false,
    ...(conversationId && { conversationId }),
    ...(task.timeout_ms && { timeoutMs: task.timeout_ms }),
  };
  if (isProjectTask) {
    execOptions.projectId = task.project_id;
    // Project timeout overrides task timeout if set
    const project = getOne('SELECT timeout_ms FROM projects WHERE id = ?', [task.project_id]);
    if (project?.timeout_ms) execOptions.timeoutMs = project.timeout_ms;
    const deliverable = getOne(
      "SELECT branch_name FROM project_deliverables WHERE assigned_agent_id = ? AND branch_name IS NOT NULL AND status IN ('pending', 'in_progress') LIMIT 1",
      [agent.id]
    );
    execOptions.branchName = deliverable?.branch_name || null;
  }

  try {
    const result = await executor.enqueue(agent.id, prompt, execOptions);

    let resultText = result.result || '';
    if (!resultText.trim()) {
      resultText = result.subtype === 'error_max_turns'
        ? '*Agent reached the maximum number of turns without producing a final response. Consider increasing max turns for this task.*'
        : '*Agent completed execution but produced no text response. All work was done through tool use (file operations, commands, etc.).*';
    }

    const metadata = JSON.stringify({
      duration_ms: result.duration_ms,
      total_cost_usd: result.total_cost_usd,
      usage: result.usage,
      subtype: result.subtype,
      ...(result.tool_history?.length > 0 && { tool_history: result.tool_history }),
    });

    const safeText = redactSecrets(resultText, orgId, agent.id);

    // Use the conversation the executor actually ran in (it may have created one)
    const resultConvId = conversationId || resolveConversation(agent.id, task.project_id).conversationId;
    if (resultConvId) {
      insertMessage({
        agentId: agent.id, conversationId: resultConvId, role: 'assistant', content: safeText, orgId,
        messageType: 'task', taskName: task.name, metadata,
        broadcastExtra,
      });
    }

    run("UPDATE tasks SET last_run_at = datetime('now'), last_status = 'success' WHERE id = ?", [task.id]);

    if (agent.notify_email) {
      sendNotification(
        orgId,
        `Task "${task.name}" completed`,
        `Agent "${agent.name}" completed task "${task.name}":\n\n${safeText.slice(0, 500)}`
      );
    }
  } catch (err) {
    console.error(`[${source}] Task "${task.name}" for agent "${agent.name}" failed:`, err.message);

    const errorConvId = conversationId || resolveConversation(agent.id, task.project_id).conversationId;
    if (errorConvId) {
      insertMessage({
        agentId: agent.id, conversationId: errorConvId, role: 'assistant',
        content: `Task failed: ${err.message}`, orgId,
        messageType: 'error', taskName: task.name,
        broadcastExtra,
      });
    }

    run("UPDATE tasks SET last_run_at = datetime('now'), last_status = 'error' WHERE id = ?", [task.id]);

    broadcastToOrg(orgId, { type: 'agent_error', agent_id: agent.id, error: err.message });
  }
}
