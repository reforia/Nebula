-- Ensure no agents have NULL/empty backend (safety net for registry resolution)
UPDATE agents SET backend = 'claude-cli' WHERE backend IS NULL OR backend = '';
