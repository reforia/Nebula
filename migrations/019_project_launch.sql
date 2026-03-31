-- Explicit launch gate: projects require deliberate activation, not auto-promotion.
-- launched_at is NULL until user/agent explicitly launches.
ALTER TABLE projects ADD COLUMN launched_at TEXT DEFAULT NULL;

-- Track which project secret key holds the git API token.
-- Allows per-project tokens instead of only org-level tokens.
ALTER TABLE projects ADD COLUMN git_token_key TEXT DEFAULT NULL;
