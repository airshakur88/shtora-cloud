import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApiKey } from "../src/lib/key-store";
import { sendChat } from "../src/lib/providers";
import { routeChatCompletion } from "../src/lib/router";
import type { AppUser, D1Database } from "../src/lib/types";
import { createParityDatabase } from "./utils/parity-database";

const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";

// Keys in these routing tests carry explicit gateway-default limits so
// the router's effective-limit reserve never throttles them: without
// stored limits the provider catalog limit would apply (groq tpm 6000),
// and a request without max_tokens reserves the 8192-token default
// output. These tests exercise routing, not rate limits.
const KEY_LIMITS = {
	rpmLimit: 60,
	tpmLimit: 200_000,
	rpdLimit: 5_000,
	tpdLimit: 5_000_000,
} as const;
const USER: AppUser = {
	id: "u1",
	name: "Test User",
	username: "testuser",
	role: "user",
	passwordHash: "unused",
	createdAt: "2026-11-12 00:00:00",
	updatedAt: "2026-11-12 00:00:00",
};

async function seedDb(db: D1Database): Promise<void> {
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(USER.id, USER.name, USER.username, USER.passwordHash)
		.run();
	await db
		.prepare(
			"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind("groq", "model-a", "Model A", 32768, 1, 1)
		.run();
	await db
		.prepare(
			"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind("groq", "model-b", "Model B", 32768, 2, 1)
		.run();
	await createApiKey(
		db,
		{
			userId: USER.id,
			platform: "groq",
			keyLabel: "test",
			rawKey: "sk-test-upstream-key",
			...KEY_LIMITS,
		},
		SECRET,
	);
}

let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;

beforeAll(() => {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		fetchImpl(String(input), init)) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("429 on a direct model returns 429 with Retry-After instead of serving a different model", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			return calls === 1
				? new Response(JSON.stringify({ error: { message: "rate limit" } }), {
						status: 429,
						headers: { "Retry-After": "90" },
					})
				: new Response(
						JSON.stringify({
							id: "ok",
							object: "chat.completion",
							created: 0,
							model: "model-b",
							choices: [
								{
									index: 0,
									message: { role: "assistant", content: "ok" },
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
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		const body = (await result.response.json()) as {
			error: { code: string; message: string };
		};
		const cooldowns = await db
			.prepare(
				"SELECT failure_count, cooldown_until_ms FROM provider_rate_limit_cooldowns",
			)
			.all<{ failure_count: number; cooldown_until_ms: number }>();
		const requests = await db
			.prepare("SELECT status, model_routed FROM provider_requests ORDER BY id")
			.all<{ status: string; model_routed: string }>();
		const usage = await db
			.prepare(
				"SELECT kind, tokens FROM provider_rate_limit_usage ORDER BY rowid",
			)
			.all<{ kind: string; tokens: number | null }>();

		// A direct request names one model: a 429 on its only key is a
		// 429 with the upstream Retry-After, and model-b is never attempted.
		expect(result.response.status).toBe(429);
		expect(result.response.headers.get("Retry-After")).toBe("90");
		expect(body.error.code).toBe("rate_limited");
		expect(body.error.message).toBe(
			"All configured upstream providers are rate limited. Try again later.",
		);
		expect(calls).toBe(1);
		expect(cooldowns.results).toHaveLength(1);
		expect(cooldowns.results[0].failure_count).toBe(1);
		expect(cooldowns.results[0].cooldown_until_ms).toBeGreaterThan(Date.now());
		expect(requests.results.map((row) => row.status)).toEqual(["rate_limited"]);
		expect(requests.results.map((row) => row.model_routed)).toEqual([
			"model-a",
		]);
		// The atomic reservation leaves its rows behind: a failed
		// attempt still consumes quota, so a dead key throttles itself
		// instead of being retried without limit. One 'request' row
		// and one 'tokens' row holding the estimated input tokens.
		expect(usage.results.map((row) => row.kind)).toEqual(["request", "tokens"]);
		expect(usage.results.filter((row) => row.tokens !== null)).toHaveLength(1);
	} finally {
		db.close();
	}
});

test("upstream exhaustion returns generic 502 and records each failed attempt", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			return new Response("internal upstream detail", { status: 500 });
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		const body = (await result.response.json()) as {
			error: { code: string; message: string };
		};
		const requests = await db
			.prepare(
				"SELECT status, error_message, model_routed FROM provider_requests ORDER BY id",
			)
			.all<{
				status: string;
				error_message: string;
				model_routed: string;
			}>();
		expect(result.response.status).toBe(502);
		expect(body.error.code).toBe("all_providers_failed");
		expect(body.error.message).not.toContain("internal upstream detail");
		// Only the requested model is ever attempted: model-b is not a
		// substitute for a direct request.
		expect(calls).toBe(1);
		expect(requests.results).toHaveLength(1);
		expect(
			requests.results.every(
				(row) => row.status === "error" && row.error_message === "Upstream 500",
			),
		).toBe(true);
		expect(requests.results.map((row) => row.model_routed)).toEqual([
			"model-a",
		]);
	} finally {
		db.close();
	}
});

test("upstream exhaustion returns the failed attempts in the result log", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		fetchImpl = async () =>
			new Response("internal upstream detail", { status: 500 });
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(result.response.status).toBe(502);
		expect(result.attemptLog).toHaveLength(1);
		expect(result.attemptLog?.[0]).toMatchObject({
			platform: "groq",
			modelId: "model-a",
			status: 500,
			kind: "server",
			phase: "member",
		});
		expect(result.attemptLog?.[0]?.latencyMs).toBeGreaterThanOrEqual(0);
	} finally {
		db.close();
	}
});

test("upstream exhaustion logs route_exhausted with the full attempt log", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		fetchImpl = async () =>
			new Response("internal upstream detail", { status: 500 });
		const errors: unknown[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args[0]);
		};
		try {
			const result = await routeChatCompletion({
				db,
				secret: SECRET,
				user: USER,
				request: {
					model: "groq/model-a",
					messages: [{ role: "user", content: "distinct-prompt-phrase" }],
				},
			});
			expect(result.response.status).toBe(502);
		} finally {
			console.error = originalError;
		}
		expect(errors).toHaveLength(1);
		const log = JSON.parse(String(errors[0])) as {
			event: string;
			model: string;
			attempts: number;
			status: number;
			skipped: Record<string, number>;
			kinds: string[];
			attemptLog: Record<string, unknown>[];
		};
		expect(Object.keys(log).sort()).toEqual([
			"attemptLog",
			"attempts",
			"event",
			"kinds",
			"model",
			"skipped",
			"status",
		]);
		expect(log.event).toBe("route_exhausted");
		expect(log.model).toBe("groq/model-a");
		expect(log.attempts).toBe(1);
		expect(log.status).toBe(502);
		expect(log.skipped).toEqual({
			noKey: 0,
			quarantined: 0,
			rateLimited: 0,
			suspended: 0,
		});
		expect(log.kinds).toEqual(["server"]);
		expect(log.attemptLog).toHaveLength(1);
		expect(Object.keys(log.attemptLog[0]).sort()).toEqual([
			"keyId",
			"kind",
			"latencyMs",
			"modelId",
			"phase",
			"platform",
			"status",
		]);
		expect(log.attemptLog[0]).toMatchObject({
			platform: "groq",
			modelId: "model-a",
			status: 500,
			kind: "server",
			phase: "member",
		});
		expect(typeof log.attemptLog[0].keyId).toBe("number");
		expect(log.attemptLog[0].latencyMs).toBeGreaterThanOrEqual(0);
		// The log carries only the six attempt fields: no upstream body,
		// prompt, or key material.
		expect(JSON.stringify(errors)).not.toContain("internal upstream detail");
		expect(JSON.stringify(errors)).not.toContain("distinct-prompt-phrase");
	} finally {
		db.close();
	}
});

