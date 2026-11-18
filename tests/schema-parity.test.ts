import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryD1 } from "./utils/d1-shim";

const initialSchema = readFileSync(
	resolve(process.cwd(), "migrations/0001_initial_schema.sql"),
	"utf8",
);
const parityMigration = readFileSync(
	resolve(process.cwd(), "migrations/0002_backend_parity.sql"),
	"utf8",
);
const usageMetricsMigration = readFileSync(
	resolve(process.cwd(), "migrations/0003_usage_metrics.sql"),
	"utf8",
);
const usageMetricsBackfill = readFileSync(
	resolve(process.cwd(), "migrations/0004_usage_metrics_backfill.sql"),
	"utf8",
);

function databaseAfterInitialMigration(): MemoryD1 {
	const db = new MemoryD1();
	db.exec(initialSchema);
	return db;
}

test("a fresh database applies migrations 0001 through 0004", async () => {
	const db = new MemoryD1();
	try {
		db.exec(initialSchema);
		db.exec(parityMigration);
		db.exec(usageMetricsMigration);
		db.exec(usageMetricsBackfill);

		const tables = await db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all<{ name: string }>();
		const names = new Set(tables.results.map((row) => row.name));
		expect(
			[
				"user",
				"keys",
				"models",
				"api_keys",
				"shtora_auth_sessions",
				"user_usage_metrics",
				"global_usage_metrics",
			].every((name) => names.has(name)),
		).toBe(true);
	} finally {
		db.close();
	}
});

test("backend parity migration preserves target rows", async () => {
	const db = databaseAfterInitialMigration();
	try {
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind("u1", "Test User", "testuser", "hash")
			.run();
		await db
			.prepare(
				"INSERT INTO keys (id, name, key_hash, user_id, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				"legacy-1",
				"Legacy key",
				"hash",
				"u1",
				"[]",
				"2026-11-12T00:00:00.000Z",
				"2026-11-12T00:00:00.000Z",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO models (platform, model_id, name, context_window) VALUES (?, ?, ?, ?)",
			)
			.bind("groq", "model-a", "Model A", 8192)
			.run();

		db.exec(parityMigration);

		const tables = await db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all<{ name: string }>();
		const names = new Set(tables.results.map((row) => row.name));
		expect(names.has("api_keys")).toBe(true);
		expect(names.has("shtora_auth_sessions")).toBe(true);
		expect(names.has("provider_requests")).toBe(true);
		expect(names.has("provider_rate_limit_usage")).toBe(true);
		expect(names.has("provider_rate_limit_cooldowns")).toBe(true);
		expect(names.has("usage_logs")).toBe(false);

		const user = await db
			.prepare("SELECT username FROM user WHERE id = ?")
			.bind("u1")
			.first<{ username: string }>();
		const key = await db
			.prepare("SELECT id FROM keys WHERE id = ?")
			.bind("legacy-1")
			.first<{ id: string }>();
		const model = await db
			.prepare("SELECT model_id FROM models WHERE platform = ?")
			.bind("groq")
			.first<{ model_id: string }>();
		expect(user?.username).toBe("testuser");
		expect(key?.id).toBe("legacy-1");
		expect(model?.model_id).toBe("model-a");
	} finally {
		db.close();
	}
});
