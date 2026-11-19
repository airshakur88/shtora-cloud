import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
	CATALOG_VALIDATION_CRON,
	handleScheduled,
	KEY_PROBE_CRON,
} from "../src/lib/jobs/scheduled";
import { createApiKey } from "../src/lib/key-store";
import type { AppUser, D1Database } from "../src/lib/types";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const USER: AppUser = {
	id: "u1",
	name: "Test User",
	username: "testuser",
	role: "user",
	passwordHash: "unused",
	createdAt: "2026-11-12 00:00:00",
	updatedAt: "2026-11-12 00:00:00",
};

let db: MemoryD1;
let fetchCalls: string[];
const originalFetch = globalThis.fetch;

beforeAll(() => {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		fetchCalls.push(String(input));
		return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
			status: 200,
		});
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

async function seedUser(target: D1Database): Promise<void> {
	await target
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(USER.id, USER.name, USER.username, USER.passwordHash)
		.run();
}

beforeEach(async () => {
	db = await createParityDatabase();
	await seedUser(db);
	fetchCalls = [];
});

test("the daily cron dispatches to catalog validation", async () => {
	await db.prepare("DELETE FROM models").run();
	await db
		.prepare(
			"INSERT INTO models (platform, model_id, name, context_window) VALUES (?, ?, ?, ?)",
		)
		.bind("testprov", "m1", "m1", 32768)
		.run();
	await handleScheduled(
		{ cron: CATALOG_VALIDATION_CRON, scheduledTime: Date.now() },
		{ DB: db, ENCRYPTION_SECRET: SECRET },
	);
	const row = await db
		.prepare(
			"SELECT suspect_reason FROM models WHERE platform = 'testprov' AND model_id = 'm1'",
		)
		.first<{ suspect_reason: string | null }>();
	expect(row?.suspect_reason).toBe("no_success_7d");
});

test("the 30-minute cron dispatches to the key probe", async () => {
	await db
		.prepare(
			"INSERT OR IGNORE INTO providers (id, name, base_url, auth_type, protocol) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(
			"testprov",
			"testprov",
			"https://upstream.test/v1",
			"bearer",
			"openai_compatible",
		)
		.run();
	const key = await createApiKey(
		db,
		{ userId: USER.id, platform: "testprov", keyLabel: "t", rawKey: "sk-test" },
		SECRET,
	);
	await handleScheduled(
		{ cron: KEY_PROBE_CRON, scheduledTime: Date.now() },
		{ DB: db, ENCRYPTION_SECRET: SECRET },
	);
	expect(fetchCalls).toHaveLength(1);
	const health = await db
		.prepare("SELECT last_health_check_status FROM api_keys WHERE id = ?")
		.bind(key.id)
		.first<{ last_health_check_status: string | null }>();
	expect(health?.last_health_check_status).toBe("healthy");
});

test("the config schedules match the dispatcher constants", async () => {
	// The schedules are literals in cloudflare.config.ts (that file is
	// loaded as plain Node ESM and cannot import the job modules), so
	// this test is the guard against the two places drifting apart:
	// a drifted schedule would log `job: "unknown"` and never run.
	const { readFileSync } = await import("node:fs");
	const { resolve } = await import("node:path");
	const config = readFileSync(
		resolve(process.cwd(), "cloudflare.config.ts"),
		"utf8",
	);
	expect(config).toContain(`"${CATALOG_VALIDATION_CRON}"`);
	expect(config).toContain(`"${KEY_PROBE_CRON}"`);
});

test("an unknown cron is a logged no-op", async () => {
	await handleScheduled(
		{ cron: "0 0 * * *", scheduledTime: Date.now() },
		{ DB: db, ENCRYPTION_SECRET: SECRET },
	);
	expect(fetchCalls).toHaveLength(0);
});

test("a missing database binding fails loudly", async () => {
	await expect(
		handleScheduled(
			{ cron: KEY_PROBE_CRON, scheduledTime: Date.now() },
			{ ENCRYPTION_SECRET: SECRET },
		),
	).rejects.toThrow("Database unavailable");
});
