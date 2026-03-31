-- Project-scoped secrets. Sibling to agent secrets (not hierarchical).
-- In project context: org secrets + project secrets (agent secrets excluded).
-- In agent context: org secrets + agent secrets (project secrets excluded).
CREATE TABLE IF NOT EXISTS project_secrets (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_project_secrets_project ON project_secrets(project_id);
