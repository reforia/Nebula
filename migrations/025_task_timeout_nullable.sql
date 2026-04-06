-- SQLite doesn't support ALTER COLUMN, so recreate the table with nullable timeout_ms
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'cron',
  cron_expression TEXT,
  webhook_secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_turns INTEGER NOT NULL DEFAULT 10,
  timeout_ms INTEGER DEFAULT NULL,
  last_run_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  project_id TEXT DEFAULT NULL REFERENCES projects(id) ON DELETE SET NULL
);

INSERT INTO tasks_new SELECT * FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
