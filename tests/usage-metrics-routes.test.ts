import { beforeEach, expect, mock, test } from "bun:test";
import { createApiKey } from "../src/lib/key-store";
import type { AppUser } from "../src/lib/types";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Usage + dashboard metrics routes (M29): both read provider_requests
// and the aggregate tables the migration-0003 triggers maintain.
const SECRET = "usage-test-secret-0123456789-abcdefghijklmnopqrst";

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
let currentUser: AppUser | null = USER;

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => SECRET,
	getImagesBucket: () => {
		throw new Error("IMAGES_BUCKET is unavailable in this test");
	},
}));
mock.module("../src/lib/session", () => ({
	requireUser: async () => {
		if (!currentUser) {
			const error = new Error("Not authenticated");
			error.name = "UnauthenticatedError";
			throw error;
		}
		return currentUser;
	},
	clearedSessionCookie: () => "",
	sessionCookie: () => "",
	createSession: async () => {
		throw new Error("unexpected session creation in this test");
	},
	deleteSession: async () => {},
	deleteAllSessionsForUser: async () => {},
	getSessionUser: async () => currentUser,
}));

const usageRoute = await import("../src/app/api/usage/route");
const metricsRoute = await import("../src/app/api/dashboard/metrics/route");

async function insertUser(id: string, username: string): Promise<void> {
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(id, username, username, "hash")
		.run();
}

interface RequestSeed {
	userId: string;
	modelRouted: string;
	platform: string;
	status: string;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number | null;
	ttftMs?: number | null;
	keyId: number;
	createdAt: string;
}

