-- The processed flag makes this backfill safe around live inserts and repeated DML.
UPDATE provider_requests
SET
  input_rate_usd_per_million = (
    SELECT input_rate_usd_per_million
    FROM provider_request_rate_snapshot
    WHERE id = provider_requests.id
  ),
  output_rate_usd_per_million = (
    SELECT output_rate_usd_per_million
    FROM provider_request_rate_snapshot
    WHERE id = provider_requests.id
  ),
  estimated_savings_usd = (
    SELECT estimated_savings_usd
    FROM provider_request_savings
    WHERE id = provider_requests.id
  ),
  metrics_processed = 1
WHERE metrics_processed = 0;
