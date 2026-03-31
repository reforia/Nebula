# Projects — Feature Spec

> Status: Design complete, not yet implemented
> Date: 2026-03-21
> Context: Multi-agent coordination around shared codebases. Designed through architectural discussion covering conversation ownership, project discovery, executor concurrency, git workflow, multi-instance agents, and integration architecture.

## Problem

Agents currently work in isolation. Each has its own workdir, own conversation, own context. When multiple agents need to work on the same codebase (e.g. R&D implementing features while Pacman handles builds), there's no shared workspace, no version control coordination, and no structured way to track progress toward milestones.

## Core Concept

A **Project** is an org-scoped workspace that coordinates multiple agents toward a shared goal with version-controlled code (git), structured milestones, and optional external system integration.

Think of it as: a git repo + a group chat + agent orchestration + optional issue/CI integration, all in one.

## Data Model

```
Organization
 └── Project
      ├── Git Repository (bare local + mandatory remote)
      │    ├── CLAUDE.md        (project knowledge — versioned, branch-aware)
      │    ├── vault/           (shared files: specs, assets, references — versioned)
      │    └── src/...          (project code)
      ├── Milestones (ordered phases)
      │    └── Deliverables (checkable items with pass criteria, each on a feature branch)
      ├── Agent Assignments
      │    ├── Coordinator (1, proposes plan, reviews PRs, merges, reports)
      │    └── Contributors (N, work on assigned feature branches — multi-instance capable)
      ├── External Links (all optional)
      │    ├── Issue tracker (YouTrack, Jira, GitHub Issues, etc.)
      │    ├── Knowledge base (YouTrack KB, Confluence, Notion, etc.)
      │    └── CI/CD (TeamCity, Gitea Actions, GitHub Actions, etc.)
      └── Project Conversation (group chat for all project agents + user)
```

## Git Model

### Remote-first

Every project has a **mandatory git remote** (Gitea, GitHub, GitLab — provider is configurable). The remote is the source of truth. A local bare repo mirrors it.

### Feature branches, not agent branches

Branches are named by feature, not by agent. Agents don't "own" branches — they are **assigned** to work on a feature branch. When the work is merged, the branch is done and the agent can be assigned to the next feature.

```
main                          ← coordinator merges PRs here
├── feature/user-auth         ← assigned to R&D (instance 1), 3 deliverables
├── feature/api-docs          ← assigned to R&D (instance 2), 2 deliverables
└── feature/ci-pipeline       ← assigned to Pacman, 1 deliverable
```

The same agent can work on multiple feature branches simultaneously as separate instances (see Multi-Instance Agents).

### PR-based workflow

Agents do **not** merge directly into main. The flow is:

1. Coordinator creates feature branch from main, assigns to a contributor
2. Contributor works in their worktree, commits, pushes to remote
3. Contributor writes unit tests and validates before submitting PR
4. Contributor creates a PR on the hosting platform (via `nebula-projects` skill)
5. Coordinator reviews the PR on the hosting platform
6. If changes needed → coordinator notifies contributor via project conversation
7. When approved → coordinator merges the PR
8. Contributor's worktree rebases to latest main, ready for next assignment

PRs happen on the hosting platform (Gitea/GitHub), not locally. The hosting platform is the source of truth for code review.

### Conflict resolution

When a PR has merge conflicts:
1. Coordinator detects the conflict (via hosting platform API or git)
2. Coordinator performs the merge resolution on main
3. If the resolution requires feature-side changes, coordinator notifies the branch contributor to modify and update the PR
4. Coordinator never pushes directly to a contributor's feature branch without notification

### Git LFS

Git LFS is available as a common skill for all project agents. The `nebula-git-lfs` skill provides:
- `git lfs track` patterns for large files
- `.gitattributes` management
- LFS storage quota awareness

## Multi-Instance Agents

### Concept: Soul and Body

An agent is a **soul** — identity, persona, skills, knowledge. A CLI process working on a specific branch is a **body**. One soul can have multiple bodies working simultaneously on different feature branches within the same project.

This is safe because:
- Each feature branch has its own worktree (isolated filesystem)
- Each instance is an independent CLI session (no shared state)
- No two instances can work on the same branch (enforced by queue key)
- Conflicts are resolved at merge time by the coordinator

