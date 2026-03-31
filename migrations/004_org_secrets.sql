-- Org-scoped secrets vault (write-only from UI, resolved in skill content at runtime)

CREATE TABLE IF NOT EXISTS org_secrets (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, key)
);

CREATE INDEX IF NOT EXISTS idx_org_secrets_org ON org_secrets(org_id);
