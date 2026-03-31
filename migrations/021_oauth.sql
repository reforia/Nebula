-- Link shadow users to Enigma Platform accounts
ALTER TABLE users ADD COLUMN platform_user_id TEXT;

-- Unique index — allows multiple NULLs (legacy local users) while preventing duplicate platform links
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_platform_id
  ON users(platform_user_id) WHERE platform_user_id IS NOT NULL;
