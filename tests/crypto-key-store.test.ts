import { expect, test } from "bun:test";
import { hashAuthPassword, verifyAuthPassword } from "../src/lib/auth-password";
import { decryptApiKey, encryptApiKey } from "../src/lib/crypto";
import {
	createApiKey,
	deleteApiKey,
	exportApiKeys,
	getEnabledKeysForPlatform,
	listApiKeys,
	setApiKeyEnabled,
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

test("provider API keys are encrypted at rest and listed masked", async () => {
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
			.prepare("SELECT encrypted_key FROM api_keys WHERE id = ?")
			.bind(created.id)
			.first<{ encrypted_key: string }>();
		const listed = await listApiKeys(db, "u1", SECRET);

		expect(stored?.encrypted_key).not.toContain(rawKey);
		expect(created.maskedKey).toBe("••••7654");
		expect(listed).toHaveLength(1);
		expect(listed[0].maskedKey).toBe("••••7654");
		expect(listed[0].enabled).toBe(true);
		// The plaintext key never appears in listings.
		expect("encryptedKey" in listed[0]).toBe(false);
		await setApiKeyEnabled(db, created.id, "u1", false);
		expect((await listApiKeys(db, "u1", SECRET))[0].enabled).toBe(false);
		await setApiKeyEnabled(db, created.id, "u1", true);
		await deleteApiKey(db, created.id, "not-the-owner");
		expect(await listApiKeys(db, "u1", SECRET)).toHaveLength(1);
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
				"INSERT INTO api_keys (user_id, platform, key_label, encrypted_key, iv, auth_tag, enabled) VALUES ('u1', 'groq', 'tampered', ?, ?, ?, 1)",
			)
			.bind(tampered, encrypted.iv, encrypted.authTag)
			.run();
		// Garbage encoding: not hex at all.
		await db
			.prepare(
				"INSERT INTO api_keys (user_id, platform, key_label, encrypted_key, iv, auth_tag, enabled) VALUES ('u1', 'groq', 'garbage', 'not-hex!!', '00', '00', 1)",
			)
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
				 (user_id, model_requested, model_routed, platform, key_id, status)
				 VALUES (?, ?, ?, ?, ?, 'success')`,
			)
			.bind("u1", "groq/model", "groq/model", "groq", key.id)
			.run();

		await deleteApiKey(db, key.id, "u1");

		const request = await db
			.prepare("SELECT key_id FROM provider_requests WHERE user_id = ?")
			.bind("u1")
			.first<{ key_id: number }>();
		expect(request?.key_id).toBe(key.id);
	} finally {
		db.close();
	}
});
