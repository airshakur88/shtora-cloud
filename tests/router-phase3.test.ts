import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApiKey } from "../src/lib/key-store";
import {
	checkReturnedModel,
	isValidReturnedModel,
} from "../src/lib/providers/model-identity";
import {
	ATTEMPT_TIMEOUT_FIRST_MS,
	ATTEMPT_TIMEOUT_MIN_MS,
	ATTEMPT_TIMEOUT_STEP_MS,
	attemptTimeoutMs,
	REQUEST_DEADLINE_MS,
	routeChatCompletion,
} from "../src/lib/router";
import type { AppUser, D1Database, ProviderCatalog } from "../src/lib/types";
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

// Keys in these routing tests carry explicit gateway-default limits so
// the router's effective-limit reserve never throttles them: without
// stored limits the provider catalog limit would apply (groq tpm
// 6000), and a request without max_tokens reserves the 8192-token
// default output. Tests that exercise limits pass their own.
const KEY_LIMITS = {
	rpmLimit: 60,
	tpmLimit: 200_000,
	rpdLimit: 5_000,
	tpdLimit: 5_000_000,
} as const;

let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;

beforeAll(() => {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		fetchImpl(String(input), init)) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

async function seedUser(db: D1Database): Promise<void> {
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(USER.id, USER.name, USER.username, USER.passwordHash)
		.run();
}

async function seedModel(
	db: D1Database,
	platform: string,
	modelId: string,
	rank = 1,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(platform, modelId, modelId, 32768, rank, 1)
		.run();
}

async function seedKey(
	db: D1Database,
	platform: string,
	rawKey: string,
	limits: {
		rpmLimit?: number | null;
		tpmLimit?: number | null;
		rpdLimit?: number | null;
		tpdLimit?: number | null;
	} = KEY_LIMITS,
): Promise<number> {
	const key = await createApiKey(
		db,
		{ userId: USER.id, platform, keyLabel: "test", rawKey, ...limits },
		SECRET,
	);
	return key.id;
}

async function route(
	db: D1Database,
	model: string,
	extra: { stream?: boolean; max_tokens?: number } = {},
) {
	return routeChatCompletion({
		db,
		secret: SECRET,
		user: USER,
		request: {
			model,
			messages: [{ role: "user", content: "hi" }],
			...extra,
		},
	});
}

async function exhaustedSkipped(
	db: D1Database,
): Promise<{ rateLimited?: number }> {
	const row = await db
		.prepare(
			"SELECT skipped_json FROM route_exhausted_events ORDER BY id DESC LIMIT 1",
		)
		.first<{ skipped_json: string }>();
	return JSON.parse(row?.skipped_json ?? "{}") as { rateLimited?: number };
}

function requestedModel(init?: RequestInit): string {
	try {
		const body = JSON.parse(String(init?.body ?? "{}")) as {
			model?: string;
		};
		return body.model ?? "";
	} catch {
		return "";
	}
}

function okCompletion(model: string, content: string): Response {
	return new Response(
		JSON.stringify({
			id: "ok",
			object: "chat.completion",
			created: 0,
			model,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content },
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function geminiResponse(modelVersion: string, parts: unknown[]): Response {
	return Response.json({
		candidates: [
			{
				content: { parts, role: "model" },
				finishReason: "STOP",
			},
		],
		modelVersion,
		usageMetadata: {
			promptTokenCount: 10,
			candidatesTokenCount: 5,
			totalTokenCount: 15,
		},
	});
}

function anthropicMessage(model: string, text: string): Response {
	return Response.json({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model,
		content: [{ type: "text", text }],
		stop_reason: "end_turn",
		usage: { input_tokens: 10, output_tokens: 5 },
	});
}

// R2 (F.1.7): the per-attempt timeout decreases and the deadline caps it.
test("attempt timeout decreases with each attempt and never passes the deadline", () => {
	const far = Date.now() + 1_000_000;
	expect(attemptTimeoutMs(0, far)).toBe(ATTEMPT_TIMEOUT_FIRST_MS);
	expect(attemptTimeoutMs(1, far)).toBe(
		ATTEMPT_TIMEOUT_FIRST_MS - ATTEMPT_TIMEOUT_STEP_MS,
	);
	expect(attemptTimeoutMs(4, far)).toBe(ATTEMPT_TIMEOUT_MIN_MS);
	expect(attemptTimeoutMs(10, far)).toBe(ATTEMPT_TIMEOUT_MIN_MS);
	// The deadline always wins over the per-attempt budget.
	const near = attemptTimeoutMs(0, Date.now() + 5_000);
	expect(near).toBeGreaterThan(0);
	expect(near).toBeLessThanOrEqual(5_000);
	expect(attemptTimeoutMs(0, Date.now() - 1_000)).toBe(0);
});

test("global deadline stays inside the client script timeout", () => {
	// The user's model-test script gives up at 90 s; the gateway must
	// answer (502 or 429) before that, so the deadline is pinned below
	// it. Raising the deadline past 90 s breaks the script's contract.
	expect(REQUEST_DEADLINE_MS).toBeLessThan(90_000);
});

// R4 (F.1.5, stream): a stream with zero deltas is recorded as empty.
test("OpenAI stream with zero deltas is recorded as empty", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-empty-stream-1");
		const wire = "data: [DONE]\n\n";
		fetchImpl = async () =>
			new Response(wire, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		const result = await route(db, "groq/model-a", { stream: true });
		expect(result.response.status).toBe(200);
		expect(await result.response.text()).toBe(wire);
		const row = await db
			.prepare("SELECT status, error_message FROM provider_requests")
			.first<{ status: string; error_message: string | null }>();
		expect(row).toEqual({
			status: "error",
			error_message: "Upstream returned empty content",
		});
	} finally {
		db.close();
	}
});

test("OpenAI stream with only reasoning deltas is recorded as empty", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-reason-stream-1");
		const wire =
			'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n' +
			"data: [DONE]\n\n";
		fetchImpl = async () =>
			new Response(wire, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		const result = await route(db, "groq/model-a", { stream: true });
		expect(result.response.status).toBe(200);
		expect(await result.response.text()).toBe(wire);
		const row = await db
			.prepare("SELECT status, error_message FROM provider_requests")
			.first<{ status: string; error_message: string | null }>();
		expect(row).toEqual({
			status: "error",
			error_message: "Upstream returned empty content",
		});
	} finally {
		db.close();
	}
});

// R9 (F.1.8): a truncated OpenAI stream is an error, not a success.
test("truncated OpenAI stream is recorded as an error, not a success", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-trunc-1");
		const wire = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
		fetchImpl = async () =>
			new Response(wire, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		const result = await route(db, "groq/model-a", { stream: true });
		expect(result.response.status).toBe(200);
		// The partial text already reached the client, so there is no
		// failover — but the record must not call it a success.
		expect(await result.response.text()).toBe(wire);
		const row = await db
			.prepare("SELECT status, error_message FROM provider_requests")
			.first<{ status: string; error_message: string | null }>();
		expect(row).toEqual({
			status: "error",
			error_message: "Upstream stream did not complete",
		});
	} finally {
		db.close();
	}
});

// R12 (F.1.9): a virtual-router member with three keys gets two
// attempts before the router moves to the next member.
test("virtual router member with three keys gets two attempts before the next member", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await db.prepare("DELETE FROM models").run();
		// Priority strategy keeps chain order (rank), so the member
		// with three keys is tried first, deterministically.
		await db
			.prepare(
				"INSERT OR REPLACE INTO settings (key, value) VALUES ('routing_strategy', 'priority')",
			)
			.run();
		await seedModel(db, "groq", "qwen3-8-max", 1);
		await seedModel(db, "groq", "qwen3-8-flash", 2);
		// Two more members so the fair share collapses to one
		// (floor(6/4) = 1) and only the floor of two binds.
		await seedModel(db, "groq", "qwen3-8-omni-flash", 3);
		await seedModel(db, "groq", "gpt-5-6-luna", 4);
		const firstKey = await seedKey(db, "groq", "sk-test-f19-1");
		const secondKey = await seedKey(db, "groq", "sk-test-f19-2");
		await seedKey(db, "groq", "sk-test-f19-3");
		await seedKey(db, "groq", "sk-test-f19-4");
		const attempted: string[] = [];
		fetchImpl = async (_input, init) => {
			const model = requestedModel(init);
			attempted.push(model);
			if (model === "qwen3-8-max") return new Response("boom", { status: 500 });
			return okCompletion(model, "ok");
		};
		const result = await route(db, "shtora/auto");
		expect(result.response.status).toBe(200);
		expect(result.modelId).toBe("qwen3-8-flash");
		expect(attempted).toEqual(["qwen3-8-max", "qwen3-8-max", "qwen3-8-flash"]);
		// Only the first two of the member's three keys were tried.
		const memberKeyIds = (result.attemptLog ?? [])
			.filter((attempt) => attempt.modelId === "qwen3-8-max")
			.map((attempt) => attempt.keyId);
		expect(memberKeyIds).toEqual([firstKey, secondKey]);
	} finally {
		db.close();
	}
});

