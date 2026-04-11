-- Track which CLI runtime was used for the current session.
-- When runtime changes, the session must be reset (different CLIs have incompatible session IDs).
ALTER TABLE conversations ADD COLUMN session_runtime TEXT DEFAULT NULL;
