import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
	runCatalogValidation,
	SUSPECT_NO_SUCCESS_7D,
	SUSPECT_UPSTREAM_MISSING,
} from "../src/lib/jobs/catalog-validation";
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
let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
let fetchCalls: string[];
const originalFetch = globalThis.fetch;

beforeAll(() => {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		fetchCalls.push(String(input));
		return fetchImpl(String(input), init);
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

function addSuspectColumns(target: D1Database): void {
	for (const sql of [
		"ALTER TABLE models ADD COLUMN suspect_reason TEXT",
		"ALTER TABLE models ADD COLUMN suspect_since INTEGER",
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

async function seedModel(
	target: D1Database,
	platform: string,
	modelId: string,
): Promise<void> {
	await target
		.prepare(
			"INSERT INTO models (platform, model_id, name, context_window) VALUES (?, ?, ?, ?)",
		)
		.bind(platform, modelId, modelId, 32768)
		.run();
}

async function seedProvider(
	target: D1Database,
	platform: string,
	protocol = "openai_compatible",
): Promise<void> {
	await target
		.prepare(
			"INSERT OR IGNORE INTO providers (id, name, base_url, auth_type, protocol) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(platform, platform, "https://upstream.test/v1", "bearer", protocol)
		.run();
}

function sqliteNow(offsetMs = 0): string {
	return new Date(Date.now() + offsetMs)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
}

async function seedSuccess(
	target: D1Database,
	platform: string,
	modelId: string,
	keyId: number,
	createdAt: string,
): Promise<void> {
	await target
		.prepare(
			`INSERT INTO provider_requests
			 (user_id, model_requested, model_routed, platform, key_id, status, created_at)
			 VALUES (?, ?, ?, ?, ?, 'success', ?)`,
		)
		.bind(USER.id, modelId, modelId, platform, keyId, createdAt)
		.run();
}

async function suspectOf(
	target: D1Database,
	platform: string,
	modelId: string,
): Promise<string | null> {
	const row = await target
		.prepare(
			"SELECT suspect_reason FROM models WHERE platform = ? AND model_id = ?",
		)
		.bind(platform, modelId)
		.first<{ suspect_reason: string | null }>();
	return row?.suspect_reason ?? null;
}

beforeEach(async () => {
	db = await createParityDatabase();
	addSuspectColumns(db);
	await db.prepare("DELETE FROM models").run();
	await seedUser(db);
	await seedProvider(db, "testprov");
	fetchCalls = [];
	fetchImpl = async () =>
		new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
			status: 200,
		});
});

test("Q5: marks rows with no success in 7 days, spares recent successes", async () => {
	const key = await createApiKey(
		db,
		{ userId: USER.id, platform: "testprov", keyLabel: "t", rawKey: "sk-test" },
		SECRET,
	);
	await seedModel(db, "testprov", "m1");
	await seedModel(db, "testprov", "m2");
	await seedModel(db, "testprov", "m3");
	await seedSuccess(db, "testprov", "m1", key.id, sqliteNow());
	await seedSuccess(
		db,
		"testprov",
		"m2",
		key.id,
		sqliteNow(-8 * 24 * 60 * 60 * 1000),
	);

	const summary = await runCatalogValidation(db, {
		now: 1790000000000,
		encryptionSecret: SECRET,
	});

	expect(summary.checked).toBe(3);
	expect(summary.suspected).toBe(2);
	expect(await suspectOf(db, "testprov", "m1")).toBeNull();
	expect(await suspectOf(db, "testprov", "m2")).toBe(SUSPECT_NO_SUCCESS_7D);
	expect(await suspectOf(db, "testprov", "m3")).toBe(SUSPECT_NO_SUCCESS_7D);
	const since = await db
		.prepare(
			"SELECT suspect_since FROM models WHERE platform = 'testprov' AND model_id = 'm2'",
		)
		.first<{ suspect_since: number }>();
	expect(since?.suspect_since).toBe(1790000000000);
	// Nothing was deleted.
	const count = await db
		.prepare("SELECT COUNT(*) AS n FROM models")
		.first<{ n: number }>();
	expect(count?.n).toBe(3);
});

test("marking is idempotent: a second run suspects nothing new", async () => {
	await seedModel(db, "testprov", "m1");
	const first = await runCatalogValidation(db, { encryptionSecret: SECRET });
	expect(first.suspected).toBe(1);
	const second = await runCatalogValidation(db, { encryptionSecret: SECRET });
	expect(second.suspected).toBe(0);
	expect(await suspectOf(db, "testprov", "m1")).toBe(SUSPECT_NO_SUCCESS_7D);
});

test("per-run cap: only maxMarked rows are marked, the rest are skipped", async () => {
	await seedModel(db, "testprov", "m1");
	await seedModel(db, "testprov", "m2");
	await seedModel(db, "testprov", "m3");
	const summary = await runCatalogValidation(db, {
		maxMarked: 1,
		encryptionSecret: SECRET,
	});
	expect(summary.suspected).toBe(1);
	expect(summary.skipped).toBe(2);
});

test("upstream comparison marks rows absent from the list, spares present ones", async () => {
	await createApiKey(
		db,
		{ userId: USER.id, platform: "testprov", keyLabel: "t", rawKey: "sk-test" },
		SECRET,
	);
	// Both rows get a recent success so part (a) leaves them alone and
	// only the upstream comparison can flag m2.
	const key = await createApiKey(
		db,
		{ userId: USER.id, platform: "testprov", keyLabel: "t", rawKey: "sk-test" },
		SECRET,
	);
	await seedModel(db, "testprov", "m1");
	await seedModel(db, "testprov", "m2");
	await seedSuccess(db, "testprov", "m1", key.id, sqliteNow());
	await seedSuccess(db, "testprov", "m2", key.id, sqliteNow());
	fetchImpl = async (input) => {
		expect(input).toBe("https://upstream.test/v1/models");
		return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
			status: 200,
		});
	};

	const summary = await runCatalogValidation(db, { encryptionSecret: SECRET });

	expect(summary.suspected).toBe(1);
	expect(await suspectOf(db, "testprov", "m1")).toBeNull();
	expect(await suspectOf(db, "testprov", "m2")).toBe(SUSPECT_UPSTREAM_MISSING);
	expect(fetchCalls).toHaveLength(1);
});

test("platform without an enabled key is skipped, not marked", async () => {
	await seedModel(db, "testprov", "m1");
	const summary = await runCatalogValidation(db, { encryptionSecret: SECRET });
	expect(summary.suspected).toBe(1); // Q5 still marks it
	// The platform skip adds nothing: its only row was already
	// validated by being marked in part (a).
	expect(summary.skipped).toBe(0);
	expect(fetchCalls).toHaveLength(0);
});

test("upstream list failure skips the platform instead of suspecting rows", async () => {
	const key = await createApiKey(
		db,
		{ userId: USER.id, platform: "testprov", keyLabel: "t", rawKey: "sk-test" },
		SECRET,
	);
	await seedModel(db, "testprov", "m1");
	await seedSuccess(db, "testprov", "m1", key.id, sqliteNow());
	fetchImpl = async () => new Response("nope", { status: 401 });

	const summary = await runCatalogValidation(db, { encryptionSecret: SECRET });

	expect(summary.suspected).toBe(0);
	expect(await suspectOf(db, "testprov", "m1")).toBeNull();
	// The row was validated by its recent success in part (a); the
	// failed list fetch leaves nothing unvalidated.
	expect(summary.skipped).toBe(0);
});

test("without an encryption secret the upstream comparison is skipped", async () => {
	await seedModel(db, "testprov", "m1");
	const summary = await runCatalogValidation(db, {});
	expect(summary.suspected).toBe(1);
	expect(summary.skipped).toBe(0); // row already suspect, nothing left to compare
	expect(fetchCalls).toHaveLength(0);
});

test("missing suspect columns: counts but marks nothing and does not throw", async () => {
	const bare = await createParityDatabase();
	// Migration 0019 already adds these columns in this tree; drop
	// them to exercise the pre-0019 fallback.
	bare.exec("ALTER TABLE models DROP COLUMN suspect_reason");
	bare.exec("ALTER TABLE models DROP COLUMN suspect_since");
	await bare.prepare("DELETE FROM models").run();
	await seedModel(bare, "testprov", "m1");
	const summary = await runCatalogValidation(bare, {
		encryptionSecret: SECRET,
	});
	expect(summary.checked).toBe(1);
	expect(summary.suspected).toBe(0);
	expect(summary.skipped).toBe(1);
});
