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
	const rows = await db
		.prepare(
			`SELECT id, encrypted_key, iv, auth_tag, base_url, rpm_limit, tpm_limit, rpd_limit, tpd_limit
             FROM api_keys WHERE platform = ? AND enabled = 1
             ORDER BY (user_id = ?) DESC, id ASC`,
		)
		.bind(platform, userId)
		.all<
			Pick<
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
			>
		>();
	// Decryptions are independent (one AES-GCM call per row, no shared
	// state), so they run in parallel instead of one await per key: the
	// old sequential loop paid a full decrypt latency per key on every
	// chat request, once per model in the chain (C4 residual). Rows that
	// cannot be decrypted are skipped: a bad row must not lose the
	// whole platform's pool.
	const decrypted = await Promise.all(
		rows.results.map(async (row) => {
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
