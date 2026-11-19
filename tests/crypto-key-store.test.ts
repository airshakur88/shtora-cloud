import { expect, test } from "bun:test";
import { hashAuthPassword, verifyAuthPassword } from "../src/lib/auth-password";
import { decryptApiKey, encryptApiKey } from "../src/lib/crypto";
import {
	createApiKey,
	deleteApiKey,
	exportApiKeys,
	getApiKeyOwnerByToken,
	getEnabledKeysForPlatform,
	listApiKeys,
	rotateUnifiedToken,
	setApiKeyEnabled,
	sha256Hex,
} from "../src/lib/key-store";
import { createParityDatabase } from "./utils/parity-database";

const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";

test("provider credential encryption round-trips without exposing ciphertext as plaintext", async () => {
	const rawKey = "sk-provider-secret-123456";
	const encrypted = await encryptApiKey(rawKey, SECRET);
	expect(encrypted.ciphertext).not.toContain(rawKey);
	expect(await decryptApiKey(encrypted, SECRET)).toBe(rawKey);
});

test("auth scrypt verifier accepts baseline and pre-parity target formats", async () => {
	const baselineHash = await hashAuthPassword("correct-horse-123");
	expect(baselineHash).toMatch(/^scrypt\$16384\$8\$1\$/);
	expect(await verifyAuthPassword("correct-horse-123", baselineHash)).toBe(
		true,
	);
	expect(await verifyAuthPassword("wrong-password", baselineHash)).toBe(false);
	const hashFromBaselineScrypt =
		"scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f$315f00a440d16bc074d8a8a1328bafbc7a500cd454ac712c70251ff504061694";
	expect(
		await verifyAuthPassword("baseline-password-123", hashFromBaselineScrypt),
	).toBe(true);
});

test("provider API keys are encrypted and unified tokens resolve to their owner", async () => {
	const db = await createParityDatabase();
	try {
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind("u1", "Test User", "testuser", "hash")
			.run();
		const rawKey = "sk-upstream-secret-987654";
		const created = await createApiKey(
			db,
			{
				userId: "u1",
				platform: "groq",
				keyLabel: "primary",
				rawKey,
			},
			SECRET,
		);
		const stored = await db
			.prepare("SELECT encrypted_key, unified_token FROM api_keys WHERE id = ?")
			.bind(created.id)
			.first<{ encrypted_key: string; unified_token: string }>();
		// The plaintext token exists only on the creation response.
		const token = created.unifiedToken as string;
		const ownerId = await getApiKeyOwnerByToken(db, token);
		const listed = await listApiKeys(db, "u1", SECRET);

		expect(stored?.encrypted_key).not.toContain(rawKey);
		// Only the SHA-256 hash of the unified token is stored.
		expect(stored?.unified_token).toBe(await sha256Hex(token));
		expect(stored?.unified_token).not.toBe(token);
		expect(ownerId).toBe("u1");
		expect(token).toMatch(
			/^flmr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(await getApiKeyOwnerByToken(db, "invalid-token")).toBe(null);
		await setApiKeyEnabled(db, created.id, "u1", false);
		expect(await getApiKeyOwnerByToken(db, token)).toBe(null);
		await setApiKeyEnabled(db, created.id, "u1", true);
		await deleteApiKey(db, created.id, "not-the-owner");
		expect(await getApiKeyOwnerByToken(db, token)).toBe("u1");
		expect(created.maskedKey).toBe("••••7654");
		expect(listed).toHaveLength(1);
		expect(listed[0].maskedKey).toBe("••••7654");
		// The token is returned once at creation, never in listings.
		expect(listed[0].unifiedToken).toBeUndefined();
		expect("encryptedKey" in listed[0]).toBe(false);
	} finally {
		db.close();
	}
});

test("failed unified-token lookups log a diagnosable reason without the token", async () => {
	const db = await createParityDatabase();
	try {
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind("u1", "Test User", "testuser", "hash")
			.run();
		const created = await createApiKey(
			db,
			{
				userId: "u1",
				platform: "groq",
				keyLabel: "primary",
				rawKey: "sk-upstream-secret-987654",
			},
			SECRET,
		);
		const token = created.unifiedToken as string;
		const warnings: unknown[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args[0]);
		};
		try {
			expect(await getApiKeyOwnerByToken(db, "ska-0123456789abcdef")).toBe(
				null,
			);
			expect(
				await getApiKeyOwnerByToken(
					db,
					"flmr-11111111-2222-3333-4444-555555555555",
				),
			).toBe(null);
			await setApiKeyEnabled(db, created.id, "u1", false);
			expect(await getApiKeyOwnerByToken(db, token)).toBe(null);
		} finally {
			console.warn = originalWarn;
		}
		expect(warnings).toHaveLength(3);
		expect(warnings[0]).toMatchObject({
			event: "v1_auth_failed",
			reason: "token_pattern_mismatch",
			isFlmr: false,
			isSka: true,
		});
		expect(warnings[1]).toMatchObject({
			event: "v1_auth_failed",
			reason: "unknown_token",
		});
		expect(warnings[2]).toMatchObject({
			event: "v1_auth_failed",
			reason: "key_disabled",
		});
		// The token itself never reaches the logs.
		expect(JSON.stringify(warnings)).not.toContain("ska-0123456789abcdef");
		expect(JSON.stringify(warnings)).not.toContain(
			"flmr-11111111-2222-3333-4444-555555555555",
		);
		expect(JSON.stringify(warnings)).not.toContain(token);
	} finally {
		db.close();
	}
});