test("upstream 400 on a direct model returns 502 instead of serving a different model", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			return calls === 1
				? new Response("secret upstream response", { status: 400 })
				: new Response(
						JSON.stringify({
							id: "ok",
							object: "chat.completion",
							created: 0,
							model: "model-b",
							choices: [
								{
									index: 0,
									message: { role: "assistant", content: "ok" },
									finish_reason: "stop",
								},
							],
							usage: {
								prompt_tokens: 5,
								completion_tokens: 3,
								total_tokens: 8,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		const body = (await result.response.json()) as {
			error: { code: string; message: string };
		};
		expect(result.response.status).toBe(502);
		expect(body.error.code).toBe("all_providers_failed");
		expect(body.error.message).not.toContain("secret upstream response");
		expect(calls).toBe(1);
		const requests = await db
			.prepare("SELECT status, model_routed FROM provider_requests ORDER BY id")
			.all<{ status: string; model_routed: string }>();
		expect(requests.results.map((row) => row.status)).toEqual(["error"]);
		expect(requests.results.map((row) => row.model_routed)).toEqual([
			"model-a",
		]);
	} finally {
		db.close();
	}
});

test("direct request for a model with no enabled key returns 502 without calling upstream", async () => {
	const db = await createParityDatabase();
	try {
		await db.prepare("DELETE FROM models").run();
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind(USER.id, USER.name, USER.username, USER.passwordHash)
			.run();
		await db
			.prepare(
				"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind("groq", "model-a", "Model A", 32768, 1, 1)
			.run();
		await db
			.prepare(
				"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind("anthropic", "model-nokey", "No Key Model", 32768, 1, 1)
			.run();
		await createApiKey(
			db,
			{
				userId: USER.id,
				platform: "groq",
				keyLabel: "test",
				rawKey: "sk-test-upstream-key",
				...KEY_LIMITS,
			},
			SECRET,
		);
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			return new Response("must not be called", { status: 200 });
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "anthropic/model-nokey",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		const body = (await result.response.json()) as {
			error: { code: string; message: string };
		};
		const requests = await db
			.prepare("SELECT model_routed FROM provider_requests")
			.all<{ model_routed: string }>();
		// model-a has a key and would have answered; a direct request for
		// model-nokey must not be served by it.
		expect(result.response.status).toBe(502);
		expect(body.error.code).toBe("all_providers_failed");
		expect(body.error.message).toBe(
			"All configured upstream providers are unavailable.",
		);
		expect(calls).toBe(0);
		expect(requests.results).toHaveLength(0);
	} finally {
		db.close();
	}
});

test("router request still fails over between members", async () => {
	const db = await createParityDatabase();
	try {
		await db.prepare("DELETE FROM models").run();
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind(USER.id, USER.name, USER.username, USER.passwordHash)
			.run();
		for (const [modelId, name, rank] of [
			["qwen3-coder-plus", "Qwen3 Coder Plus", 1],
			["qwen3-8-max", "Qwen3 8 Max", 2],
		] as const) {
			await db
				.prepare(
					"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier, supports_tools, supports_vision) VALUES (?, ?, ?, ?, ?, ?, 1, 1)",
				)
				.bind("groq", modelId, name, 32768, rank, 1)
				.run();
		}
		await createApiKey(
			db,
			{
				userId: USER.id,
				platform: "groq",
				keyLabel: "test",
				rawKey: "sk-test-upstream-key",
				...KEY_LIMITS,
			},
			SECRET,
		);
		let calls = 0;
		const attempted: string[] = [];
		fetchImpl = async (_input, init) => {
			calls += 1;
			let model = "echo";
			try {
				const body = JSON.parse(String(init?.body ?? "{}")) as {
					model?: string;
				};
				if (body.model) model = body.model;
			} catch {
				// Keep the fallback model.
			}
			attempted.push(model);
			if (calls === 1) return new Response("boom", { status: 500 });
			return new Response(
				JSON.stringify({
					id: "ok",
					object: "chat.completion",
					created: 0,
					model,
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "ok" },
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
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "shtora/coding",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(result.response.status).toBe(200);
		expect(calls).toBe(2);
		expect(["qwen3-coder-plus", "qwen3-8-max"]).toContain(result.modelId);
		expect(new Set(attempted)).toEqual(
			new Set(["qwen3-coder-plus", "qwen3-8-max"]),
		);
	} finally {
		db.close();
	}
});
test("streaming provider usage updates the stored attempt with exact counts", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		const wire = [
			'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
			'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n',
			"data: [DONE]\n\n",
		].join("");
		fetchImpl = async () =>
			new Response(wire, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
				stream: true,
			},
		});
		expect(await result.response.text()).toBe(wire);
		const row = await db
			.prepare(
				`SELECT input_tokens, output_tokens, input_tokens_estimated,
				 output_tokens_estimated, ttft_ms, estimated_savings_usd
				 FROM provider_requests`,
			)
			.first<{
				input_tokens: number;
				output_tokens: number;
				input_tokens_estimated: number;
				output_tokens_estimated: number;
				ttft_ms: number;
				estimated_savings_usd: number;
			}>();
		expect(row).toMatchObject({
			input_tokens: 12,
			output_tokens: 7,
			input_tokens_estimated: 0,
			output_tokens_estimated: 0,
		});
		expect(row?.ttft_ms).toBeGreaterThanOrEqual(0);
		expect(row?.estimated_savings_usd).toBeCloseTo(0.000008);
	} finally {
		db.close();
	}
});

test("usage-less streaming attempts estimate visible text and tool arguments", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		const wire = [
			'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}}]}\n\n',
			"data: [DONE]\n\n",
		].join("");
		fetchImpl = async () =>
			new Response(wire, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
				stream: true,
			},
		});
		expect(await result.response.text()).toBe(wire);
		const row = await db
			.prepare(
				`SELECT input_tokens, output_tokens, input_tokens_estimated,
				 output_tokens_estimated, ttft_ms
				 FROM provider_requests`,
			)
			.first<{
				input_tokens: number;
				output_tokens: number;
				input_tokens_estimated: number;
				output_tokens_estimated: number;
				ttft_ms: number;
			}>();
		expect(row).toMatchObject({
			input_tokens: 1,
			output_tokens: 3,
			input_tokens_estimated: 1,
			output_tokens_estimated: 1,
		});
		expect(row?.ttft_ms).toBeGreaterThanOrEqual(0);
	} finally {
		db.close();
	}
});
test("non-stream malformed usage falls back to emitted text and tool arguments", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		fetchImpl = async () =>
			new Response(
				JSON.stringify({
					id: "completion",
					object: "chat.completion",
					created: 1,
					model: "model-a",
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: "hello",
								tool_calls: [
									{
										id: "call_1",
										type: "function",
										function: { name: "test", arguments: '{"a":1}' },
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
					usage: { prompt_tokens: -1, completion_tokens: -2 },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(result.response.status).toBe(200);
		const row = await db
			.prepare(
				"SELECT input_tokens, output_tokens, input_tokens_estimated, output_tokens_estimated FROM provider_requests",
			)
			.first<{
				input_tokens: number;
				output_tokens: number;
				input_tokens_estimated: number;
				output_tokens_estimated: number;
			}>();
		expect(row).toEqual({
			input_tokens: 1,
			output_tokens: 3,
			input_tokens_estimated: 1,
			output_tokens_estimated: 1,
		});
	} finally {
		db.close();
	}
});
test("custom provider URLs reject literal private addresses before fetch", async () => {
	// sendChat resolves the provider config from D1: pass an explicit
	// database (plain `bun test` has no Workers binding to fall back to).
	const db = await createParityDatabase();
	try {
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			return new Response("unexpected fetch", { status: 200 });
		};
		await expect(
			sendChat(
				{
					platform: "custom",
					modelId: "model-a",
					apiKey: "secret",
					baseUrl: "https://127.0.0.1/v1",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				},
				undefined,
				db,
			),
		).rejects.toThrow("Invalid upstream configuration");
		expect(calls).toBe(0);
	} finally {
		db.close();
	}
});
