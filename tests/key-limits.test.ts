import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { encryptApiKey } from "../src/lib/crypto";
import {
	effectiveKeyLimits,
	getKeyUsageWindows,
	getUsageByKey,
	parseOptionalLimit,
	withEffectiveLimits,
} from "../src/lib/key-limits";
import { createApiKey } from "../src/lib/key-store";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

const SECRET = "key-limits-test-secret-0123456789-abcdefghij";
const USER_ID = "user-1";

let db: MemoryD1;
beforeAll(async () => {
	db = await createParityDatabase();
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(USER_ID, "Test User", "testuser", "hash")
		.run();
	// A second user, to prove usage queries never leak across users.
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind("user-2", "Other User", "otheruser", "hash")
		.run();
});
afterAll(() => {
	db.close();
});

test("parseOptionalLimit accepts integers, null means unset, junk is invalid", () => {
	expect(parseOptionalLimit(null)).toBe(null);
	expect(parseOptionalLimit(undefined)).toBe(null);
	expect(parseOptionalLimit(0)).toBe(0);
	expect(parseOptionalLimit(30)).toBe(30);
	expect(parseOptionalLimit(10_000_000)).toBe(10_000_000);
	expect(parseOptionalLimit(-1)).toBe(undefined);
	expect(parseOptionalLimit(1.5)).toBe(undefined);
	expect(parseOptionalLimit("30")).toBe(undefined);
	expect(parseOptionalLimit(Number.NaN)).toBe(undefined);
	expect(parseOptionalLimit(10_000_001)).toBe(undefined);
});

test("effective limits fall back to gateway defaults when nothing is stored", () => {
	const limits = effectiveKeyLimits({
		rpmLimit: null,
		tpmLimit: null,
		rpdLimit: null,
		tpdLimit: null,
	});
	expect(limits).toEqual({
		rpm: 60,
		tpm: 200_000,
		rpd: 5_000,
		tpd: 5_000_000,
		source: "gateway",
	});
});

test("stored limits equal to the provider catalog count as provider default", () => {
	// aion ships rpm 15, tpm 20000, tpd 20000 in migration 0010.
	const limits = effectiveKeyLimits(
		{ rpmLimit: 15, tpmLimit: 20_000, rpdLimit: null, tpdLimit: 20_000 },
		{ rpmLimit: 15, tpmLimit: 20_000, tpdLimit: 20_000 },
	);
	expect(limits.source).toBe("provider");
	expect(limits.rpm).toBe(15);
	expect(limits.tpm).toBe(20_000);
	expect(limits.rpd).toBe(5_000);
	expect(limits.tpd).toBe(20_000);
});

test("a stored limit different from the catalog counts as set for the key", () => {
	const limits = effectiveKeyLimits(
		{ rpmLimit: 30, tpmLimit: null, rpdLimit: null, tpdLimit: null },
		{ rpmLimit: 15, tpmLimit: 20_000, tpdLimit: 20_000 },
	);
	expect(limits.source).toBe("key");
	expect(limits.rpm).toBe(30);
	// Per-field fallback: the fields the key does not set still come
	// from the provider catalog, not from the gateway defaults.
	expect(limits.tpm).toBe(20_000);
	expect(limits.rpd).toBe(5_000);
	expect(limits.tpd).toBe(20_000);
});

