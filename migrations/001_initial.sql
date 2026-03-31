-- Baseline schema: all tables as of initial multi-user/multi-org release

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orgs_owner ON organizations(owner_id);

CREATE TABLE IF NOT EXISTS org_settings (
  org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (org_id, key)
);

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT '',
  emoji           TEXT NOT NULL DEFAULT '🤖',
  session_id      TEXT NOT NULL UNIQUE,
  allowed_tools   TEXT NOT NULL DEFAULT 'Read,Grep,Glob,WebFetch,Bash',
  model           TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  security_tier   TEXT NOT NULL DEFAULT 'standard',
  enabled         INTEGER NOT NULL DEFAULT 1,
  notify_email    INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  session_initialized INTEGER NOT NULL DEFAULT 0,
  nas_paths       TEXT NOT NULL DEFAULT '[]',
  execution_mode  TEXT NOT NULL DEFAULT 'local',
  remote_token    TEXT,
  remote_last_seen TEXT,
  remote_device    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org_id);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  message_type    TEXT NOT NULL DEFAULT 'chat',
  task_name       TEXT,
  metadata        TEXT,
  is_read         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_agent_time ON messages(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(agent_id, is_read) WHERE is_read = 0;
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  trigger_type    TEXT NOT NULL DEFAULT 'cron',
  cron_expression TEXT,
  webhook_secret  TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  max_turns       INTEGER NOT NULL DEFAULT 10,
  timeout_ms      INTEGER NOT NULL DEFAULT 600000,
  last_run_at     TEXT,
  last_status     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title               TEXT NOT NULL DEFAULT 'New conversation',
  session_id          TEXT NOT NULL,
  session_initialized INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id, created_at);

CREATE TABLE IF NOT EXISTS custom_skills (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id    TEXT REFERENCES agents(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_custom_skills_org ON custom_skills(org_id);
CREATE INDEX IF NOT EXISTS idx_custom_skills_agent ON custom_skills(agent_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default system settings
INSERT OR IGNORE INTO settings (key, value) VALUES ('max_concurrent_agents', '2');
