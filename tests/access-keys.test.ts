import { expect, test } from "bun:test";
import {
	AccessKeyLimitError,
	createAccessKey,
	getAccessKeysByPrefix,
	validateAccessKey,
} from "../src/lib/access-keys";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

async function sha256Hex(value: string): Promise<string> {
	const buffer = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(buffer), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

async function insertUser(db: MemoryD1, id: string): Promise<void> {
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(id, "Test User", `user-${id}`, "hash")
		.run();
}

test("access keys store a 20-char (64-bit) prefix and validate", async () => {
	const db = await createParityDatabase();
	try {
		await insertUser(db, "u1");
		const created = await createAccessKey(db, "u1", { name: "key-1" });
		expect(created.keyPrefix).toHaveLength(20);
		expect(created.keyPrefix.startsWith("ska-")).toBe(true);
		expect(created.apiKey.startsWith(created.keyPrefix)).toBe(true);
		const record = await validateAccessKey(db, created.apiKey);
		expect(record?.id).toBe(created.id);
		expect(await validateAccessKey(db, `${created.apiKey}0`)).toBe(null);
		expect(await validateAccessKey(db, "not-a-key")).toBe(null);
	} finally {
		db.close();
	}
});

test("legacy 12-char prefix keys still validate; a same-prefix wrong key does not", async () => {
	const db = await createParityDatabase();
	try {
		await insertUser(db, "u1");
		// A key as stored before the prefix change: 12-char prefix.
		const keyA = `ska-${"aa".repeat(32)}`;
		await db
			.prepare(
				`INSERT INTO user_access_keys
				 (user_id, name, key_hash, key_prefix, enabled, created_at, updated_at)
				 VALUES (?, 'legacy', ?, ?, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
			)
			.bind("u1", await sha256Hex(keyA), keyA.slice(0, 12))
			.run();
		const found = await validateAccessKey(db, keyA);
		expect(found?.name).toBe("legacy");
		expect(await getAccessKeysByPrefix(db, keyA.slice(0, 12))).toHaveLength(1);
		// Same 20-char prefix, different body: the hash comparison rejects it.
		const keyB = `${keyA.slice(0, 20)}${"bb".repeat(22)}`;
		expect(await validateAccessKey(db, keyB)).toBe(null);
	} finally {
		db.close();
	}
});

test("expired access keys do not validate", async () => {
	const db = await createParityDatabase();
	try {
		await insertUser(db, "u1");
		const created = await createAccessKey(db, "u1", {
			name: "short-lived",
			expiresInDays: 1,
		});
		await db
			.prepare("UPDATE user_access_keys SET expires_at = ? WHERE id = ?")
			.bind("2020-01-01T00:00:00Z", created.id)
			.run();
		expect(await validateAccessKey(db, created.apiKey)).toBe(null);
	} finally {
		db.close();
	}
});

test("at most 50 access keys per user", async () => {
	const db = await createParityDatabase();
	try {
		await insertUser(db, "u1");
		for (let i = 0; i < 50; i += 1) {
			await createAccessKey(db, "u1", { name: `key-${i}` });
		}
		let thrown: unknown;
		try {
			await createAccessKey(db, "u1", { name: "key-51" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AccessKeyLimitError);
	} finally {
		db.close();
	}
});
