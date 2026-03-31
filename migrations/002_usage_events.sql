-- Usage event logging for billing/analytics
CREATE TABLE IF NOT EXISTS usage_events (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  conversation_id TEXT,
  backend         TEXT NOT NULL DEFAULT 'claude-cli',
  model           TEXT,
  tokens_in       INTEGER DEFAULT 0,
  tokens_out      INTEGER DEFAULT 0,
  total_cost      REAL DEFAULT 0,
  duration_ms     INTEGER DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'success',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_org ON usage_events(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_events(agent_id, created_at);