### Concurrency model

```
Queue key = agentId + ":" + projectId + ":" + branchName

Examples:
  rnd:proj1:feature/auth        — R&D instance 1
  rnd:proj1:feature/api-docs    — R&D instance 2 (concurrent with instance 1)
  rnd:global                    — R&D doing non-project work (concurrent with above)
  coordinator:proj1:main        — coordinator on main (serialized)
```

| Context | Concurrency |
|---------|------------|
| R&D on `feature/auth` | 1 at a time (serialized within same branch) |
| R&D on `feature/api-docs` | Concurrent with `feature/auth` — different worktree |
| R&D on global (no project) | Concurrent with all project work |
| Coordinator on `main` | 1 at a time (merge serialization) |
| Same agent, same branch, different request | Queued |

### Concurrency cap

Per-agent limit on simultaneous branch executions within a project, configurable in `project_agents`:

```sql
max_concurrent INTEGER NOT NULL DEFAULT 3
```

Coordinator is implicitly capped at 1 on main (single branch). Contributors default to 3 concurrent feature branches.

The executor enforces this:
```js
const activeCount = [...this.activeKeys]
  .filter(k => k.startsWith(`${agentId}:${projectId}:`))
  .length;
if (activeCount >= maxConcurrent) continue; // queue, don't execute yet
```

### Shared knowledge via git

Project knowledge lives in `CLAUDE.md` at the root of the git repo — not on the filesystem outside git. Each branch has its own copy.

When an agent instance discovers something important:
1. It updates `CLAUDE.md` in its feature branch (just a file edit)
2. The change is part of the PR when submitted
3. Coordinator sees the knowledge addition during PR review
4. If two branches both modified CLAUDE.md, the second PR has a merge conflict
5. Coordinator resolves the conflict — merging both contributions into main
6. Next branch created from main (or rebased) gets the aggregated knowledge

This eliminates the need for any special knowledge-sharing mechanism:
- No append-only API — git handles concurrent evolution
- No DB-backed knowledge table — the file is versioned in git
- No file locking — branches are isolated
- No special read/write path in the executor — it just reads `${worktreePath}/CLAUDE.md`

The executor reads project knowledge the same way it reads global org knowledge:
```js
// Global org knowledge (existing)
const globalPath = orgPath(orgId, 'global', 'CLAUDE.md');

// Project knowledge (from worktree — branch-specific version)
const projectPath = path.join(worktreePath, 'CLAUDE.md');
```

## Agent Roles

### Coordinator (1 per project)
- Assigned at project creation
- **Proposes** milestones, deliverables, folder structure, feature branches, and agent assignments — user approves/tweaks
- Creates and manages feature branches
- Reviews and merges PRs from contributors
- Writes and maintains **integration tests** for the project
- Resolves CLAUDE.md merge conflicts — aggregates knowledge from all branches
- Aggregates progress, updates milestones, reports to user
- Runs cron tasks (daily standup, milestone reviews) that post to project conversation
- Resolves merge conflicts or delegates resolution to branch contributor
- Discovers project state dynamically via `nebula-projects` skill

### Contributors (N per project, multi-instance capable)
- Assigned to feature branches (1 agent per branch, 1+ deliverables per branch)
- Same agent can work on multiple branches simultaneously as separate instances
- Work in their worktree, commit + push to remote
- Write **unit tests** and validate their work before creating PRs
- Update project CLAUDE.md in their branch when discovering important knowledge
- Create PRs when deliverables are ready for review
- Can read main but only write to their assigned feature branch
- Discover assignments dynamically via `nebula-projects` skill
- Respond in project conversation when @mentioned by coordinator

## Milestones & Deliverables

```
Milestone: "Alpha Release"
  ├── Deliverable: "Core gameplay loop implemented"
  │    ├── Pass criteria: "Player can start game, play 3 rounds, see score"
  │    ├── Branch: feature/core-gameplay
  │    ├── Assigned to: RnD
  │    └── Status: in_progress
  ├── Deliverable: "Basic UI wireframe"
  │    ├── Pass criteria: "Main menu, game board, score screen — screenshots in vault"
  │    ├── Branch: feature/core-gameplay  (same branch as above — grouped work)
  │    ├── Assigned to: RnD
  │    └── Status: pending
  └── Deliverable: "Build pipeline working"
       ├── Pass criteria: "Push to main triggers CI build, produces artifact"
       ├── Branch: feature/ci-pipeline
       ├── Assigned to: Pacman
       └── Status: done
```

