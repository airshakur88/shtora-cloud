import type { D1Database } from "@/lib/types";

/**
 * Cooldown ladder, indexed by failure number: 1st failure 90 s, 2nd
 * 5 min, 3rd 10 min, 4th 30 min, 5th 1 h, 6th 4 h, 7th+ 24 h — the
 * ladder documented in the 502 audit (§B.5). The second rung used to
 * read 120 s here while the SQL CASE below and the audit both said
 * 5 min; the stray value matched neither and is gone.
 */
export const COOLDOWN_LADDER_MS = [
	90_000, 300_000, 600_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000,
] as const;
const DAY_MS = 86_400_000;

export type FailureSource =
	| "rate_limit"
	| "server_error"
	| "auth_error"
	| "payment"
	| "tier"
	| "timeout"
	| "manual";

export interface QuarantineRow {
	id: number;
	platform: string;
	modelId: string;
	keyId: number;
	keyLabel: string | null;
	ownerUsername: string | null;
	failureCount: number;
	cooldownUntilMs: number;
	reason: string | null;
	source: string;
}

interface QuarantineJoinRow {
	id: number;
	platform: string;
	model_id: string;
	key_id: number;
	failure_count: number;
	cooldown_until_ms: number;
	reason: string | null;
	source: string;
	key_label: string | null;
	owner_username: string | null;
}

export async function reportFailure(
	db: D1Database,
	input: {
		platform: string;
		modelId: string;
		keyId: number;
		source: FailureSource;
		reason?: string;
		retryAfterMs?: number;
	},
): Promise<void> {
	const now = Date.now();
	// Decay (R15): a failure_count that last moved more than a day
	// ago restarts instead of climbing the ladder. The table has no
	// last-failure timestamp; cooldown_until_ms is the last failure's
	// deadline, so a deadline older than a day means the last failure
	// is certainly more than a day old — a failure always precedes its
	// own cooldown deadline. Deleting the stale row makes the upsert
	// below insert fresh at failure_count 1 / 90 s.
	await db
		.prepare(
			`DELETE FROM provider_rate_limit_cooldowns
			  WHERE platform = ? AND model_id = ? AND key_id = ?
			    AND cooldown_until_ms <= ?`,
		)
		.bind(input.platform, input.modelId, input.keyId, now - DAY_MS)
		.run();
	const isLongCooldown = input.source === "payment" || input.source === "tier";

	if (isLongCooldown) {
		// Payment/tier failures always get a full-day cooldown regardless of count.
		await db
			.prepare(
				`INSERT INTO provider_rate_limit_cooldowns
				 (platform, model_id, key_id, failure_count, cooldown_until_ms, reason, source)
				 VALUES (?, ?, ?, 1, ?, ?, ?)
				 ON CONFLICT(platform, model_id, key_id) DO UPDATE SET
				   failure_count = failure_count + 1,
				   cooldown_until_ms = excluded.cooldown_until_ms,
				   reason = excluded.reason,
				   source = excluded.source`,
			)
			.bind(
				input.platform,
				input.modelId,
				input.keyId,
				now + DAY_MS,
				input.reason ?? null,
				input.source,
			)
			.run();
		return;
	}

	// Ladder duration is based on the NEW failure_count after increment.
	// In the INSERT case new count = 1 → ladder[0] = 90 000 ms.
	// In the UPDATE case the existing failure_count (before +1) is used in
	// the CASE so MIN(failure_count, 6) maps to ladder index 0-6: an
	// existing count of 1 (2nd failure) takes ladder[1] = 300 000 ms.
	// The WHEN 0 branch is unreachable in practice — rows insert at 1
	// and decay deletes stale rows instead of zeroing them — but it is
	// kept at the first rung so the CASE and the ladder agree.
	// retryAfterMs from the upstream Retry-After header takes precedence when
	// it exceeds the ladder value, capped to one day.
	const ladderSql = `CASE MIN(failure_count, 6)
		WHEN 0 THEN 90000
		WHEN 1 THEN 300000
		WHEN 2 THEN 600000
		WHEN 3 THEN 1800000
		WHEN 4 THEN 3600000
		WHEN 5 THEN 14400000
		ELSE 86400000
	END`;

	const retryMs = input.retryAfterMs;
	const cooldownExpr =
		retryMs !== undefined
			? // Cap is now + 1 day, not the 1-day duration: MIN used to
				// compare a timestamp (~1.79e12) with DAY_MS (86_400_000)
				// and always returned 86_400_000 (02/01/1970), so a
				// key 429'd twice with Retry-After never cooled down.
				`MIN(? + ${DAY_MS}, MAX(? + ${ladderSql}, ?))`
			: `? + ${ladderSql}`;
	const initialCooldown =
		retryMs !== undefined
			? Math.min(DAY_MS, Math.max(COOLDOWN_LADDER_MS[0], retryMs))
			: COOLDOWN_LADDER_MS[0];

	const binds: (string | number | null)[] =
		retryMs !== undefined
			? [
					input.platform,
					input.modelId,
					input.keyId,
					now + initialCooldown,
					input.reason ?? null,
					input.source,
					// UPDATE binds, in placeholder order: cap (now + 1 day),
					// ladder base (now), Retry-After deadline (now + retry).
					now,
					now,
					now + retryMs,
				]
			: [
					input.platform,
					input.modelId,
					input.keyId,
					now + initialCooldown,
					input.reason ?? null,
					input.source,
					now,
				];

	await db
		.prepare(
			`INSERT INTO provider_rate_limit_cooldowns
			 (platform, model_id, key_id, failure_count, cooldown_until_ms, reason, source)
			 VALUES (?, ?, ?, 1, ?, ?, ?)
			 ON CONFLICT(platform, model_id, key_id) DO UPDATE SET
			   failure_count = failure_count + 1,
			   cooldown_until_ms = ${cooldownExpr},
			   reason = excluded.reason,
			   source = excluded.source`,
		)
		.bind(...binds)
		.run();
}

