import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { EventEmitter } from 'events';
import { generateId } from '../utils/uuid.js';
import { getOne, getAll, run, getOrgSetting, orgPath } from '../db.js';
import { decrypt } from '../utils/crypto.js';
import { isRemoteConnected, executeRemote, cancelRemote } from './remote-agents.js';
import { registry } from '../backends/index.js';
import { generateIntegrationSkills } from './integrations.js';
import { CODING_CONVENTIONS_SKILL, intelligenceScanSkill } from './builtin-skills.js';
import { evaluateReadiness } from './readiness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = (process.env.NEBULA_URL || 'http://localhost:8080').replace(/\/+$/, '');

class AgentExecutor extends EventEmitter {
  constructor() {
    super();
    this.queues = new Map();          // contextKey -> Array<{resolve, reject, job}>
    this.activeKeys = new Set();      // Set<contextKey>
    this.abortControllers = new Map(); // contextKey -> AbortController
    this.typingState = new Map();     // contextKey -> { agentId, orgId, conversationId, projectId, branchName }
    this.processing = false;
  }

  getTypingAgents(orgId) {
    const result = [];
    for (const info of this.typingState.values()) {
      if (info.orgId === orgId) result.push(info);
    }
    return result;
  }

  /**
   * Build a context-recovery preamble from Nebula message history.
   * Used when a CLI session resets (branch change, stale session, etc.)
   * so the agent doesn't lose all conversational context.
   * Approximates tokens at ~4 chars/token, returns empty string if no history.
   */
  _buildContextRecovery(conversationId, tokenBudget = 25000) {
    const charBudget = tokenBudget * 4;
    const messages = getAll(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC',
      [conversationId]
    );

    // Take recent messages until we hit the budget
    // Error messages are included for context but don't count toward the budget
    const selected = [];
    let charCount = 0;
    const isError = (m) => m.role === 'assistant' && m.content.startsWith('Error:');
    for (const msg of messages) {
      if (!msg.content) continue;
      if (!isError(msg) && charCount + msg.content.length > charBudget) break;
      selected.unshift(msg); // restore chronological order
      if (!isError(msg)) charCount += msg.content.length;
    }

    if (selected.length === 0) return '';

    const history = selected.map(m => {
      const label = m.role === 'user' ? 'User' : 'Assistant';
      return `${label}: ${m.content}`;
    }).join('\n\n');

    return `[SESSION RECOVERY — Your previous session was lost due to an internal reset. The conversation history below is reconstructed from saved messages and may be incomplete. This is the last traceable context available. Review it to understand what was discussed and what work was in progress. If there are gaps or ambiguity, check relevant files, git history, and working directory state to fill in the missing context. Ask the user to clarify anything you cannot determine on your own.]\n\n${history}\n\n[End of recovered context — now respond to the new message below]\n\n`;
  }

  _contextKey(agentId, projectId, branchName) {
    return `${agentId}:${projectId || 'global'}:${branchName || '_'}`;
  }

  cancel(agentId, projectId = null, branchName = null) {
    let cancelled = false;

    // Forward cancel to remote agent if connected
    const agent = getOne('SELECT execution_mode FROM agents WHERE id = ?', [agentId]);
    if (agent?.execution_mode === 'remote' && isRemoteConnected(agentId)) {
      cancelled = cancelRemote(agentId);
    }

    if (projectId && branchName) {
      // Cancel specific context
      const key = this._contextKey(agentId, projectId, branchName);
      const controller = this.abortControllers.get(key);
      if (controller) {
        controller.abort();
        cancelled = true;
      }
      // Drain queued jobs for this key
      const queue = this.queues.get(key);
      if (queue) {
        while (queue.length > 0) {
          const { reject } = queue.shift();
          reject(new Error('Execution cancelled'));
        }
        this.queues.delete(key);
      }
    } else {
      // Cancel matching contexts via prefix
      const prefix = projectId
        ? `${agentId}:${projectId}:`     // all branches in project
        : `${agentId}:`;                 // all contexts for agent

      for (const [key, controller] of this.abortControllers) {
        if (key.startsWith(prefix)) {
          controller.abort();
          cancelled = true;
        }
      }
      // Drain queued jobs for matching keys
      for (const [key, queue] of this.queues) {
        if (key.startsWith(prefix)) {
          while (queue.length > 0) {
            const { reject } = queue.shift();
            reject(new Error('Execution cancelled'));
          }
          this.queues.delete(key);
        }
      }
    }

    return cancelled;
  }