test("withEffectiveLimits labels keys from the stored row and the catalog", async () => {
	const providerKey = await createApiKey(
		db,
		{
			userId: USER_ID,
			platform: "aion",
			rawKey: "sk-aion-provider",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: 15,
			tpmLimit: 20_000,
			rpdLimit: null,
			tpdLimit: 20_000,
		},
		SECRET,
	);
	const customKey = await createApiKey(
		db,
		{
			userId: USER_ID,
			platform: "aion",
			rawKey: "sk-aion-custom",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: 30,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		},
		SECRET,
	);
	const unsetKey = await createApiKey(
		db,
		{
			userId: USER_ID,
			platform: "groq",
			rawKey: "gsk-unset",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: null,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		},
		SECRET,
	);
	// anthropic ships no catalog limits (migration 0015), so a key
	// with nothing stored falls through to the gateway defaults.
	const gatewayKey = await createApiKey(
		db,
		{
			userId: USER_ID,
			platform: "anthropic",
			rawKey: "sk-ant-unset",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: null,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		},
		SECRET,
	);
	const enriched = await withEffectiveLimits(db, [
		{ ...providerKey },
		{ ...customKey },
		{ ...unsetKey },
		{ ...gatewayKey },
	]);
	expect(enriched[0]?.limitsSource).toBe("provider");
	expect(enriched[0]?.effectiveLimits.rpm).toBe(15);
	expect(enriched[1]?.limitsSource).toBe("key");
	expect(enriched[1]?.effectiveLimits.rpm).toBe(30);
	// No stored limits, but groq has catalog limits (rpm 30), so the
	// key is labelled provider, not gateway.
	expect(enriched[2]?.limitsSource).toBe("provider");
	expect(enriched[2]?.effectiveLimits.rpm).toBe(30);
	expect(enriched[3]?.limitsSource).toBe("gateway");
	expect(enriched[3]?.effectiveLimits.rpm).toBe(60);
});

async function insertUsageRow(
	keyId: number,
	modelId: string,
	kind: "request" | "tokens",
	tokens: number | null,
	createdAtMs: number,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO provider_rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind("groq", modelId, keyId, kind, tokens, createdAtMs)
		.run();
}

test("usage windows read the same minute and day windows the enforcer uses", async () => {
	const key = await createApiKey(
		db,
		{
			userId: USER_ID,
			platform: "groq",
			rawKey: "gsk-windows",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: null,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		},
		SECRET,
	);
	const now = Date.now();
	const dayStart = Date.UTC(
		new Date(now).getUTCFullYear(),
		new Date(now).getUTCMonth(),
		new Date(now).getUTCDate(),
	);
	// Inside the last minute, two models: usage sums across models.
	await insertUsageRow(key.id, "model-a", "request", null, now - 30_000);
	await insertUsageRow(key.id, "model-a", "tokens", 100, now - 30_000);
	await insertUsageRow(key.id, "model-b", "request", null, now - 10_000);
	await insertUsageRow(key.id, "model-b", "tokens", 40, now - 10_000);
	// Today but outside the last minute.
	await insertUsageRow(key.id, "model-a", "request", null, dayStart + 60_000);
	await insertUsageRow(key.id, "model-a", "tokens", 50, dayStart + 60_000);
	// Yesterday: outside both windows.
	await insertUsageRow(key.id, "model-a", "request", null, dayStart - 60_000);
	await insertUsageRow(key.id, "model-a", "tokens", 999, dayStart - 60_000);

	const windows = await getKeyUsageWindows(db, [key.id], now);
	expect(windows).toHaveLength(1);
	expect(windows[0]).toEqual({
		keyId: key.id,
		requestsMinute: 2,
		tokensMinute: 140,
		requestsDay: 3,
		tokensDay: 190,
	});
	expect(await getKeyUsageWindows(db, [])).toEqual([]);
});

test("usage windows merge chunks past the D1 bound-variable limit (R25)", async () => {
	// getKeyUsageWindows splits keyIds into batches of 50: a single
	// IN (...) with every key a user owns answered /api/keys/usage with
	// 500 ("too many SQL variables"). Usage rows land in different
	// batches on purpose, so a dropped batch fails the test.
	const keyIds: number[] = [];
	for (let i = 0; i < 120; i += 1) {
		const inserted = await db
			.prepare(
				"INSERT INTO api_keys (user_id, platform, encrypted_key, iv, auth_tag, enabled) VALUES (?, 'groq', 'x', 'y', 'z', 1) RETURNING id",
			)
			.bind(USER_ID)
			.all<{ id: number }>();
		keyIds.push(inserted.results[0].id);
	}
	const now = Date.now();
	for (const [index, tokens] of [
		[0, 10],
		[60, 20],
		[119, 30],
	] as const) {
		await insertUsageRow(
			keyIds[index],
			"model-a",
			"request",
			null,
			now - 5_000,
		);
		await insertUsageRow(
			keyIds[index],
			"model-a",
			"tokens",
			tokens,
			now - 5_000,
		);
	}

	const windows = await getKeyUsageWindows(db, keyIds, now);
	expect(windows).toHaveLength(3);
	const byId = new Map(windows.map((row) => [row.keyId, row]));
	for (const [index, tokens] of [
		[0, 10],
		[60, 20],
		[119, 30],
	] as const) {
		expect(byId.get(keyIds[index])).toEqual({
			keyId: keyIds[index],
			requestsMinute: 1,
			tokensMinute: tokens,
			requestsDay: 1,
			tokensDay: tokens,
		});
	}
});

