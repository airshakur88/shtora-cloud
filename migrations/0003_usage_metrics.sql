-- 0004 backfills existing rows; the processed marker makes concurrent writes idempotent.
ALTER TABLE provider_requests ADD COLUMN estimated_savings_usd REAL;
ALTER TABLE provider_requests ADD COLUMN ttft_ms INTEGER;
ALTER TABLE provider_requests ADD COLUMN metrics_processed INTEGER NOT NULL DEFAULT 0 CHECK (metrics_processed IN (0, 1));
ALTER TABLE provider_requests ADD COLUMN input_tokens_estimated INTEGER;
ALTER TABLE provider_requests ADD COLUMN output_tokens_estimated INTEGER;
ALTER TABLE provider_requests ADD COLUMN input_rate_usd_per_million REAL;
ALTER TABLE provider_requests ADD COLUMN output_rate_usd_per_million REAL;

CREATE TABLE usage_metric_pricing (
  platform TEXT NOT NULL,
  model_routed TEXT NOT NULL,
  input_usd_per_million REAL NOT NULL CHECK (input_usd_per_million >= 0),
  output_usd_per_million REAL NOT NULL CHECK (output_usd_per_million >= 0),
  PRIMARY KEY (platform, model_routed)
);

INSERT INTO usage_metric_pricing (platform, model_routed, input_usd_per_million, output_usd_per_million) VALUES
  ('google', 'gemini-2.5-flash', 0.3, 2.5),
  ('google', 'gemini-2.5-pro', 1.25, 10),
  ('mistral', 'mistral-large-latest', 0.5, 1.5),
  ('mistral', 'codestral-latest', 0.3, 0.9),
  ('*', '*', 0.2, 0.8);
CREATE VIEW provider_request_rate_snapshot AS
SELECT
  p.id,
  COALESCE(
    p.input_rate_usd_per_million,
    (SELECT input_usd_per_million FROM usage_metric_pricing WHERE platform = p.platform AND model_routed = p.model_routed),
    (SELECT input_usd_per_million FROM usage_metric_pricing WHERE platform = '*' AND model_routed = '*')
  ) AS input_rate_usd_per_million,
  COALESCE(
    p.output_rate_usd_per_million,
    (SELECT output_usd_per_million FROM usage_metric_pricing WHERE platform = p.platform AND model_routed = p.model_routed),
    (SELECT output_usd_per_million FROM usage_metric_pricing WHERE platform = '*' AND model_routed = '*')
  ) AS output_rate_usd_per_million
FROM provider_requests AS p;

CREATE VIEW provider_request_savings AS
SELECT
  p.id,
  CASE
    WHEN p.status = 'success' THEN (
      COALESCE(CASE WHEN p.input_tokens >= 0 THEN p.input_tokens ELSE 0 END, 0) *
        r.input_rate_usd_per_million +
      COALESCE(CASE WHEN p.output_tokens >= 0 THEN p.output_tokens ELSE 0 END, 0) *
        r.output_rate_usd_per_million
    ) / 1000000.0
    ELSE NULL
  END AS estimated_savings_usd
FROM provider_requests AS p
JOIN provider_request_rate_snapshot AS r ON r.id = p.id;


CREATE TABLE user_usage_metrics (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requests INTEGER NOT NULL,
  successful_requests INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  estimated_savings_usd REAL NOT NULL,
  latency_sum_ms INTEGER NOT NULL,
  latency_count INTEGER NOT NULL,
  ttft_sum_ms INTEGER NOT NULL,
  ttft_count INTEGER NOT NULL
);

CREATE TABLE global_usage_metrics (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  requests INTEGER NOT NULL,
  successful_requests INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  estimated_savings_usd REAL NOT NULL,
  latency_sum_ms INTEGER NOT NULL,
  latency_count INTEGER NOT NULL,
  ttft_sum_ms INTEGER NOT NULL,
  ttft_count INTEGER NOT NULL
);

CREATE TABLE user_usage_latency_histogram (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  bucket_id INTEGER NOT NULL CHECK (bucket_id >= 0 AND bucket_id <= 2191),
  samples INTEGER NOT NULL CHECK (samples > 0),
  PRIMARY KEY (user_id, bucket_id)
);

