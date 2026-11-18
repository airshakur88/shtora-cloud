import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApiKey } from "../src/lib/key-store";
import { sendChat } from "../src/lib/providers";
import { routeChatCompletion } from "../src/lib/router";
import type { AppUser, D1Database } from "../src/lib/types";
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

test("429 fails over and records isolated provider usage and cooldowns", async () => {
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
		const cooldowns = await db
			.prepare(
				"SELECT failure_count, cooldown_until_ms FROM provider_rate_limit_cooldowns",
			)
			.all<{ failure_count: number; cooldown_until_ms: number }>();
		const requests = await db
			.prepare("SELECT status FROM provider_requests ORDER BY id")
			.all<{ status: string }>();
		const usage = await db
			.prepare(
				"SELECT kind, tokens FROM provider_rate_limit_usage ORDER BY rowid",
			)
			.all<{ kind: string; tokens: number | null }>();

		expect(result.response.status).toBe(200);
		expect(result.modelId).toBe("model-b");
		expect(calls).toBe(2);
		expect(cooldowns.results).toHaveLength(1);
		expect(cooldowns.results[0].failure_count).toBe(1);
		expect(cooldowns.results[0].cooldown_until_ms).toBeGreaterThan(Date.now());
		expect(requests.results.map((row) => row.status)).toEqual([
			"rate_limited",
			"success",
		]);
		expect(usage.results.map((row) => row.kind)).toEqual(["request", "tokens"]);
		expect(usage.results[1].tokens).toBe(15);
	} finally {
		db.close();
	}
});

test("upstream exhaustion returns generic 502 and records each failed attempt", async () => {
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
		const body = (await result.response.json()) as {
			error: { code: string; message: string };
		};
		const requests = await db
			.prepare(
				"SELECT status, error_message FROM provider_requests ORDER BY id",
			)
			.all<{ status: string; error_message: string }>();
		expect(result.response.status).toBe(502);
		expect(body.error.code).toBe("all_providers_failed");
		expect(body.error.message).not.toContain("internal upstream detail");
		expect(requests.results).toHaveLength(2);
		expect(
			requests.results.every(
				(row) => row.status === "error" && row.error_message === "Upstream 500",
			),
		).toBe(true);
	} finally {
		db.close();
	}
});

test("upstream 400 continues failover without exposing response details", async () => {
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
		expect(result.response.status).toBe(200);
		expect(calls).toBe(2);
		const requests = await db
			.prepare("SELECT status FROM provider_requests ORDER BY id")
			.all<{ status: string }>();
		expect(requests.results.map((row) => row.status)).toEqual([
			"error",
			"success",
		]);
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
	let calls = 0;
	fetchImpl = async () => {
		calls += 1;
		return new Response("unexpected fetch", { status: 200 });
	};
	await expect(
		sendChat({
			platform: "custom",
			modelId: "model-a",
			apiKey: "secret",
			baseUrl: "https://127.0.0.1/v1",
			messages: [{ role: "user", content: "hi" }],
			stream: false,
		}),
	).rejects.toThrow("Invalid upstream configuration");
	expect(calls).toBe(0);
});
