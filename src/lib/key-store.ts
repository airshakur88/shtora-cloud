import { decryptApiKey, encryptApiKey } from "@/lib/crypto";
import { KEYLESS_API_KEY } from "@/lib/provider-catalog";
import type {
	ApiKeyRecord,
	D1Database,
	HealthStatus,
	KeyInput,
	KeySummary,
} from "@/lib/types";

type KeyRow = ApiKeyRecord;

function maskKey(rawKey: string): string {
	return rawKey === KEYLESS_API_KEY ? "No key" : `••••${rawKey.slice(-4)}`;
}

/**
 * Mask shown for a stored key that cannot be decrypted (corrupt
 * ciphertext, or a secret that no longer matches). The row stays in the
 * listing so the owner can see it and delete it; it carries no key
 * material and can never serve traffic.
 */
export const UNREADABLE_KEY_MASK = "•••• unreadable";

/**
 * Decrypt one stored key row, or null when the row cannot be read. A
 * single bad row must never take down a whole listing or a whole
 * platform's pool: callers skip nulls (the listing shows the placeholder
 * mask instead). The failure is logged with the key id only, never key
 * material.
 */
async function tryDecryptApiKey(
	row: Pick<KeyRow, "id" | "platform" | "encrypted_key" | "iv" | "auth_tag">,
	secret: string,
): Promise<string | null> {
	try {
		return await decryptApiKey(
			{
				ciphertext: row.encrypted_key,
				iv: row.iv,
				authTag: row.auth_tag,
			},
			secret,
		);
	} catch {
		console.error(
			JSON.stringify({
				event: "key_decrypt_failed",
				keyId: row.id,
				platform: row.platform,
			}),
		);
		return null;
	}
}

/** Cap on provider keys per user (M1). Enforced in POST /api/keys and import. */
export const MAX_API_KEYS_PER_USER = 50;

