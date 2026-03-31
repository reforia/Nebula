-- Optional API URL override per project. Used when the git hosting API
-- is on a different port/host than what's derivable from the SSH remote URL.
ALTER TABLE projects ADD COLUMN git_api_url TEXT DEFAULT NULL;
