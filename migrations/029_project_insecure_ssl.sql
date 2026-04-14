-- Allow projects to skip TLS certificate verification for self-signed Gitea instances
ALTER TABLE projects ADD COLUMN git_insecure_ssl INTEGER NOT NULL DEFAULT 0;