test("legacy plaintext unified tokens authenticate and are re-hashed on first use", async () => {
	const db = await createParityDatabase();
	try {
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind("u1", "Test User", "testuser", "hash")
			.run();
		const legacyToken = "flmr-11111111-2222-3333-4444-555555555555";
		await db
			.prepare(
				"INSERT INTO api_keys (user_id, platform, encrypted_key, iv, auth_tag, enabled, unified_token) VALUES ('u1', 'groq', 'enc', 'iv', 'tag', 1, ?)",
			)
			.bind(legacyToken)
			.run();
		expect(await getApiKeyOwnerByToken(db, legacyToken)).toBe("u1");
		const stored = await db
			.prepare("SELECT unified_token FROM api_keys WHERE user_id = ?")
			.bind("u1")
			.first<{ unified_token: string }>();
		expect(stored?.unified_token).toBe(await sha256Hex(legacyToken));
		expect(stored?.unified_token).not.toBe(legacyToken);
		// Still works after the re-hash.
		expect(await getApiKeyOwnerByToken(db, legacyToken)).toBe("u1");
	} finally {
		db.close();
	}
});

test("rotating a unified token invalidates the old one", async () => {
	const db = await createParityDatabase();
	try {
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind("u1", "Test User", "testuser", "hash")
			.run();
		const created = await createApiKey(
			db,
			{ userId: "u1", platform: "groq", keyLabel: "primary", rawKey: "sk-x" },
			SECRET,
		);
		const oldToken = created.unifiedToken as string;
		expect(await getApiKeyOwnerByToken(db, oldToken)).toBe("u1");
		const newToken = await rotateUnifiedToken(db, created.id, "u1");
		expect(newToken).toMatch(
			/^flmr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(newToken).not.toBe(oldToken);
		expect(await getApiKeyOwnerByToken(db, oldToken)).toBe(null);
		expect(await getApiKeyOwnerByToken(db, newToken as string)).toBe("u1");
		expect(await rotateUnifiedToken(db, created.id, "not-the-owner")).toBe(
			null,
		);
	} finally {
		db.close();
	}
});

test("a key that cannot be decrypted does not take down the key listing", async () => {
	const db = await createParityDatabase();
	try {
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind("u1", "Test User", "testuser", "hash")
			.run();
		const good = await createApiKey(
			db,
			{
				userId: "u1",
				platform: "groq",
				keyLabel: "good",
				rawKey: "sk-good-1234",
			},
			SECRET,
		);
		// Tampered ciphertext: valid hex, but the auth tag no longer
		// matches, so AES-GCM rejects it.
		const encrypted = await encryptApiKey("sk-tampered-1234", SECRET);
		const last = encrypted.ciphertext.slice(-1);
		const tampered =
			encrypted.ciphertext.slice(0, -1) + (last === "0" ? "1" : "0");
		await db
			.prepare(
				"INSERT INTO api_keys (user_id, platform, key_label, encrypted_key, iv, auth_tag, enabled, unified_token) VALUES ('u1', 'groq', 'tampered', ?, ?, ?, 1, ?)",
			)
			.bind(
				tampered,
				encrypted.iv,
				encrypted.authTag,
				await sha256Hex("flmr-aaaaaaaa-1111-2222-3333-444444444444"),
			)
			.run();
		// Garbage encoding: not hex at all.
		await db
			.prepare(
				"INSERT INTO api_keys (user_id, platform, key_label, encrypted_key, iv, auth_tag, enabled, unified_token) VALUES ('u1', 'groq', 'garbage', 'not-hex!!', '00', '00', 1, ?)",
			)
			.bind(await sha256Hex("flmr-bbbbbbbb-1111-2222-3333-444444444444"))
			.run();

		const listed = await listApiKeys(db, "u1", SECRET);
		expect(listed).toHaveLength(3);
		expect(listed.find((key) => key.id === good.id)?.maskedKey).toBe(
			"••••1234",
		);
		// The bad rows stay visible so the owner can delete them, but
		// carry no key material.
		for (const label of ["tampered", "garbage"]) {
			expect(listed.find((key) => key.keyLabel === label)?.maskedKey).toBe(
				"•••• unreadable",
			);
		}
		// The router and the export only see keys they can actually read:
		// one bad row must not lose the whole platform.
		const platformKeys = await getEnabledKeysForPlatform(
			db,
			"u1",
			"groq",
			SECRET,
		);
		expect(platformKeys.map((key) => key.id)).toEqual([good.id]);
		const exported = await exportApiKeys(db, "u1", SECRET);
		expect(exported).toHaveLength(1);
		expect(exported[0].key).toBe("sk-good-1234");
	} finally {
		db.close();
	}
});

test("deleting a provider key preserves request history", async () => {
	const db = await createParityDatabase();
	try {
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind("u1", "Test User", "testuser", "hash")
			.run();
		const key = await createApiKey(
			db,
			{
				userId: "u1",
				platform: "groq",
				keyLabel: "primary",
				rawKey: "sk-upstream-secret",
			},
			SECRET,
		);
		await db
			.prepare(
				`INSERT INTO provider_requests
				 (user_id, unified_token_id, model_requested, model_routed, platform, key_id, status)
				 VALUES (?, ?, ?, ?, ?, ?, 'success')`,
			)
			.bind("u1", key.id, "groq/model", "groq/model", "groq", key.id)
			.run();

		await deleteApiKey(db, key.id, "u1");

		const request = await db
			.prepare(
				"SELECT unified_token_id, key_id FROM provider_requests WHERE user_id = ?",
			)
			.bind("u1")
			.first<{ unified_token_id: number | null; key_id: number }>();
		expect(request?.unified_token_id).toBe(null);
		expect(request?.key_id).toBe(key.id);
	} finally {
		db.close();
	}
});
