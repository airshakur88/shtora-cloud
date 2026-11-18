CREATE TABLE IF NOT EXISTS playground_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'New Session',
  model_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playground_sessions_user
  ON playground_sessions(user_id, created_at_ms DESC);
