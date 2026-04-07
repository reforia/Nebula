-- Clear stale timeout_ms=600000 left over from pre-025 default.
-- These tasks should inherit from agent/org default instead.
UPDATE tasks SET timeout_ms = NULL WHERE timeout_ms = 600000;