CREATE TABLE global_usage_latency_histogram (
  bucket_id INTEGER PRIMARY KEY CHECK (bucket_id >= 0 AND bucket_id <= 2191),
  samples INTEGER NOT NULL CHECK (samples > 0)
);
CREATE INDEX IF NOT EXISTS idx_provider_requests_user_latency
  ON provider_requests(user_id, latency_ms);
CREATE INDEX IF NOT EXISTS idx_provider_requests_latency
  ON provider_requests(latency_ms);

INSERT INTO global_usage_metrics VALUES (1, 0, 0, 0, 0, 0, 0, 0, 0, 0);


CREATE TRIGGER provider_requests_metrics_processed
AFTER UPDATE OF metrics_processed ON provider_requests
WHEN OLD.metrics_processed = 0 AND NEW.metrics_processed = 1
BEGIN

  INSERT INTO user_usage_metrics (
    user_id, requests, successful_requests, input_tokens, output_tokens,
    estimated_savings_usd, latency_sum_ms, latency_count, ttft_sum_ms, ttft_count
  )
  SELECT
    NEW.user_id,
    1,
    CASE WHEN NEW.status = 'success' THEN 1 ELSE 0 END,
    COALESCE(NEW.input_tokens, 0),
    COALESCE(NEW.output_tokens, 0),
    COALESCE(NEW.estimated_savings_usd, 0),
    CASE WHEN NEW.latency_ms >= 0 THEN NEW.latency_ms ELSE 0 END,
    CASE WHEN NEW.latency_ms >= 0 THEN 1 ELSE 0 END,
    CASE WHEN NEW.ttft_ms >= 0 THEN NEW.ttft_ms ELSE 0 END,
    CASE WHEN NEW.ttft_ms >= 0 THEN 1 ELSE 0 END
  ON CONFLICT(user_id) DO UPDATE SET
    requests = requests + excluded.requests,
    successful_requests = successful_requests + excluded.successful_requests,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    estimated_savings_usd = estimated_savings_usd + excluded.estimated_savings_usd,
    latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
    latency_count = latency_count + excluded.latency_count,
    ttft_sum_ms = ttft_sum_ms + excluded.ttft_sum_ms,
    ttft_count = ttft_count + excluded.ttft_count;

  UPDATE global_usage_metrics
  SET
    requests = requests + 1,
    successful_requests = successful_requests + CASE WHEN NEW.status = 'success' THEN 1 ELSE 0 END,
    input_tokens = input_tokens + COALESCE(NEW.input_tokens, 0),
    output_tokens = output_tokens + COALESCE(NEW.output_tokens, 0),
    estimated_savings_usd = estimated_savings_usd + COALESCE(NEW.estimated_savings_usd, 0),
    latency_sum_ms = latency_sum_ms + CASE WHEN NEW.latency_ms >= 0 THEN NEW.latency_ms ELSE 0 END,
    latency_count = latency_count + CASE WHEN NEW.latency_ms >= 0 THEN 1 ELSE 0 END,
    ttft_sum_ms = ttft_sum_ms + CASE WHEN NEW.ttft_ms >= 0 THEN NEW.ttft_ms ELSE 0 END,
    ttft_count = ttft_count + CASE WHEN NEW.ttft_ms >= 0 THEN 1 ELSE 0 END
  WHERE singleton = 1;

  INSERT INTO user_usage_latency_histogram (user_id, bucket_id, samples)
  SELECT
    NEW.user_id,
    CASE
      WHEN NEW.latency_ms < 1000 THEN NEW.latency_ms
      WHEN NEW.latency_ms < 120100 THEN 1000 + ((NEW.latency_ms - 1000) / 100)
      ELSE 2191
    END,
    1
  WHERE NEW.latency_ms >= 0
  ON CONFLICT(user_id, bucket_id) DO UPDATE SET samples = samples + 1;

  INSERT INTO global_usage_latency_histogram (bucket_id, samples)
  SELECT
    CASE
      WHEN NEW.latency_ms < 1000 THEN NEW.latency_ms
      WHEN NEW.latency_ms < 120100 THEN 1000 + ((NEW.latency_ms - 1000) / 100)
      ELSE 2191
    END,
    1
  WHERE NEW.latency_ms >= 0
  ON CONFLICT(bucket_id) DO UPDATE SET samples = samples + 1;
