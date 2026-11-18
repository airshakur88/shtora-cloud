import { expect, test } from "bun:test";
import { hashAuthPassword, verifyAuthPassword } from "../src/lib/auth-password";
import { decryptApiKey, encryptApiKey } from "../src/lib/crypto";
import {
	createApiKey,
	deleteApiKey,
	getApiKeyOwnerByToken,
	listApiKeys,
	setApiKeyEnabled,
} from "../src/lib/key-store";
import { hashPassword } from "../src/lib/password";
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

	const targetHash = await hashPassword("legacy-password-123");
	expect(await verifyAuthPassword("legacy-password-123", targetHash)).toBe(
		true,
	);
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
		const ownerId = await getApiKeyOwnerByToken(db, created.unifiedToken);
		const listed = await listApiKeys(db, "u1", SECRET);

		expect(stored?.encrypted_key).not.toContain(rawKey);
		expect(stored?.unified_token).toBe(created.unifiedToken);
		expect(ownerId).toBe("u1");
		expect(created.unifiedToken).toMatch(
			/^flmr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(await getApiKeyOwnerByToken(db, "invalid-token")).toBe(null);
		await setApiKeyEnabled(db, created.id, "u1", false);
		expect(await getApiKeyOwnerByToken(db, created.unifiedToken)).toBe(null);
		await setApiKeyEnabled(db, created.id, "u1", true);
		await deleteApiKey(db, created.id, "not-the-owner");
		expect(await getApiKeyOwnerByToken(db, created.unifiedToken)).toBe("u1");
		expect(created.maskedKey).toBe("••••7654");
		expect(listed).toHaveLength(1);
		expect(listed[0].maskedKey).toBe("••••7654");
		expect("encryptedKey" in listed[0]).toBe(false);
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