export async function countApiKeysForUser(
	db: D1Database,
	userId: string,
): Promise<number> {
	const row = await db
		.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?")
		.bind(userId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}
export async function createApiKey(
	db: D1Database,
	input: KeyInput,
	secret: string,
): Promise<KeySummary> {
	const encrypted = await encryptApiKey(input.rawKey, secret);
	const row = (
		await db
			.prepare(
				`INSERT INTO api_keys
             (user_id, platform, key_label, encrypted_key, iv, auth_tag, base_url,
              rpm_limit, tpm_limit, rpd_limit, tpd_limit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING *`,
			)
			.bind(
				input.userId,
				input.platform,
				input.keyLabel ?? null,
				encrypted.ciphertext,
				encrypted.iv,
				encrypted.authTag,
				input.baseUrl ?? null,
				input.rpmLimit ?? null,
				input.tpmLimit ?? null,
				input.rpdLimit ?? null,
				input.tpdLimit ?? null,
			)
			.all<KeyRow>()
	).results[0];
	if (!row) throw new Error("Created key unavailable");
	return {
		id: row.id,
		platform: row.platform,
		keyLabel: row.key_label,
		enabled: row.enabled === 1,
		lastHealthCheckAt: row.last_health_check_at,
		lastHealthCheckStatus: row.last_health_check_status,
		createdAt: row.created_at,
		maskedKey: maskKey(input.rawKey),
		rpmLimit: row.rpm_limit,
		tpmLimit: row.tpm_limit,
		rpdLimit: row.rpd_limit,
		tpdLimit: row.tpd_limit,
	};
}

export async function listApiKeys(
	db: D1Database,
	userId: string,
	secret: string,
): Promise<KeySummary[]> {
	const rows = await db
		.prepare(
			"SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
		)
		.bind(userId)
		.all<KeyRow>();
	// Decryptions are independent (one AES-GCM call per row, no shared
	// state), so they run in parallel instead of one await per key (C4).
	// A row that cannot be decrypted stays listed with the placeholder
	// mask instead of rejecting the whole listing.
	return Promise.all(
		rows.results.map(async (row) => {
			const decrypted = await tryDecryptApiKey(row, secret);
			return {
				id: row.id,
				platform: row.platform,
				keyLabel: row.key_label,
				enabled: row.enabled === 1,
				lastHealthCheckAt: row.last_health_check_at,
				lastHealthCheckStatus: row.last_health_check_status,
				createdAt: row.created_at,
				maskedKey:
					decrypted === null ? UNREADABLE_KEY_MASK : maskKey(decrypted),
				rpmLimit: row.rpm_limit,
				tpmLimit: row.tpm_limit,
				rpdLimit: row.rpd_limit,
				tpdLimit: row.tpd_limit,
			};
		}),
	);
}

export interface ExportedKey {
	platform: string;
	key: string;
	label: string | null;
}

/**
 * Returns all API keys for a user with decrypted raw values.
 * Used for export/import round-trip functionality.
 * Result is NOT masked - contains the actual key values.
 */
export async function exportApiKeys(
	db: D1Database,
	userId: string,
	secret: string,
): Promise<ExportedKey[]> {
	const rows = await db
		.prepare(
			"SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
		)
		.bind(userId)
		.all<KeyRow>();
	// Decryptions are independent: run them in parallel (C4). Rows that
	// cannot be decrypted are skipped: there is no value to export for
	// them, and one bad row must not fail the whole export.
	const exported = await Promise.all(
		rows.results.map(async (row) => {
			const decrypted = await tryDecryptApiKey(row, secret);
			if (decrypted === null) return null;
			return {
				platform: row.platform,
				key: decrypted,
				label: row.key_label,
			};
		}),
	);
	return exported.filter((entry): entry is ExportedKey => entry !== null);
}

export interface DecryptedPlatformKey {
	id: number;
	apiKey: string;
	baseUrl: string | null;
	rpmLimit: number | null;
	tpmLimit: number | null;
	rpdLimit: number | null;
	tpdLimit: number | null;
	/** Suspension deadline (migration 0019), epoch ms; null = never suspended. */
	suspendedUntilMs: number | null;
}

type EnabledPlatformKeyRow = Pick<
	KeyRow,
	| "id"
	| "encrypted_key"
	| "iv"
	| "auth_tag"
	| "base_url"
	| "rpm_limit"
	| "tpm_limit"
	| "rpd_limit"
	| "tpd_limit"
	| "suspended_until_ms"
>;

/**
 * Enabled keys of one platform with their suspension deadline.
 * Migration 0019 adds suspended_until_ms; on a database without it
 * the select throws "no such column" and every key reads as never
 * suspended, so an old database keeps serving instead of failing the
 * whole pool lookup.
 */
async function selectEnabledPlatformKeys(
	db: D1Database,
	platform: string,
	userId: string,
): Promise<EnabledPlatformKeyRow[]> {
	const columns =
		"id, encrypted_key, iv, auth_tag, base_url, rpm_limit, tpm_limit, rpd_limit, tpd_limit";
	const where =
		"FROM api_keys WHERE platform = ? AND enabled = 1 ORDER BY (user_id = ?) DESC, id ASC";
	try {
		const rows = await db
			.prepare(`SELECT ${columns}, suspended_until_ms ${where}`)
			.bind(platform, userId)
			.all<EnabledPlatformKeyRow>();
		return rows.results;
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes("no such column"))
			throw err;
		const rows = await db
			.prepare(`SELECT ${columns} ${where}`)
			.bind(platform, userId)
			.all<Omit<EnabledPlatformKeyRow, "suspended_until_ms">>();
		return rows.results.map((row) => ({
			...row,
			suspended_until_ms: null,
		}));
	}
}

export async function getEnabledKeysForPlatform(
	db: D1Database,
	userId: string,
	platform: string,
	secret: string,
): Promise<DecryptedPlatformKey[]> {
	// Community pool: every enabled key for the platform is available to all
	// users. The requester's own keys come first so they spend their own quota
	// before borrowing from the pool; per-key rate limits still apply to each.
	const rows = await selectEnabledPlatformKeys(db, platform, userId);
	// Decryptions are independent (one AES-GCM call per row, no shared
	// state), so they run in parallel instead of one await per key: the
	// old sequential loop paid a full decrypt latency per key on every
	// chat request, once per model in the chain (C4 residual). Rows that
	// cannot be decrypted are skipped: a bad row must not lose the
	// whole platform's pool.
	const decrypted = await Promise.all(
		rows.map(async (row) => {
			// The query selects no platform column; the platform is the
			// function's own argument, passed along for the failure log.
			const apiKey = await tryDecryptApiKey({ ...row, platform }, secret);
			if (apiKey === null) return null;
			return {
				id: row.id,
				apiKey,
				baseUrl: row.base_url,
				rpmLimit: row.rpm_limit,
				tpmLimit: row.tpm_limit,
				rpdLimit: row.rpd_limit,
				tpdLimit: row.tpd_limit,
				suspendedUntilMs: row.suspended_until_ms ?? null,
			};
		}),
	);
	return decrypted.filter(
		(entry): entry is DecryptedPlatformKey => entry !== null,
	);
}

