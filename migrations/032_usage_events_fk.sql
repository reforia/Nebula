-- Add FKs to usage_events. org_id cascades (org deletion purges history).
-- agent_id becomes nullable with SET NULL so audit rows survive agent deletion.
-- Rows referencing a missing organization are dropped during the copy.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE usage_events_new (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        TEXT    REFERENCES agents(id)        ON DELETE SET NULL,
  conversation_id TEXT,
  backend         TEXT NOT NULL DEFAULT 'claude-cli',
  model           TEXT,
  tokens_in       INTEGER DEFAULT 0,
  tokens_out      INTEGER DEFAULT 0,
  total_cost      REAL    DEFAULT 0,
  duration_ms     INTEGER DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'success',
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO usage_events_new
  (id, org_id, agent_id, conversation_id, backend, model,
   tokens_in, tokens_out, total_cost, duration_ms, status, error_message, created_at)
SELECT u.id, u.org_id,
       CASE WHEN EXISTS (SELECT 1 FROM agents a WHERE a.id = u.agent_id)
            THEN u.agent_id ELSE NULL END,
       u.conversation_id, u.backend, u.model,
       u.tokens_in, u.tokens_out, u.total_cost, u.duration_ms, u.status,
       u.error_message, u.created_at
FROM usage_events u
WHERE EXISTS (SELECT 1 FROM organizations o WHERE o.id = u.org_id);

DROP TABLE usage_events;
ALTER TABLE usage_events_new RENAME TO usage_events;

CREATE INDEX idx_usage_org   ON usage_events(org_id, created_at);
CREATE INDEX idx_usage_agent ON usage_events(agent_id, created_at);

COMMIT;

PRAGMA foreign_keys = ON;
