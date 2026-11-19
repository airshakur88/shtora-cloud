-- SQLite cannot DROP COLUMN on a UNIQUE column, and api_keys.unified_token
-- is TEXT NOT NULL UNIQUE, so the table is rebuilt without it. The index
-- on the column goes away with the old table.
PRAGMA foreign_keys = OFF;
CREATE TABLE api_keys_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  key_label TEXT,
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  base_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  rpd_limit INTEGER,
  tpd_limit INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_health_check_at TEXT,
  last_health_check_status TEXT
);
INSERT INTO api_keys_new (
  id, user_id, platform, key_label, encrypted_key, iv, auth_tag, base_url,
  enabled, rpm_limit, tpm_limit, rpd_limit, tpd_limit, created_at,
  updated_at, last_health_check_at, last_health_check_status
) SELECT
  id, user_id, platform, key_label, encrypted_key, iv, auth_tag, base_url,
  enabled, rpm_limit, tpm_limit, rpd_limit, tpd_limit, created_at,
  updated_at, last_health_check_at, last_health_check_status
FROM api_keys;
DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform, enabled);
CREATE INDEX IF NOT EXISTS idx_api_keys_health ON api_keys(enabled, last_health_check_at);
ALTER TABLE provider_requests DROP COLUMN unified_token_id;
PRAGMA foreign_keys = ON;
