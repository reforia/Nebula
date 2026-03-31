-- Track whether an agent has completed its self-initialization
-- (scouted environment, built org profile, established working context).
ALTER TABLE agents ADD COLUMN initialized INTEGER NOT NULL DEFAULT 0;