// R5: the shared echo validator — the check every sender funnels into.
const exactProvider = {
	id: "groq",
	name: "Groq",
	baseUrl: "https://api.groq.com",
	authType: "bearer",
	protocol: "openai_compatible",
	modelIdentity: "exact",
} as ProviderCatalog;

test("exact echo accepts the id, an alias, and a versioned echo; rejects another family", () => {
	expect(
		isValidReturnedModel(exactProvider, "gemini-2.0-flash", "gemini-2.0-flash"),
	).toBe(true);
	expect(
		isValidReturnedModel(
			exactProvider,
			"gemini-2.0-flash",
			"gemini-2.0-flash-001",
		),
	).toBe(true);
	expect(
		isValidReturnedModel(
			{
				...exactProvider,
				modelAliases: { "gemini-2.0-flash": "gemini-2.0-flash-001" },
			},
			"gemini-2.0-flash",
			"gemini-2.0-flash-001",
		),
	).toBe(true);
	expect(
		isValidReturnedModel(
			exactProvider,
			"gemini-2.0-flash",
			"gemini-2.0-flash-lite",
		),
	).toBe(false);
	expect(
		isValidReturnedModel(exactProvider, "gemini-2.0-flash", "gpt-5-6-luna"),
	).toBe(false);
	expect(() =>
		checkReturnedModel(
			exactProvider,
			"gemini-2.0-flash",
			"gemini-2.0-flash-lite",
		),
	).toThrow("Upstream returned an unexpected model");
});

