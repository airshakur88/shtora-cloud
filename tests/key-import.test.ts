import { afterAll, beforeAll, expect, test } from "bun:test";
import { parseKeyImport } from "../src/lib/key-import";
import { createApiKey, exportApiKeys } from "../src/lib/key-store";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";

// Key import validates platforms against the D1 `providers` table
// (migrations 0001-0010 applied to an in-memory database), never from JSON.
let db: MemoryD1;
beforeAll(async () => {
	db = await createParityDatabase();
});
afterAll(() => {
	db.close();
});

test("rejects null input", async () => {
	const result = await parseKeyImport(null, db);
	expect(result.success).toBe(false);
	if (!result.success) {
		expect(result.error.code).toBe("invalid_json");
	}
});

test("rejects array at root (not in keys array) - wrap in {keys: [...]}", async () => {
	const result = await parseKeyImport(
		[
			{ platform: "openai", key: "sk-test" },
			{ platform: "groq", key: "gsk-test" },
		],
		db,
	);
	expect(result.success).toBe(false);
	if (!result.success) {
		expect(result.error.code).toBe("invalid_json");
	}
});

test("parses freellmapi format with version and source", async () => {
	const input = {
		version: 1,
		exportedBy: "test-user",
		exportedAt: "2026-11-12T03:44:55.040Z",
		source: "freellmapi",
		keys: [
			{ platform: "agnes", key: "sk-test-agnes-key", label: "agnes" },
			{ platform: "aihorde", key: "ek-test-key", label: "" },
		],
	};
	const result = await parseKeyImport(input, db);
	expect(result.success).toBe(true);
	if (result.success) {
		expect(result.data.keys).toHaveLength(2);
		expect(result.data.keys[0].platform).toBe("agnes");
		expect(result.data.keys[0].key).toBe("sk-test-agnes-key");
		expect(result.data.keys[0].label).toBe("agnes");
		expect(result.data.keys[1].label).toBe(null); // Empty label normalized to null
	}
});

test("parses freellmapi format without version/source wrapper", async () => {
	const input = {
		keys: [{ platform: "openai", key: "sk-test-openai", label: "gpt-4" }],
	};
	const result = await parseKeyImport(input, db);
	expect(result.success).toBe(true);
	if (result.success) {
		// openai is not a catalog provider: discarded, but reported.
		expect(result.data.keys).toHaveLength(0);
		expect(result.data.skipped).toEqual([
			{ platform: "openai", reason: "unsupported_platform" },
		]);
	}
});

test("parses single-key object (freellmapi-style)", async () => {
	const input = {
		platform: "groq",
		key: "gsk-test-groq-key",
		label: "my groq key",
	};
	const result = await parseKeyImport(input, db);
	expect(result.success).toBe(true);
	if (result.success) {
		expect(result.data.keys).toHaveLength(1);
		expect(result.data.keys[0].platform).toBe("groq");
		expect(result.data.keys[0].key).toBe("gsk-test-groq-key");
		expect(result.data.keys[0].label).toBe("my groq key");
	}
});

test("parses flat map format {provider: key}", async () => {
	const input = {
		openai: "sk-test-openai-key",
		groq: "gsk-test-groq-key",
		anthropic: "sk-test-anthropic-key",
	};
	const result = await parseKeyImport(input, db);
	expect(result.success).toBe(true);
	if (result.success) {
		// groq and anthropic are catalog providers (migration 0015 added
		// the anthropic row); openai is discarded and reported.
		expect(result.data.keys).toHaveLength(2);
		const platforms = result.data.keys.map((k) => k.platform).sort();
		expect(platforms).toEqual(["anthropic", "groq"]);
		expect(result.data.skipped).toEqual([
			{ platform: "openai", reason: "unsupported_platform" },
		]);
	}
});

test("parses array format with platform/key aliases inside keys array", async () => {
	const input = {
		keys: [
			{ provider: "openai", apiKey: "sk-provider-openai" },
			{ platform: "groq", key: "gsk-groq-key" },
			{ name: "anthropic", api_token: "sk-anthropic-key" },
			{ id: "google", token: "sk-google-key" },
		],
	};
	const result = await parseKeyImport(input, db);
	expect(result.success).toBe(true);
	if (result.success) {
		// groq, anthropic and google import; openai is discarded and reported.
		expect(result.data.keys).toHaveLength(3);
		const platforms = result.data.keys.map((k) => k.platform).sort();
		expect(platforms).toEqual(["anthropic", "google", "groq"]);
		expect(result.data.skipped).toEqual([
			{ platform: "openai", reason: "unsupported_platform" },
		]);
	}
});

test("normalizes platform to lowercase and trims values", async () => {
	const input = {
		platform: "  Groq  ",
		key: "  sk-test  ",
		label: "  test label  ",
	};
	const result = await parseKeyImport(input, db);
	expect(result.success).toBe(true);
	if (result.success) {
		expect(result.data.keys[0].platform).toBe("groq");
		expect(result.data.keys[0].key).toBe("sk-test");
		expect(result.data.keys[0].label).toBe("test label");
	}
});

test("skips unsupported platforms with reason", async () => {
	const input = {
		keys: [
			{ platform: "openai", key: "sk-test" },
			{ platform: "unknown-fake-platform", key: "sk-test" },
		],
	};
	const result = await parseKeyImport(input, db);
	expect(result.success).toBe(true);
	if (result.success) {
		// Both are discarded with platform and reason, not silently.
		expect(result.data.keys).toHaveLength(0);
		expect(result.data.skipped).toEqual(
			expect.arrayContaining([
				{ platform: "openai", reason: "unsupported_platform" },
				{ platform: "unknown-fake-platform", reason: "unsupported_platform" },
			]),
		);
	}
});