- Milestones are ordered
- A milestone is "complete" when all deliverables are done
- Multiple deliverables can share a feature branch (grouped work by the same agent)
- When a branch's PR is merged, all deliverables on that branch can be marked done
- Deliverables can be reassigned, added, or removed mid-project
- Coordinator proposes initial milestones from project description; user approves

## Project Conversation

A shared group chat visible to all project agents and the user.

- Conversations table extended with nullable `project_id` (dual nullable columns — see Design Decisions)
- All project agents can read and post
- Messages tagged with agent identity (`agent_id` on each message)
- Coordinator cron tasks post here (e.g. daily standup at 9am: coordinator @mentions each contributor asking for status)
- User can participate directly
- @mentions within the project conversation trigger the mentioned agent to respond

## Project Discovery Skill (`nebula-projects`)

Project context is delivered to agents via a built-in skill rather than hardcoded system prompt injection. Follows the same pattern as `nebula-tasks` and `nebula-agents`.

### What gets embedded in the skill (static, written at execution time)
- Project name, agent's role (coordinator/contributor)
- Current feature branch assignment (if any)
- Working directory (worktree path)
- Git remote provider and URL
- Repo conventions: `vault/` for shared files (specs, assets, references), `CLAUDE.md` for project knowledge
- API endpoints for dynamic queries

### What the agent queries dynamically via API
- Full milestone/deliverable list with statuses
- Branch list with PR statuses (from hosting platform)
- Other agents' assignments and progress
- Merge/conflict status

### Why skill-based, not system prompt
- Project state is dynamic — milestones change, branches get merged mid-session
- Keeps system prompt small — agent fetches only what it needs per task
- Always fresh data — no stale snapshots from execution start time
- Matches existing skill patterns (nebula-tasks, nebula-agents, nebula-mail)

## External Integration Skills

All external integrations are **optional** and **provider-agnostic**. When a user links an external system to a project, a corresponding skill is made available to project agents.

### Issue Tracker Skill (`nebula-issues`)
- Providers: YouTrack, Jira, GitHub Issues, Gitea Issues
- Capabilities: create issues from deliverables, query issue status, update issues, link issues to branches/PRs
- Delivered as a skill with provider-specific API instructions
- Only available when an issue tracker is linked to the project

### Knowledge Base Skill (`nebula-kb`)
- Providers: YouTrack Knowledge Base, Confluence, Notion
- Capabilities: search articles, read documentation, reference external specs
- Complementary to project CLAUDE.md — agents can fetch external context on demand
- Only available when a knowledge base is linked to the project

### CI/CD Skill (`nebula-ci`)
- Providers: TeamCity, Gitea Actions, GitHub Actions
- Capabilities: trigger builds, check build status, read build logs, report failures to project conversation
- Only available when a CI system is linked to the project

### Git LFS Skill (`nebula-git-lfs`)
- Always available for all project agents (common skill)
- Capabilities: track large files, manage `.gitattributes`, check LFS storage

### Architecture
- Each provider is an adapter implementing a common interface (e.g., issue tracker: create, read, update, search)
- Skill content is generated at execution time with provider-specific API instructions
- Credentials stored in project_links config (encrypted via org vault)
- Agents never see raw credentials — skill provides pre-authenticated API patterns

## Resource Discovery

Agents discover available infrastructure through existing mechanisms — no user-defined resource config needed.

- **Server (Docker)**: knows its own hardware + installed tools at boot
- **Remote agents (Tauri app)**: survey host machine on connect, report structured metadata as part of the auth handshake (`msg.device` in `remote-agents.js:55` — already exists, needs richer schema)
- **Peer awareness**: agents discover each other's capabilities via `nebula-agents` skill (already works)
- **Device metadata schema**: OS, arch, CPU model, RAM, GPU, installed toolchains (node, python, go, etc.)
- When a remote agent disconnects and reconnects to a different machine, specs update automatically

