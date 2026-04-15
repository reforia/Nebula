-- Transient column for dreaming session handoff.
-- Stores the agent's self-authored context summary between the dreaming
-- execution (which writes it) and the initialization execution (which
-- consumes it and clears it). NULL when no handoff is pending.
ALTER TABLE conversations ADD COLUMN compact_context TEXT DEFAULT NULL;
