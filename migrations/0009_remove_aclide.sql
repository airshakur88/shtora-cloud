-- Forward-only catalog removal: delete the ACLIDE provider and its models.
-- Historical requests and their frozen rates are untouched (see 0005).
DELETE FROM models WHERE platform = 'aclide';
DELETE FROM rate_limit_usage WHERE platform = 'aclide';
DELETE FROM rate_limit_cooldowns WHERE platform = 'aclide';
DELETE FROM usage_metric_pricing WHERE platform = 'aclide';