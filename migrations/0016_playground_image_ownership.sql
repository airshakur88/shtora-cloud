-- Playground image ownership (M3). R2 objects are keyed by random UUID and
-- previously had no owner record: any logged-in user could fetch any image
-- by key, and there was no per-user quota. This table records the uploader
-- of each object so GET can check ownership and POST can enforce quotas.
-- Images uploaded before this migration have no row and stop being served
-- (GET answers 404 for them); re-upload them to regain access.
CREATE TABLE IF NOT EXISTS playground_images (
  key TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  content_type TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playground_images_user
  ON playground_images(user_id, created_at_ms);
