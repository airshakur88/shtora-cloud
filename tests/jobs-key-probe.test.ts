import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PROBE_MODEL_ID, runKeyProbe } from "../src/lib/jobs/key-probe";
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
const NOW = 1790000000000;
const DAY_MS = 24 * 60 * 60 * 1000;

let db: MemoryD1;
let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
let fetchCalls: { url: string; init?: RequestInit }[];
const originalFetch = globalThis.fetch;

beforeAll(() => {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		fetchCalls.push({ url: String(input), init });
		return fetchImpl(String(input), init);
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

function addSuspensionColumns(target: D1Database): void {
	for (const sql of [
		"ALTER TABLE api_keys ADD COLUMN suspended_until_ms INTEGER",
		"ALTER TABLE api_keys ADD COLUMN suspension_reason TEXT",
	]) {
		try {
			(target as MemoryD1).exec(sql);
		} catch {
			// Already added (idempotent setup).
		}
	}
}

async function seedUser(target: D1Database): Promise<void> {
	await target
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(USER.id, USER.name, USER.username, USER.passwordHash)
		.run();
}

async function seedProvider(
	target: D1Database,
	platform: string,
	protocol = "openai_compatible",
	baseUrl = "https://upstream.test/v1",
): Promise<void> {
	await target
		.prepare(
			"INSERT OR IGNORE INTO providers (id, name, base_url, auth_type, protocol) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(platform, platform, baseUrl, "bearer", protocol)
		.run();
}

async function seedKey(
	target: D1Database,
	platform: string,
	rawKey: string,
): Promise<number> {
	const key = await createApiKey(
		target,
		{ userId: USER.id, platform, keyLabel: "t", rawKey },
		SECRET,
	);
	return key.id;
}

async function seedAttempt(
	target: D1Database,
	keyId: number,
	platform: string,
	status: string,
	statusCode: number | null,
): Promise<void> {
	await target
		.prepare(
			`INSERT INTO provider_requests
			 (user_id, model_requested, model_routed, platform, key_id, status, status_code)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			USER.id,
			PROBE_MODEL_ID,
			PROBE_MODEL_ID,
			platform,
			keyId,
			status,
			statusCode,
		)
		.run();
}

async function keyRow(target: D1Database, id: number) {
	return target
		.prepare(
			`SELECT enabled, last_health_check_status, suspended_until_ms, suspension_reason
			  FROM api_keys WHERE id = ?`,
		)
		.bind(id)
		.first<{
			enabled: number;
			last_health_check_status: string | null;
			suspended_until_ms: number | null;
			suspension_reason: string | null;
		}>();
}

async function probeRows(target: D1Database, keyId: number) {
	return (
		await target
			.prepare(
				`SELECT status, status_code FROM provider_requests
				  WHERE key_id = ? AND model_routed = ? ORDER BY id ASC`,
			)
			.bind(keyId, PROBE_MODEL_ID)
			.all<{ status: string; status_code: number | null }>()
	).results;
}

function okModels(ids: string[]): Response {
	return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
		status: 200,
	});
}

beforeEach(async () => {
	db = await createParityDatabase();
	addSuspensionColumns(db);
	await seedUser(db);
	await seedProvider(db, "testprov");
	fetchCalls = [];
	fetchImpl = async () => okModels(["m1"]);
});

test("healthy probe updates health and records a success", async () => {
	const keyId = await seedKey(db, "testprov", "sk-test");
	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary).toMatchObject({
		checked: 1,
		healthy: 1,
		invalid: 0,
		errored: 0,
	});
	expect(fetchCalls).toHaveLength(1);
	expect(fetchCalls[0].url).toBe("https://upstream.test/v1/models");
	expect(fetchCalls[0].init?.headers).toEqual({
		Authorization: "Bearer sk-test",
	});
	expect((await keyRow(db, keyId))?.last_health_check_status).toBe("healthy");
	expect(await probeRows(db, keyId)).toEqual([
		{ status: "success", status_code: 200 },
	]);
});

test("401 marks invalid and the third consecutive 401 disables the key", async () => {
	const keyId = await seedKey(db, "testprov", "sk-test");
	await seedAttempt(db, keyId, "testprov", "error", 401);
	await seedAttempt(db, keyId, "testprov", "error", 401);
	fetchImpl = async () => new Response("bad key", { status: 401 });

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary).toMatchObject({ checked: 1, invalid: 1 });
	expect((await keyRow(db, keyId))?.last_health_check_status).toBe("invalid");
	expect((await keyRow(db, keyId))?.enabled).toBe(0);
});

test("five consecutive failures suspend the key for 24h", async () => {
	const keyId = await seedKey(db, "testprov", "sk-test");
	for (let i = 0; i < 4; i++)
		await seedAttempt(db, keyId, "testprov", "error", 500);
	fetchImpl = async () => new Response("boom", { status: 500 });

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary).toMatchObject({ checked: 1, errored: 1, suspended: 1 });
	const row = await keyRow(db, keyId);
	expect(row?.suspended_until_ms).toBe(NOW + DAY_MS);
	expect(row?.suspension_reason).toBe("consecutive_failures");
});

test("499s neither count nor break the consecutive-failure streak", async () => {
	const keyId = await seedKey(db, "testprov", "sk-test");
	for (let i = 0; i < 4; i++)
		await seedAttempt(db, keyId, "testprov", "error", 500);
	await seedAttempt(db, keyId, "testprov", "error", 499);
	fetchImpl = async () => new Response("boom", { status: 500 });

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary.suspended).toBe(1);
});

test("a success breaks the streak: four failures plus a success do not suspend", async () => {
	const keyId = await seedKey(db, "testprov", "sk-test");
	for (let i = 0; i < 4; i++)
		await seedAttempt(db, keyId, "testprov", "error", 500);
	await seedAttempt(db, keyId, "testprov", "success", 200);
	fetchImpl = async () => new Response("boom", { status: 500 });

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary.suspended).toBe(0);
});

test("expired suspension clears on a good probe", async () => {
	const keyId = await seedKey(db, "testprov", "sk-test");
	await db
		.prepare(
			"UPDATE api_keys SET suspended_until_ms = ?, suspension_reason = ? WHERE id = ?",
		)
		.bind(NOW - 1000, "consecutive_failures", keyId)
		.run();

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary).toMatchObject({ healthy: 1, reenabled: 1 });
	const row = await keyRow(db, keyId);
	expect(row?.suspended_until_ms).toBeNull();
	expect(row?.suspension_reason).toBeNull();
});

test("an actively suspended key is skipped without an upstream call", async () => {
	const keyId = await seedKey(db, "testprov", "sk-test");
	await db
		.prepare(
			"UPDATE api_keys SET suspended_until_ms = ?, suspension_reason = ? WHERE id = ?",
		)
		.bind(NOW + DAY_MS, "consecutive_failures", keyId)
		.run();

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary).toMatchObject({ checked: 1, skipped: 1, healthy: 0 });
	expect(fetchCalls).toHaveLength(0);
});

test("network errors are not recorded and do not count toward suspension", async () => {
	const keyId = await seedKey(db, "testprov", "sk-test");
	for (let i = 0; i < 4; i++)
		await seedAttempt(db, keyId, "testprov", "error", 500);
	fetchImpl = async () => {
		throw new Error("unreachable");
	};

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary).toMatchObject({ errored: 1, suspended: 0 });
	expect(await probeRows(db, keyId)).toHaveLength(4); // no new row
});

test("404 from the probe endpoint is not recorded and does not suspend", async () => {
	const keyId = await seedKey(db, "testprov", "sk-test");
	for (let i = 0; i < 4; i++)
		await seedAttempt(db, keyId, "testprov", "error", 500);
	fetchImpl = async () => new Response("not here", { status: 404 });

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary).toMatchObject({ errored: 1, suspended: 0 });
	expect(await probeRows(db, keyId)).toHaveLength(4);
});

test("anthropic keys probe with a minimal chat, not a model list", async () => {
	await seedProvider(db, "testprov-anthropic", "anthropic_messages");
	await db
		.prepare(
			"INSERT INTO models (platform, model_id, name, context_window) VALUES (?, ?, ?, ?)",
		)
		.bind("testprov-anthropic", "claude-test", "claude-test", 32768)
		.run();
	const keyId = await seedKey(db, "testprov-anthropic", "sk-ant-test");
	fetchImpl = async (input, init) => {
		expect(input).toBe("https://upstream.test/v1/messages");
		expect(init?.method).toBe("POST");
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(body).toMatchObject({ model: "claude-test", max_tokens: 1 });
		return new Response(JSON.stringify({ content: [] }), { status: 200 });
	};

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary).toMatchObject({ checked: 1, healthy: 1 });
	expect((await keyRow(db, keyId))?.last_health_check_status).toBe("healthy");
});

test("batch size caps the keys probed per run, stalest first", async () => {
	const first = await seedKey(db, "testprov", "sk-one");
	const second = await seedKey(db, "testprov", "sk-two");
	// Both checked before; the second one is staler.
	await db
		.prepare("UPDATE api_keys SET last_health_check_at = ? WHERE id = ?")
		.bind("2026-06-01 00:00:00", first)
		.run();
	await db
		.prepare("UPDATE api_keys SET last_health_check_at = ? WHERE id = ?")
		.bind("2026-01-01 00:00:00", second)
		.run();

	const summary = await runKeyProbe(db, {
		now: NOW,
		batchSize: 1,
		encryptionSecret: SECRET,
	});

	expect(summary.checked).toBe(1);
	expect(fetchCalls).toHaveLength(1);
	expect(fetchCalls[0].init?.headers).toEqual({
		Authorization: "Bearer sk-two",
	});
	// The unprobed key was never touched.
	expect((await keyRow(db, first))?.last_health_check_status).toBeNull();
});

test("missing suspension columns: health still updates, nothing suspends", async () => {
	const bare = await createParityDatabase();
	// Migration 0019 already adds these columns in this tree; drop
	// them to exercise the pre-0019 fallback.
	bare.exec("ALTER TABLE api_keys DROP COLUMN suspended_until_ms");
	bare.exec("ALTER TABLE api_keys DROP COLUMN suspension_reason");
	await seedUser(bare);
	await seedProvider(bare, "testprov");
	const keyId = await seedKey(bare, "testprov", "sk-test");
	for (let i = 0; i < 4; i++)
		await seedAttempt(bare, keyId, "testprov", "error", 500);
	fetchImpl = async () => new Response("boom", { status: 500 });

	const summary = await runKeyProbe(bare, {
		now: NOW,
		encryptionSecret: SECRET,
	});

	expect(summary).toMatchObject({ checked: 1, errored: 1, suspended: 0 });
	expect(
		(
			await bare
				.prepare("SELECT last_health_check_status FROM api_keys WHERE id = ?")
				.bind(keyId)
				.first<{ last_health_check_status: string }>()
		)?.last_health_check_status,
	).toBe("error");
});

test("429s from the probe do not count toward suspension", async () => {
	const keyId = await seedKey(db, "testprov", "sk-test");
	for (let i = 0; i < 4; i++)
		await seedAttempt(db, keyId, "testprov", "error", 429);
	fetchImpl = async () => new Response("slow down", { status: 429 });

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary).toMatchObject({ checked: 1, errored: 1, suspended: 0 });
	expect((await keyRow(db, keyId))?.suspended_until_ms).toBeNull();
});

test("410s from the probe do not count toward suspension", async () => {
	const keyId = await seedKey(db, "testprov", "sk-test");
	for (let i = 0; i < 4; i++)
		await seedAttempt(db, keyId, "testprov", "error", 410);
	fetchImpl = async () => new Response("gone", { status: 410 });

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary).toMatchObject({ checked: 1, errored: 1, suspended: 0 });
	expect((await keyRow(db, keyId))?.suspended_until_ms).toBeNull();
});

test("platform-wide 503 episode: probe suspends nothing", async () => {
	const keyA = await seedKey(db, "testprov", "sk-test-a");
	const keyB = await seedKey(db, "testprov", "sk-test-b");
	for (let i = 0; i < 4; i++) {
		await seedAttempt(db, keyA, "testprov", "error", 500);
		await seedAttempt(db, keyB, "testprov", "error", 500);
	}
	fetchImpl = async () => new Response("boom", { status: 500 });

	const summary = await runKeyProbe(db, { now: NOW, encryptionSecret: SECRET });

	expect(summary).toMatchObject({ checked: 2, errored: 2, suspended: 0 });
	expect((await keyRow(db, keyA))?.suspended_until_ms).toBeNull();
	expect((await keyRow(db, keyB))?.suspended_until_ms).toBeNull();
});