## Project Creation

Two creation flows — both result in the same project state.

### Flow A: Manual (via UI)
- User fills out form: name, description, git remote URL, provider, coordinator agent
- Optionally links external systems (issue tracker, KB, CI)
- Backend clones or initializes the repo
- Scaffold ensured (CLAUDE.md, vault/.gitkeep, README.md) — committed to default branch if missing
- Project registered in DB, conversation created

### Flow B: Autonomous (via conversation)
- User tells an agent: "create a new project called X" or "link this repo as a project: git@gitea:Enigma/SomeProject.git"
- The agent the user is talking to becomes the **coordinator by default** (configurable later via UI)
- Agent uses `nebula-projects` skill to:
  - Create a new repo on the hosting platform, or clone an existing one
  - Detect the default branch (main/master)
  - Ensure scaffold exists (CLAUDE.md, vault/.gitkeep, README.md) — commit if missing, no-op if present
  - Register the project in Nebula via API
- Agent can immediately proceed to the PLAN step (propose milestones, assignments)

Both flows end with: project registered in DB, project conversation created, coordinator assigned.

## Project Lifecycle

```
1. CREATE
   - Flow A (manual): user creates via UI with git remote URL + provider
   - Flow B (autonomous): user tells agent to create new or link existing repo
   - In Flow B, the agent the user is talking to becomes coordinator by default
   - Repo cloned or initialized, scaffold ensured (CLAUDE.md, vault/, README.md)
   - Project conversation created

2. PLAN
   - Coordinator analyzes project description (and repo if existing)
   - Proposes milestones, deliverables, feature branches, folder structure, agent assignments
   - User reviews and approves/tweaks the plan
   - Approved milestones + deliverables saved to DB

3. ASSIGN
   - Coordinator creates feature branches from main
   - Contributors get worktree checkouts for their assigned branches
   - Same agent can be assigned to multiple branches (runs as separate instances)
   - nebula-projects skill becomes available to assigned agents
   - Issue tracker issues created if integration is linked

4. EXECUTE
   - Coordinator dispatches work to contributors via project conversation
   - Contributors work in their feature branches, commit + push to remote
   - Contributors write unit tests and validate before creating PRs
   - Contributors update CLAUDE.md in their branch when discovering important knowledge
   - Contributors create PRs on hosting platform when ready
   - Coordinator reviews PRs, merges approved work, resolves CLAUDE.md conflicts
   - Coordinator writes and maintains integration tests
   - Milestones update as deliverables complete
   - Daily standup cron: coordinator @mentions contributors in project conversation

5. REVIEW
   - Coordinator produces milestone reports in project conversation
   - User reviews, adjusts milestones, reassigns if needed
   - Merge conflicts resolved by coordinator (or delegated to branch contributor)

6. COMPLETE
   - All milestones done → project marked complete
   - Final report generated by coordinator
   - Repository left intact for reference
```

## Database Schema

```sql
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  git_remote_url  TEXT NOT NULL,                    -- mandatory: the git remote URL
  git_provider    TEXT NOT NULL DEFAULT 'gitea',    -- gitea, github, gitlab
  coordinator_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  auto_merge      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',   -- active, paused, complete, archived
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_projects_org ON projects(org_id);

CREATE TABLE project_links (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,       -- issue_tracker, knowledge_base, ci
  provider      TEXT NOT NULL,       -- youtrack, jira, github_issues, confluence, notion, teamcity, gitea_actions, github_actions
  url           TEXT NOT NULL,
  config        TEXT NOT NULL DEFAULT '{}',  -- JSON: credentials, project IDs, etc.
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE project_milestones (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending, in_progress, done
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_milestones_project ON project_milestones(project_id);

CREATE TABLE project_deliverables (
  id                TEXT PRIMARY KEY,
  milestone_id      TEXT NOT NULL REFERENCES project_milestones(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  pass_criteria     TEXT NOT NULL DEFAULT '',
  branch_name       TEXT,                           -- feature branch (e.g. 'feature/user-auth')
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending, in_progress, done, blocked
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_deliverables_milestone ON project_deliverables(milestone_id);
CREATE INDEX idx_deliverables_agent ON project_deliverables(assigned_agent_id);
CREATE INDEX idx_deliverables_branch ON project_deliverables(branch_name);

CREATE TABLE project_agents (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'contributor',  -- coordinator, contributor
  max_concurrent  INTEGER NOT NULL DEFAULT 3,           -- max simultaneous branch executions
  PRIMARY KEY (project_id, agent_id)
);
```

