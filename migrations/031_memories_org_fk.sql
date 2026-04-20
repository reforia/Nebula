-- Add org_id + FK to memories, cascade-delete on org/agent/project delete.
-- Orphan memories (no matching agent/project) are dropped during the copy.
-- Foreign keys must be toggled outside the transaction.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE memories_new (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, owner_type, owner_id, title COLLATE NOCASE)
);

INSERT INTO memories_new (id, org_id, owner_type, owner_id, title, description, content, created_at, updated_at)
SELECT m.id,
       COALESCE(a.org_id, p.org_id) AS org_id,
       m.owner_type, m.owner_id, m.title, m.description, m.content, m.created_at, m.updated_at
FROM memories m
LEFT JOIN agents   a ON m.owner_type = 'agent'   AND m.owner_id = a.id
LEFT JOIN projects p ON m.owner_type = 'project' AND m.owner_id = p.id
WHERE COALESCE(a.org_id, p.org_id) IS NOT NULL;

DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;

CREATE INDEX idx_memories_owner ON memories(owner_type, owner_id);
CREATE INDEX idx_memories_org   ON memories(org_id);

-- Polymorphic owner_id can't use a single FK. Triggers enforce cleanup when
-- the owning agent or project is deleted (org-level cleanup is covered by
-- the FK above).
CREATE TRIGGER memories_cleanup_on_agent_delete
AFTER DELETE ON agents
BEGIN
  DELETE FROM memories WHERE owner_type = 'agent' AND owner_id = OLD.id;
END;

CREATE TRIGGER memories_cleanup_on_project_delete
AFTER DELETE ON projects
BEGIN
  DELETE FROM memories WHERE owner_type = 'project' AND owner_id = OLD.id;
END;

COMMIT;

PRAGMA foreign_keys = ON;
