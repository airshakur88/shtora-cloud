-- ============================================
-- SHTORA-CLOUD — INITIAL SCHEMA
-- Auth: @shtora/auth (D1) + app-owned tables
-- ============================================

-- Users (app-owned; auth = @shtora/auth)
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================
-- Schema D1 from @shtora/auth
-- ============================================

CREATE TABLE IF NOT EXISTS shtora_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_shtora_sessions_user ON shtora_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_shtora_sessions_expiry ON shtora_sessions (expires_at);

CREATE TABLE IF NOT EXISTS shtora_rate_limits (
  key_hash TEXT PRIMARY KEY NOT NULL,
  window_start_ms INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0)
);
CREATE INDEX IF NOT EXISTS idx_shtora_rate_limits_window_start ON shtora_rate_limits (window_start_ms);

CREATE TABLE IF NOT EXISTS shtora_action_tokens (
  purpose TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (purpose, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_shtora_action_tokens_expiry ON shtora_action_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_shtora_action_tokens_user_purpose ON shtora_action_tokens (purpose, user_id);

-- ============================================
-- Core router schema
-- ============================================

-- API keys per user
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_keys_user ON keys(user_id);
CREATE INDEX IF NOT EXISTS idx_keys_revoked ON keys(revoked);

-- Available model catalog
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  context_window INTEGER NOT NULL,
  input_cost_per_mt INTEGER DEFAULT 0,
  output_cost_per_mt INTEGER DEFAULT 0,
  intelligence_rank INTEGER,
  tier INTEGER DEFAULT 1,
  supports_tools INTEGER DEFAULT 0,
  supports_vision INTEGER DEFAULT 0,
  supports_json_mode INTEGER DEFAULT 0,
  max_output_tokens INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  provider_moment_failure_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, model_id)
);

CREATE INDEX IF NOT EXISTS idx_models_platform ON models(platform, enabled);
CREATE INDEX IF NOT EXISTS idx_models_intelligence ON models(intelligence_rank);

-- Rate limit usage (sliding windows + daily counters)
CREATE TABLE IF NOT EXISTS rate_limit_usage (
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  tokens INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_lookup
  ON rate_limit_usage(platform, model_id, key_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_limit_cleanup
  ON rate_limit_usage(created_at);

-- Active cooldowns per (platform, model, key)
CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  failure_count INTEGER NOT NULL DEFAULT 1,
  cooldown_until TEXT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'rate_limit',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, model_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_cooldowns_lookup
  ON rate_limit_cooldowns(platform, model_id, key_id, cooldown_until);
CREATE INDEX IF NOT EXISTS idx_cooldowns_expiry
  ON rate_limit_cooldowns(cooldown_until);

-- Request history for analytics and scoring
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  model_requested TEXT NOT NULL,
  model_routed TEXT NOT NULL,
  platform TEXT NOT NULL,
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model_routed, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_cleanup ON requests(created_at);
CREATE INDEX IF NOT EXISTS idx_requests_scoring ON requests(model_routed, status, created_at);

-- Fallback config and routing chains
CREATE TABLE IF NOT EXISTS fallback_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  chain_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Global system settings
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
