-- Phase 1 (R13): persist the route_exhausted aggregate in D1 instead of
-- only logging it. A 502/429 with zero attempts is otherwise
-- indistinguishable from "upstream down" once the Worker logs roll, and
-- the per-attempt rows in provider_requests carry no skip counts.
-- One row per exhausted request, in either the 429 or the 502 branch.
-- skipped_json: {"noKey": n, "quarantined": n, "rateLimited": n} counts
-- keys skipped without an attempt; kinds_json: distinct failure kinds in
-- first-seen order; attempt_log_json: the full RouteAttempt array.
CREATE TABLE IF NOT EXISTS route_exhausted_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms INTEGER NOT NULL,
  model TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  skipped_json TEXT NOT NULL,
  kinds_json TEXT NOT NULL,
  attempt_log_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_route_exhausted_created
  ON route_exhausted_events(created_at_ms);