export async function isKeyQuarantined(
	db: D1Database,
	platform: string,
	modelId: string,
	keyId: number,
): Promise<boolean> {
	const row = await db
		.prepare(
			"SELECT cooldown_until_ms FROM provider_rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND key_id = ?",
		)
		.bind(platform, modelId, keyId)
		.first<{ cooldown_until_ms: number }>();
	return row !== null && row.cooldown_until_ms > Date.now();
}

export async function listQuarantined(
	db: D1Database,
): Promise<QuarantineRow[]> {
	const result = await db
		.prepare(
			`SELECT c.id, c.platform, c.model_id, c.key_id, c.failure_count,
			 c.cooldown_until_ms, c.reason, c.source, k.key_label, u.username AS owner_username
			 FROM provider_rate_limit_cooldowns c
			 JOIN api_keys k ON k.id = c.key_id
			 JOIN user u ON u.id = k.user_id
			 WHERE c.cooldown_until_ms > ? ORDER BY c.cooldown_until_ms ASC`,
		)
		.bind(Date.now())
		.all<QuarantineJoinRow>();
	return result.results.map((row) => ({
		id: row.id,
		platform: row.platform,
		modelId: row.model_id,
		keyId: row.key_id,
		keyLabel: row.key_label,
		ownerUsername: row.owner_username,
		failureCount: row.failure_count,
		cooldownUntilMs: row.cooldown_until_ms,
		reason: row.reason,
		source: row.source,
	}));
}

export async function releaseQuarantine(
	db: D1Database,
	input: { platform: string; modelId: string; keyId: number },
): Promise<void> {
	await db
		.prepare(
			"DELETE FROM provider_rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND key_id = ?",
		)
		.bind(input.platform, input.modelId, input.keyId)
		.run();
}

export async function resetKeyFailures(
	db: D1Database,
	platform: string,
	modelId: string,
	keyId: number,
): Promise<void> {
	await releaseQuarantine(db, { platform, modelId, keyId });
}
