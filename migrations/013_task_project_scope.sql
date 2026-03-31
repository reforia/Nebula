-- Allow tasks to be scoped to a project (fires in project conversation context).
-- Nullable: existing agent-only tasks keep project_id = NULL.
ALTER TABLE tasks ADD COLUMN project_id TEXT DEFAULT NULL REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id) WHERE project_id IS NOT NULL;
