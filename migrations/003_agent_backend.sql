-- Add backend column to agents for execution backend selection
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so this may
-- fail silently on re-run if column already exists (handled by migration tracking)
ALTER TABLE agents ADD COLUMN backend TEXT NOT NULL DEFAULT 'claude-cli';