  enqueue(agentId, prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const key = this._contextKey(agentId, options.projectId, options.branchName);

      if (!this.queues.has(key)) {
        this.queues.set(key, []);
      }
      const queue = this.queues.get(key);
      const job = { agentId, prompt, options };

      if (options.priority) {
        queue.unshift({ resolve, reject, job });
      } else {
        queue.push({ resolve, reject, job });
      }

      this._processQueues();
    });
  }

  _processQueues() {
    if (this.processing) return;
    this.processing = true;

    try {
      for (const [key, queue] of this.queues) {
        if (this.activeKeys.has(key)) continue;
        if (queue.length === 0) continue;

        // Peek at the job to check concurrency cap
        const { options } = queue[0].job;
        const { projectId, maxConcurrent } = options;

        // Enforce per-agent concurrency cap within a project
        if (projectId && maxConcurrent != null && maxConcurrent < Infinity) {
          const agentId = queue[0].job.agentId;
          const prefix = `${agentId}:${projectId}:`;
          let activeCount = 0;
          for (const activeKey of this.activeKeys) {
            if (activeKey.startsWith(prefix)) activeCount++;
          }
          if (activeCount >= maxConcurrent) continue;
        }

        const { resolve, reject, job } = queue.shift();
        this.activeKeys.add(key);

        this._execute(job)
          .then(resolve)
          .catch(reject)
          .finally(() => {
            this.activeKeys.delete(key);
            this._processQueues();
          });
      }

      for (const [key, queue] of this.queues) {
        if (queue.length === 0) this.queues.delete(key);
      }
    } finally {
      this.processing = false;
    }
  }

  async _execute({ agentId, prompt, options }) {
    const agent = getOne('SELECT * FROM agents WHERE id = ?', [agentId]);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (!agent.enabled) throw new Error(`Agent ${agentId} is disabled`);

    const agentOrgId = agent.org_id;
    const contextKey = this._contextKey(agentId, options.projectId, options.branchName);

    // Resolve runtime via registry — handles agent override, org default, model compat fallback
    const backend = registry.resolveForAgent(agent, agentOrgId);
    const runtime = backend.cliId;

    // Resolve conversation for session management
    let conversation = null;
    if (options.conversationId) {
      conversation = getOne('SELECT * FROM conversations WHERE id = ?', [options.conversationId]);
    }
    // For project context without explicit conversationId, find/create a project-scoped
    // conversation for this agent. This gives each agent its own session_id per project,
    // avoiding clashes with the agent's regular conversation session.
    if (!conversation && options.projectId) {
      conversation = getOne(
        'SELECT * FROM conversations WHERE agent_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1',
        [agentId, options.projectId]
      );
      if (!conversation) {
        const convId = generateId();
        const sessionId = generateId();
        run(
          `INSERT INTO conversations (id, agent_id, project_id, title, session_id, session_initialized)
           VALUES (?, ?, ?, 'Project Work', ?, 0)`,
          [convId, agentId, options.projectId, sessionId]
        );
        conversation = getOne('SELECT * FROM conversations WHERE id = ?', [convId]);
      }
    }
    if (!conversation) {
      conversation = getOne(
        'SELECT * FROM conversations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1',
        [agentId]
      );
    }
    if (!conversation) {
      const convId = generateId();
      run(
        `INSERT INTO conversations (id, agent_id, title, session_id, session_initialized)
         VALUES (?, ?, 'General', ?, 0)`,
        [convId, agentId, agent.session_id]
      );
      conversation = getOne('SELECT * FROM conversations WHERE id = ?', [convId]);
    }

    // Resolve CWD — worktree path for project work, global agent dir otherwise
    const agentDir = (options.projectId && options.branchName)
      ? orgPath(agentOrgId, 'agents', agentId, 'projects', options.projectId, options.branchName)
      : orgPath(agentOrgId, 'agents', agentId);
    fs.mkdirSync(agentDir, { recursive: true });

    // Branch change detection — CLI runtimes tie sessions to CWD, so when the branch
    // changes (deliverable completed, agent moves to next), we must reset the
    // session to avoid stale session errors from a CWD mismatch.
    const resolvedBranch = options.branchName || null;
    let sessionWasReset = false;
    if (conversation.session_initialized && conversation.session_branch !== resolvedBranch) {
      console.log(`[executor] Branch changed for conversation ${conversation.id}: "${conversation.session_branch}" → "${resolvedBranch}", resetting session`);
      const newSessionId = generateId();
      run('UPDATE conversations SET session_initialized = 0, session_id = ?, session_branch = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [newSessionId, resolvedBranch, conversation.id]);
      conversation = { ...conversation, session_initialized: 0, session_id: newSessionId, session_branch: resolvedBranch };
      sessionWasReset = true;
    }

    // --- Assemble system prompt and skills (Nebula concerns) ---

    const systemParts = [];
    const skillDefinitions = []; // Accumulated for remote transfer
    const apiToken = getOrgSetting(agentOrgId, 'internal_api_token');
    const ccSkillsDir = path.join(agentDir, '.claude', 'skills');

    // Clean Nebula-managed skills from previous executions (context may change between runs)
    // Only removes nebula-* and custom-* prefixed skills — leaves user-created skills untouched
    if (fs.existsSync(ccSkillsDir)) {
      for (const entry of fs.readdirSync(ccSkillsDir)) {
        if (entry.startsWith('nebula-') || entry.startsWith('custom-')) {
          try { fs.rmSync(path.join(ccSkillsDir, entry), { recursive: true }); } catch {}
        }
      }
    }

    function writeSkill(name, description, content) {
      const skillContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}`;
      skillDefinitions.push({ name, content: skillContent });
      // Disk-based CLIs read skills from .claude/skills/; systemprompt CLIs get them inlined
      if (backend.skillInjection === 'disk') {
        const dir = path.join(ccSkillsDir, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), skillContent);
      }
    }

    // Global knowledge (org-scoped)
    const globalPath = orgPath(agentOrgId, 'global', 'CLAUDE.md');
    if (fs.existsSync(globalPath)) {
      const globalKnowledge = fs.readFileSync(globalPath, 'utf-8').trim();
      if (globalKnowledge) systemParts.push(globalKnowledge);
    }

    // Project knowledge (from worktree — branch-specific version)
    if (options.projectId && options.branchName) {
      const projectClaudeMd = path.join(agentDir, 'CLAUDE.md');
      if (fs.existsSync(projectClaudeMd)) {
        const projectKnowledge = fs.readFileSync(projectClaudeMd, 'utf-8').trim();
        if (projectKnowledge) systemParts.push(projectKnowledge);
      }
    }

    // --- Built-in Skills ---

    // Task management
    const existingTasks = getAll('SELECT id, name, cron_expression, enabled, prompt FROM tasks WHERE agent_id = ?', [agentId]);
    const taskList = existingTasks.length > 0
      ? existingTasks.map(t => `  - ${t.name} (id: ${t.id}, cron: ${t.cron_expression}, enabled: ${t.enabled})`).join('\n')
      : '  (none)';
    writeSkill('nebula-tasks',
      'Manage scheduled cron tasks. Use when the user asks to schedule, list, update, or delete recurring tasks.',
      `Manage your own scheduled tasks via the Nebula API. Use the Bash tool with curl.

Agent ID: ${agentId}
API base: ${API_BASE}
Auth header: Authorization: Bearer ${apiToken}

Current tasks:
${taskList}

## Create
curl -s -X POST ${API_BASE}/api/agents/${agentId}/tasks \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"name":"Name","prompt":"What to do","cron_expression":"0 9 * * *","enabled":true}'

## List
curl -s ${API_BASE}/api/agents/${agentId}/tasks -H "Authorization: Bearer ${apiToken}"

## Update
curl -s -X PUT ${API_BASE}/api/tasks/{task_id} \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"name":"New Name","cron_expression":"*/30 * * * *","enabled":false}'

## Delete
curl -s -X DELETE ${API_BASE}/api/tasks/{task_id} -H "Authorization: Bearer ${apiToken}"

Cron format: minute hour day-of-month month day-of-week (e.g. "0 9 * * *" = daily 9am)`);

    // Workspace structure convention
    writeSkill('nebula-workspace',
      'Understand your workspace folder structure. Use when deciding where to store files, notes, or work output.',
      `Your workspace has a structured layout. Each location has a distinct purpose — do not overlap.

Working directory: ${agentDir}

## Folder Structure

### CLAUDE.md — Active working state + agent guidelines
- Your working guidelines and conventions (how you approach your role, output standards, standing rules)
- Current watchlists, signals, opportunity picks, active flags
- Deadlines and follow-up items
- Anything the user should see at a glance when they open your chat
- Keep it scannable — tables and bullet points, not paragraphs
- Remove items when they're resolved or no longer relevant
- NOT for: historical research, accumulated data, or bulk findings

### Memory — Persistent knowledge (API-managed)
- Memory is managed through the nebula-memory skill (search, read, create, update, delete)
- NOT stored on disk — use the memory API endpoints, not file writes
- Titles + descriptions are shown in your system prompt for quick reference
- Use search_memory to find relevant knowledge before starting new tasks

### workspace/ — Temporary work files
- Scripts, drafts, outputs, temp files — anything in-progress
- Disposable — can be deleted when the task is done
- NOT for: anything you want to persist across sessions