### Conversation schema change (migration)

```sql
-- Add nullable project_id to existing conversations table
ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;

-- Existing rows keep agent_id set, project_id NULL (no data change needed)
-- New project conversations: agent_id = NULL, project_id = set
-- CHECK constraint not supported via ALTER TABLE in SQLite — enforced in application layer
-- Index for project conversation queries
CREATE INDEX idx_conversations_project ON conversations(project_id) WHERE project_id IS NOT NULL;
```

Note: SQLite does not support adding CHECK constraints via ALTER TABLE. The mutual exclusivity (exactly one of agent_id or project_id must be non-null) is enforced in application code at insert time. If a full schema rebuild is ever done, add: `CHECK ((agent_id IS NOT NULL) != (project_id IS NOT NULL))`.

## Filesystem Layout

```
/data/orgs/{org_id}/projects/{project_id}/
  └── repo.git/                    # Bare git repository — everything lives here

/data/orgs/{org_id}/agents/{agent_id}/projects/{project_id}/{branch_name}/
  ├── CLAUDE.md                    # Project knowledge (branch-specific version)
  ├── vault/                       # Shared files (specs, assets, references)
  ├── README.md                    # Project readme
  └── src/...                      # Project code
  (worktree checkout of the feature branch)
```

Everything is in git. No project-level files on the filesystem outside the repo.
The `vault/` directory and `CLAUDE.md` are just files in the repo, versioned per branch like any other code.

## API Endpoints

```
# Projects
GET    /api/projects                        # List org projects
POST   /api/projects                        # Create project (requires git_remote_url)
GET    /api/projects/:id                    # Get project detail (includes agents, milestone summary)
PUT    /api/projects/:id                    # Update project
DELETE /api/projects/:id                    # Archive/delete project

# Milestones
GET    /api/projects/:id/milestones         # List milestones with nested deliverables
POST   /api/projects/:id/milestones         # Add milestone
PUT    /api/milestones/:id                  # Update milestone
DELETE /api/milestones/:id                  # Delete milestone

# Deliverables
POST   /api/milestones/:id/deliverables     # Add deliverable
PUT    /api/deliverables/:id                # Update deliverable (status, assignment, branch)
DELETE /api/deliverables/:id                # Delete deliverable

# Agent assignments
GET    /api/projects/:id/agents             # List assigned agents with roles + max_concurrent
POST   /api/projects/:id/agents             # Assign agent to project
PUT    /api/projects/:id/agents/:agentId    # Update agent config (role, max_concurrent)
DELETE /api/projects/:id/agents/:agentId    # Remove agent from project

# Git operations (Phase 2)
GET    /api/projects/:id/branches           # List branches with PR status from hosting platform
POST   /api/projects/:id/branches           # Create feature branch from main
DELETE /api/projects/:id/branches/:name     # Delete merged branch
GET    /api/projects/:id/diff/:branch       # Diff a branch against main

# PR operations (Phase 2 — proxied to hosting platform)
POST   /api/projects/:id/pr                 # Create PR on hosting platform
GET    /api/projects/:id/pr                 # List open PRs
POST   /api/projects/:id/pr/:number/merge   # Merge PR on hosting platform

# Project conversation (Phase 3)
GET    /api/projects/:id/messages           # Messages in project conversation
POST   /api/projects/:id/messages           # Post to project conversation (triggers agent execution)

# External links
GET    /api/projects/:id/links              # List linked external systems
POST   /api/projects/:id/links              # Add external link (issue tracker, KB, CI)
PUT    /api/projects/:id/links/:linkId      # Update link config
DELETE /api/projects/:id/links/:linkId      # Remove link

# Vault (read-only view of vault/ on main, via git ls-tree / git show on bare repo)
GET    /api/projects/:id/vault              # List files in vault/ on main (name, size, type)
GET    /api/projects/:id/vault/*path        # Read file content — text rendered inline, binary as download
```

