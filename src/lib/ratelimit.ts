import type { D1Database, D1Value } from "@/lib/types";

const MINUTE_MS = 60_000;

/** Gateway defaults, used when neither the key nor its provider sets a limit. */
export const DEFAULT_RATE_LIMITS = {
	rpm: 60,
	tpm: 200_000,
	rpd: 5_000,
	tpd: 5_000_000,
} as const;

export type RateLimitName = keyof typeof DEFAULT_RATE_LIMITS;

/**
 * Public inference caps (A2). Enforced per API key owner and per
 * client IP, on top of the per-(key, model) limits above.
 *
 * Why these numbers: the per-key ceiling is rpm 60 per (key, model). An API
 * key owner normally holds several keys across several models, so 120 req/min
 * per API key is 2x one key-model ceiling while still capping what a single
 * API key can drain from the shared pool, no matter how many keys or models
 * the router fans out to. 300 req/min per IP is 2.5x the per-API-key cap: it
 * tolerates shared egress/NAT but still bounds one source abusing many
 * API keys. Both are fixed 60 s windows, like the auth limiter.
 */
export const PUBLIC_INFERENCE_LIMITS = {
	perTokenRpm: 120,
	perIpRpm: 300,
	/** Failed-token attempts per minute per IP. Cheap on purpose: one D1
	 * statement per attempt, the same cost class as the login limiter. */
	invalidTokenRpm: 20,
	/** Uploads per minute per user on POST /api/playground/images. */
	imageUploadRpm: 20,
	windowMs: 60_000,
} as const;

export type PublicLimitScope = "token" | "ip" | "invalid_token" | "upload";

export interface PublicLimitResult {
	ok: boolean;
	scope?: PublicLimitScope;
	retryAfterSeconds?: number;
}

/** Client IP as the auth limiter reads it. */
export function getClientIp(request: Request): string {
	return request.headers.get("cf-connecting-ip") || "127.0.0.1";
}