test("usage windows include the previous day in the first minute after UTC midnight", async () => {
	const key = await createApiKey(
		db,
		{
			userId: USER_ID,
			platform: "groq",
			rawKey: "gsk-windows-midnight",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: null,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		},
		SECRET,
	);
	const now = Date.now();
	const dayStart = Date.UTC(
		new Date(now).getUTCFullYear(),
		new Date(now).getUTCMonth(),
		new Date(now).getUTCDate(),
	);
	// 30 seconds after UTC midnight: the sliding minute window still
	// reaches 45 seconds back, into the previous day.
	const midnightNow = dayStart + 30_000;
	// Previous day, inside the minute window but outside the day window.
	await insertUsageRow(
		key.id,
		"model-a",
		"request",
		null,
		midnightNow - 45_000,
	);
	await insertUsageRow(key.id, "model-a", "tokens", 100, midnightNow - 45_000);
	// Today, inside both windows.
	await insertUsageRow(
		key.id,
		"model-b",
		"request",
		null,
		midnightNow - 10_000,
	);
	await insertUsageRow(key.id, "model-b", "tokens", 40, midnightNow - 10_000);

	const windows = await getKeyUsageWindows(db, [key.id], midnightNow);
	expect(windows).toHaveLength(1);
	expect(windows[0]).toEqual({
		keyId: key.id,
		requestsMinute: 2,
		tokensMinute: 140,
		requestsDay: 1,
		tokensDay: 40,
	});
});

async function insertRequestRow(input: {
	userId: string;
	keyId: number;
	platform: string;
	status: string;
	inputTokens: number | null;
	outputTokens: number | null;
	latencyMs: number | null;
}): Promise<void> {
	await db
		.prepare(
			`INSERT INTO provider_requests
			 (user_id, model_requested, model_routed, platform, key_id, status,
			  input_tokens, output_tokens, latency_ms, created_at)
			 VALUES (?, 'shtora/test', 'test-model', ?, ?, ?, ?, ?, ?, datetime('now'))`,
		)
		.bind(
			input.userId,
			input.platform,
			input.keyId,
			input.status,
			input.inputTokens,
			input.outputTokens,
			input.latencyMs,
		)
		.run();
}

test("usage by key aggregates the requester's rows per serving key", async () => {
	const ownKey = await createApiKey(
		db,
		{
			userId: USER_ID,
			platform: "groq",
			rawKey: "gsk-bykey-own",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: null,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		},
		SECRET,
	);
	const communityKey = await createApiKey(
		db,
		{
			userId: "user-2",
			platform: "aion",
			rawKey: "sk-bykey-shared",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: null,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		},
		SECRET,
	);
	await insertRequestRow({
		userId: USER_ID,
		keyId: ownKey.id,
		platform: "groq",
		status: "success",
		inputTokens: 10,
		outputTokens: 5,
		latencyMs: 100,
	});
	await insertRequestRow({
		userId: USER_ID,
		keyId: ownKey.id,
		platform: "groq",
		status: "success",
		inputTokens: 20,
		outputTokens: 10,
		latencyMs: 200,
	});
	await insertRequestRow({
		userId: USER_ID,
		keyId: ownKey.id,
		platform: "groq",
		status: "error",
		inputTokens: 0,
		outputTokens: 0,
		latencyMs: null,
	});
	await insertRequestRow({
		userId: USER_ID,
		keyId: communityKey.id,
		platform: "aion",
		status: "success",
		inputTokens: 7,
		outputTokens: 3,
		latencyMs: 50,
	});
	// Another user's requests never count here.
	await insertRequestRow({
		userId: "user-2",
		keyId: ownKey.id,
		platform: "groq",
		status: "success",
		inputTokens: 999,
		outputTokens: 999,
		latencyMs: 999,
	});

	const rows = await getUsageByKey(db, USER_ID);
	expect(rows).toHaveLength(2);
	const own = rows.find((row) => row.keyId === ownKey.id);
	expect(own).toEqual({
		keyId: ownKey.id,
		platform: "groq",
		requests: 3,
		successes: 2,
		latencyMs: 150,
		inputTokens: 30,
		outputTokens: 15,
	});
	const shared = rows.find((row) => row.keyId === communityKey.id);
	expect(shared).toEqual({
		keyId: communityKey.id,
		platform: "aion",
		requests: 1,
		successes: 1,
		latencyMs: 50,
		inputTokens: 7,
		outputTokens: 3,
	});
});

