// Per-key rate limits: what a key may use, and what it has used.
// The numbers shown in the dashboard come from the same places the
// enforcer reads, so display and enforcement cannot disagree.
//
// Precedence for each of rpm/tpm/rpd/tpd (see POST /api/keys, which bakes
// the provider default into the row at creation):
//   1. value stored on the api_keys row (set by the user, or the provider
//      default copied in at creation)
//   2. gateway default in ratelimit.ts when the row has nothing
// The displayed source is inferred by comparing the stored row with the
// provider catalog: equal to the catalog means "provider", different means
// the key was given its own value ("key"), all null means "gateway".
import { DEFAULT_RATE_LIMITS, getRateLimitWindowStarts } from "./ratelimit";
import type { D1Database, KeySummary, OptionalLimits } from "./types";

export type LimitsSource = "key" | "provider" | "gateway";

export interface EffectiveLimits {
	rpm: number;
	tpm: number;
	rpd: number;
	tpd: number;
	source: LimitsSource;
}

const MAX_LIMIT = 10_000_000;

/**
 * Shared limit validator for POST/PATCH /api/keys: an integer within
 * 0..10_000_000, null/undefined means "no value set", anything else is
 * invalid (undefined) so the route can reject it.
 */
export function parseOptionalLimit(value: unknown): number | null | undefined {
	if (value === undefined || value === null) return null;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > MAX_LIMIT
	)
		return undefined;
	return value;
}

export function effectiveKeyLimits(
	stored: OptionalLimits,
	providerLimits?: OptionalLimits,
): EffectiveLimits {
	const rpm = stored.rpmLimit ?? DEFAULT_RATE_LIMITS.rpm;
	const tpm = stored.tpmLimit ?? DEFAULT_RATE_LIMITS.tpm;
	const rpd = stored.rpdLimit ?? DEFAULT_RATE_LIMITS.rpd;
	const tpd = stored.tpdLimit ?? DEFAULT_RATE_LIMITS.tpd;
	let source: LimitsSource = "gateway";
	const hasStored =
		(stored.rpmLimit ?? null) !== null ||
		(stored.tpmLimit ?? null) !== null ||
		(stored.rpdLimit ?? null) !== null ||
		(stored.tpdLimit ?? null) !== null;
	if (hasStored) {
		source = "provider";
		const differs = (
			[["rpmLimit"], ["tpmLimit"], ["rpdLimit"], ["tpdLimit"]] as const
		).some(([field]) => {
			const storedValue = stored[field] ?? null;
			if (storedValue === null) return false;
			if (!providerLimits) return true;
			return storedValue !== (providerLimits[field] ?? null);
		});
		if (differs) source = "key";
	}
	return { rpm, tpm, rpd, tpd, source };
}

export interface EnrichedKeySummary extends KeySummary {
	effectiveLimits: Omit<EffectiveLimits, "source">;
	limitsSource: LimitsSource;
}

/**
 * Adds effective limits and their source to key summaries. Provider limits
 * come from the D1 `providers` table in a single query.
 */
export async function withEffectiveLimits(
	db: D1Database,
	keys: KeySummary[],
): Promise<EnrichedKeySummary[]> {
	const platforms = [...new Set(keys.map((key) => key.platform))];
	const catalog = new Map<string, OptionalLimits>();
	if (platforms.length > 0) {
		const placeholders = platforms.map(() => "?").join(", ");
		const rows = await db
			.prepare(`SELECT id, limits FROM providers WHERE id IN (${placeholders})`)
			.bind(...platforms)
			.all<{ id: string; limits: string | null }>();
		for (const row of rows.results) {
			if (!row.limits) continue;
			try {
				const parsed: unknown = JSON.parse(row.limits);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
					catalog.set(row.id, parsed as OptionalLimits);
			} catch {
				// Corrupt provider limits: treat as absent, the gateway
				// default applies.
			}
		}
	}
	return keys.map((key) => {
		const { source, ...limits } = effectiveKeyLimits(
			{
				rpmLimit: key.rpmLimit,
				tpmLimit: key.tpmLimit,
				rpdLimit: key.rpdLimit,
				tpdLimit: key.tpdLimit,
			},
			catalog.get(key.platform),
		);
		return { ...key, effectiveLimits: limits, limitsSource: source };
	});
}

export interface KeyUsageWindow {
	keyId: number;
	requestsMinute: number;
	tokensMinute: number;
	requestsDay: number;
	tokensDay: number;
}

/**
 * Current usage per key in the same windows the enforcer uses: the last 60
 * seconds and today (UTC), read from provider_rate_limit_usage. The rows
 * count every request the key served, including requests from other users
 * borrowing it from the community pool, because that is what spends its
 * quota. Keys without rows come back as zeros from the caller.
 */
export async function getKeyUsageWindows(
	db: D1Database,
	keyIds: number[],
	now = Date.now(),
): Promise<KeyUsageWindow[]> {
	if (keyIds.length === 0) return [];
	const { minuteStart, dayStart } = getRateLimitWindowStarts(now);
	const placeholders = keyIds.map(() => "?").join(", ");
	// Both windows live inside today, except for the first minute after
	// UTC midnight: the minute window slides, so it can still reach rows
	// from the previous day, and the enforcer counts those rows. The
	// scan bound is therefore the earlier of the two starts, which keeps
	// the query from walking the whole table as usage accumulates (the
	// cleanup index on created_at_ms can serve the bound).
	const scanStart = Math.min(dayStart, minuteStart);
	const result = await db
		.prepare(
			`SELECT key_id AS keyId,
			 COALESCE(SUM(CASE WHEN kind = 'request' AND created_at_ms > ? THEN 1 ELSE 0 END), 0) AS requestsMinute,
			 COALESCE(SUM(CASE WHEN kind = 'tokens' AND created_at_ms > ? THEN tokens ELSE 0 END), 0) AS tokensMinute,
			 COALESCE(SUM(CASE WHEN kind = 'request' AND created_at_ms >= ? THEN 1 ELSE 0 END), 0) AS requestsDay,
			 COALESCE(SUM(CASE WHEN kind = 'tokens' AND created_at_ms >= ? THEN tokens ELSE 0 END), 0) AS tokensDay
			 FROM provider_rate_limit_usage WHERE key_id IN (${placeholders}) AND created_at_ms >= ?
			 GROUP BY key_id`,
		)
		.bind(minuteStart, minuteStart, dayStart, dayStart, ...keyIds, scanStart)
		.all<KeyUsageWindow>();
	return result.results;
}

export interface UsageByKeyRow {
	keyId: number;
	platform: string;
	requests: number;
	successes: number;
	latencyMs: number | null;
	inputTokens: number;
	outputTokens: number;
}

/**
 * All-time usage of the keys that served this user's requests, from
 * provider_requests. A serving key can belong to the community pool, so the
 * caller maps keyId to a masked label from the user's own keys and shows
 * nothing more than the mask for keys it does not own.
 */
export async function getUsageByKey(
	db: D1Database,
	userId: string,
): Promise<UsageByKeyRow[]> {
	const result = await db
		.prepare(
			`SELECT key_id AS keyId, platform,
			 COUNT(*) AS requests,
			 SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
			 AVG(latency_ms) AS latencyMs,
			 COALESCE(SUM(input_tokens), 0) AS inputTokens,
			 COALESCE(SUM(output_tokens), 0) AS outputTokens
			 FROM provider_requests WHERE user_id = ?
			 GROUP BY key_id, platform ORDER BY requests DESC`,
		)
		.bind(userId)
		.all<UsageByKeyRow>();
	return result.results;
}
