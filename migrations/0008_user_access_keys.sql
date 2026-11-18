CREATE TABLE IF NOT EXISTS user_access_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_access_keys_prefix
  ON user_access_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_user_access_keys_user
  ON user_access_keys(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_access_keys_enabled
  ON user_access_keys(enabled, expires_at);