test("skips empty keys", async () => {
	const input = {
		keys: [
			{ platform: "groq", key: "sk-valid" },
			{ platform: "groq", key: "" },
			{ platform: "anthropic", key: "   " },
		],
	};
	const result = await parseKeyImport(input, db);
	expect(result.success).toBe(true);
	if (result.success) {
		expect(result.data.keys).toHaveLength(1);
		expect(result.data.keys[0].key).toBe("sk-valid");
		expect(result.data.skipped).toEqual(
			expect.arrayContaining([
				{ platform: "groq", reason: "empty_key" },
				{ platform: "anthropic", reason: "empty_key" },
			]),
		);
	}
});

test("rejects non-object input", async () => {
	expect((await parseKeyImport("not an object", db)).success).toBe(false);
	expect((await parseKeyImport(123, db)).success).toBe(false);
	expect((await parseKeyImport(undefined, db)).success).toBe(false);
});

test("handles empty keys array", async () => {
	const result = await parseKeyImport({ keys: [] }, db);
	expect(result.success).toBe(true);
	if (result.success) {
		expect(result.data.keys).toHaveLength(0);
	}
});

test("exportApiKeys returns decrypted raw keys without sensitive metadata", async () => {
	const db = await createParityDatabase();
	try {
		// Insert a test user
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind("test-user-1", "Test User", "testuser", "hash")
			.run();

		// Create test keys with known values
		const rawKey1 = "sk-test-openai-key-12345";
		const rawKey2 = "gsk-test-groq-key-67890";

		await createApiKey(
			db,
			{
				userId: "test-user-1",
				platform: "openai",
				rawKey: rawKey1,
				keyLabel: "primary-gpt",
			},
			SECRET,
		);

		await createApiKey(
			db,
			{
				userId: "test-user-1",
				platform: "groq",
				rawKey: rawKey2,
				keyLabel: null,
			},
			SECRET,
		);

		// Export keys
		const exported = await exportApiKeys(db, "test-user-1", SECRET);

		expect(exported).toHaveLength(2);

		// Verify structure
		expect(exported[0].platform).toBe("openai");
		expect(exported[0].key).toBe(rawKey1);
		expect(exported[0].label).toBe("primary-gpt");

		expect(exported[1].platform).toBe("groq");
		expect(exported[1].key).toBe(rawKey2);
		expect(exported[1].label).toBe(null);

		// Verify no encrypted/sensitive metadata fields
		expect("encryptedKey" in exported[0]).toBe(false);
		expect("encryptedKey" in exported[1]).toBe(false);
		expect("iv" in exported[0]).toBe(false);
		expect("authTag" in exported[0]).toBe(false);
		expect("unifiedToken" in exported[0]).toBe(false);
	} finally {
		db.close();
	}
});

test("round-trip: create -> export -> import preserves key data", async () => {
	const db = await createParityDatabase();
	try {
		// Insert test user
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind("user-a", "User A", "usera", "hash")
			.run();

		// Create initial keys
		const originalKeys = [
			{ platform: "openai", rawKey: "sk-original-1", label: "gpt-key" },
			{ platform: "groq", rawKey: "gsk-original-2", label: null },
		];

		for (const k of originalKeys) {
			await createApiKey(
				db,
				{
					userId: "user-a",
					platform: k.platform,
					rawKey: k.rawKey,
					keyLabel: k.label,
				},
				SECRET,
			);
		}

		// Export
		const exported = await exportApiKeys(db, "user-a", SECRET);

		// Create export data in shtora-cloud format
		const exportData = {
			version: 1,
			exportedBy: "user-a",
			exportedAt: new Date().toISOString(),
			source: "shtora-cloud",
			keys: exported,
		};

		// Parse and verify
		const parseResult = await parseKeyImport(exportData, db);
		expect(parseResult.success).toBe(true);

		if (parseResult.success) {
			// groq round-trips; the openai key is discarded (not a catalog
			// provider) and reported instead of imported silently.
			expect(parseResult.data.keys).toHaveLength(1);
			expect(parseResult.data.skipped).toEqual([
				{ platform: "openai", reason: "unsupported_platform" },
			]);

			// Verify keys match
			const parsedKeys = parseResult.data.keys;
			expect(parsedKeys[0].platform).toBe("groq");
			expect(parsedKeys[0].key).toBe("gsk-original-2");
			expect(parsedKeys[0].label).toBe(null);
		}
	} finally {
		db.close();
	}
});

test("parses user's freellmapi export format correctly", async () => {
	// Simulating the user's actual export file structure
	// Using fake keys like the user's real format
	const input = {
		version: 1,
		exportedAt: "2026-11-12T03:44:55.040Z",
		source: "freellmapi",
		keys: [
			{
				platform: "agnes",
				key: "sk-EQcV7lCWbhybSBUwYEFeVoPLXOoC6H78zDnQ5o3AIv9IAqM3",
				label: "agnes",
			},
			{ platform: "aihorde", key: "ekK3Kvv7HQ3d5YU_7gCG4w", label: "" },
			{ platform: "openai", key: "sk-test-openai", label: "gpt-4" },
		],
	};

	const result = await parseKeyImport(input, db);
	expect(result.success).toBe(true);

	if (result.success) {
		// agnes and aihorde import; openai is discarded and reported.
		expect(result.data.keys).toHaveLength(2);
		expect(result.data.keys[0].platform).toBe("agnes");
		expect(result.data.keys[1].platform).toBe("aihorde");
		expect(result.data.keys[1].label).toBe(null); // Empty label normalized
		expect(result.data.skipped).toEqual([
			{ platform: "openai", reason: "unsupported_platform" },
		]);
	}
});
