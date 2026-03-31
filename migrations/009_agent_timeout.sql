-- Add timeout_ms column to agents for per-agent execution timeout
-- NULL means "inherit org default" (which itself defaults to 600000ms / 10 min)

ALTER TABLE agents ADD COLUMN timeout_ms INTEGER;
