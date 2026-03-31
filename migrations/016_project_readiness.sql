-- Project readiness checklist for agent-created prerequisites.
-- System checks are derived at runtime, not stored here.
CREATE TABLE IF NOT EXISTS project_checklist (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  met        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, label)
);

CREATE INDEX IF NOT EXISTS idx_project_checklist_project ON project_checklist(project_id);

-- Track when webhook communication was last verified.
ALTER TABLE projects ADD COLUMN webhook_verified_at TEXT DEFAULT NULL;
