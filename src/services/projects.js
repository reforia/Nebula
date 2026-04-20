// Project-scoped helpers and business logic extracted from routes/projects.js.
// The route file stays in charge of HTTP concerns (req/res parsing, status
// codes); anything that touches DB state, git providers, or the executor
// belongs here.

import { getOne, getAll, run, orgPath, getOrgSetting } from '../db.js';
import { generateId } from '../utils/uuid.js';
import { decrypt } from '../utils/crypto.js';
import { getGitProvider } from '../services/git-providers.js';
import executor from '../services/executor.js';
import { broadcastToOrg, broadcastUnreadCounts } from '../services/websocket.js';
import { redactSecrets } from '../utils/redact.js';
import { logAsync } from '../utils/async.js';

export function getProject(projectId, orgId) {
  return getOne('SELECT * FROM projects WHERE id = ? AND org_id = ?', [projectId, orgId]);
}

export function repoPath(orgId, projectId) {
  return orgPath(orgId, 'projects', projectId, 'repo.git');
}

// Resolve the git provider client for a project. Prefers the project-scoped
// token (stored encrypted in project_secrets) and falls back to the org-level
// provider token. Callers rely on this being the single authoritative source
// of provider credentials — do not re-derive in route handlers.
export function getProviderForProject(project, orgId) {
  let token;
  if (project.git_token_key) {
    const secretRow = getOne(
      'SELECT value FROM project_secrets WHERE project_id = ? AND key = ?',
      [project.id, project.git_token_key]
    );
    if (secretRow) token = decrypt(secretRow.value);
  }
  if (!token) {
    const providerKey = `${project.git_provider}_api_token`;
    token = getOrgSetting(orgId, providerKey);
  }
  const apiUrl = project.git_api_url || getOrgSetting(orgId, `${project.git_provider}_api_url`);
  return getGitProvider(project, token, { apiUrl: apiUrl || undefined, insecure: !!project.git_insecure_ssl });
}

// Cap recursive mention chains so a loop like `@Alice` → response contains `@Bob`
// → response contains `@Alice` → ... cannot run forever. Three hops matches the
// coordinator-dispatch-follow-up depth we actually design for.
export const MAX_PROJECT_MENTION_DEPTH = 3;

/**
 * Process @mentions in project conversation text.
 * @notify is intentionally NOT supported in projects — all mentions route responses
 * back to the project conversation so the coordinator can synthesize results.
 * Returns a promise that resolves with an array of { agentName, agentEmoji, text } for each
 * dispatched agent, allowing the caller to trigger coordinator follow-up.
 */
export function processProjectMentions(text, excludeAgentId, project, conversation, orgId, depth = 0) {
  if (!text) return Promise.resolve([]);
  if (depth >= MAX_PROJECT_MENTION_DEPTH) {
    console.warn(`[project ${project.id}] mention recursion capped at depth ${depth}`);
    return Promise.resolve([]);
  }

  const mentionRe = /@(\S+)/g;
  const mentions = [...text.matchAll(mentionRe)]
    .map(m => m[1])
    .filter(name => name.toLowerCase() !== 'notify');

  const uniqueMentions = [...new Set(mentions)].slice(0, 3);
  const promises = [];

  for (const mentionedName of uniqueMentions) {
    const mentioned = getOne(
      'SELECT a.* FROM agents a JOIN project_agents pa ON a.id = pa.agent_id WHERE a.name = ? AND a.org_id = ? AND pa.project_id = ? AND a.enabled = 1',
      [mentionedName, orgId, project.id]
    );
    if (!mentioned || mentioned.id === excludeAgentId) continue;

    const mentionedDeliverable = getOne(
      "SELECT branch_name FROM project_deliverables WHERE assigned_agent_id = ? AND branch_name IS NOT NULL AND status IN ('pending', 'in_progress') LIMIT 1",
      [mentioned.id]
    );

    const promise = executor
      .enqueue(mentioned.id, text, {
        priority: true, maxTurns: 50,
        displayConversationId: conversation.id,
        projectId: project.id,
        branchName: mentionedDeliverable?.branch_name || null,
      })
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

        const safeText = redactSecrets(resultText, orgId, mentioned.id);
        run(
          `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, metadata, is_read, created_at)
           VALUES (?, ?, ?, 'assistant', ?, 'chat', ?, 0, datetime('now'))`,
          [msgId, mentioned.id, conversation.id, safeText, metadata]
        );
        run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [conversation.id]);

        const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
        broadcastToOrg(orgId, { type: 'new_message', project_id: project.id, message: msg });
        broadcastUnreadCounts(orgId);

        logAsync(processProjectMentions(safeText, mentioned.id, project, conversation, orgId, depth + 1),
          `project-mention-recurse:${mentioned.name}`);

        return { agentName: mentioned.name, agentEmoji: mentioned.emoji, text: safeText };
      })
      .catch((err) => {
        const msgId = generateId();
        console.error('[project] Agent mention execution failed:', err);
        run(
          `INSERT INTO messages (id, agent_id, conversation_id, role, content, message_type, is_read, created_at)
           VALUES (?, ?, ?, 'assistant', ?, 'error', 0, datetime('now'))`,
          [msgId, mentioned.id, conversation.id, 'Execution failed']
        );
        const msg = getOne('SELECT * FROM messages WHERE id = ?', [msgId]);
        broadcastToOrg(orgId, { type: 'new_message', project_id: project.id, message: msg });
        broadcastUnreadCounts(orgId);

        return { agentName: mentioned.name, agentEmoji: mentioned.emoji, text: 'Execution failed', error: true };
      });

    promises.push(promise);
  }

  return Promise.all(promises);
}