## Frontend Views

- **Project list** — cards showing name, status, coordinator, milestone progress bar
- **Project detail** — tabbed: Overview, Milestones, Conversation, Vault, Settings
- **Vault tab** — file browser for `vault/` on main. Text files (md, code, config) rendered inline with syntax highlighting. Images displayed. Other binaries downloadable. Read-only — modifications happen through agent PRs
- **Milestones view** — ordered list, deliverables nested with branch + PR status badges, assigned agent avatars
- **Project conversation** — group chat UI (similar to agent chat but multi-agent, messages show agent identity)
- **Create project wizard** — name, description, git remote URL, provider selector, coordinator selection
- **Settings tab** — external links management (issue tracker, KB, CI), auto-merge toggle, per-agent concurrency cap
- **Sidebar** — new "Projects" section below agents

## Implementation Phases

### Phase 0 — Executor Concurrency (prerequisite)

**Goal**: Allow an agent to execute concurrently across different contexts (global vs project/branch combinations) while serializing within the same branch. Support multi-instance agents.

**Backend changes**:
- `executor.js`: change queue key from `agentId` to `agentId:projectId:branchName`
- `activeKeys` set replaces `activeAgents` set (stores composite keys)
- Per-agent concurrency cap enforcement: count active keys matching `agentId:projectId:*`, compare against `max_concurrent` from `project_agents`
- `abortControllers` map uses composite key
- `cancel(agentId, projectId?, branchName?)` — cancel specific context or all contexts for an agent
- `enqueue(agentId, prompt, { projectId, branchName, ... })` — project and branch in options
- `agent_typing` event includes `projectId` and `branchName` so frontend knows which view to update

**Tests** (`tests/executor.test.js`):
- Two jobs for same agent with different branches execute concurrently
- Two jobs for same agent with same branch execute sequentially (second waits)
- Job with no projectId (global) doesn't block project jobs for same agent
- Concurrency cap: 4th concurrent job queues when max_concurrent = 3
- Cancel with branch only cancels that context
- Cancel with projectId cancels all branches for that agent in that project
- Cancel without args cancels global context only
- Queue drains correctly after concurrent completions

### Phase 1 — Data Model & CRUD API

**Goal**: All project tables, full CRUD, no git, no execution.

**Backend changes**:
- Migration `005_projects.sql`: all project tables + conversation schema change
- `src/routes/projects.js`: CRUD for projects, milestones, deliverables, agent assignments, external links
- Org scoping on all queries (like existing routes)
- Validation: project names unique per org, git_remote_url required, coordinator must exist, assigned agents must exist
- Cascade deletes: project deletion cleans up milestones, deliverables, agent assignments, links
- Application-level check: conversations must have exactly one of agent_id or project_id

**Tests** (`tests/projects.test.js`):
- CRUD projects: create (requires git_remote_url), read, update, delete
- Org scoping: can't see other org's projects
- Milestones: create, reorder, update status, delete cascades deliverables
- Deliverables: create with branch_name, assign agent, update status, multiple deliverables on same branch
- Agent assignments: assign, remove, prevent duplicate, coordinator role enforced (max 1), max_concurrent configurable
- External links: add, update, remove, provider validation
- Cascade: deleting project removes all milestones, deliverables, assignments, links
- Validation: duplicate project names rejected, nonexistent agent rejected, missing git_remote_url rejected
- Conversation creation: project conversation created with project_id set, agent_id null
- Existing agent conversation queries still work (backward compatibility)

**Frontend**:
- Project list page with create button
- Create project form (name, description, git remote URL, provider, coordinator dropdown)
- Project detail page with milestone/deliverable management
- Settings tab for external links
- Sidebar "Projects" section

### Phase 2 — Git Worktrees & PR Workflow

**Goal**: Projects have real git repos, agents work in isolated worktrees, PR-based merge flow, multi-instance execution.

