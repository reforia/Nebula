# Nebula Memory System — Design Specification

## Overview

Nebula manages agent memory as structured data in the database, replacing file-based memory with API-managed concepts. Memory is scoped by context (agent or project), with progressive disclosure (metadata always visible, content on demand via search and read skills). A unified search skill queries local memories and external knowledge bases in a single call.

## Core Principles

1. **Memory is API-managed.** Agents create, read, update, and delete memories through HTTP endpoints, not file writes. The server owns the data.
2. **Scope determines write access.** An agent in main context writes to agent memory. An agent in project context writes to project memory. The skill is the same; the server routes by execution context.
3. **Read access is aggregated.** An agent always sees its own memories + the current project's memories (if in project context). Two scopes, one view.
4. **Task stacks are read-only.** Sub-agents in task frames (branch work) can read memories but not write. They execute, return results, and the parent decides what to persist.
5. **Knowledge flows upward.** Task → project agent reviews → project memory. Project memory → main agent reviews → agent memory. Never forced downward.
6. **Progressive disclosure.** Titles + descriptions always in system prompt. Search for discovery. Read for full content.

## Data Model

### Memories Table

```sql
CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL,          -- 'agent' or 'project'
    owner_id TEXT NOT NULL,            -- agent_id or project_id
    title TEXT NOT NULL,
    description TEXT NOT NULL,         -- one-line summary
    content TEXT NOT NULL,             -- full knowledge content
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(owner_type, owner_id, title COLLATE NOCASE)
);

CREATE INDEX idx_memories_owner ON memories(owner_type, owner_id);
```

### Search Index

Built from memory content using BM25/TF-IDF. Rebuilt on every memory write (create, update, delete). At typical corpus sizes (30-120 documents per agent+project), full rebuild is microseconds.

The index is an in-memory structure, not a separate table. Rebuilt on server start and on any memory mutation.

## Scope and Access Control

### Write Access

| Execution Context | `update_memory` writes to | Enforced by |
|---|---|---|
| Main conversation | `memories WHERE owner_type='agent' AND owner_id=agent_id` | Server routes by context |
| Project conversation | `memories WHERE owner_type='project' AND owner_id=project_id` | Server routes by context |
| Task stack (branch work) | **Rejected** — task clones cannot write memory | Server rejects + skill not injected |

### Read Access

| Execution Context | Visible memories |
|---|---|
| Main conversation | Agent memories |
| Project conversation | Agent memories (read-only) + Project memories |
| Task stack | Agent memories (read-only) + Project memories (read-only) |

### Skill Injection

The `nebula-memory` built-in skill is injected with context-appropriate content:

- **Main context:** "You are updating your personal memory."
- **Project context:** "You are updating project memory for [Project Name]. Your personal memories are read-only here."
- **Task context:** Skill describes read/search only. No update capability described. Backend rejects write attempts as secondary guard.

## API Endpoints

### CRUD

```
POST   /api/agents/:agentId/memory          — Create memory concept
GET    /api/agents/:agentId/memory          — List all memory metadata (titles + descriptions)
GET    /api/agents/:agentId/memory/:id      — Read full memory content
PUT    /api/agents/:agentId/memory/:id      — Update memory concept
DELETE /api/agents/:agentId/memory/:id      — Delete memory concept

POST   /api/projects/:projectId/memory       — Create project memory
GET    /api/projects/:projectId/memory       — List project memory metadata
GET    /api/projects/:projectId/memory/:id   — Read full project memory content
PUT    /api/projects/:projectId/memory/:id   — Update project memory
DELETE /api/projects/:projectId/memory/:id   — Delete project memory
```

All endpoints are org-scoped via JWT middleware.

On create/update:
1. Validate title uniqueness (case-insensitive) within scope
2. Store/update content
3. Rebuild search index for this scope

### Search

```
POST /api/memory/search
Body: { query: string, agent_id: string, project_id?: string }

Returns: [
    { id, title, description, snippet, score, source: 'agent' | 'project' | 'kb:provider' }
]
```

Search flow:
1. BM25 query against agent memories
2. If project_id provided, BM25 query against project memories
3. If project has KB integration links, query external KBs
4. Merge results, sort by score, return with source tags

External KB queries are best-effort — timeout after N seconds, return local results if external fails.

## System Prompt Injection

At each execution, inject memory metadata into the system prompt:

```
## Your Memories
Use search_memory(query) to find relevant knowledge.
Use read_memory(title) to load full content.
[Use update_memory(title, description, content) to store learnings.]  ← omitted in task context

Personal (N concepts):
- Title: one-line description
- Title: one-line description
...

Project "Name" (M concepts):       ← only in project/task context
- Title: one-line description
...
```

This metadata section is regenerated per execution. At 100 concepts with ~60 chars per line, this is ~6KB — well within acceptable system prompt budget.

## Built-in Skill: nebula-memory

### Skill Definition (context-dependent)