END;
CREATE TRIGGER provider_requests_metrics_insert
AFTER INSERT ON provider_requests
BEGIN
  UPDATE provider_requests
  SET
    input_rate_usd_per_million = (SELECT input_rate_usd_per_million FROM provider_request_rate_snapshot WHERE id = NEW.id),
    output_rate_usd_per_million = (SELECT output_rate_usd_per_million FROM provider_request_rate_snapshot WHERE id = NEW.id),
    estimated_savings_usd = (SELECT estimated_savings_usd FROM provider_request_savings WHERE id = NEW.id),
    metrics_processed = 1
  WHERE id = NEW.id;
END;

CREATE TRIGGER provider_requests_metrics_update
AFTER UPDATE OF user_id, status, input_tokens, output_tokens, latency_ms, ttft_ms ON provider_requests
WHEN OLD.metrics_processed = 1 AND NEW.metrics_processed = 1
BEGIN
  UPDATE provider_requests
  SET estimated_savings_usd = CASE
    WHEN NEW.status = 'success' THEN (
      COALESCE(CASE WHEN NEW.input_tokens >= 0 THEN NEW.input_tokens ELSE 0 END, 0) *
        COALESCE(NEW.input_rate_usd_per_million, 0) +
      COALESCE(CASE WHEN NEW.output_tokens >= 0 THEN NEW.output_tokens ELSE 0 END, 0) *
        COALESCE(NEW.output_rate_usd_per_million, 0)
    ) / 1000000.0
    ELSE NULL
  END
  WHERE id = NEW.id
    AND (
      OLD.status IS NOT NEW.status OR
      OLD.input_tokens IS NOT NEW.input_tokens OR
      OLD.output_tokens IS NOT NEW.output_tokens
    );
  UPDATE user_usage_metrics SET
    requests = requests - 1,
    successful_requests = successful_requests - CASE WHEN OLD.status = 'success' THEN 1 ELSE 0 END,
    input_tokens = input_tokens - COALESCE(OLD.input_tokens, 0),
    output_tokens = output_tokens - COALESCE(OLD.output_tokens, 0),
    estimated_savings_usd = estimated_savings_usd - COALESCE(OLD.estimated_savings_usd, 0),
    latency_sum_ms = latency_sum_ms - CASE WHEN OLD.latency_ms >= 0 THEN OLD.latency_ms ELSE 0 END,
    latency_count = latency_count - CASE WHEN OLD.latency_ms >= 0 THEN 1 ELSE 0 END,
    ttft_sum_ms = ttft_sum_ms - CASE WHEN OLD.ttft_ms >= 0 THEN OLD.ttft_ms ELSE 0 END,
    ttft_count = ttft_count - CASE WHEN OLD.ttft_ms >= 0 THEN 1 ELSE 0 END
  WHERE user_id = OLD.user_id;

  UPDATE global_usage_metrics SET
    requests = requests - 1,
    successful_requests = successful_requests - CASE WHEN OLD.status = 'success' THEN 1 ELSE 0 END,
    input_tokens = input_tokens - COALESCE(OLD.input_tokens, 0),
    output_tokens = output_tokens - COALESCE(OLD.output_tokens, 0),
    estimated_savings_usd = estimated_savings_usd - COALESCE(OLD.estimated_savings_usd, 0),
    latency_sum_ms = latency_sum_ms - CASE WHEN OLD.latency_ms >= 0 THEN OLD.latency_ms ELSE 0 END,
    latency_count = latency_count - CASE WHEN OLD.latency_ms >= 0 THEN 1 ELSE 0 END,
    ttft_sum_ms = ttft_sum_ms - CASE WHEN OLD.ttft_ms >= 0 THEN OLD.ttft_ms ELSE 0 END,
    ttft_count = ttft_count - CASE WHEN OLD.ttft_ms >= 0 THEN 1 ELSE 0 END
  WHERE singleton = 1;

  INSERT INTO user_usage_metrics (
    user_id, requests, successful_requests, input_tokens, output_tokens,
    estimated_savings_usd, latency_sum_ms, latency_count, ttft_sum_ms, ttft_count
  )
  VALUES (
    NEW.user_id,
    1,
    CASE WHEN NEW.status = 'success' THEN 1 ELSE 0 END,
    COALESCE(NEW.input_tokens, 0),
    COALESCE(NEW.output_tokens, 0),
    COALESCE((SELECT estimated_savings_usd FROM provider_requests WHERE id = NEW.id), 0),
    CASE WHEN NEW.latency_ms >= 0 THEN NEW.latency_ms ELSE 0 END,
    CASE WHEN NEW.latency_ms >= 0 THEN 1 ELSE 0 END,
    CASE WHEN NEW.ttft_ms >= 0 THEN NEW.ttft_ms ELSE 0 END,
    CASE WHEN NEW.ttft_ms >= 0 THEN 1 ELSE 0 END
  )
  ON CONFLICT(user_id) DO UPDATE SET
    requests = requests + excluded.requests,
    successful_requests = successful_requests + excluded.successful_requests,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    estimated_savings_usd = estimated_savings_usd + excluded.estimated_savings_usd,
    latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
    latency_count = latency_count + excluded.latency_count,
    ttft_sum_ms = ttft_sum_ms + excluded.ttft_sum_ms,
    ttft_count = ttft_count + excluded.ttft_count;

  UPDATE global_usage_metrics SET
    requests = requests + 1,
    successful_requests = successful_requests + CASE WHEN NEW.status = 'success' THEN 1 ELSE 0 END,
    input_tokens = input_tokens + COALESCE(NEW.input_tokens, 0),
    output_tokens = output_tokens + COALESCE(NEW.output_tokens, 0),
    estimated_savings_usd = estimated_savings_usd + COALESCE((SELECT estimated_savings_usd FROM provider_requests WHERE id = NEW.id), 0),
    latency_sum_ms = latency_sum_ms + CASE WHEN NEW.latency_ms >= 0 THEN NEW.latency_ms ELSE 0 END,
    latency_count = latency_count + CASE WHEN NEW.latency_ms >= 0 THEN 1 ELSE 0 END,
    ttft_sum_ms = ttft_sum_ms + CASE WHEN NEW.ttft_ms >= 0 THEN NEW.ttft_ms ELSE 0 END,
    ttft_count = ttft_count + CASE WHEN NEW.ttft_ms >= 0 THEN 1 ELSE 0 END
  WHERE singleton = 1;

  DELETE FROM user_usage_latency_histogram
  WHERE user_id = OLD.user_id AND bucket_id = CASE
    WHEN OLD.latency_ms < 1000 THEN OLD.latency_ms
    WHEN OLD.latency_ms < 120100 THEN 1000 + ((OLD.latency_ms - 1000) / 100)
    ELSE 2191
  END AND samples = 1 AND OLD.latency_ms >= 0;
  UPDATE user_usage_latency_histogram
  SET samples = samples - 1
  WHERE user_id = OLD.user_id AND bucket_id = CASE
    WHEN OLD.latency_ms < 1000 THEN OLD.latency_ms
    WHEN OLD.latency_ms < 120100 THEN 1000 + ((OLD.latency_ms - 1000) / 100)
    ELSE 2191
  END AND samples > 1 AND OLD.latency_ms >= 0;

  DELETE FROM global_usage_latency_histogram
  WHERE bucket_id = CASE
    WHEN OLD.latency_ms < 1000 THEN OLD.latency_ms
    WHEN OLD.latency_ms < 120100 THEN 1000 + ((OLD.latency_ms - 1000) / 100)
    ELSE 2191
  END AND samples = 1 AND OLD.latency_ms >= 0;
  UPDATE global_usage_latency_histogram
  SET samples = samples - 1
  WHERE bucket_id = CASE
    WHEN OLD.latency_ms < 1000 THEN OLD.latency_ms
    WHEN OLD.latency_ms < 120100 THEN 1000 + ((OLD.latency_ms - 1000) / 100)
    ELSE 2191
  END AND samples > 1 AND OLD.latency_ms >= 0;

  INSERT INTO user_usage_latency_histogram (user_id, bucket_id, samples)
  SELECT
    NEW.user_id,
    CASE
      WHEN NEW.latency_ms < 1000 THEN NEW.latency_ms
      WHEN NEW.latency_ms < 120100 THEN 1000 + ((NEW.latency_ms - 1000) / 100)
      ELSE 2191
    END,
    1
  WHERE NEW.latency_ms >= 0
  ON CONFLICT(user_id, bucket_id) DO UPDATE SET samples = samples + 1;

  INSERT INTO global_usage_latency_histogram (bucket_id, samples)
  SELECT
    CASE
      WHEN NEW.latency_ms < 1000 THEN NEW.latency_ms
      WHEN NEW.latency_ms < 120100 THEN 1000 + ((NEW.latency_ms - 1000) / 100)
      ELSE 2191
    END,
    1
  WHERE NEW.latency_ms >= 0
  ON CONFLICT(bucket_id) DO UPDATE SET samples = samples + 1;
