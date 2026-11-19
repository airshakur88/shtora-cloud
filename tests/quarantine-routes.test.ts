import { beforeEach, expect, mock, test } from "bun:test";
import { createApiKey } from "../src/lib/key-store";
import { reportFailure } from "../src/lib/quarantine";
import type { AppUser } from "../src/lib/types";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Quarantine list/release routes (Fase 4, 4.1/R15): the caller sees only
// quarantines of keys they own, and can release only those. Same setup
// as key-export-import-routes.test.ts: only the env binding is mocked,
// sessions are real.
const SECRET = "quarantine-test-secret-0123456789-abcdefghijklmnop";

const USER: AppUser = {
	id: "user-1",
	name: "Test User",
	username: "testuser",
	role: "user",
	passwordHash: "",
	createdAt: "",
	updatedAt: "",
};
const OTHER: AppUser = {
	...USER,
	id: "user-2",
	username: "otheruser",
	name: "Other User",
};

let db: MemoryD1;
let sessionCookie = "";

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => SECRET,
	getImagesBucket: () => {
		throw new Error("IMAGES_BUCKET is unavailable in this test");
	},
}));

const { SESSION_COOKIE_NAME, createSession } = await import(
	"../src/lib/session"
);

const quarantineRoute = await import("../src/app/api/quarantine/route");
const releaseRoute = await import(
	"../src/app/api/quarantine/[id]/release/route"
);

async function insertUser(id: string, username: string): Promise<void> {
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(id, username, username, "hash")
		.run();
}

async function quarantineKey(
	userId: string,
	platform: string,
	modelId: string,
	rawKey: string,
): Promise<{ keyId: number; rowId: number }> {
	const key = await createApiKey(
		db,
		{ userId, platform, rawKey, keyLabel: null },
		SECRET,
	);
	await reportFailure(db, {
		platform,
		modelId,
		keyId: key.id,
		source: "server_error",
	});
	const row = await db
		.prepare(
			"SELECT id FROM provider_rate_limit_cooldowns WHERE key_id = ? AND model_id = ?",
		)
		.bind(key.id, modelId)
		.first<{ id: number }>();
	if (!row) throw new Error("Quarantine row was not created");
	return { keyId: key.id, rowId: row.id };
}

async function quarantineRowCount(rowId: number): Promise<number> {
	const row = await db
		.prepare(
			"SELECT COUNT(*) AS n FROM provider_rate_limit_cooldowns WHERE id = ?",
		)
		.bind(rowId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

beforeEach(async () => {
	db = await createParityDatabase();
	await insertUser(USER.id, USER.username);
	await insertUser(OTHER.id, OTHER.username);
	const created = await createSession(USER.id);
	sessionCookie = `${SESSION_COOKIE_NAME}=${created.token}`;
});

test("GET /api/quarantine lists only the caller's quarantines, masked", async () => {
	await quarantineKey(USER.id, "groq", "llama-3-70b", "gsk-quar-1234");
	await quarantineKey(OTHER.id, "groq", "llama-3-70b", "gsk-theirs-9999");
	const response = await quarantineRoute.GET(
		new Request("http://localhost/api/quarantine", {
			headers: { Cookie: sessionCookie },
		}),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		quarantines: Array<{
			platform: string;
			modelId: string;
			maskedKey: string;
			failureCount: number;
			cooldownUntilMs: number;
		}>;
	};
	expect(body.quarantines).toHaveLength(1);
	expect(body.quarantines[0].platform).toBe("groq");
	expect(body.quarantines[0].modelId).toBe("llama-3-70b");
	expect(body.quarantines[0].maskedKey).toBe("••••1234");
	expect(body.quarantines[0].failureCount).toBe(1);
	expect(body.quarantines[0].cooldownUntilMs).toBeGreaterThan(Date.now());
});

test("GET /api/quarantine without a session answers 401", async () => {
	const response = await quarantineRoute.GET(
		new Request("http://localhost/api/quarantine"),
	);
	expect(response.status).toBe(401);
});

test("GET /api/quarantine excludes expired cooldowns", async () => {
	const key = await createApiKey(
		db,
		{
			userId: USER.id,
			platform: "groq",
			rawKey: "gsk-old-1234",
			keyLabel: null,
		},
		SECRET,
	);
	await db
		.prepare(
			`INSERT INTO provider_rate_limit_cooldowns
			 (platform, model_id, key_id, failure_count, cooldown_until_ms, source)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind("groq", "old-model", key.id, 3, Date.now() - 60_000, "server_error")
		.run();
	const response = await quarantineRoute.GET(
		new Request("http://localhost/api/quarantine", {
			headers: { Cookie: sessionCookie },
		}),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { quarantines: unknown[] };
	expect(body.quarantines).toHaveLength(0);
});

test("POST /api/quarantine/[id]/release releases the caller's quarantine", async () => {
	const { rowId } = await quarantineKey(
		USER.id,
		"groq",
		"llama-3-70b",
		"gsk-release-1",
	);
	const response = await releaseRoute.POST(
		new Request(`http://localhost/api/quarantine/${rowId}/release`, {
			method: "POST",
			headers: { Cookie: sessionCookie },
		}),
		{ params: Promise.resolve({ id: String(rowId) }) },
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ released: true });
	expect(await quarantineRowCount(rowId)).toBe(0);
});

test("POST release of another user's quarantine answers 404 and keeps the row", async () => {
	const { rowId } = await quarantineKey(
		OTHER.id,
		"groq",
		"llama-3-70b",
		"gsk-theirs-9999",
	);
	const response = await releaseRoute.POST(
		new Request(`http://localhost/api/quarantine/${rowId}/release`, {
			method: "POST",
			headers: { Cookie: sessionCookie },
		}),
		{ params: Promise.resolve({ id: String(rowId) }) },
	);
	expect(response.status).toBe(404);
	expect(await quarantineRowCount(rowId)).toBe(1);
});

test("POST release of a missing quarantine answers 404 and an invalid id answers 400", async () => {
	const missing = await releaseRoute.POST(
		new Request("http://localhost/api/quarantine/99999/release", {
			method: "POST",
			headers: { Cookie: sessionCookie },
		}),
		{ params: Promise.resolve({ id: "99999" }) },
	);
	expect(missing.status).toBe(404);
	const invalid = await releaseRoute.POST(
		new Request("http://localhost/api/quarantine/abc/release", {
			method: "POST",
			headers: { Cookie: sessionCookie },
		}),
		{ params: Promise.resolve({ id: "abc" }) },
	);
	expect(invalid.status).toBe(400);
});

test("POST release without a session answers 401", async () => {
	const { rowId } = await quarantineKey(
		USER.id,
		"groq",
		"llama-3-70b",
		"gsk-release-2",
	);
	const response = await releaseRoute.POST(
		new Request(`http://localhost/api/quarantine/${rowId}/release`, {
			method: "POST",
		}),
		{ params: Promise.resolve({ id: String(rowId) }) },
	);
	expect(response.status).toBe(401);
	expect(await quarantineRowCount(rowId)).toBe(1);
});
