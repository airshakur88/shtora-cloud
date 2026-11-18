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
/**
 * Stored lookup prefix length: "ska-" + 16 hex chars = 64 bits of the key
 * (was 12 chars / 32 bits). A 32-bit prefix collides after ~77k keys; a
 * 64-bit prefix needs ~2^32 keys for the same collision odds. Keys created
 * before this change keep their 12-char prefix and still authenticate:
 * validation tries the 20-char prefix first, then the legacy 12-char one.
 */
const ACCESS_KEY_PREFIX_LENGTH = 20;
const LEGACY_ACCESS_KEY_PREFIX_LENGTH = 12;

/** Same cap as provider keys: at most 50 access keys per user (M1). */
export const MAX_ACCESS_KEYS_PER_USER = 50;

export class AccessKeyLimitError extends Error {
	constructor() {
		super("Access key limit reached");
		this.name = "AccessKeyLimitError";
	}
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

async function sha256Hex(value: string): Promise<string> {
	const hashBuffer = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(hashBuffer), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

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

	const keyHash = await sha256Hex(apiKey);
	const keyPrefix = apiKey.slice(0, ACCESS_KEY_PREFIX_LENGTH);

	return { apiKey, keyHash, keyPrefix };
}

export async function createAccessKey(
	db: D1Database,
	userId: string,
	input: CreateAccessKeyRequest,
): Promise<CreateAccessKeyResult> {
	const existing = await db
		.prepare("SELECT COUNT(*) AS n FROM user_access_keys WHERE user_id = ?")
		.bind(userId)
		.first<{ n: number }>();
	if ((existing?.n ?? 0) >= MAX_ACCESS_KEYS_PER_USER) {
		// Thrown, not returned: the /api/access-keys route catches
		// AccessKeyLimitError and answers 403 `limit_reached`, like the
		// 50-key cap on POST /api/keys.
		throw new AccessKeyLimitError();
	}
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

	const id = result.results[0]?.id ?? 0;

	return {
		id,
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

/**
 * All enabled keys sharing a lookup prefix. A prefix collision must not
 * hide a key, so callers compare every candidate instead of taking the
 * first row.
 */
export async function getAccessKeysByPrefix(
	db: D1Database,
	keyPrefix: string,
): Promise<AccessKeyRecord[]> {
	const result = await db
		.prepare(
			`SELECT * FROM user_access_keys
		WHERE key_prefix = ? AND enabled = 1 ORDER BY id ASC`,
		)
		.bind(keyPrefix)
		.all<AccessKeyRecord>();

	return result.results;
}

export async function validateAccessKey(
	db: D1Database,
	apiKey: string,
): Promise<AccessKeyRecord | null> {
	if (!apiKey?.startsWith(ACCESS_KEY_PREFIX)) {
		return null;
	}

	const keyHash = await sha256Hex(apiKey);
	// New keys store a 20-char prefix; pre-change keys store 12 chars.
	// Both are tried so old keys keep working, and every candidate sharing
	// a prefix is compared — a collision never blocks the second key.
	const prefixes = [
		apiKey.slice(0, ACCESS_KEY_PREFIX_LENGTH),
		apiKey.slice(0, LEGACY_ACCESS_KEY_PREFIX_LENGTH),
	];
	for (const keyPrefix of [...new Set(prefixes)]) {
		const candidates = await getAccessKeysByPrefix(db, keyPrefix);
		for (const record of candidates) {
			if (!timingSafeEqual(record.key_hash, keyHash)) continue;
			if (record.expires_at) {
				const exp = new Date(record.expires_at).getTime();
				if (Date.now() > exp) continue;
			}
			return record;
		}
	}

	return null;
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