END;


CREATE TRIGGER provider_requests_metrics_delete
AFTER DELETE ON provider_requests
WHEN OLD.metrics_processed = 1
BEGIN
  UPDATE user_usage_metrics SET
    requests = requests - 1,
    successful_requests = successful_requests - CASE WHEN OLD.status = 'success' THEN 1 ELSE 0 END,
    input_tokens = input_tokens - COALESCE(OLD.input_tokens, 0),
    output_tokens = output_tokens - COALESCE(OLD.output_tokens, 0),
    estimated_savings_usd = estimated_savings_usd - COALESCE(OLD.estimated_savings_usd, 0),
    latency_sum_ms = latency_sum_ms - CASE WHEN OLD.latency_ms >= 0 THEN OLD.latency_ms ELSE 0 END,
    latency_count = latency_count - CASE WHEN OLD.latency_ms >= 0 THEN 1 ELSE 0 END,
    ttft_sum_ms = ttft_sum_ms - CASE WHEN OLD.ttft_ms >= 0 THEN OLD.ttft_ms ELSE 0 END,
    ttft_count = ttft_count - CASE WHEN OLD.ttft_ms >= 0 THEN 1 ELSE 0 END
  WHERE user_id = OLD.user_id;

  UPDATE global_usage_metrics SET
    requests = requests - 1,
    successful_requests = successful_requests - CASE WHEN OLD.status = 'success' THEN 1 ELSE 0 END,
    input_tokens = input_tokens - COALESCE(OLD.input_tokens, 0),
    output_tokens = output_tokens - COALESCE(OLD.output_tokens, 0),
    estimated_savings_usd = estimated_savings_usd - COALESCE(OLD.estimated_savings_usd, 0),
    latency_sum_ms = latency_sum_ms - CASE WHEN OLD.latency_ms >= 0 THEN OLD.latency_ms ELSE 0 END,
    latency_count = latency_count - CASE WHEN OLD.latency_ms >= 0 THEN 1 ELSE 0 END,
    ttft_sum_ms = ttft_sum_ms - CASE WHEN OLD.ttft_ms >= 0 THEN OLD.ttft_ms ELSE 0 END,
    ttft_count = ttft_count - CASE WHEN OLD.ttft_ms >= 0 THEN 1 ELSE 0 END
  WHERE singleton = 1;

  DELETE FROM user_usage_latency_histogram
  WHERE user_id = OLD.user_id AND bucket_id = CASE
    WHEN OLD.latency_ms < 1000 THEN OLD.latency_ms
    WHEN OLD.latency_ms < 120100 THEN 1000 + ((OLD.latency_ms - 1000) / 100)
    ELSE 2191
  END AND samples = 1 AND OLD.latency_ms >= 0;
  UPDATE user_usage_latency_histogram
  SET samples = samples - 1
  WHERE user_id = OLD.user_id AND bucket_id = CASE
    WHEN OLD.latency_ms < 1000 THEN OLD.latency_ms
    WHEN OLD.latency_ms < 120100 THEN 1000 + ((OLD.latency_ms - 1000) / 100)
    ELSE 2191
  END AND samples > 1 AND OLD.latency_ms >= 0;

  DELETE FROM global_usage_latency_histogram
  WHERE bucket_id = CASE
    WHEN OLD.latency_ms < 1000 THEN OLD.latency_ms
    WHEN OLD.latency_ms < 120100 THEN 1000 + ((OLD.latency_ms - 1000) / 100)
    ELSE 2191
  END AND samples = 1 AND OLD.latency_ms >= 0;
  UPDATE global_usage_latency_histogram
  SET samples = samples - 1
  WHERE bucket_id = CASE
    WHEN OLD.latency_ms < 1000 THEN OLD.latency_ms
    WHEN OLD.latency_ms < 120100 THEN 1000 + ((OLD.latency_ms - 1000) / 100)
    ELSE 2191
  END AND samples > 1 AND OLD.latency_ms >= 0;
END;
