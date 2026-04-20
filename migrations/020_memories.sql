-- Memory system: structured, API-managed agent and project memories
CREATE TABLE IF NOT EXISTS memories (
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

CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(owner_type, owner_id);
