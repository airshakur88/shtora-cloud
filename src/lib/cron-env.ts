import { env } from "cloudflare:workers";
import type { ShtoraEnv } from "./types";

/**
 * Shared secret for the cron endpoints (`/api/cron/*`), set as a
 * Worker secret. Undefined when unset — the endpoints answer 503
 * instead of running unauthenticated.
 *
 * This lives apart from `@/lib/env` on purpose: the cron secret is
 * only read by the two cron routes, and the route tests mock this
 * module (no other test file does), so no other file's `env` mock
 * can shadow it — `mock.module` for `@/lib/env` leaks across test
 * files in `bun test`, and those factories do not export this.
 */
export function getCronSecret(): string | undefined {
	const secret = (env as unknown as ShtoraEnv).CRON_SECRET;
	return secret && secret.length > 0 ? secret : undefined;
}