test("missing echo and providers without model_identity are unverifiable, not mismatches", () => {
	for (const returned of [undefined, null, "", 42]) {
		expect(
			isValidReturnedModel(exactProvider, "gemini-2.0-flash", returned),
		).toBe(true);
		expect(() =>
			checkReturnedModel(exactProvider, "gemini-2.0-flash", returned),
		).not.toThrow();
	}
	const noIdentity = { ...exactProvider, modelIdentity: undefined };
	expect(
		isValidReturnedModel(noIdentity, "gemini-2.0-flash", "something-else"),
	).toBe(true);
});

// R5: Google preserves its modelVersion echo; a versioned alias answers.
test("Google versioned alias echo is a success", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "google", "gemini-2.0-flash");
		await seedKey(db, "google", "sk-test-google-echo-1");
		fetchImpl = async () =>
			geminiResponse("gemini-2.0-flash-001", [{ text: "ok" }]);
		const result = await route(db, "google/gemini-2.0-flash");
		expect(result.response.status).toBe(200);
		const body = (await result.response.json()) as {
			model: string;
			choices: { message: { content: string } }[];
		};
		expect(body.model).toBe("gemini-2.0-flash-001");
		expect(body.choices[0].message.content).toBe("ok");
	} finally {
		db.close();
	}
});

test("Google divergent echo fails over with model_mismatch and does not quarantine", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "google", "gemini-2.0-flash");
		await seedKey(db, "google", "sk-test-google-bad-1");
		await seedKey(db, "google", "sk-test-google-bad-2");
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			if (calls === 1)
				return geminiResponse("gemini-2.0-flash-lite", [{ text: "wrong" }]);
			return geminiResponse("gemini-2.0-flash-001", [{ text: "ok" }]);
		};
		const result = await route(db, "google/gemini-2.0-flash");
		expect(result.response.status).toBe(200);
		expect(calls).toBe(2);
		expect(result.attemptLog?.[0]?.kind).toBe("model_mismatch");
		const body = (await result.response.json()) as {
			choices: { message: { content: string } }[];
		};
		expect(body.choices[0].message.content).toBe("ok");
		const cooldowns = await db
			.prepare("SELECT * FROM provider_rate_limit_cooldowns")
			.all();
		expect(cooldowns.results).toHaveLength(0);
	} finally {
		db.close();
	}
});

test("Google thinking parts are synthesized as reasoning_content", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "google", "gemini-2.0-flash");
		await seedKey(db, "google", "sk-test-google-think-1");
		fetchImpl = async () =>
			geminiResponse("gemini-2.0-flash-001", [
				{ text: "let me think", thought: true },
				{ text: "ok" },
			]);
		const result = await route(db, "google/gemini-2.0-flash");
		expect(result.response.status).toBe(200);
		const body = (await result.response.json()) as {
			choices: {
				message: { content: string; reasoning_content?: string };
			}[];
		};
		expect(body.choices[0].message.content).toBe("ok");
		expect(body.choices[0].message.reasoning_content).toBe("let me think");
	} finally {
		db.close();
	}
});

// R5: Anthropic preserves its model echo; a dated snapshot answers.
test("Anthropic dated snapshot echo is a success", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "anthropic", "claude-sonnet-4-5");
		await seedKey(db, "anthropic", "sk-test-anthropic-echo-1");
		fetchImpl = async () =>
			anthropicMessage("claude-sonnet-4-5-20250929", "ok");
		const result = await route(db, "anthropic/claude-sonnet-4-5");
		expect(result.response.status).toBe(200);
		const body = (await result.response.json()) as {
			model: string;
			choices: { message: { content: string } }[];
		};
		expect(body.model).toBe("claude-sonnet-4-5-20250929");
		expect(body.choices[0].message.content).toBe("ok");
	} finally {
		db.close();
	}
});