**Main context:**
```
# Memory Management

You have a persistent memory system for storing knowledge and learnings.
You are updating your PERSONAL memory — knowledge that persists across all contexts.

## Available Operations

- search_memory(query): Search your memories by keyword. Returns ranked results with snippets.
  curl -X POST http://localhost:8080/api/memory/search \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"query": "...", "agent_id": "YOUR_ID"}'

- read_memory(title): Load full content of a memory concept.
  curl http://localhost:8080/api/agents/YOUR_ID/memory/MEMORY_ID \
    -H "Authorization: Bearer $TOKEN"

- update_memory(title, description, content): Create or update a memory concept.
  curl -X POST http://localhost:8080/api/agents/YOUR_ID/memory \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"title": "...", "description": "...", "content": "..."}'

- delete_memory(id): Remove a memory concept.
  curl -X DELETE http://localhost:8080/api/agents/YOUR_ID/memory/MEMORY_ID \
    -H "Authorization: Bearer $TOKEN"
```

**Project context:**
```
# Memory Management

You have access to two memory scopes:
- Personal memory (read-only in project context)
- Project memory for "[Project Name]" (read/write)

## Available Operations

- search_memory(query): Search across personal + project memories.
  Returns results tagged with their source.

- read_memory(title): Load full content of any visible memory.

- update_memory(title, description, content): Create or update PROJECT memory.
  Note: You cannot modify personal memory from project context.
  If you discover something broadly useful, note it in your work summary
  for your main identity to review.
```

**Task context:**
```
# Memory Reference

You have read-only access to memories for reference during this task.

- search_memory(query): Search for relevant knowledge.
- read_memory(title): Load full content.

You cannot modify memories during task execution. Include any learnings
in your work summary when the task completes.
```

## Memory Cleanup Task

A native cron task (toggleable per agent) that triggers the main agent to review and organize its memories:

**Prompt:**
```
Review your memories for quality and organization:
1. Search for duplicates or near-duplicates — merge them
2. Identify outdated information — update or remove
3. Look for overly vague descriptions — clarify them
4. Check for concepts that should be split into separate memories
5. Review project memories from your active projects for knowledge
   worth promoting to your personal memory

Use search_memory, read_memory, update_memory, and delete_memory as needed.
```

This runs in the agent's main context (not project context), so it has write access to agent memory and read access to all project memories. Queued like any other execution — if the agent is busy, it waits.

## Task Stack Memory Flow

When a task stack (branch work) completes and pops:

1. The executor captures the task's work summary (agent's final response)
2. This is returned to the parent context (project agent) as a message
3. The project agent reviews the summary naturally
4. If the summary contains learnings worth persisting, the project agent
   calls `update_memory` to store them in project memory
5. No special merge protocol — just the agent responding to information

The transaction is implicit in the conversation, not a separate data structure.

## External Integration (Unified Search, Scoped Write)

When a project has integration links (issue tracker, knowledge base, CI), Nebula auto-generates native skills for each linked service. These are project-scoped — only injected when agents execute in that project's context.

### Read: Unified Search

The `search_memory` endpoint fans out to multiple sources in parallel:

1. Local agent memories (BM25)
2. Local project memories (BM25)
3. External KBs configured via project integration links

| Provider | Query mechanism |
|---|---|
| Confluence | CQL search API |
| Notion | Search API with query filter |
| YouTrack | Issue search with text query |
| Custom | Configurable URL template with query parameter |

Results are merged, sorted by score, and tagged with source:

```
Results:
1. [memory] JWT Auth — "...refresh tokens rotate on each use..."
2. [kb:confluence] Auth Service Design — "...OAuth2 PKCE flow..."
   url: https://wiki.example.com/pages/12345
3. [kb:youtrack] AUTH-142 — "Token refresh fails on clock skew >30s"
   url: https://youtrack.example.com/issue/AUTH-142
```

External results include enough metadata (URL, page/issue ID) for the agent to act on them using the auto-generated write skills.

External queries timeout after 5 seconds — local results are always returned regardless of external success.

### Write: Source-Specific Skills

Writes are NOT unified — each external service has its own auto-generated skill:

| Source tag | Write mechanism |
|---|---|
| `[memory]` | `update_memory` skill (same endpoint, context-routed) |
| `[kb:confluence]` | Auto-generated `nebula-confluence` skill (Confluence REST API) |
| `[kb:youtrack]` | Auto-generated `nebula-youtrack` skill (YouTrack REST API) |
| `[kb:notion]` | Auto-generated `nebula-notion` skill (Notion API) |

The agent sees the source tag on search results and uses the corresponding skill to write back. No abstraction layer for writes — each provider has different data models (pages vs issues vs blocks), and the auto-generated skills expose provider-appropriate operations.

### Auto-Generation Flow

1. User links external service to project (e.g., Confluence KB with URL + credentials)
2. Nebula auto-generates a project-scoped skill for that service
3. Skill includes read/write/query operations with pre-authenticated API calls
4. Skill is injected into agents executing in that project context
5. Search endpoint also queries the service when searching in that project
6. No manual skill authoring needed — user connects, Nebula handles the rest

## Migration Path

### From file-based memory

Existing agents have `memory/` directories with markdown files. Migration:
1. On first boot after upgrade, scan each agent's `memory/` directory
2. Parse any files with frontmatter (title, description) → insert into `memories` table
3. Files without frontmatter → use filename as title, first line as description, rest as content
4. Rename `memory/` to `memory.bak/` (preserve but don't use)
5. CLAUDE.md reference to memory files → update to describe the new skill

### CLAUDE.md changes

Remove memory directory instructions from `nebula-workspace` skill. Memory is now fully API-managed — no filesystem references needed.