### vault/ — User-uploaded reference files
- Read-only — do not modify
- Specs, assets, reference docs uploaded by the user

### .claude/skills/ — Skills (managed by Nebula)
- Do not edit directly — use the nebula-skills skill to create/update skills via API`);

    // Skill management
    writeSkill('nebula-skills',
      'Create, list, update, and delete skills via the Nebula API. Use when creating reusable capabilities for yourself or the organization.',
      `Manage skills via the Nebula API. Use the Bash tool with curl.

Your agent ID: ${agentId}
API base: ${API_BASE}
Auth header: Authorization: Bearer ${apiToken}

## List your skills (agent + org-wide)
curl -s ${API_BASE}/api/agents/${agentId}/skills -H "Authorization: Bearer ${apiToken}"

## List all org skills
curl -s ${API_BASE}/api/skills -H "Authorization: Bearer ${apiToken}"

## Create agent-scoped skill (only you can use it)
curl -s -X POST ${API_BASE}/api/agents/${agentId}/skills \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"name":"skill-name","description":"What this skill does","content":"Instructions for this skill","scope":"agent"}'

## Create org-wide skill (all agents can use it)
curl -s -X POST ${API_BASE}/api/skills \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"name":"skill-name","org_id":"${agentOrgId}","description":"What this skill does","content":"Instructions for this skill"}'

## Update a skill
curl -s -X PUT ${API_BASE}/api/skills/{skill_id} \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"name":"new-name","description":"Updated desc","content":"Updated content"}'

## Delete a skill
curl -s -X DELETE ${API_BASE}/api/skills/{skill_id} -H "Authorization: Bearer ${apiToken}"

## Tips
- Agent-scoped skills are only visible to you. Org-scoped skills are visible to ALL agents.
- Skill content = instructions that teach how to perform a task (API calls, file ops, workflows).
- Secrets are available as environment variables (e.g. $GITEA_TOKEN). Use them in shell commands directly.
- In skill definitions, use {{SECRET_NAME}} template syntax — Nebula resolves these to env var references at runtime.
- Created skills automatically appear in your available skill list on next execution.`);

    // Mail
    if (getOrgSetting(agentOrgId, 'mail_enabled') === '1' || getOrgSetting(agentOrgId, 'imap_host') || getOrgSetting(agentOrgId, 'smtp_host')) {
      const notifyTo = getOrgSetting(agentOrgId, 'notify_email_to') || '';
      const smtpFrom = getOrgSetting(agentOrgId, 'smtp_from') || '';
      writeSkill('nebula-mail',
        'Read and send email. Use when the user asks to check mail, read emails, search inbox, send messages, or reply to emails.',
        `Read and send email via the Nebula API. Use the Bash tool with curl.
Auth header: Authorization: Bearer ${apiToken}
${notifyTo ? `Default recipient: ${notifyTo}` : ''}
${smtpFrom ? `Sending from: ${smtpFrom}` : ''}

## Read inbox
curl -s "${API_BASE}/api/mail/inbox?limit=10&folder=INBOX" -H "Authorization: Bearer ${apiToken}"

## Read specific email (by UID from inbox listing)
curl -s "${API_BASE}/api/mail/{uid}" -H "Authorization: Bearer ${apiToken}"

## Search
curl -s "${API_BASE}/api/mail/search?from=someone@example.com&limit=10" -H "Authorization: Bearer ${apiToken}"
Params: from, to, subject, text, since (date), before (date), unseen (flag), folder

## List folders
curl -s "${API_BASE}/api/mail/folders" -H "Authorization: Bearer ${apiToken}"

## Send email
curl -s -X POST ${API_BASE}/api/mail/send \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"to":"${notifyTo || 'recipient@example.com'}","subject":"Subject","body":"Message body"}'
Optional fields: cc, bcc, html, in_reply_to (message ID for threading)`);
    }

    // Peer agents awareness
    const peerAgents = getAll(
      'SELECT id, name, role, emoji, enabled, execution_mode, remote_device FROM agents WHERE org_id = ? AND id != ?',
      [agentOrgId, agentId]
    );
    if (peerAgents.length > 0) {
      const peerList = peerAgents.map(p => {
        let info = `  - ${p.emoji} ${p.name} (id: ${p.id}, role: ${p.role || 'none'}, ${p.enabled ? 'active' : 'disabled'})`;
        if (p.execution_mode === 'remote' && p.remote_device) {
          try {
            const dev = JSON.parse(p.remote_device);
            const specs = [dev.platform, dev.arch, dev.cpu, dev.ram ? `${dev.ram} RAM` : null, dev.gpu].filter(Boolean).join(', ');
            if (specs) info += `\n    Hardware: ${specs}`;
            if (dev.toolchains) info += `\n    Toolchains: ${dev.toolchains}`;
          } catch {}
        }
        return info;
      }).join('\n');
      const notifySection = options.projectId ? '' : `

## Notify another agent (fire-and-forget)
Write @notify TheirName to send a task to their own conversation.
They process it independently — no response comes back here.
${peerAgents.length > 0 ? `Example: "@notify ${peerAgents[0].name} please handle this when you get a chance."` : ''}`;

      writeSkill('nebula-agents',
        'Interact with peer agents. Use when you need to check what other agents are doing, read their messages, or ask them for help.',
        `Communicate with peer agents in your organization via the Nebula API. Use the Bash tool with curl.

Your Agent ID: ${agentId}
API base: ${API_BASE}
Auth header: Authorization: Bearer ${apiToken}

Peer agents:
${peerList}

## List all agents
curl -s ${API_BASE}/api/agents -H "Authorization: Bearer ${apiToken}"

## Read another agent's recent messages
curl -s "${API_BASE}/api/agents/{agent_id}/messages?limit=5" -H "Authorization: Bearer ${apiToken}"

## Talk to another agent
Write @TheirName in your response to pull them into the current conversation.
They will see your full message and respond here — the user sees the exchange without switching.
${peerAgents.length > 0 ? `Example: "Let me check with @${peerAgents[0].name} about this."` : ''}${notifySection}