export async function deleteApiKey(
	db: D1Database,
	id: number,
	userId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?")
		.bind(id, userId)
		.run();
}

export async function setApiKeyEnabled(
	db: D1Database,
	id: number,
	userId: string,
	enabled: boolean,
): Promise<void> {
	await db
		.prepare(
			"UPDATE api_keys SET enabled = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
		)
		.bind(enabled ? 1 : 0, id, userId)
		.run();
}

export async function updateKeyLimits(
	db: D1Database,
	id: number,
	userId: string,
	limits: {
		rpmLimit: number | null;
		tpmLimit: number | null;
		rpdLimit: number | null;
		tpdLimit: number | null;
	},
): Promise<void> {
	await db
		.prepare(
			`UPDATE api_keys SET rpm_limit = ?, tpm_limit = ?, rpd_limit = ?,
			 tpd_limit = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
		)
		.bind(
			limits.rpmLimit,
			limits.tpmLimit,
			limits.rpdLimit,
			limits.tpdLimit,
			id,
			userId,
		)
		.run();
}

export async function updateKeyHealth(
	db: D1Database,
	id: number,
	status: HealthStatus,
): Promise<void> {
	await db
		.prepare(
			`UPDATE api_keys SET last_health_check_at = datetime('now'),
             last_health_check_status = ?, updated_at = datetime('now') WHERE id = ?`,
		)
		.bind(status, id)
		.run();
}

/**
 * Consecutive upstream auth failures after which a key is treated as
 * dead and disabled. Three, not one: a single 401 can be a key
 * rotation in flight, but three in a row with no success or other
 * outcome between them means the key itself no longer authenticates.
 * Only 401/403 count, never 404, 5xx or timeouts. A disabled key
 * leaves the pool at once (getEnabledKeysForPlatform only returns
 * enabled keys) and the owner can re-enable it from the dashboard.
 */
export const AUTH_FAILURES_TO_DISABLE = 3;

/**
 * Disable a key whose last AUTH_FAILURES_TO_DISABLE recorded attempts
 * were all auth failures (401/403). Only attempts the router
 * persisted in provider_requests are visible here, so a failure the
 * router did not record (e.g. native count_tokens) does not count.
 * Cancelled requests (499) are ignored entirely: they neither count
 * nor break the sequence, because the client hanging up says nothing
 * about the key. A provider-wide 401 episode can disable several keys
 * of that platform; the log names the platform and key id so the owner
 * can tell a dead key from a provider misconfiguration. Returns true
 * when this call disabled the key.
 */
export async function maybeDisableKeyAfterAuthFailures(
	db: D1Database,
	platform: string,
	keyId: number,
): Promise<boolean> {
	const rows = await db
		.prepare(
			`SELECT status_code FROM provider_requests
			  WHERE key_id = ? AND (status_code IS NULL OR status_code <> 499)
			  ORDER BY id DESC LIMIT ?`,
		)
		.bind(keyId, AUTH_FAILURES_TO_DISABLE)
		.all<{ status_code: number | null }>();
	if (rows.results.length < AUTH_FAILURES_TO_DISABLE) return false;
	if (
		!rows.results.every(
			(row) => row.status_code === 401 || row.status_code === 403,
		)
	)
		return false;
	const changed = await db
		.prepare(
			`UPDATE api_keys SET enabled = 0, updated_at = datetime('now')
			  WHERE id = ? AND enabled = 1`,
		)
		.bind(keyId)
		.run();
	if (changed.meta.changes === 0) return false;
	console.error(
		JSON.stringify({ event: "key_auto_disabled", platform, keyId }),
	);
	return true;
}

/**
 * Consecutive key-blamed failures after which a key is suspended for
 * 24 h. Unlike the auth expurgo above (3× 401/403 → enabled = 0,
 * permanent until the owner re-enables), a suspension expires on its
 * own and only the key probe clears it early — a normal request never
 * re-enables a key. Non-auth failures need 5 in a row; auth failures
 * need 3, the same count as the disable, which runs first in the
 * router: an auth suspension only fires when a catalog row sat
 * between the auth failures in the raw history.
 */
export const CONSECUTIVE_FAILURES_TO_SUSPEND = 5;
/** Suspension length: 24 h, the same as the probe's default. */
export const KEY_SUSPENSION_MS = 86_400_000;
/** Short window in which every enabled key of a platform 401/403 = episode. */
export const PROVIDER_AUTH_EPISODE_WINDOW_MINUTES = 10;
/**
 * An episode needs at least this many enabled keys: with a single
 * key a provider misconfiguration is indistinguishable from a dead
 * key, and there is no mass suspension to protect against.
 */
export const PROVIDER_AUTH_EPISODE_MIN_KEYS = 2;

/** Rows read per suspension check: room for skipped rows between counted failures. */
const SUSPENSION_STREAK_READ_LIMIT = 20;

function toSqliteDate(ms: number): string {
	return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * True when every enabled key of the platform failed with 401/403
 * inside the episode window: a provider-side misconfiguration (bad
 * base URL, rotated shared credential), not N dead keys at once.
 * Only currently enabled keys count on either side, so keys the auth
 * expurgo already disabled do not inflate the episode.
 */
async function isProviderAuthEpisode(
	db: D1Database,
	platform: string,
	now: number,
): Promise<boolean> {
	const enabled = await db
		.prepare(
			"SELECT COUNT(*) AS n FROM api_keys WHERE platform = ? AND enabled = 1",
		)
		.bind(platform)
		.first<{ n: number }>();
	const total = enabled?.n ?? 0;
	if (total < PROVIDER_AUTH_EPISODE_MIN_KEYS) return false;
	const failed = await db
		.prepare(
			`SELECT COUNT(DISTINCT r.key_id) AS n FROM provider_requests r
			  JOIN api_keys k ON k.id = r.key_id
			  WHERE r.platform = ? AND r.status_code IN (401, 403)
			    AND r.created_at > ? AND k.enabled = 1`,
		)
		.bind(
			platform,
			toSqliteDate(now - PROVIDER_AUTH_EPISODE_WINDOW_MINUTES * 60_000),
		)
		.first<{ n: number }>();
	return (failed?.n ?? 0) >= total;
}

/**
 * Failure kinds that never count toward suspension, because they blame
 * the catalog, the platform, or the client — never the key:
 * - 499: the client hung up.
 * - 400/404/410: the model is gone, renamed, or rejected the request
 *   (a catalog fault; the row is marked suspect instead).
 * - 429: the platform is throttling; the quarantine ladder is the
 *   backoff for that, a 24 h suspension is not.
 * - model_mismatch: the upstream answered for another model.
 * - empty 200: the upstream answered with no content.
 * Everything else recorded as an error counts: 401/403 (auth),
 * 500/502/503 (upstream error), 504/0 (timeout/network). A success
 * breaks the streak.
 */
function countsTowardSuspension(row: {
	status_code: number | null;
	failure_attribution: string | null;
	error_message: string | null;
}): boolean {
	if (row.status_code === 499) return false;
	if (
		row.status_code === 400 ||
		row.status_code === 404 ||
		row.status_code === 410 ||
		row.status_code === 429
	)
		return false;
	if (row.failure_attribution === "model_mismatch") return false;
	if (
		row.status_code === 200 &&
		row.error_message === "Upstream returned empty content"
	)
		return false;
	return true;
}

/**
 * The key's current suspension streak: newest-first over its recorded
 * attempts, counting only key-blamed failures (see
 * countsTowardSuspension). Shared by the request path and the key
 * probe so both suspend on the same rule.
 */
export async function countSuspensionStreak(
	db: D1Database,
	keyId: number,
): Promise<{ failures: number; authFailures: number }> {
	const rows = await db
		.prepare(
			`SELECT status, status_code, failure_attribution, error_message
			  FROM provider_requests WHERE key_id = ? ORDER BY id DESC LIMIT ?`,
		)
		.bind(keyId, SUSPENSION_STREAK_READ_LIMIT)
		.all<{
			status: string;
			status_code: number | null;
			failure_attribution: string | null;
			error_message: string | null;
		}>();
	let failures = 0;
	let authFailures = 0;
	for (const row of rows.results) {
		if (!countsTowardSuspension(row)) continue;
		if (row.status === "success") break;
		failures += 1;
		if (row.status_code === 401 || row.status_code === 403) authFailures += 1;
		if (
			failures >= CONSECUTIVE_FAILURES_TO_SUSPEND ||
			authFailures >= AUTH_FAILURES_TO_DISABLE
		)
			break;
	}
	return { failures, authFailures };
}

/**
 * True when every enabled key of the platform recorded a key-blamed
 * failure inside the episode window: a platform-wide outage or
 * throttling episode, not N dead keys at once. Same shape as
 * isProviderAuthEpisode, but over every failure kind that counts
 * toward suspension — so a 429/5xx storm cannot suspend the whole
 * pool the way a 401 storm cannot disable it.
 */
export async function isProviderFailureEpisode(
	db: D1Database,
	platform: string,
	now: number,
): Promise<boolean> {
	const enabled = await db
		.prepare(
			"SELECT COUNT(*) AS n FROM api_keys WHERE platform = ? AND enabled = 1",
		)
		.bind(platform)
		.first<{ n: number }>();
	const total = enabled?.n ?? 0;
	if (total < PROVIDER_AUTH_EPISODE_MIN_KEYS) return false;
	const failed = await db
		.prepare(
			`SELECT COUNT(DISTINCT r.key_id) AS n FROM provider_requests r
			  JOIN api_keys k ON k.id = r.key_id
			  WHERE r.platform = ? AND r.status = 'error'
			    AND (r.status_code IS NULL OR r.status_code NOT IN (499, 400, 404, 410, 429))
			    AND (r.failure_attribution IS NULL OR r.failure_attribution <> 'model_mismatch')
			    AND NOT (r.status_code = 200 AND r.error_message = 'Upstream returned empty content')
			    AND r.created_at > ? AND k.enabled = 1`,
		)
		.bind(
			platform,
			toSqliteDate(now - PROVIDER_AUTH_EPISODE_WINDOW_MINUTES * 60_000),
		)
		.first<{ n: number }>();
	return (failed?.n ?? 0) >= total;
}

/**
 * Suspend a key whose recent attempts are a solid run of key-blamed
 * failures: 5 in a row, or 3 in a row of 401/403. The streak is
 * countSuspensionStreak: a success breaks it; 499, 400/404/410, 429,
 * model_mismatch and empty 200s neither count nor break it, so a dead
 * model or a throttling platform cannot suspend the keys that serve
 * it. A platform-wide failure episode suspends nothing either: when
 * every enabled key of the platform failed with a key-blamed kind
 * inside the window, the platform is having an episode, not N dead
 * keys at once. Returns true when this call suspended the key.
 *
 * The suspension columns come from migration 0019. Without them the
 * UPDATE throws "no such column" and the check is a no-op: a
 * data-marking failure must never fail the client request. The
 * UPDATE itself is the same one the key probe runs (same columns,
 * same `consecutive_failures` reason); the probe's helpers live in
 * src/lib/jobs/key-probe.ts, which this module cannot import without
 * a cycle, so the statement is mirrored here until the two are
 * consolidated.
 */
export async function maybeSuspendKeyAfterFailures(
	db: D1Database,
	platform: string,
	keyId: number,
	now = Date.now(),
): Promise<boolean> {
	const { failures, authFailures } = await countSuspensionStreak(db, keyId);
	if (
		failures < CONSECUTIVE_FAILURES_TO_SUSPEND &&
		authFailures < AUTH_FAILURES_TO_DISABLE
	)
		return false;
	if (
		authFailures >= AUTH_FAILURES_TO_DISABLE &&
		(await isProviderAuthEpisode(db, platform, now))
	) {
		// Every enabled key of the platform is failing auth at once:
		// alert, do not suspend in bulk.
		console.error(
			JSON.stringify({ event: "provider_auth_episode", platform, keyId }),
		);
		return false;
	}
	if (await isProviderFailureEpisode(db, platform, now)) {
		// Every enabled key of the platform failed with a key-blamed
		// kind inside the window: a platform-wide outage or throttling
		// episode, not N dead keys at once.
		console.error(
			JSON.stringify({
				event: "provider_failure_episode",
				platform,
				keyId,
			}),
		);
		return false;
	}
	try {
		const changed = await db
			.prepare(
				`UPDATE api_keys
				  SET suspended_until_ms = ?, suspension_reason = ?,
				      updated_at = datetime('now')
				  WHERE id = ? AND enabled = 1
				    AND (suspended_until_ms IS NULL OR suspended_until_ms <= ?)`,
			)
			.bind(now + KEY_SUSPENSION_MS, "consecutive_failures", keyId, now)
			.run();
		if (changed.meta.changes === 0) return false;
	} catch (err) {
		if (err instanceof Error && err.message.includes("no such column"))
			return false;
		throw err;
	}
	console.error(
		JSON.stringify({
			event: "key_suspended",
			platform,
			keyId,
			consecutiveFailures: failures,
			authFailures,
		}),
	);
	return true;
}