test("Anthropic divergent echo fails over with model_mismatch", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "anthropic", "claude-sonnet-4-5");
		await seedKey(db, "anthropic", "sk-test-anthropic-bad-1");
		await seedKey(db, "anthropic", "sk-test-anthropic-bad-2");
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			if (calls === 1)
				return anthropicMessage("claude-opus-5-5", "wrong model");
			return anthropicMessage("claude-sonnet-4-5-20250929", "ok");
		};
		const result = await route(db, "anthropic/claude-sonnet-4-5");
		expect(result.response.status).toBe(200);
		expect(calls).toBe(2);
		expect(result.attemptLog?.[0]?.kind).toBe("model_mismatch");
		const body = (await result.response.json()) as {
			choices: { message: { content: string } }[];
		};
		expect(body.choices[0].message.content).toBe("ok");
	} finally {
		db.close();
	}
});

// R16/R18: the provider catalog limit binds a key with no stored limits.
test("provider catalog limit throttles a key with no stored limits; max_tokens fits", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		// groq ships tpm 6000 in migration 0010; a request without
		// max_tokens reserves ~8192 tokens, so the reservation fails.
		await seedKey(db, "groq", "sk-test-null-limits-1", {
			rpmLimit: null,
			tpmLimit: null,
			rpdLimit: null,
			tpdLimit: null,
		});
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			return okCompletion(requestedModel(init), "ok");
		};
		const throttled = await route(db, "groq/model-a");
		expect(throttled.response.status).toBe(429);
		expect(calls).toBe(0);
		expect((await exhaustedSkipped(db)).rateLimited).toBeGreaterThan(0);
		// The same key serves a request that fits inside tpm 6000.
		const served = await route(db, "groq/model-a", { max_tokens: 16 });
		expect(served.response.status).toBe(200);
		expect(calls).toBe(1);
	} finally {
		db.close();
	}
});

test("a failed attempt consumes quota: the next request on the same key is throttled", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-fail-quota-1", {
			rpmLimit: 1,
			tpmLimit: 200_000,
			rpdLimit: 5_000,
			tpdLimit: 5_000_000,
		});
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			// Empty 200: no quarantine, so the key stays usable — only
			// the reservation rows are left behind.
			return new Response(
				JSON.stringify({
					id: "empty",
					object: "chat.completion",
					created: 0,
					model: requestedModel(init),
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: null },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 0,
						total_tokens: 10,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};
		const first = await route(db, "groq/model-a");
		expect(first.response.status).toBe(502);
		expect(calls).toBe(1);
		const usage = await db
			.prepare("SELECT kind FROM provider_rate_limit_usage ORDER BY rowid")
			.all<{ kind: string }>();
		expect(usage.results.map((row) => row.kind)).toEqual(["request", "tokens"]);
		const second = await route(db, "groq/model-a");
		expect(second.response.status).toBe(429);
		expect(calls).toBe(1);
		expect((await exhaustedSkipped(db)).rateLimited).toBe(1);
	} finally {
		db.close();
	}
});

test("a successful attempt finalizes the reservation to the real token total", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-finalize-1");
		fetchImpl = async (_input, init) =>
			okCompletion(requestedModel(init), "ok");
		const result = await route(db, "groq/model-a");
		expect(result.response.status).toBe(200);
		const tokens = await db
			.prepare(
				"SELECT tokens FROM provider_rate_limit_usage WHERE kind = 'tokens'",
			)
			.first<{ tokens: number }>();
		// prompt 10 + completion 5 from the upstream usage, not the
		// ~8192-token estimate the reservation held.
		expect(tokens?.tokens).toBe(15);
	} finally {
		db.close();
	}
});

// R19: one key listing per platform per request.
test("one key listing per platform per request", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await db.prepare("DELETE FROM models").run();
		await seedModel(db, "groq", "qwen3-8-max", 1);
		await seedModel(db, "groq", "qwen3-8-flash", 2);
		await seedKey(db, "groq", "sk-test-cache-1");
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			return new Response("boom", { status: 500 });
		};
		let listings = 0;
		const countingDb = Object.create(Object.getPrototypeOf(db)) as D1Database;
		Object.assign(countingDb, db);
		const realPrepare = db.prepare.bind(db);
		countingDb.prepare = (sql: string) => {
			if (sql.includes("FROM api_keys WHERE platform = ? AND enabled = 1"))
				listings += 1;
			return realPrepare(sql);
		};
		const result = await route(countingDb, "shtora/auto");
		expect(result.response.status).toBe(502);
		// Both members were attempted, but the groq pool was listed once.
		expect(calls).toBe(2);
		expect(listings).toBe(1);
	} finally {
		db.close();
	}
});