// Route tests: the database is the same in-memory D1 from the lib tests
// above, and the caller authenticates with a real session cookie instead
// of a mocked session: a mock.module("../src/lib/session", ...) here
// leaks into other test files that import the real session helpers
// (e.g. auth-http.test.ts), because Bun shares the mocked module across
// files in one `bun test` run.
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

let sessionCookie = "";
async function authHeaders(): Promise<Record<string, string>> {
	if (!sessionCookie) {
		const created = await createSession(USER_ID);
		sessionCookie = `${SESSION_COOKIE_NAME}=${created.token}`;
	}
	return { Cookie: sessionCookie };
}

const keyByIdRoute = await import("../src/app/api/keys/[id]/route");
const keyUsageRoute = await import("../src/app/api/keys/usage/route");

test("PATCH sets a limit, resets it to the provider default on null, rejects junk", async () => {
	const key = await createApiKey(
		db,
		{
			userId: USER_ID,
			platform: "aion",
			rawKey: "sk-patch-limits",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: null,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		},
		SECRET,
	);
	const params = { params: Promise.resolve({ id: String(key.id) }) };
	const patch = async (body: unknown) =>
		keyByIdRoute.PATCH(
			new Request("http://localhost/api/keys/1", {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					...(await authHeaders()),
				},
				body: JSON.stringify(body),
			}),
			params,
		);

	let response = await patch({ enabled: true, rpmLimit: 30 });
	expect(response.status).toBe(200);
	let body = (await response.json()) as { key: { rpmLimit: number | null } };
	expect(body.key.rpmLimit).toBe(30);

	response = await patch({ enabled: true, rpmLimit: null });
	expect(response.status).toBe(200);
	body = (await response.json()) as { key: { rpmLimit: number | null } };
	// aion catalog rpm is 15: null resets to the provider default.
	expect(body.key.rpmLimit).toBe(15);

	response = await patch({ enabled: true, rpmLimit: -1 });
	expect(response.status).toBe(400);

	response = await patch({ enabled: true, rpmLimit: "30" });
	expect(response.status).toBe(400);
});

test("PATCH on another user's key is not found", async () => {
	const otherKey = await createApiKey(
		db,
		{
			userId: "user-2",
			platform: "groq",
			rawKey: "gsk-other-user",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: null,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		},
		SECRET,
	);
	const response = await keyByIdRoute.PATCH(
		new Request("http://localhost/api/keys/1", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				...(await authHeaders()),
			},
			body: JSON.stringify({ enabled: false }),
		}),
		{ params: Promise.resolve({ id: String(otherKey.id) }) },
	);
	expect(response.status).toBe(404);
});

test("GET /api/keys/usage returns current windows per own key", async () => {
	const key = await createApiKey(
		db,
		{
			userId: USER_ID,
			platform: "groq",
			rawKey: "gsk-usage-route",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: null,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		},
		SECRET,
	);
	const now = Date.now();
	await insertUsageRow(key.id, "model-a", "request", null, now - 5_000);
	await insertUsageRow(key.id, "model-a", "tokens", 25, now - 5_000);

	const response = await keyUsageRoute.GET(
		new Request("http://localhost/api/keys/usage", {
			headers: await authHeaders(),
		}),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		usage: Array<{
			keyId: number;
			requestsMinute: number;
			tokensMinute: number;
			requestsDay: number;
			tokensDay: number;
		}>;
	};
	const row = body.usage.find((item) => item.keyId === key.id);
	expect(row).toEqual({
		keyId: key.id,
		requestsMinute: 1,
		tokensMinute: 25,
		requestsDay: 1,
		tokensDay: 25,
	});
	// Keys the user owns but never used come back as zeros, not missing.
	const unused = body.usage.find(
		(item) => item.requestsMinute === 0 && item.requestsDay === 0,
	);
	expect(unused).toBeDefined();
});

