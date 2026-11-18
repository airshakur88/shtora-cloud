-- 0015: Anthropic as a catalog provider, and the Moondream protocol fix.
--
-- The 4 Claude models from migration 0005 had no row in `providers`, so the
-- router never had catalog config for platform 'anthropic': any key stored
-- with a custom baseUrl was trusted instead (C1), and the native Messages
-- path (count_tokens, bound content) always answered 400 for lack of a
-- direct provider (C3). This adds the Anthropic row with the Messages
-- protocol; `sendChat`/`sendNativeMessages` now resolve the catalog base URL
-- and ignore a stored key baseUrl for this platform.
--
-- Also fixes the Moondream row written by 0010 as 'openai_compatible': the
-- `moondream` branch of the provider dispatch was unreachable with that
-- value, so Moondream's tool/image validation never ran (C2).
-- Safe to re-apply: the insert upserts only the anthropic row, the update
-- touches only the moondream row, and neither touches `enabled`.

INSERT INTO providers (id, name, base_url, auth_type, protocol, description, keyless, key_hint, extra_headers, force_single_tool_call, model_identity, model_aliases, electron_hub_proxy_error, ensure_done, limits)
VALUES ('anthropic', 'Anthropic', 'https://api.anthropic.com/v1', 'bearer', 'anthropic_messages', NULL, 0, 'sk-ant-', NULL, NULL, 'exact', NULL, NULL, NULL, NULL)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  base_url = excluded.base_url,
  auth_type = excluded.auth_type,
  protocol = excluded.protocol,
  key_hint = excluded.key_hint;

UPDATE providers SET protocol = 'moondream' WHERE id = 'moondream';