async function insertRequest(row: RequestSeed): Promise<void> {
	await db
		.prepare(
			`INSERT INTO provider_requests
			 (user_id, model_requested, model_routed, platform, status,
			  input_tokens, output_tokens, latency_ms, ttft_ms, key_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.userId,
			row.modelRouted,
			row.modelRouted,
			row.platform,
			row.status,
			row.inputTokens,
			row.outputTokens,
			row.latencyMs,
			row.ttftMs ?? null,
			row.keyId,
			row.createdAt,
		)
		.run();
}

function todayAt(hour: number): string {
	const d = new Date();
	d.setUTCHours(hour, 0, 0, 0);
	return d.toISOString().slice(0, 19).replace("T", " ");
}

beforeEach(async () => {
	db = await createParityDatabase();
	currentUser = USER;
	await insertUser(USER.id, USER.username);
	await insertUser(OTHER.id, OTHER.username);
});

test("GET /api/usage lists only the caller's requests with totals", async () => {
	await insertRequest({
		userId: USER.id,
		modelRouted: "groq/model-a",
		platform: "groq",
		status: "success",
		inputTokens: 10,
		outputTokens: 5,
		latencyMs: 200,
		keyId: 1,
		createdAt: todayAt(10),
	});
	await insertRequest({
		userId: USER.id,
		modelRouted: "groq/model-a",
		platform: "groq",
		status: "error",
		inputTokens: 4,
		outputTokens: 0,
		latencyMs: 100,
		keyId: 1,
		createdAt: todayAt(9),
	});
	await insertRequest({
		userId: OTHER.id,
		modelRouted: "groq/model-a",
		platform: "groq",
		status: "success",
		inputTokens: 999,
		outputTokens: 999,
		latencyMs: 999,
		keyId: 1,
		createdAt: todayAt(10),
	});
	const response = await usageRoute.GET(
		new Request("http://localhost/api/usage"),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		requests: Array<{
			modelRouted: string;
			platform: string;
			status: string;
			inputTokens: number;
			outputTokens: number;
			latencyMs: number;
		}>;
		totals: {
			requests: number;
			successfulRequests: number;
			inputTokens: number;
			outputTokens: number;
		};
	};
	expect(body.requests).toHaveLength(2);
	expect(body.requests.map((r) => r.status)).toEqual(["success", "error"]);
	expect(body.totals.requests).toBe(2);
	expect(body.totals.successfulRequests).toBe(1);
	expect(body.totals.inputTokens).toBe(14);
	expect(body.totals.outputTokens).toBe(5);
});

test("GET /api/usage honours limit and clamps it to 500", async () => {
	for (let i = 0; i < 3; i += 1) {
		await insertRequest({
			userId: USER.id,
			modelRouted: "groq/model-a",
			platform: "groq",
			status: "success",
			inputTokens: 1,
			outputTokens: 1,
			latencyMs: 10,
			keyId: 1,
			createdAt: todayAt(8 + i),
		});
	}
	const limited = await usageRoute.GET(
		new Request("http://localhost/api/usage?limit=2"),
	);
	const limitedBody = (await limited.json()) as { requests: unknown[] };
	expect(limitedBody.requests).toHaveLength(2);
	const zero = await usageRoute.GET(
		new Request("http://localhost/api/usage?limit=0"),
	);
	const zeroBody = (await zero.json()) as { requests: unknown[] };
	// limit=0 is not a positive integer, so the default 100 applies.
	expect(zeroBody.requests).toHaveLength(3);
	const huge = await usageRoute.GET(
		new Request("http://localhost/api/usage?limit=1000"),
	);
	const hugeBody = (await huge.json()) as { requests: unknown[] };
	expect(hugeBody.requests).toHaveLength(3);
});

test("GET /api/usage without a session answers 401", async () => {
	currentUser = null;
	const response = await usageRoute.GET(
		new Request("http://localhost/api/usage"),
	);
	expect(response.status).toBe(401);
});

test("GET /api/dashboard/metrics aggregates the caller's requests by day, provider and key", async () => {
	const key = await createApiKey(
		db,
		{
			userId: USER.id,
			platform: "groq",
			rawKey: "gsk-metrics",
			keyLabel: null,
		},
		SECRET,
	);
	await insertRequest({
		userId: USER.id,
		modelRouted: "groq/model-a",
		platform: "groq",
		status: "success",
		inputTokens: 100,
		outputTokens: 50,
		latencyMs: 1000,
		ttftMs: 200,
		keyId: key.id,
		createdAt: todayAt(10),
	});
	await insertRequest({
		userId: USER.id,
		modelRouted: "groq/model-a",
		platform: "groq",
		status: "success",
		inputTokens: 100,
		outputTokens: 50,
		latencyMs: 3000,
		ttftMs: 400,
		keyId: key.id,
		createdAt: todayAt(11),
	});
	await insertRequest({
		userId: OTHER.id,
		modelRouted: "groq/model-a",
		platform: "groq",
		status: "success",
		inputTokens: 999,
		outputTokens: 999,
		latencyMs: 999,
		keyId: 999,
		createdAt: todayAt(10),
	});
	const response = await metricsRoute.GET(
		new Request("http://localhost/api/dashboard/metrics"),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		requestsByDay: Array<{ total: number; success: number; error: number }>;
		tokensByDay: Array<{ date: string; input: number; output: number }>;
		byProvider: Array<{
			platform: string;
			providerName: string;
			requests: number;
			errors: number;
			p95LatencyMs: number | null;
			avgTtftMs: number | null;
			tokensPerSec: number | null;
			inputTokens: number;
			outputTokens: number;
		}>;
		byKey: Array<{ keyId: number; key_mask: string; requests: number }>;
		overall: { p95LatencyMs: number | null; averageTtftMs: number | null };
	};
	expect(body.requestsByDay).toHaveLength(14);
	const today = body.requestsByDay[13];
	expect(today.total).toBe(2);
	expect(today.success).toBe(2);
	expect(today.error).toBe(0);
	expect(body.tokensByDay[13]).toEqual({
		date: expect.any(String),
		input: 200,
		output: 100,
	});
	expect(body.byProvider).toHaveLength(1);
	const groq = body.byProvider[0];
	expect(groq.platform).toBe("groq");
	expect(groq.providerName).toBe("Groq");
	expect(groq.requests).toBe(2);
	expect(groq.errors).toBe(0);
	expect(groq.inputTokens).toBe(200);
	expect(groq.outputTokens).toBe(100);
	// Throughput is total tokens over total latency: 300 tokens / 4000 ms.
	expect(groq.tokensPerSec).toBe(75);
	// Real TTFT from usage-metrics, not the fixed null the audit found.
	expect(groq.avgTtftMs).toBe(300);
	// Overall p95 comes from the latency histogram (100 ms buckets above
	// 1 s): 3000 ms lands in bucket 1020, reported as 1000 + 20*100 + 99.
	expect(body.overall.p95LatencyMs).toBe(3099);
	// Per-provider p95 is the nearest-rank raw latency instead.
	expect(groq.p95LatencyMs).toBe(3000);
	expect(body.overall.averageTtftMs).toBe(300);
	expect(body.byKey).toHaveLength(1);
	expect(body.byKey[0].keyId).toBe(key.id);
	expect(body.byKey[0].key_mask).toBe("••••rics");
	expect(body.byKey[0].requests).toBe(2);
});

test("metrics with no requests return empty aggregates, not errors", async () => {
	const response = await metricsRoute.GET(
		new Request("http://localhost/api/dashboard/metrics"),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		requestsByDay: Array<{ total: number }>;
		byProvider: unknown[];
		byKey: unknown[];
		overall: { p95LatencyMs: number | null; averageTtftMs: number | null };
	};
	expect(body.requestsByDay).toHaveLength(14);
	expect(body.requestsByDay.every((d) => d.total === 0)).toBe(true);
	expect(body.byProvider).toEqual([]);
	expect(body.byKey).toEqual([]);
	expect(body.overall.p95LatencyMs).toBeNull();
	expect(body.overall.averageTtftMs).toBeNull();
});

test("GET /api/dashboard/metrics without a session answers 401", async () => {
	currentUser = null;
	const response = await metricsRoute.GET(
		new Request("http://localhost/api/dashboard/metrics"),
	);
	expect(response.status).toBe(401);
});
