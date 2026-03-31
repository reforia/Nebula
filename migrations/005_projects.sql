-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  git_remote_url  TEXT NOT NULL,
  git_provider    TEXT NOT NULL DEFAULT 'gitea',
  coordinator_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  auto_merge      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

-- External links (issue tracker, KB, CI — all optional)
CREATE TABLE IF NOT EXISTS project_links (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  provider      TEXT NOT NULL,
  url           TEXT NOT NULL,
  config        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Milestones
CREATE TABLE IF NOT EXISTS project_milestones (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_milestones_project ON project_milestones(project_id);

-- Deliverables
CREATE TABLE IF NOT EXISTS project_deliverables (
  id                TEXT PRIMARY KEY,
  milestone_id      TEXT NOT NULL REFERENCES project_milestones(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  pass_criteria     TEXT NOT NULL DEFAULT '',
  branch_name       TEXT,
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deliverables_milestone ON project_deliverables(milestone_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_agent ON project_deliverables(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_branch ON project_deliverables(branch_name);

-- Agent assignments
CREATE TABLE IF NOT EXISTS project_agents (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'contributor',
  max_concurrent  INTEGER NOT NULL DEFAULT 3,
  PRIMARY KEY (project_id, agent_id)
);

-- Recreate conversations table to make agent_id nullable and add project_id
-- SQLite can't ALTER COLUMN, so we recreate the table
CREATE TABLE IF NOT EXISTS conversations_new (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT REFERENCES agents(id) ON DELETE CASCADE,
  project_id          TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title               TEXT NOT NULL DEFAULT 'New conversation',
  session_id          TEXT NOT NULL,
  session_initialized INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO conversations_new (id, agent_id, project_id, title, session_id, session_initialized, created_at, updated_at)
SELECT id, agent_id, NULL, title, session_id, session_initialized, created_at, updated_at
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id) WHERE project_id IS NOT NULL;
