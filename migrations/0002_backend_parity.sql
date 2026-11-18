-- Backend parity additions for the schema created by 0001_initial_schema.sql.
-- Fresh databases apply 0001_initial_schema.sql followed by this migration.
-- Existing generic `keys`, `requests`, rate_limit_usage and rate_limit_cooldowns are intentionally untouched.

CREATE TABLE IF NOT EXISTS shtora_auth_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shtora_auth_sessions_user
  ON shtora_auth_sessions(user_id, created_at_ms, id);
CREATE INDEX IF NOT EXISTS idx_shtora_auth_sessions_expiry
  ON shtora_auth_sessions(expires_at_ms);

CREATE TABLE IF NOT EXISTS api_keys (
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
  last_health_check_status TEXT,
  unified_token TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform, enabled);
CREATE INDEX IF NOT EXISTS idx_api_keys_unified ON api_keys(unified_token);
CREATE INDEX IF NOT EXISTS idx_api_keys_health ON api_keys(enabled, last_health_check_at);

CREATE TABLE IF NOT EXISTS provider_rate_limit_usage (
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
  tokens INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_rate_limit_lookup
  ON provider_rate_limit_usage(platform, model_id, key_id, kind, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_provider_rate_limit_cleanup
  ON provider_rate_limit_usage(created_at_ms);

CREATE TABLE IF NOT EXISTS provider_rate_limit_cooldowns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  failure_count INTEGER NOT NULL DEFAULT 1,
  cooldown_until_ms INTEGER NOT NULL,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'rate_limit',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, model_id, key_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_cooldowns_lookup
  ON provider_rate_limit_cooldowns(platform, model_id, key_id, cooldown_until_ms);
CREATE INDEX IF NOT EXISTS idx_provider_cooldowns_expiry
  ON provider_rate_limit_cooldowns(cooldown_until_ms);

CREATE TABLE IF NOT EXISTS provider_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  unified_token_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  model_requested TEXT NOT NULL,
  model_routed TEXT NOT NULL,
  platform TEXT NOT NULL,
  key_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_code INTEGER,
  error_message TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  routing_decision TEXT,
  failure_attribution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  request_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_provider_requests_user
  ON provider_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_provider_requests_model
  ON provider_requests(model_routed, created_at);
CREATE INDEX IF NOT EXISTS idx_provider_requests_platform
  ON provider_requests(platform, created_at);
CREATE INDEX IF NOT EXISTS idx_provider_requests_cleanup
  ON provider_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_provider_requests_scoring
  ON provider_requests(model_routed, status, created_at);