test("GET /api/keys/usage stays 200 with 200 keys (R25)", async () => {
	// Regression test for the production 500: the route used to pass
	// every key id in one IN (...). 200 real keys (decryptable, so the
	// listing path runs too) must all come back, with usage merged
	// across the internal batches.
	const keyIds: number[] = [];
	for (let i = 0; i < 200; i += 1) {
		const key = await createApiKey(
			db,
			{
				userId: USER_ID,
				platform: "groq",
				rawKey: `gsk-usage-200-${i}`,
				keyLabel: null,
				baseUrl: null,
				rpmLimit: null,
				tpmLimit: null,
				rpdLimit: null,
				tpdLimit: null,
			},
			SECRET,
		);
		keyIds.push(key.id);
	}
	const now = Date.now();
	await insertUsageRow(keyIds[0], "model-a", "request", null, now - 5_000);
	await insertUsageRow(keyIds[0], "model-a", "tokens", 25, now - 5_000);
	await insertUsageRow(keyIds[199], "model-a", "request", null, now - 5_000);

	const response = await keyUsageRoute.GET(
		new Request("http://localhost/api/keys/usage", {
			headers: await authHeaders(),
		}),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		usage: Array<{
			keyId: number;
			requestsMinute: number;
			tokensMinute: number;
			requestsDay: number;
			tokensDay: number;
		}>;
	};
	const byId = new Map(body.usage.map((item) => [item.keyId, item]));
	for (const keyId of keyIds) expect(byId.has(keyId)).toBe(true);
	expect(byId.get(keyIds[0])).toEqual({
		keyId: keyIds[0],
		requestsMinute: 1,
		tokensMinute: 25,
		requestsDay: 1,
		tokensDay: 25,
	});
	expect(byId.get(keyIds[199])?.requestsMinute).toBe(1);
});

test("GET /api/keys/usage stays 200 when one of the user's keys cannot be decrypted", async () => {
	const key = await createApiKey(
		db,
		{
			userId: USER_ID,
			platform: "groq",
			rawKey: "gsk-usage-corrupt",
			keyLabel: null,
			baseUrl: null,
			rpmLimit: null,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		},
		SECRET,
	);
	// A stored key whose ciphertext no longer authenticates (tampered
	// bytes, or a secret that changed): before the fix, decrypting it
	// inside listApiKeys rejected the whole listing and the route
	// answered 500.
	const encrypted = await encryptApiKey("sk-corrupt-1234", SECRET);
	const last = encrypted.ciphertext.slice(-1);
	const tampered =
		encrypted.ciphertext.slice(0, -1) + (last === "0" ? "1" : "0");
	const corruptId = (
		await db
			.prepare(
				"INSERT INTO api_keys (user_id, platform, key_label, encrypted_key, iv, auth_tag, enabled) VALUES (?, 'groq', 'corrupt', ?, ?, ?, 1) RETURNING id",
			)
			.bind(USER_ID, tampered, encrypted.iv, encrypted.authTag)
			.all<{ id: number }>()
	).results[0].id;
	const now = Date.now();
	await insertUsageRow(key.id, "model-a", "request", null, now - 5_000);

	const response = await keyUsageRoute.GET(
		new Request("http://localhost/api/keys/usage", {
			headers: await authHeaders(),
		}),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		usage: Array<{
			keyId: number;
			requestsMinute: number;
			tokensMinute: number;
			requestsDay: number;
			tokensDay: number;
		}>;
	};
	expect(body.usage.find((item) => item.keyId === key.id)).toEqual({
		keyId: key.id,
		requestsMinute: 1,
		tokensMinute: 0,
		requestsDay: 1,
		tokensDay: 0,
	});
	// The unreadable key still lists, with zeros, because it never served.
	expect(body.usage.find((item) => item.keyId === corruptId)).toEqual({
		keyId: corruptId,
		requestsMinute: 0,
		tokensMinute: 0,
		requestsDay: 0,
		tokensDay: 0,
	});
});
