CREATE TABLE IF NOT EXISTS agent_secrets (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_secrets_agent ON agent_secrets(agent_id);
