import type { D1Database } from "./types";

export interface AccessKeyRecord {
	id: number;
	user_id: string;
	name: string;
	key_hash: string;
	key_prefix: string;
	enabled: number;
	created_at: string;
	updated_at: string;
	last_used_at: string | null;
	expires_at: string | null;
}

export interface AccessKeyResponse {
	id: number;
	name: string;
	enabled: boolean;
	createdAt: string;
	lastUsedAt: string | null;
	expiresAt: string | null;
	keyPrefix: string;
}

export interface CreateAccessKeyRequest {
	name: string;
	expiresInDays?: number | null;
}

export interface CreateAccessKeyResult extends AccessKeyResponse {
	apiKey: string;
}

const ACCESS_KEY_PREFIX = "ska-";
const ACCESS_KEY_BYTES = 32;

async function generateAccessKey(): Promise<{
	apiKey: string;
	keyHash: string;
	keyPrefix: string;
}> {
	const bytes = new Uint8Array(ACCESS_KEY_BYTES);
	crypto.getRandomValues(bytes);
	const keyBody = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const apiKey = `${ACCESS_KEY_PREFIX}${keyBody}`;

	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(apiKey),
	);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const keyHash = hashArray
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	const keyPrefix = apiKey.slice(0, 12);

	return { apiKey, keyHash, keyPrefix };
}

export async function createAccessKey(
	db: D1Database,
	userId: string,
	input: CreateAccessKeyRequest,
): Promise<CreateAccessKeyResult> {
	const { apiKey, keyHash, keyPrefix } = await generateAccessKey();

	const now = new Date().toISOString();
	let expiresAt: string | null = null;
	if (input.expiresInDays && input.expiresInDays > 0) {
		const exp = new Date();
		exp.setDate(exp.getDate() + input.expiresInDays);
		expiresAt = exp.toISOString();
	}

	const result = await db
		.prepare(
			`INSERT INTO user_access_keys
		(user_id, name, key_hash, key_prefix, enabled, created_at, updated_at, expires_at)
		VALUES (?, ?, ?, ?, 1, ?, ?, ?)
		RETURNING id`,
		)
		.bind(userId, input.name, keyHash, keyPrefix, now, now, expiresAt)
		.all<{ id: number }>();

	const row = result.results[0];
	if (!row) throw new Error("Created access key unavailable");

	return {
		id: row.id,
		name: input.name,
		enabled: true,
		createdAt: now,
		lastUsedAt: null,
		expiresAt,
		keyPrefix,
		apiKey,
	};
}

export async function listAccessKeys(
	db: D1Database,
	userId: string,
): Promise<AccessKeyResponse[]> {
	const result = await db
		.prepare(
			`SELECT id, name, enabled, created_at, updated_at, last_used_at, expires_at, key_prefix
		FROM user_access_keys
		WHERE user_id = ?
		ORDER BY created_at DESC`,
		)
		.bind(userId)
		.all<AccessKeyRecord>();

	return result.results.map((row) => ({
		id: row.id,
		name: row.name,
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
		expiresAt: row.expires_at,
		keyPrefix: row.key_prefix,
	}));
}

export async function getAccessKeyByPrefix(
	db: D1Database,
	keyPrefix: string,
): Promise<AccessKeyRecord | null> {
	const result = await db
		.prepare(
			`SELECT * FROM user_access_keys
		WHERE key_prefix = ? AND enabled = 1`,
		)
		.bind(keyPrefix)
		.first<AccessKeyRecord>();

	return result ?? null;
}

export async function validateAccessKey(
	db: D1Database,
	apiKey: string,
): Promise<AccessKeyRecord | null> {
	if (!apiKey?.startsWith(ACCESS_KEY_PREFIX)) {
		return null;
	}

	const keyPrefix = apiKey.slice(0, 12);
	const record = await getAccessKeyByPrefix(db, keyPrefix);
	if (!record) {
		return null;
	}

	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(apiKey),
	);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const keyHash = hashArray
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	if (record.key_hash !== keyHash) {
		return null;
	}

	if (record.expires_at) {
		const exp = new Date(record.expires_at).getTime();
		if (Date.now() > exp) {
			return null;
		}
	}

	return record;
}

export async function updateAccessKeyLastUsed(
	db: D1Database,
	id: number,
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`UPDATE user_access_keys
		SET last_used_at = ?, updated_at = ?
		WHERE id = ?`,
		)
		.bind(now, now, id)
		.run();
}

export async function deleteAccessKey(
	db: D1Database,
	id: number,
	userId: string,
): Promise<void> {
	await db
		.prepare(`DELETE FROM user_access_keys WHERE id = ? AND user_id = ?`)
		.bind(id, userId)
		.run();
}

export async function toggleAccessKeyEnabled(
	db: D1Database,
	id: number,
	userId: string,
	enabled: boolean,
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`UPDATE user_access_keys
		SET enabled = ?, updated_at = ?
		WHERE id = ? AND user_id = ?`,
		)
		.bind(enabled ? 1 : 0, now, id, userId)
		.run();
}