async function sha256Hex(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Fixed-window counter with the reservation in the same statement that
 * counts (INSERT ... ON CONFLICT ... RETURNING), so concurrent requests
 * cannot all slip through before any row is written. This is the same
 * single-statement pattern src/lib/auth.ts uses for login/register.
 *
 * The per-(key, model) enforcer below (canMakeRequest + recordUsage)
 * is still check-then-act — the check and the reservation are separate
 * calls made by src/lib/router.ts, so concurrent requests can pass the
 * check before any usage row exists. The router closes that race with
 * reserveUsage (one conditional INSERT that counts and writes in the
 * same statement); canMakeRequest stays as the cheap pre-filter that
 * keeps obviously over-quota keys out of the attempt loop.
 */
export async function checkFixedWindowLimit(
	db: D1Database,
	input: {
		scope: string;
		id: string;
		limit: number;
		windowMs?: number;
	},
): Promise<{ ok: boolean; retryAfterSeconds?: number }> {
	const windowMs = input.windowMs ?? PUBLIC_INFERENCE_LIMITS.windowMs;
	const now = Date.now();
	const keyHash = await sha256Hex(`${input.scope}:${input.id}`);
	const row = await db
		.prepare(
			`INSERT INTO shtora_rate_limits (key_hash, window_start_ms, count)
			 VALUES (?, ?, 1)
			 ON CONFLICT(key_hash) DO UPDATE SET
			   window_start_ms = CASE WHEN excluded.window_start_ms - shtora_rate_limits.window_start_ms > ?
			     THEN excluded.window_start_ms ELSE shtora_rate_limits.window_start_ms END,
			   count = CASE WHEN excluded.window_start_ms - shtora_rate_limits.window_start_ms > ?
			     THEN 1 WHEN shtora_rate_limits.count < ? THEN shtora_rate_limits.count + 1
			     ELSE ? END
			 RETURNING window_start_ms, count`,
		)
		.bind(keyHash, now, windowMs, windowMs, input.limit, input.limit + 1)
		.first<{ window_start_ms: number; count: number }>();
	if (!row) throw new Error("Rate limit state unavailable");
	if (row.count <= input.limit) return { ok: true };
	return {
		ok: false,
		retryAfterSeconds: Math.max(
			1,
			Math.ceil((row.window_start_ms + windowMs - now) / 1000),
		),
	};
}

/**
 * Per-token and per-IP caps for public inference. Call after the token
 * authenticates, before routing: the cap bounds the token's total request
 * rate, so no change to the router's key failover is needed for A2 to
 * hold — a token that exhausted its cap never reaches the pool.
 * Call sites: /v1/chat/completions, /v1/messages and
 * /v1/messages/count_tokens (via handleNativeMessages), and
 * /api/v1/chat/completions. Answer 429 with Retry-After when ok is false.
 */
export async function checkPublicInferenceLimit(
	db: D1Database,
	input: { userId: string; ip: string },
): Promise<PublicLimitResult> {
	const token = await checkFixedWindowLimit(db, {
		scope: "public-inference:token",
		id: input.userId,
		limit: PUBLIC_INFERENCE_LIMITS.perTokenRpm,
	});
	if (!token.ok)
		return {
			ok: false,
			scope: "token",
			retryAfterSeconds: token.retryAfterSeconds,
		};
	const ip = await checkFixedWindowLimit(db, {
		scope: "public-inference:ip",
		id: input.ip,
		limit: PUBLIC_INFERENCE_LIMITS.perIpRpm,
	});
	if (!ip.ok)
		return {
			ok: false,
			scope: "ip",
			retryAfterSeconds: ip.retryAfterSeconds,
		};
	return { ok: true };
}

/**
 * Rate limit for requests that fail token authentication. Call when auth
 * fails, before returning 401: if the bucket is exhausted, answer 429
 * instead, so invalid-token probing costs one D1 statement per attempt
 * and cannot be repeated without bound.
 */
export async function checkInvalidTokenLimit(
	db: D1Database,
	input: { ip: string },
): Promise<PublicLimitResult> {
	const result = await checkFixedWindowLimit(db, {
		scope: "public-inference:invalid-token",
		id: input.ip,
		limit: PUBLIC_INFERENCE_LIMITS.invalidTokenRpm,
	});
	if (!result.ok)
		return {
			ok: false,
			scope: "invalid_token",
			retryAfterSeconds: result.retryAfterSeconds,
		};
	return { ok: true };
}

/** Upload rate limit for POST /api/playground/images, per user. */
export async function checkImageUploadLimit(
	db: D1Database,
	input: { userId: string },
): Promise<PublicLimitResult> {
	const result = await checkFixedWindowLimit(db, {
		scope: "image-upload",
		id: input.userId,
		limit: PUBLIC_INFERENCE_LIMITS.imageUploadRpm,
	});
	if (!result.ok)
		return {
			ok: false,
			scope: "upload",
			retryAfterSeconds: result.retryAfterSeconds,
		};
	return { ok: true };
}

/**
 * Window starts the enforcer uses: the last 60 seconds and today (UTC).
 * Usage displays read the same windows, so the numbers match enforcement.
 */
export function getRateLimitWindowStarts(now = Date.now()): {
	minuteStart: number;
	dayStart: number;
} {
	return { minuteStart: now - MINUTE_MS, dayStart: utcMidnightMs(now) };
}

function utcMidnightMs(now: number): number {
	const date = new Date(now);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

async function count(
	db: D1Database,
	sql: string,
	values: D1Value[],
): Promise<number> {
	const row = await db
		.prepare(sql)
		.bind(...values)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export async function canMakeRequest(
	db: D1Database,
	input: {
		platform: string;
		modelId: string;
		keyId: number;
		estTokens: number;
		rpmLimit?: number | null;
		tpmLimit?: number | null;
		rpdLimit?: number | null;
		tpdLimit?: number | null;
	},
): Promise<{ ok: boolean; reason?: string }> {
	const now = Date.now();
	const { minuteStart, dayStart } = getRateLimitWindowStarts(now);
	const where =
		"platform = ? AND model_id = ? AND key_id = ? AND kind = ? AND created_at_ms > ?";
	const [requestsMinute, tokensMinute, requestsDay, tokensDay] =
		await Promise.all([
			count(
				db,
				`SELECT COUNT(*) AS n FROM provider_rate_limit_usage WHERE ${where}`,
				[input.platform, input.modelId, input.keyId, "request", minuteStart],
			),
			count(
				db,
				`SELECT COALESCE(SUM(tokens), 0) AS n FROM provider_rate_limit_usage WHERE ${where}`,
				[input.platform, input.modelId, input.keyId, "tokens", minuteStart],
			),
			count(
				db,
				`SELECT COUNT(*) AS n FROM provider_rate_limit_usage WHERE ${where}`,
				[input.platform, input.modelId, input.keyId, "request", dayStart],
			),
			count(
				db,
				`SELECT COALESCE(SUM(tokens), 0) AS n FROM provider_rate_limit_usage WHERE ${where}`,
				[input.platform, input.modelId, input.keyId, "tokens", dayStart],
			),
		]);
	const rpm = input.rpmLimit ?? DEFAULT_RATE_LIMITS.rpm;
	const tpm = input.tpmLimit ?? DEFAULT_RATE_LIMITS.tpm;
	const rpd = input.rpdLimit ?? DEFAULT_RATE_LIMITS.rpd;
	const tpd = input.tpdLimit ?? DEFAULT_RATE_LIMITS.tpd;
	if (requestsMinute >= rpm) return { ok: false, reason: "rpm" };
	if (tokensMinute + input.estTokens > tpm) return { ok: false, reason: "tpm" };
	if (requestsDay >= rpd) return { ok: false, reason: "rpd" };
	if (tokensDay + input.estTokens > tpd) return { ok: false, reason: "tpd" };
	return { ok: true };
}

export interface UsageReservation {
	rowId: number;
	createdAtMs: number;
	keyId: number;
	platform: string;
	modelId: string;
}

/**
 * Atomic reservation for one upstream attempt, in the same
 * single-statement pattern as checkFixedWindowLimit: one conditional
 * INSERT writes the `request` row only when all four windows (rpm /
 * tpm / rpd / tpd, with the caller's effective limits) still have room
 * for the estimated tokens. Two concurrent requests for the same key
 * cannot both slip through — the second one's subqueries see the
 * first one's row, because SQLite runs the statement atomically.
 *
 * The `tokens` placeholder row holds the input estimate only: the
 * output reserve (estTokens − estInputTokens) is counted by the gate
 * but not written, so a failed attempt burns its input estimate, not
 * a full 8k-token output reserve it never produced. On success the
 * caller finalizes the placeholder with the real total via
 * finalizeUsage; on failure the rows stay, so failed attempts count
 * against the key's rpm/tpm — a dead key throttles itself instead of
 * being retried without bound.
 *
 * Best-effort limit: the gate and the placeholder insert are two
 * statements, so a crash between them leaves a `request` row with no
 * `tokens` row (conservative: the request still counts toward rpm).
 * The windows use the same bounds as canMakeRequest, so the gate and
 * the pre-filter agree.
 */
export async function reserveUsage(
	db: D1Database,
	input: {
		platform: string;
		modelId: string;
		keyId: number;
		estTokens: number;
		estInputTokens: number;
		rpmLimit?: number | null;
		tpmLimit?: number | null;
		rpdLimit?: number | null;
		tpdLimit?: number | null;
	},
): Promise<
	| { ok: true; reservation: UsageReservation }
	| { ok: false; reservation?: undefined }
> {
	const now = Date.now();
	const { minuteStart, dayStart } = getRateLimitWindowStarts(now);
	const rpm = input.rpmLimit ?? DEFAULT_RATE_LIMITS.rpm;
	const tpm = input.tpmLimit ?? DEFAULT_RATE_LIMITS.tpm;
	const rpd = input.rpdLimit ?? DEFAULT_RATE_LIMITS.rpd;
	const tpd = input.tpdLimit ?? DEFAULT_RATE_LIMITS.tpd;
	const requestWhere =
		"platform = ? AND model_id = ? AND key_id = ? AND kind = 'request' AND created_at_ms > ?";
	const tokensWhere =
		"platform = ? AND model_id = ? AND key_id = ? AND kind = 'tokens' AND created_at_ms > ?";
	const gated = await db
		.prepare(
			`INSERT INTO provider_rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
			 SELECT ?, ?, ?, 'request', NULL, ?
			  WHERE (SELECT COUNT(*) FROM provider_rate_limit_usage WHERE ${requestWhere}) < ?
			    AND (SELECT COALESCE(SUM(tokens), 0) FROM provider_rate_limit_usage WHERE ${tokensWhere}) + ? <= ?
			    AND (SELECT COUNT(*) FROM provider_rate_limit_usage WHERE ${requestWhere}) < ?
			    AND (SELECT COALESCE(SUM(tokens), 0) FROM provider_rate_limit_usage WHERE ${tokensWhere}) + ? <= ?
			 RETURNING rowid AS id`,
		)
		.bind(
			input.platform,
			input.modelId,
			input.keyId,
			now,
			input.platform,
			input.modelId,
			input.keyId,
			minuteStart,
			rpm,
			input.platform,
			input.modelId,
			input.keyId,
			minuteStart,
			input.estTokens,
			tpm,
			input.platform,
			input.modelId,
			input.keyId,
			dayStart,
			rpd,
			input.platform,
			input.modelId,
			input.keyId,
			dayStart,
			input.estTokens,
			tpd,
		)
		.first<{ id: number }>();
	if (!gated) return { ok: false };
	const row = await db
		.prepare(
			"INSERT INTO provider_rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'tokens', ?, ?) RETURNING rowid AS id",
		)
		.bind(input.platform, input.modelId, input.keyId, input.estInputTokens, now)
		.first<{ id: number }>();
	if (!row) throw new Error("Usage reservation unavailable");
	return {
		ok: true,
		reservation: {
			rowId: row.id,
			createdAtMs: now,
			keyId: input.keyId,
			platform: input.platform,
			modelId: input.modelId,
		},
	};
}

export async function finalizeUsage(
	db: D1Database,
	receipt: UsageReservation,
	tokens: number,
): Promise<void> {
	if (!Number.isSafeInteger(tokens) || tokens < 0)
		throw new Error("Invalid token total");
	await db
		.prepare(
			"UPDATE provider_rate_limit_usage SET tokens = ? WHERE rowid = ? AND created_at_ms = ? AND key_id = ? AND platform = ? AND model_id = ? AND kind = 'tokens'",
		)
		.bind(
			tokens,
			receipt.rowId,
			receipt.createdAtMs,
			receipt.keyId,
			receipt.platform,
			receipt.modelId,
		)
		.run();
}

export async function recordUsage(
	db: D1Database,
	input: {
		platform: string;
		modelId: string;
		keyId: number;
		inputTokens: number;
		outputTokens: number;
	},
): Promise<UsageReservation> {
	const now = Date.now();
	await db
		.prepare(
			"INSERT INTO provider_rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'request', NULL, ?)",
		)
		.bind(input.platform, input.modelId, input.keyId, now)
		.run();
	const row = await db
		.prepare(
			"INSERT INTO provider_rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'tokens', ?, ?) RETURNING rowid AS id",
		)
		.bind(
			input.platform,
			input.modelId,
			input.keyId,
			input.inputTokens + input.outputTokens,
			now,
		)
		.first<{ id: number }>();
	if (!row) throw new Error("Usage reservation unavailable");
	return {
		rowId: row.id,
		createdAtMs: now,
		keyId: input.keyId,
		platform: input.platform,
		modelId: input.modelId,
	};
}