**Backend changes**:
- `src/services/git.js`: new service for git operations
  - `initProjectRepo(projectPath, { name, description })` — `git init --bare`, scaffold initial commit (CLAUDE.md, vault/.gitkeep, README.md), push to remote
  - `addRemote(repoPath, url)` — `git remote add origin`
  - `syncRemote(repoPath)` — `git fetch origin`
  - `createBranch(repoPath, branchName)` — branch from main, push to remote
  - `createWorktree(repoPath, worktreePath, branchName)` — `git worktree add`
  - `removeWorktree(repoPath, worktreePath)` — `git worktree remove`
  - `listBranches(repoPath)` — branches with ahead/behind main
  - `rebaseWorktree(worktreePath)` — rebase feature branch on latest main
- `src/services/git-providers.js`: hosting platform abstraction
  - Interface: `createPR(branch, title, body)`, `listPRs()`, `mergePR(number)`, `getPRStatus(number)`
  - Implementations: Gitea adapter, GitHub adapter (GitLab later if needed)
- Project creation initializes repo with scaffold (CLAUDE.md, vault/.gitkeep, README.md), adds remote, pushes
- Deliverable assignment creates feature branch + worktree
- Same agent assigned to multiple branches → multiple worktrees (multi-instance)
- PR operations proxied to hosting platform
- Executor: resolve CWD to worktree path using `projectId + branchName`
- Executor: read project CLAUDE.md from worktree (branch-specific version)
- `nebula-projects` built-in skill written by executor with PR management capabilities
- `nebula-git-lfs` common skill available to all project agents

**Tests** (`tests/git.test.js`):
- Repo scaffold: initial commit has CLAUDE.md, vault/.gitkeep, README.md
- Branch creation from main
- Worktree creation and removal
- Two worktrees can have independent changes
- Branch ahead/behind calculation
- CLAUDE.md modified independently in two branches
- Remote add (validates git config)

**Tests** (`tests/projects-git.test.js`):
- Assign deliverable with branch → branch + worktree created on disk
- Remove agent from project → all worktrees cleaned up
- Same agent, two branches → two independent worktrees created
- Executor with projectId + branchName uses correct worktree path as CWD
- Executor reads project CLAUDE.md from worktree, not filesystem
- nebula-projects skill written with correct project/branch context
- Multiple deliverables on same branch share one worktree
- After branch merge, worktree rebases to latest main

**Tests** (`tests/git-providers.test.js`):
- Gitea adapter: create PR, list PRs, merge PR (mock HTTP)
- GitHub adapter: same (mock HTTP)
- Provider selection based on project's git_provider field

### Phase 3 — Project Conversation & Coordinator Skills

**Goal**: Multi-agent group chat per project, coordinator can manage project via skill.

**Backend changes**:
- Project conversation: created on project creation (project_id set, agent_id null)
- `POST /api/projects/:id/messages`: posts message, triggers execution for target agent in project context
- @mention routing within project conversation (reuse existing pattern from messages.js)
- `nebula-projects` skill extended with full API:
  - List/update milestones and deliverables
  - Create feature branches, assign agents
  - Create/review/merge PRs via hosting platform
  - Post to project conversation
  - Propose milestones from project description (coordinator only)
- Coordinator cron task support: post standup to project conversation

**Tests** (`tests/projects-conversation.test.js`):
- Create project → project conversation exists
- Post message to project conversation → stored with correct project_id
- Messages from multiple agents appear in same conversation
- @mention in project conversation triggers mentioned agent
- Project conversation messages visible to all assigned agents
- Non-assigned agent can't post to project conversation
- Org scoping: can't access other org's project conversations

### Phase 4 — External Integration Skills

**Goal**: Optional, provider-agnostic integrations for issue tracking, KB, and CI.

**Backend changes**:
- `src/services/integrations/` directory with provider adapters:
  - Issue tracker: YouTrack, Jira, GitHub Issues, Gitea Issues
  - Knowledge base: YouTrack KB, Confluence, Notion
  - CI/CD: TeamCity, Gitea Actions, GitHub Actions
- Common interface per integration type (e.g., issue tracker: create, read, update, search)
- Skills generated dynamically based on linked integrations:
  - `nebula-issues` — issue tracker operations
  - `nebula-kb` — knowledge base search and retrieval
  - `nebula-ci` — build triggers, status, logs
- Credentials stored in project_links config (encrypted via org vault)
- Webhook endpoints for inbound status updates (issue resolved, build completed, etc.)

