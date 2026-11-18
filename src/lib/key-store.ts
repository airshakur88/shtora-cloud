import {
	decryptApiKey,
	encryptApiKey,
	generateUnifiedToken,
} from "@/lib/crypto";
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
const TOKEN_PATTERN =
	/^flmr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function createApiKey(
	db: D1Database,
	input: KeyInput,
	secret: string,
): Promise<KeySummary> {
	const encrypted = await encryptApiKey(input.rawKey, secret);
	const token = generateUnifiedToken();
	const row = (
		await db
			.prepare(
				`INSERT INTO api_keys
             (user_id, platform, key_label, encrypted_key, iv, auth_tag, base_url,
              rpm_limit, tpm_limit, rpd_limit, tpd_limit, unified_token)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				token,
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
		unifiedToken: row.unified_token,
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
	const keys: KeySummary[] = [];
	for (const row of rows.results) {
		const rawKey = await decryptApiKey(
			{ ciphertext: row.encrypted_key, iv: row.iv, authTag: row.auth_tag },
			secret,
		);
		keys.push({
			id: row.id,
			platform: row.platform,
			keyLabel: row.key_label,
			enabled: row.enabled === 1,
			lastHealthCheckAt: row.last_health_check_at,
			lastHealthCheckStatus: row.last_health_check_status,
			unifiedToken: row.unified_token,
			createdAt: row.created_at,
			maskedKey: maskKey(rawKey),
			rpmLimit: row.rpm_limit,
			tpmLimit: row.tpm_limit,
			rpdLimit: row.rpd_limit,
			tpdLimit: row.tpd_limit,
		});
	}
	return keys;
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
	const keys: ExportedKey[] = [];
	for (const row of rows.results) {
		const rawKey = await decryptApiKey(
			{ ciphertext: row.encrypted_key, iv: row.iv, authTag: row.auth_tag },
			secret,
		);
		keys.push({
			platform: row.platform,
			key: rawKey,
			label: row.key_label,
		});
	}
	return keys;
}

export async function getApiKeyOwnerByToken(
	db: D1Database,
	unifiedToken: string,
): Promise<string | null> {
	if (!TOKEN_PATTERN.test(unifiedToken)) return null;
	const row = await db
		.prepare(
			"SELECT user_id FROM api_keys WHERE unified_token = ? AND enabled = 1",
		)
		.bind(unifiedToken)
		.first<{ user_id: string }>();
	return row?.user_id ?? null;
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
	const keys: DecryptedPlatformKey[] = [];
	for (const row of rows.results) {
		keys.push({
			id: row.id,
			apiKey: await decryptApiKey(
				{ ciphertext: row.encrypted_key, iv: row.iv, authTag: row.auth_tag },
				secret,
			),
			baseUrl: row.base_url,
			rpmLimit: row.rpm_limit,
			tpmLimit: row.tpm_limit,
			rpdLimit: row.rpd_limit,
			tpdLimit: row.tpd_limit,
		});
	}
	return keys;
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