IMPORTANT: Write the agent's exact name after @ — e.g. @${peerAgents.length > 0 ? peerAgents[0].name : 'AgentName'}. Nebula handles the routing automatically. Do NOT use curl or API calls for inter-agent communication.`);
    }

    // Project management — global context: list/create projects
    // Skip generic project skill when in project context — split skills replace it
    if (options.projectId) {
      // Project-specific skills written below
    } else {
    const existingProjects = getAll('SELECT id, name, status FROM projects WHERE org_id = ?', [agentOrgId]);
    const projectList = existingProjects.length > 0
      ? existingProjects.map(p => `  - ${p.name} (id: ${p.id}, ${p.status})`).join('\n')
      : '  (none)';
    // Load available agents for the skill context
    const availableAgents = getAll('SELECT id, name, emoji, role FROM agents WHERE org_id = ? AND enabled = 1', [agentOrgId]);
    const agentsList = availableAgents.map(a => `  - ${a.emoji} ${a.name}: id="${a.id}" ${a.role ? `(${a.role})` : ''}`).join('\n');

    writeSkill('nebula-projects',
      'Use when creating a new project, linking a repo, or checking project status. Supports full project scaffold in one call.',
      `Manage multi-agent projects via the Nebula API. Use the Bash tool with curl.

Agent ID: ${agentId}
API base: ${API_BASE}
Auth header: Authorization: Bearer ${apiToken}

Current projects:
${projectList}

Available agents:
${agentsList}

## List Projects
curl -s ${API_BASE}/api/projects -H "Authorization: Bearer ${apiToken}"

## Create Project (full scaffold in one call)
Before creating, gather from the user:
- Project name and description
- Git remote URL (e.g. git@host:org/repo.git)
- Git provider (gitea, github, gitlab)
- Who should coordinate (usually yourself)
- Which agents should contribute
- Initial milestones and deliverables (optional — can be added later in project conversation)

curl -s -X POST ${API_BASE}/api/projects \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{
    "name": "Project Name",
    "description": "What this project is about",
    "git_remote_url": "git@host:owner/repo.git",
    "git_provider": "gitea",
    "coordinator_agent_id": "${agentId}",
    "agents": ["agent_id_1", "agent_id_2"],
    "milestones": [
      {
        "name": "Milestone 1",
        "description": "First milestone",
        "deliverables": [
          {
            "name": "Deliverable name",
            "pass_criteria": "What must be true for this to be done",
            "branch_name": "feature/xxx",
            "assigned_agent_id": "agent_id_1"
          }
        ]
      }
    ]
  }'

All fields except name and git_remote_url are optional. agents, milestones, and deliverables can be added later via the project conversation.
Supported git_provider values: gitea, github, gitlab
IMPORTANT: The API rejects duplicate git_remote_url per org. Check the project list first.

## After Creating
Tell the user the project has been created and they should switch to the **project conversation** (in the Projects section of the sidebar) to continue working on it.

## Get Project Detail
curl -s ${API_BASE}/api/projects/{project_id} -H "Authorization: Bearer ${apiToken}"`);
    }

    // Project skills (when executing in project context)
    if (options.projectId) {
      const project = getOne('SELECT * FROM projects WHERE id = ?', [options.projectId]);
      if (project) {
        const projectAssignment = getOne(
          'SELECT * FROM project_agents WHERE project_id = ? AND agent_id = ?',
          [options.projectId, agentId]
        );
        const agentRole = projectAssignment?.role || 'contributor';

        // Load this agent's assigned deliverables for context
        const myDeliverables = getAll(
          `SELECT d.*, m.name as milestone_name FROM project_deliverables d
           JOIN project_milestones m ON d.milestone_id = m.id
           WHERE d.assigned_agent_id = ? AND m.project_id = ?
           ORDER BY d.status = 'in_progress' DESC, d.status = 'pending' DESC, d.sort_order`,
          [agentId, options.projectId]
        );
        const deliverableList = myDeliverables.length > 0
          ? myDeliverables.map(d => `  - [${d.status}] "${d.name}" (milestone: ${d.milestone_name}, branch: ${d.branch_name || 'unassigned'}, id: ${d.id})${d.pass_criteria ? `\n    Pass criteria: ${d.pass_criteria}` : ''}`).join('\n')
          : '  (none assigned)';

        // --- Contributor skill (all project agents get this) ---
        writeSkill('nebula-project-contributor',
          'Use when doing implementation work on project deliverables — coding, creating branches, pushing changes, creating PRs, updating deliverable status.',
          `You are working on project "${project.name}" as ${agentRole}.
${options.branchName ? `Your current branch: ${options.branchName}` : ''}
Working directory: ${agentDir}
Git remote: ${project.git_remote_url} (${project.git_provider})

Repo conventions:
- \`vault/\` — shared files (specs, assets, references)
- \`CLAUDE.md\` — project knowledge base (update when you discover important information)

API base: ${API_BASE}
Auth header: Authorization: Bearer ${apiToken}

## Your Assigned Deliverables
${deliverableList}

## Workflow
1. Check your assigned deliverables above
2. **Before writing any code**: read the design spec and tech spec in vault/, understand the existing codebase structure, review the pass criteria for your deliverable. Do NOT jump straight into implementation.
3. Update status to "in_progress" when starting work
4. Work on the deliverable — write code, tests, docs
5. Push to the assigned feature branch (never push to main)
6. Create a PR referencing the deliverable
7. Update status to "done" and @mention the coordinator for review

## Update Deliverable Status
curl -s -X PUT ${API_BASE}/api/projects/deliverables/{deliverable_id} \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"status":"in_progress"}'
Statuses: pending, in_progress, done, blocked

## Branches
curl -s ${API_BASE}/api/projects/${project.id}/branches -H "Authorization: Bearer ${apiToken}"

## Create PR (when deliverable is ready for review)
curl -s -X POST ${API_BASE}/api/projects/${project.id}/pr \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"branch":"${options.branchName || 'feature/xxx'}","title":"PR title","body":"Closes deliverable: {name}\\n\\n{description}"}'

## List PRs
curl -s ${API_BASE}/api/projects/${project.id}/pr -H "Authorization: Bearer ${apiToken}"

## Post to Project Conversation
curl -s -X POST ${API_BASE}/api/projects/${project.id}/messages \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"content":"Message text","agent_id":"${agentId}"}'`);

        // --- Coordinator skill (only for coordinators — manages project structure) ---
        if (agentRole === 'coordinator') {
          // Inject readiness state so coordinator knows project status
          const readiness = evaluateReadiness(options.projectId);
          let readinessBlock = '';
          if (!readiness.ready) {
            const failing = [
              ...readiness.systemChecks.filter(c => !c.met).map(c => `  - [MISSING] ${c.label}`),
              ...readiness.agentChecks.filter(c => !c.met).map(c => `  - [MISSING] ${c.label} (custom)`),
            ].join('\n');
            readinessBlock = `\n\n## PROJECT NOT READY
The project is in a not-ready state. The following prerequisites are not met:
${failing}

You MUST guide the user to resolve these before creating milestones or dispatching work. You can still discuss design, write spec files, and help the user set up the project. Focus on getting the project to a ready state.
For spec files: write design-spec.md and tech-spec.md to the project vault/ directory.`;
          } else {
            readinessBlock = '\n\n## Project Status: READY\nAll prerequisites are met. You may create milestones and dispatch work.';
          }
          // Load all project agents for context
          const projectAgents = getAll(
            `SELECT pa.*, a.name as agent_name, a.emoji as agent_emoji
             FROM project_agents pa JOIN agents a ON pa.agent_id = a.id
             WHERE pa.project_id = ?`,
            [options.projectId]
          );
          const agentList = projectAgents.map(a => `  - ${a.agent_emoji} ${a.agent_name} (${a.role}, id: ${a.agent_id})`).join('\n');

          writeSkill('nebula-project-coordinator',
            'Use when organizing the project — creating milestones/deliverables, assigning work to agents, reviewing PRs, merging, and monitoring progress.',
            `You are the coordinator of project "${project.name}".${readinessBlock}

## Autonomous Execution
Your primary goal is to push the project forward autonomously. After each interaction:
1. Check project status — are there pending deliverables with no assigned agent or no active work?
2. Check for completed deliverables that need PRs reviewed/merged
3. If a contributor finished their task, immediately dispatch the next pending deliverable to them
4. If all deliverables in a milestone are done, mark the milestone complete and move to the next

Only stop and ask the user when you need:
- **Decisions**: architectural choices, scope changes, priority conflicts
- **Milestone approval**: before marking a milestone as complete, confirm with the user
- **Project completion**: when all milestones are done, report status and ask for sign-off
- **Blockers**: issues you cannot resolve autonomously (missing credentials, unclear requirements)

Do NOT wait for the user to tell you what to do next. When unblocked, immediately assess the project state and take action.

## Team
${agentList}

API base: ${API_BASE}
Auth header: Authorization: Bearer ${apiToken}

## Project Status
curl -s ${API_BASE}/api/projects/${project.id} -H "Authorization: Bearer ${apiToken}"

## Milestones & Deliverables
curl -s ${API_BASE}/api/projects/${project.id}/milestones -H "Authorization: Bearer ${apiToken}"

## Create Milestone
curl -s -X POST ${API_BASE}/api/projects/${project.id}/milestones \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"name":"Milestone Name","description":"What this milestone covers"}'

## Create Deliverable (under a milestone)
curl -s -X POST ${API_BASE}/api/projects/milestones/{milestone_id}/deliverables \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"name":"Deliverable Name","pass_criteria":"What must be true for this to be done","branch_name":"feature/xxx","assigned_agent_id":"{agent_id}"}'

## Update Deliverable
curl -s -X PUT ${API_BASE}/api/projects/deliverables/{deliverable_id} \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"status":"done","assigned_agent_id":"{agent_id}","branch_name":"feature/xxx"}'

## Delete Deliverable
curl -s -X DELETE ${API_BASE}/api/projects/deliverables/{deliverable_id} \\
  -H "Authorization: Bearer ${apiToken}"

## Assign Agent to Project
curl -s -X POST ${API_BASE}/api/projects/${project.id}/agents \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"agent_id":"{agent_id}","role":"contributor"}'

## Update Agent Role
curl -s -X PUT ${API_BASE}/api/projects/${project.id}/agents/{agent_id} \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"role":"contributor"}'

## Remove Agent from Project
curl -s -X DELETE ${API_BASE}/api/projects/${project.id}/agents/{agent_id} \\
  -H "Authorization: Bearer ${apiToken}"

## Merge PR
curl -s -X POST "${API_BASE}/api/projects/${project.id}/pr/{number}/merge?delete_branch=true" \\
  -H "Authorization: Bearer ${apiToken}"
Add \`?delete_branch=true\` to delete the source branch after merge (recommended to keep branches clean).

## Dispatching Work
To assign work to contributors:
1. Create deliverables with branch names and assigned agents
2. @mention the agent in the project conversation with instructions (responses come back here)
3. The agent will see their assigned deliverables in their skill context
4. Monitor progress via project status and PR list

## Cron Tasks for Project Management
Use the nebula-tasks skill to create recurring tasks. Templates:

### Daily Standup (9am)
Cron: "0 9 * * *" — prompt: "Query project status. For each contributor, check deliverable status and branch activity. Post standup summary to project conversation."

### PR Review Reminder (daily 2pm)
Cron: "0 14 * * *" — prompt: "Check for open PRs waiting >24h. Post reminder @mentioning relevant contributors."

### Weekly Milestone Report (Friday 5pm)
Cron: "0 17 * * 5" — prompt: "Generate milestone progress report with completion %, open PRs, risks. Post to project conversation."`);
        }

        // Git LFS skill — common for all project agents
        writeSkill('nebula-git-lfs',
          'Manage Git LFS for large files. Use when tracking, untracking, or checking status of large files.',
          `Manage Git Large File Storage in your worktree. Use the Bash tool.

## Track large files by pattern
git lfs track "*.psd"
git lfs track "*.zip"
git lfs track "assets/**"

## View tracked patterns
cat .gitattributes

## Check LFS status
git lfs status
git lfs ls-files

## After tracking, commit .gitattributes
git add .gitattributes
git commit -m "Track large files with LFS"

Note: After adding a track pattern, you must commit the updated .gitattributes before LFS will manage those files.`);

        // Integration skills (issue tracker, KB, CI) — only if linked
        const projectLinks = getAll('SELECT * FROM project_links WHERE project_id = ?', [options.projectId]);
        if (projectLinks.length > 0) {
          const integrationSkills = generateIntegrationSkills(projectLinks, (link) => {
            // Resolve token from link config or org settings
            const config = typeof link.config === 'string' ? JSON.parse(link.config) : link.config;
            return config.token || getOrgSetting(agentOrgId, `${link.provider}_api_token`);
          });
          for (const skill of integrationSkills) {
            writeSkill(skill.name, skill.description, skill.content);
          }
        }
      }
    }

    // NAS access + symlink setup
    let nasPaths = [];
    try { nasPaths = JSON.parse(agent.nas_paths || '[]'); } catch {}
    if (nasPaths.length > 0) {
      const nasLinksDir = path.join(agentDir, 'nas');
      fs.mkdirSync(nasLinksDir, { recursive: true });
      const accessiblePaths = [];
      for (const nasPath of nasPaths) {
        const containerPath = nasPath.startsWith('/') ? '/nas' + nasPath : nasPath;
        if (fs.existsSync(containerPath)) {
          const linkName = path.basename(nasPath);
          const linkPath = path.join(nasLinksDir, linkName);
          try { fs.unlinkSync(linkPath); } catch {}
          try {
            fs.symlinkSync(containerPath, linkPath);
            accessiblePaths.push(`  - ${linkPath} -> ${nasPath}`);
          } catch (e) {
            accessiblePaths.push(`  - ${nasPath} (link failed: ${e.message})`);
          }
        } else {
          accessiblePaths.push(`  - ${nasPath} (not mounted)`);
        }
      }
      writeSkill('nebula-nas',
        'Access NAS filesystem paths. Use when the user asks to read, write, or manage files on the NAS.',
        `NAS paths are symlinked in ${nasLinksDir}:
${accessiblePaths.join('\n')}

Read, write, and manage files in these directories.`);
    }

    // Load secrets — scope-specific secrets override org secrets of the same key.
    // Project context: org + project secrets (agent secrets excluded for isolation).
    // Agent context: org + agent secrets (project secrets excluded).
    const orgSecrets = getAll(
      'SELECT key, value FROM org_secrets WHERE org_id = ?',
      [agentOrgId]
    );
    const secretMap = new Map(orgSecrets.map(s => [s.key, decrypt(s.value)]));

    if (options.projectId) {
      // Project context — use project secrets, NOT agent secrets
      const projectSecrets = getAll(
        'SELECT key, value FROM project_secrets WHERE project_id = ?',
        [options.projectId]
      );
      for (const s of projectSecrets) {
        secretMap.set(s.key, decrypt(s.value));
      }
    } else {
      // Agent context — use agent secrets
      const agentSecrets = getAll(
        'SELECT key, value FROM agent_secrets WHERE agent_id = ?',
        [agentId]
      );
      for (const s of agentSecrets) {
        secretMap.set(s.key, decrypt(s.value));
      }
    }

    // Build env vars for the CLI process
    const secretEnvVars = {};
    for (const [key, value] of secretMap) {
      secretEnvVars[key] = value;
    }

    // Resolve {{KEY}} to ${KEY} (env var reference) for skills — agent never sees the actual value
    function resolveSecretsForSkills(text) {
      return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
        return secretMap.has(key) ? `\${${key}}` : match;
      });
    }

    // Resolve {{KEY}} to actual values for MCP configs (not agent-visible, passed to MCP process)
    function resolveSecretsForConfig(text) {
      return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
        return secretMap.has(key) ? secretMap.get(key) : match;
      });
    }

    // MCP servers (org-wide + agent-specific)
    const mcpServers = getAll(
      `SELECT * FROM mcp_servers
       WHERE enabled = 1 AND ((org_id = ? AND agent_id IS NULL) OR agent_id = ?)`,
      [agentOrgId, agentId]
    ).map(s => {
      const config = JSON.parse(resolveSecretsForConfig(s.config));
      return { name: s.name, transport: s.transport, config };
    });

    // Custom skills (org-wide + agent-specific)
    const customSkills = getAll(
      `SELECT * FROM custom_skills
       WHERE enabled = 1 AND ((org_id = ? AND agent_id IS NULL) OR agent_id = ?)`,
      [agentOrgId, agentId]
    );
    for (const skill of customSkills) {
      const skillName = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      writeSkill(`custom-${skillName}`, skill.description, resolveSecretsForSkills(skill.content));
    }

    // Coding conventions (built-in)
    writeSkill('nebula-coding-conventions',
      'Coding conventions and architectural rules. Reference when writing new code, reviewing changes, or refactoring. Covers hierarchy design, API ownership, lifecycle contracts, data modeling, and test quality.',
      CODING_CONVENTIONS_SKILL);

    // Intelligence scan SOP (built-in)
    {
      const org = getOne('SELECT name FROM organizations WHERE id = ?', [agentOrgId]);
      writeSkill('nebula-intelligence-scan',
        'Standard operating procedure for intelligence scans and research reports. Use when running morning/evening scans, market research, competitive analysis, or any structured research task.',
        intelligenceScanSkill({
          notifyEmail: getOrgSetting(agentOrgId, 'notify_email_to') || '',
          orgName: org?.name || 'the organization',
        }));
    }

    // --- Memory system ---
    const isTaskContext = !!(options.projectId && options.branchName);
    const isProjectContext = !!(options.projectId && !options.branchName);

    // Fetch memory metadata for system prompt injection
    const agentMemories = getAll(
      'SELECT id, title, description FROM memories WHERE owner_type = ? AND owner_id = ? ORDER BY updated_at DESC',
      ['agent', agentId]
    );
    let projectMemories = [];
    let projectName = '';
    if (options.projectId) {
      projectMemories = getAll(
        'SELECT id, title, description FROM memories WHERE owner_type = ? AND owner_id = ? ORDER BY updated_at DESC',
        ['project', options.projectId]
      );
      const proj = getOne('SELECT name FROM projects WHERE id = ?', [options.projectId]);
      projectName = proj?.name || 'Unknown';
    }

    // Inject memory metadata into system prompt
    if (agentMemories.length > 0 || projectMemories.length > 0) {
      const memParts = ['## Your Memories', 'Use search_memory(query) to find relevant knowledge.\nUse read_memory(id) to load full content.'];
      if (!isTaskContext) {
        memParts.push('Use update_memory(title, description, content) to store learnings.');
      }
      memParts.push('');
      if (agentMemories.length > 0) {
        memParts.push(`Personal (${agentMemories.length} concepts):`);
        for (const m of agentMemories) {
          memParts.push(`- ${m.title}: ${m.description}`);
        }
      }
      if (projectMemories.length > 0) {
        memParts.push(`\nProject "${projectName}" (${projectMemories.length} concepts):`);
        for (const m of projectMemories) {
          memParts.push(`- ${m.title}: ${m.description}`);
        }
      }
      systemParts.push(memParts.join('\n'));
    }

    // Memory management skill (context-dependent)
    if (isTaskContext) {
      writeSkill('nebula-memory',
        'Search and read memories for reference during task execution. Read-only — include learnings in your work summary.',
        `# Memory Reference

You have read-only access to memories for reference during this task.

## Available Operations

### search_memory(query)
Search for relevant knowledge across personal and project memories.
curl -s -X POST ${API_BASE}/api/memory/search \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"query": "...", "agent_id": "${agentId}"${options.projectId ? `, "project_id": "${options.projectId}"` : ''}}'

### read_memory(id)
Load full content of a memory concept.
curl -s ${API_BASE}/api/agents/${agentId}/memory/{memory_id} \\
  -H "Authorization: Bearer ${apiToken}"

You cannot modify memories during task execution. Include any learnings in your work summary when the task completes.`);
    } else if (isProjectContext) {
      writeSkill('nebula-memory',
        'Manage project memories and search across personal + project knowledge. Personal memories are read-only in project context.',
        `# Memory Management

You have access to two memory scopes:
- Personal memory (read-only in project context)
- Project memory for "${projectName}" (read/write)

Agent ID: ${agentId}
Project ID: ${options.projectId}
API base: ${API_BASE}
Auth header: Authorization: Bearer ${apiToken}

## Available Operations

### search_memory(query)
Search across personal + project memories. Returns results tagged with source.
curl -s -X POST ${API_BASE}/api/memory/search \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"query": "...", "agent_id": "${agentId}", "project_id": "${options.projectId}"}'

### read_memory(id)
Load full content of any visible memory.
curl -s ${API_BASE}/api/agents/${agentId}/memory/{memory_id} -H "Authorization: Bearer ${apiToken}"
curl -s ${API_BASE}/api/projects/${options.projectId}/memory/{memory_id} -H "Authorization: Bearer ${apiToken}"

### update_memory(title, description, content) — PROJECT memory only
Create or update a project memory concept.
curl -s -X POST ${API_BASE}/api/projects/${options.projectId}/memory \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"title": "...", "description": "...", "content": "..."}'

To update an existing memory:
curl -s -X PUT ${API_BASE}/api/projects/${options.projectId}/memory/{memory_id} \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"title": "...", "description": "...", "content": "..."}'

### delete_memory(id) — PROJECT memory only
curl -s -X DELETE ${API_BASE}/api/projects/${options.projectId}/memory/{memory_id} -H "Authorization: Bearer ${apiToken}"

Note: You cannot modify personal memory from project context. If you discover something broadly useful, note it in your work summary for your main identity to review.`);
    } else {
      // Main context — full R/W on personal memory
      writeSkill('nebula-memory',
        'Manage your persistent memory — store knowledge, search past learnings, and maintain context across sessions.',
        `# Memory Management

You have a persistent memory system for storing knowledge and learnings.
You are updating your PERSONAL memory — knowledge that persists across all contexts.

Agent ID: ${agentId}
API base: ${API_BASE}
Auth header: Authorization: Bearer ${apiToken}

## Available Operations

### search_memory(query)
Search your memories by keyword. Returns ranked results with snippets.
curl -s -X POST ${API_BASE}/api/memory/search \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"query": "...", "agent_id": "${agentId}"}'

### read_memory(id)
Load full content of a memory concept.
curl -s ${API_BASE}/api/agents/${agentId}/memory/{memory_id} \\
  -H "Authorization: Bearer ${apiToken}"

### update_memory(title, description, content)
Create or update a memory concept. Title must be unique (case-insensitive).
curl -s -X POST ${API_BASE}/api/agents/${agentId}/memory \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"title": "...", "description": "...", "content": "..."}'

To update an existing memory:
curl -s -X PUT ${API_BASE}/api/agents/${agentId}/memory/{memory_id} \\
  -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json" \\
  -d '{"title": "...", "description": "...", "content": "..."}'

### delete_memory(id)
Remove a memory concept.
curl -s -X DELETE ${API_BASE}/api/agents/${agentId}/memory/{memory_id} -H "Authorization: Bearer ${apiToken}"

### list_memories
List all your memory titles and descriptions.
curl -s ${API_BASE}/api/agents/${agentId}/memory -H "Authorization: Bearer ${apiToken}"

## Guidelines
- Store knowledge worth recalling in future sessions (patterns, decisions, preferences, context)
- Use descriptive titles and one-line descriptions for quick scanning
- Keep content focused — one concept per memory
- Search before creating to avoid duplicates
- Update existing memories rather than creating near-duplicates
- SECURITY: Never store secrets, tokens, or passwords in memory content`);
    }

    // Agent identity in system prompt
    const vaultDir = path.join(agentDir, 'vault');
    let vaultListing = '';
    if (fs.existsSync(vaultDir)) {
      const files = fs.readdirSync(vaultDir);
      if (files.length > 0) {
        vaultListing = '\n\nFiles in your vault:\n' + files.map(f => {
          const stat = fs.statSync(path.join(vaultDir, f));
          const kb = (stat.size / 1024).toFixed(1);
          return `  - ${path.join(vaultDir, f)} (${kb} KB)`;
        }).join('\n') + '\nUse the Read tool to access these files when relevant to the conversation.';
      }
    }

    const org = getOne('SELECT name FROM organizations WHERE id = ?', [agentOrgId]);
    const orgName = org?.name || 'Unknown';
    const peerCount = peerAgents.length;

    const collaborateHint = peerAgents.length > 0
      ? (options.projectId
        ? `\nCollaborate with peers using @TheirName to pull them into the conversation. Available: ${peerAgents.map(a => a.name).join(', ')}.`
        : `\nCollaborate with peers using @TheirName to pull them in, or @notify TheirName to send them a task. Available: ${peerAgents.map(a => a.name).join(', ')}.`)
      : '';

    systemParts.push(`## Nebula Agent
You are "${agent.name}" in the "${orgName}" organization — a team of ${peerCount + 1} AI agents collaborating on shared goals.${agent.role ? `\nYour role: ${agent.role}` : ''}
The Global Knowledge section above contains your organization's mission and shared context — align your work accordingly.${collaborateHint}
Working directory: ${agentDir}
IMPORTANT: Stay within your working directory. Do NOT read, write, list, or access files outside of it — this includes other agents' directories, the database, home directory, and system paths. To communicate with other agents, use @TheirName or @notify — never access their files directly. Violating this boundary compromises data isolation between agents.
Update your CLAUDE.md to persist notes across sessions.
SECURITY: Never write secrets, tokens, passwords, or API keys as plaintext into any file (CLAUDE.md, vault/, or conversation responses) or memory content. Secrets are available as environment variables (e.g. $GITEA_TOKEN) — reference them by variable name only. If you need to note that a secret exists, write the key name (e.g. "uses GITEA_TOKEN"), never the value.
Messages prefixed with [Inter-agent message from ...] are from peer agents, not from a human user. Respond professionally and directly to the request — no social pleasantries, no asking the user to relay thanks. Focus on executing the task.${vaultListing}`);

    // Agent readiness check — if not initialized, inject setup directive
    if (!agent.initialized && !options.projectId) {
      const hasCLAUDEmd = fs.existsSync(path.join(agentDir, 'CLAUDE.md'));
      const hasOrgProfile = getOne(
        "SELECT id FROM memories WHERE owner_type = 'agent' AND owner_id = ? AND title = 'Organization Profile' COLLATE NOCASE",
        [agentId]
      );
      // Backward compat: also check file-based org profile (pre-migration agents)
      const hasOrgProfileFile = fs.existsSync(path.join(agentDir, 'memory', 'org-profile.md'));
      const hasRole = !!agent.role;
      const missing = [];
      if (!hasRole) missing.push('Role not set (user should configure in agent settings)');
      if (!hasCLAUDEmd) missing.push('Agent guidelines file (CLAUDE.md) not created yet');
      if (!hasOrgProfile && !hasOrgProfileFile) missing.push('Organization profile memory not created yet — use update_memory to create a memory titled "Organization Profile" with your understanding of the org, peer agents, resources, and priorities');

      if (missing.length > 0) {
        systemParts.push(`## AGENT SETUP NEEDED
This agent is not fully initialized. Missing:
${missing.map(m => `- ${m}`).join('\n')}

Help the user complete the setup. Ask about your role if not set. Once you have enough context from the user, create your CLAUDE.md (working guidelines, role, conventions) and use the memory system to store your organization profile. You can still help the user with tasks, but prioritize completing your setup when there's a natural opportunity.`);
      } else {
        // All present — mark as initialized
        run('UPDATE agents SET initialized = 1 WHERE id = ?', [agentId]);
      }
    }

    // CLIs with systemprompt skill injection need skills inlined into the system prompt
    if (backend.skillInjection === 'systemprompt' && skillDefinitions.length > 0) {
      const skillsBlock = skillDefinitions.map(s => s.content).join('\n\n---\n\n');
      systemParts.push(`## Skills\n\n${skillsBlock}`);
    }

    const systemPrompt = systemParts.join('\n\n');
    const orgDefaultTimeout = parseInt(getOrgSetting(agentOrgId, 'default_timeout_ms')) || 600000;
    // Timeout resolution depends on context:
    // - Project context: explicit override > project timeout > org default
    // - Agent context: explicit override > agent timeout > org default
    let timeoutMs;
    if (options.timeoutMs) {
      timeoutMs = options.timeoutMs;
    } else if (options.projectId) {
      const proj = getOne('SELECT timeout_ms FROM projects WHERE id = ?', [options.projectId]);
      timeoutMs = proj?.timeout_ms || orgDefaultTimeout;
    } else {
      timeoutMs = agent.timeout_ms || orgDefaultTimeout;
    }

    // Recovery token budget: agent override > org setting > default (25000)
    const recoveryTokenBudget = agent.recovery_token_budget
      || parseInt(getOrgSetting(agentOrgId, 'recovery_token_budget')) || 25000;

    // --- Execute via backend ---

    const abortController = new AbortController();
    this.abortControllers.set(contextKey, abortController);

    const typingInfo = {
      agentId, orgId: agentOrgId, conversationId: conversation.id,
      projectId: options.projectId || null, branchName: options.branchName || null,
    };
    this.typingState.set(contextKey, typingInfo);
    this.emit('agent_typing', { ...typingInfo, active: true });

    // If the session was reset (branch change) or is uninitialized but has prior messages
    // (e.g. session was reset by a failed recovery attempt), inject conversation history
    let execPrompt = prompt;
    const needsRecovery = sessionWasReset || (!conversation.session_initialized && getOne(
      'SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1', [conversation.id]
    ));
    if (needsRecovery) {
      const recovery = this._buildContextRecovery(conversation.id, recoveryTokenBudget);
      if (recovery) execPrompt = recovery + prompt;
    }

    try {
      let result;

      if (agent.execution_mode === 'remote') {
        // Remote execution — routed to connected remote client
        if (!isRemoteConnected(agentId)) {
          throw new Error('Remote agent is not connected — check the client on the remote machine');
        }
        result = await executeRemote(agentId, execPrompt, systemPrompt, agent, conversation, { ...options, timeoutMs, runtime, skills: skillDefinitions, mcpServers, secretEnvVars });
      } else {
        const execOpts = { maxTurns: options.maxTurns || 50, timeoutMs, signal: abortController.signal, images: options.images || [], mcpServers, secretEnvVars };
        try {
          result = await backend.execute({
            prompt: execPrompt, systemPrompt, agent, agentDir, conversation, options: execOpts,
          });
        } catch (execErr) {
          // Stale session recovery — CLI runtimes may reject sessions that were
          // purged (container restart, cleanup, etc.) or are locked by a prior run.
          // Reset session_initialized and retry with a fresh session, with context recovery
          const errMsg = String(execErr.message);

          // Auth errors are not recoverable via session reset — bail immediately
          if (/auth expired/i.test(errMsg)) throw execErr;

          const isStaleSession = /No conversation found with session ID/i.test(errMsg);
          const isSessionInUse = /Session ID .* is already in use/i.test(errMsg);
          // CC CLI exit code 1 with zero usage = session failed to start (e.g. purged, corrupted).
          // Recover even if the specific error text wasn't captured in the truncated output.
          const isZeroUsageExit = conversation.session_initialized
            && /CC exit code 1/i.test(errMsg)
            && /"input_tokens"\s*:\s*0/.test(errMsg)
            && /"output_tokens"\s*:\s*0/.test(errMsg);
          if (isStaleSession || isSessionInUse || isZeroUsageExit) {
            const reason = isSessionInUse ? 'in use' : isStaleSession ? 'not found' : 'zero-usage exit (session likely purged)';
            console.warn(`[executor] Session error for conversation ${conversation.id} (session ${conversation.session_id}): ${reason}, resetting and retrying`);
            const newSessionId = generateId();
            run('UPDATE conversations SET session_initialized = 0, session_id = ?, session_branch = ?, updated_at = datetime(\'now\') WHERE id = ?',
              [newSessionId, resolvedBranch, conversation.id]);
            conversation = { ...conversation, session_initialized: 0, session_id: newSessionId, session_branch: resolvedBranch };
            const recovery = this._buildContextRecovery(conversation.id, recoveryTokenBudget);
            const recoveredPrompt = recovery ? recovery + prompt : prompt;
            result = await backend.execute({
              prompt: recoveredPrompt, systemPrompt, agent, agentDir, conversation, options: execOpts,
            });
          } else {
            throw execErr;
          }
        }
      }

      if (!conversation.session_initialized) {
        // All CLIs generate their own session ID on first run.
        // Capture it from the parsed output and store for future --resume calls.
        const cliSessionId = result.cli_session_id;
        if (cliSessionId) {
          run('UPDATE conversations SET session_initialized = 1, session_id = ?, session_branch = ?, updated_at = datetime(\'now\') WHERE id = ?',
            [cliSessionId, resolvedBranch, conversation.id]);
        } else {
          run('UPDATE conversations SET session_initialized = 1, session_branch = ?, updated_at = datetime(\'now\') WHERE id = ?',
            [resolvedBranch, conversation.id]);
        }
      }

      // Log usage event
      try {
        run(
          `INSERT INTO usage_events (id, org_id, agent_id, conversation_id, backend, model, tokens_in, tokens_out, total_cost, duration_ms, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success')`,
          [generateId(), agentOrgId, agentId, conversation.id, runtime, agent.model,
           result.usage?.input_tokens || 0, result.usage?.output_tokens || 0,
           result.total_cost_usd || 0, result.duration_ms || 0]
        );
      } catch (e) {
        console.error('[executor] Failed to log usage event:', e.message);
      }

      return result;
    } catch (err) {
      // Log failed usage event
      try {
        run(
          `INSERT INTO usage_events (id, org_id, agent_id, conversation_id, backend, model, duration_ms, status, error_message)
           VALUES (?, ?, ?, ?, ?, ?, 0, 'error', ?)`,
          [generateId(), agentOrgId, agentId, conversation.id, runtime, agent.model, String(err.message || err).slice(0, 1000)]
        );
      } catch (e) {
        console.error('[executor] Failed to log usage event:', e.message);
      }
      throw err;
    } finally {
      this.abortControllers.delete(contextKey);
      this.typingState.delete(contextKey);
      this.emit('agent_typing', {
        agentId, orgId: agentOrgId, conversationId: conversation.id, active: false,
        projectId: options.projectId || null, branchName: options.branchName || null,
      });
    }
  }
}

// Singleton
const executor = new AgentExecutor();
export default executor;
