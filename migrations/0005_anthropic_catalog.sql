-- Forward-only catalog refresh. Historical requests and their frozen rates are untouched.
-- Sources: https://platform.claude.com/docs/en/models/overview
-- https://platform.claude.com/docs/en/about-claude/model-deprecations
UPDATE models SET enabled = 0, updated_at = datetime('now')
WHERE platform = 'anthropic' AND model_id IN ('claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620');

INSERT INTO models (platform, model_id, name, context_window, max_output_tokens, supports_tools, supports_vision, input_cost_per_mt, output_cost_per_mt)
VALUES
 ('anthropic', 'claude-fable-5-2', 'Claude Fable 5.2', 1000000, 128000, 1, 1, 8, 40),
 ('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 1000000, 128000, 1, 1, 4, 20),
 ('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000000, 128000, 1, 1, 2, 10),
 ('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', 1000000, 128000, 1, 1, NULL, NULL)
ON CONFLICT(platform, model_id) DO UPDATE SET
 name = excluded.name, context_window = excluded.context_window, max_output_tokens = excluded.max_output_tokens,
 supports_tools = excluded.supports_tools, supports_vision = excluded.supports_vision,
 input_cost_per_mt = excluded.input_cost_per_mt, output_cost_per_mt = excluded.output_cost_per_mt,
 updated_at = datetime('now');

-- Haiku's published prices are 'From', not universal rates; retain the generic
-- estimated-equivalent baseline rather than seed a falsely exact Haiku price.
INSERT INTO usage_metric_pricing (platform, model_routed, input_usd_per_million, output_usd_per_million)
VALUES ('anthropic', 'claude-fable-5-2', 8, 40), ('anthropic', 'claude-opus-5-5', 4, 20), ('anthropic', 'claude-sonnet-5-5', 2, 10)
ON CONFLICT(platform, model_routed) DO UPDATE SET
 input_usd_per_million = excluded.input_usd_per_million, output_usd_per_million = excluded.output_usd_per_million;