**Tests** (`tests/integrations.test.js`):
- Issue tracker adapter: create issue, update status, search (mock HTTP, per provider)
- KB adapter: search articles, read article (mock HTTP, per provider)
- CI adapter: trigger build, get status (mock HTTP, per provider)
- Inbound webhook updates deliverable status
- Build status posted to project conversation
- Integration link CRUD with provider validation
- Skills only generated when corresponding integration is linked
- Invalid webhook payloads rejected

### Phase 5 — Project Intelligence & Dashboard

**Goal**: Coordinator actively manages projects, dashboard for user oversight.

**Backend changes**:
- Coordinator auto-proposes milestones from project description + repo analysis
- Auto-merge for clean PRs (when `auto_merge` enabled)
- Coordinator milestone reports (cron-driven, posted to project conversation)
- Project dashboard API: milestone progress, agent activity, branch/PR status summary

**Frontend**:
- Project dashboard: milestone progress bars, agent activity timeline, branch/PR status
- Milestone burndown or timeline view

## Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Git only | No P4/Perforce | Git + LFS covers 90% of cases. P4 projects need more human oversight than autonomous orchestration can safely provide |
| Git remote | Mandatory | Remote is source of truth. Provider (Gitea/GitHub/GitLab) is configurable |
| Branch model | Feature branches, not agent branches | Branches are named by feature and assigned to agents. When merged, branch is done, agent moves on. Maps to real dev workflow |
| Multi-instance agents | Same agent, multiple branches, concurrent execution | Branches are isolated worktrees — no conflicts possible. Coordinator handles merge. Capped by `max_concurrent` per agent per project |
| Merge flow | PR-based via hosting platform | PRs on Gitea/GitHub, not local merges. Hosting platform handles review UI, CI checks. Coordinator merges via API |
| Everything in git | CLAUDE.md, vault/, code — all versioned in the repo | No filesystem state outside the bare repo. vault/ is a directory in git, not a separate API. CLAUDE.md is branch-aware. Knowledge and assets merge via PRs like code |
| Testing responsibility | Contributors: unit tests. Coordinator: integration tests | Contributors validate their own work before PR. Coordinator ensures merged code works together |
| Conflict resolution | Coordinator merges or notifies branch owner | Coordinator doesn't push to contributor branches without notification |
| External integrations | All optional, provider-agnostic | Issue tracker, KB, CI are opt-in. Multiple providers per type. Delivered as skills only when linked |
| Conversation ownership | Dual nullable columns (`agent_id`, `project_id`) | Preserves FK constraints and cascade deletes. CHECK enforced in app layer due to SQLite ALTER TABLE limitation |
| Project discovery | `nebula-projects` skill with API endpoints | Dynamic queries give fresh data. System prompt injection would be stale and waste tokens |
| Executor concurrency | Three-part queue key `agentId:projectId:branchName` | Enables multi-instance agents. Serializes within same branch, parallel across branches. Replaces the "subsession" TODO |
| Resource discovery | Remote agent hardware survey on connect | Tauri app reports structured device metadata. Not user-defined — the machine itself is source of truth |
| Coordinator planning | Coordinator proposes, user approves | Reduces upfront user work. Coordinator analyzes description and suggests milestones, branches, assignments |
| Database | Stay on SQLite | Migration to Postgres is bounded (~150 await additions + dialect changes) when SaaS demands it. No decisions lock us in |

## Test Project: Nebula API Docs Site

First project to validate the feature end-to-end:
- **Goal**: Generate a static API documentation site from Nebula's own `src/routes/*.js`
- **Git remote**: Gitea repo on NAS
- **Coordinator**: Secretary (or similar) — plans docs structure, reviews PRs, merges, writes integration tests
- **Contributor**: R&D — assigned to multiple feature branches concurrently (multi-instance):
  - `feature/api-routes-docs` — reads route files, generates markdown API docs
  - `feature/static-site` — builds static HTML site from markdown
  - Both branches include unit tests
- **Deploy**: nginx container on NAS for visual verification
- **Why this scope**: derived content (low risk), exercises multi-instance agents, real branching/merging/PRs, visible output, validates the full lifecycle
