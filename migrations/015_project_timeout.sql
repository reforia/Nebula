-- Project-level timeout override. When set, project tasks use this instead of agent/org default.
ALTER TABLE projects ADD COLUMN timeout_ms INTEGER DEFAULT NULL;
