import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApiKey } from "../src/lib/key-store";
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
): Promise<number> {
	const key = await createApiKey(
		db,
		{ userId: USER.id, platform, keyLabel: "test", rawKey },
		SECRET,
	);
	return key.id;
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
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
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

async function keyEnabled(db: D1Database, keyId: number): Promise<boolean> {
	const row = await db
		.prepare("SELECT enabled FROM api_keys WHERE id = ?")
		.bind(keyId)
		.first<{ enabled: number }>();
	return row?.enabled === 1;
}

// Fix A: the attempt budget is per canonical model, not per catalog row.
test("direct request for a model on three providers uses all six attempts", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		for (const [platform, rank] of [
			["groq", 1],
			["cerebras", 2],
			["together", 3],
		] as const) {
			await seedModel(db, platform, "shared-model", rank);
			await seedKey(db, platform, `sk-test-${platform}-1`);
			await seedKey(db, platform, `sk-test-${platform}-2`);
		}
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			return new Response("boom", { status: 500 });
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "shtora/shared-model",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		// One logical model, six keys: floor(6/3 rows) used to give two
		// attempts total. The canonical budget gives six.
		expect(result.response.status).toBe(502);
		expect(result.attempts).toBe(6);
		expect(calls).toBe(6);
		expect(result.attemptLog).toHaveLength(6);
	} finally {
		db.close();
	}
});

// Fix B: an empty 200 with finish_reason "length" fails over.
test("empty completion with length fails over to the next key", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-empty-1");
		await seedKey(db, "groq", "sk-test-empty-2");
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			if (calls === 1) {
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
								finish_reason: "length",
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
			}
			return okCompletion(requestedModel(init), "ok");
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
		const body = (await result.response.json()) as {
			choices: { message: { content: string } }[];
		};
		expect(body.choices[0].message.content).toBe("ok");
		expect(result.attempts).toBe(2);
		expect(calls).toBe(2);
		const requests = await db
			.prepare(
				"SELECT status, status_code, error_message, failure_attribution FROM provider_requests ORDER BY id",
			)
			.all<{
				status: string;
				status_code: number;
				error_message: string;
				failure_attribution: string;
			}>();
		expect(requests.results).toHaveLength(2);
		expect(requests.results[0]).toMatchObject({
			status: "error",
			status_code: 200,
			error_message: "Upstream returned empty content",
			failure_attribution: "model_error",
		});
		expect(requests.results[1].status).toBe("success");
		// The empty reply quarantines nothing: no cooldown row at all.
		const cooldowns = await db
			.prepare("SELECT * FROM provider_rate_limit_cooldowns")
			.all();
		expect(cooldowns.results).toHaveLength(0);
	} finally {
		db.close();
	}
});

test("a key that returned empty content stays usable on the next request", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-empty-1");
		await seedKey(db, "groq", "sk-test-empty-2");
		const usedKeys: string[] = [];
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			usedKeys.push(new Headers(init?.headers).get("authorization") ?? "");
			if (calls === 1) {
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
								finish_reason: "length",
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
			}
			return okCompletion(requestedModel(init), "ok");
		};
		const first = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(first.response.status).toBe(200);
		const second = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi again" }],
			},
		});
		expect(second.response.status).toBe(200);
		// First attempt of the first request used key 1 and returned
		// empty; the second request still starts with key 1.
		expect(usedKeys[0]).toBe("Bearer sk-test-empty-1");
		expect(usedKeys[2]).toBe("Bearer sk-test-empty-1");
	} finally {
		db.close();
	}
});

test("empty completion with reasoning fails over to the next key", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-empty-1");
		await seedKey(db, "groq", "sk-test-empty-2");
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			if (calls === 1) {
				return new Response(
					JSON.stringify({
						id: "empty",
						object: "chat.completion",
						created: 0,
						model: requestedModel(init),
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: null,
									reasoning_content: "thinking it over",
								},
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
			}
			return okCompletion(requestedModel(init), "ok");
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
		const body = (await result.response.json()) as {
			choices: { message: { content: string } }[];
		};
		expect(body.choices[0].message.content).toBe("ok");
		expect(calls).toBe(2);
		const cooldowns = await db
			.prepare("SELECT * FROM provider_rate_limit_cooldowns")
			.all();
		expect(cooldowns.results).toHaveLength(0);
	} finally {
		db.close();
	}
});

test("native empty completion with length fails over to the next key", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-native-empty-1");
		await seedKey(db, "groq", "sk-test-native-empty-2");
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			if (calls === 1) {
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
								finish_reason: "length",
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
			}
			return okCompletion(requestedModel(init), "ok");
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
			},
			native: {
				body: {
					model: "groq/model-a",
					messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
					max_tokens: 1024,
				},
				headers: new Headers(),
				operation: "messages",
				translated: {
					model: "groq/model-a",
					messages: [{ role: "user", content: "hi" }],
				},
				inputCharacters: 2,
				bound: false,
			},
		});
		expect(result.response.status).toBe(200);
		expect(calls).toBe(2);
		const body = (await result.response.json()) as {
			content: { type: string; text?: string; citations?: unknown }[];
			stop_reason: string;
		};
		expect(body.stop_reason).toBe("end_turn");
		expect(body.content).toEqual([
			{ type: "text", text: "ok", citations: null },
		]);
		const cooldowns = await db
			.prepare("SELECT * FROM provider_rate_limit_cooldowns")
			.all();
		expect(cooldowns.results).toHaveLength(0);
	} finally {
		db.close();
	}
});

test("reply with only tool calls stays a success", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-tool-1");
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			return new Response(
				JSON.stringify({
					id: "tools",
					object: "chat.completion",
					created: 0,
					model: requestedModel(init),
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "call_1",
										type: "function",
										function: {
											name: "get_weather",
											arguments: '{"city":"Paris"}',
										},
									},
								],
							},
							finish_reason: "tool_calls",
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
		expect(result.response.status).toBe(200);
		expect(calls).toBe(1);
		const body = (await result.response.json()) as {
			choices: { message: { tool_calls: { function: { name: string } }[] } }[];
		};
		expect(body.choices[0].message.tool_calls).toHaveLength(1);
		expect(body.choices[0].message.tool_calls[0].function.name).toBe(
			"get_weather",
		);
	} finally {
		db.close();
	}
});

test("empty completion with stop stays a success", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-stop-1");
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			return new Response(
				JSON.stringify({
					id: "empty-stop",
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
		expect(calls).toBe(1);
		const requests = await db
			.prepare("SELECT status FROM provider_requests")
			.all<{ status: string }>();
		expect(requests.results).toEqual([{ status: "success" }]);
	} finally {
		db.close();
	}
});

// Fix C: three consecutive auth failures disable the key.
test("key with three consecutive 401s is disabled and leaves the pool", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		for (const [modelId, rank] of [
			["model-c1", 1],
			["model-c2", 2],
			["model-c3", 3],
			["model-c4", 4],
		] as const) {
			await seedModel(db, "groq", modelId, rank);
		}
		const keyId = await seedKey(db, "groq", "sk-test-dead-1");
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			if (requestedModel(init) === "model-c4")
				return okCompletion("model-c4", "ok");
			return new Response("unauthorized", { status: 401 });
		};
		const errors: unknown[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args[0]);
		};
		try {
			for (const modelId of ["model-c1", "model-c2", "model-c3"]) {
				const result = await routeChatCompletion({
					db,
					secret: SECRET,
					user: USER,
					request: {
						model: `groq/${modelId}`,
						messages: [{ role: "user", content: "hi" }],
					},
				});
				expect(result.response.status).toBe(502);
			}
			expect(calls).toBe(3);
			expect(await keyEnabled(db, keyId)).toBe(false);
			// A fourth model the key never failed on is still not
			// served: the key is out of the pool, not just quarantined
			// for the three failed models.
			const fourth = await routeChatCompletion({
				db,
				secret: SECRET,
				user: USER,
				request: {
					model: "groq/model-c4",
					messages: [{ role: "user", content: "hi" }],
				},
			});
			expect(fourth.response.status).toBe(502);
			expect(calls).toBe(3);
		} finally {
			console.error = originalError;
		}
		const disabled = errors
			.map((entry) => {
				try {
					return JSON.parse(String(entry)) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter((entry) => entry?.event === "key_auto_disabled");
		expect(disabled).toHaveLength(1);
		expect(disabled[0]).toMatchObject({ platform: "groq", keyId });
	} finally {
		db.close();
	}
});

test("key with three 404s is not disabled", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		for (const [modelId, rank] of [
			["model-c1", 1],
			["model-c2", 2],
			["model-c3", 3],
			["model-c4", 4],
		] as const) {
			await seedModel(db, "groq", modelId, rank);
		}
		const keyId = await seedKey(db, "groq", "sk-test-404-1");
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			if (requestedModel(init) === "model-c4")
				return okCompletion("model-c4", "ok");
			return new Response("not found", { status: 404 });
		};
		for (const modelId of ["model-c1", "model-c2", "model-c3"]) {
			const result = await routeChatCompletion({
				db,
				secret: SECRET,
				user: USER,
				request: {
					model: `groq/${modelId}`,
					messages: [{ role: "user", content: "hi" }],
				},
			});
			expect(result.response.status).toBe(502);
		}
		expect(calls).toBe(3);
		expect(await keyEnabled(db, keyId)).toBe(true);
		const fourth = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-c4",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(fourth.response.status).toBe(200);
		expect(calls).toBe(4);
	} finally {
		db.close();
	}
});

test("key with three 500s is not disabled", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		for (const [modelId, rank] of [
			["model-c1", 1],
			["model-c2", 2],
			["model-c3", 3],
			["model-c4", 4],
		] as const) {
			await seedModel(db, "groq", modelId, rank);
		}
		const keyId = await seedKey(db, "groq", "sk-test-500-1");
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			if (requestedModel(init) === "model-c4")
				return okCompletion("model-c4", "ok");
			return new Response("boom", { status: 500 });
		};
		for (const modelId of ["model-c1", "model-c2", "model-c3"]) {
			const result = await routeChatCompletion({
				db,
				secret: SECRET,
				user: USER,
				request: {
					model: `groq/${modelId}`,
					messages: [{ role: "user", content: "hi" }],
				},
			});
			expect(result.response.status).toBe(502);
		}
		expect(calls).toBe(3);
		expect(await keyEnabled(db, keyId)).toBe(true);
		const fourth = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-c4",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(fourth.response.status).toBe(200);
		expect(calls).toBe(4);
	} finally {
		db.close();
	}
});

// Fix D: an echoed model that differs from the requested one is logged
// as a mismatch, not as a generic 502.
test("upstream 200 with a different echoed model logs model_mismatch", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-mismatch-1");
		fetchImpl = async () => okCompletion("different-model", "ok");
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
		expect(result.attempts).toBe(1);
		expect(result.attemptLog).toHaveLength(1);
		expect(result.attemptLog?.[0]).toMatchObject({
			platform: "groq",
			modelId: "model-a",
			status: 502,
			kind: "model_mismatch",
			phase: "member",
		});
		const row = await db
			.prepare(
				"SELECT status_code, error_message, failure_attribution FROM provider_requests",
			)
			.first<{
				status_code: number;
				error_message: string;
				failure_attribution: string;
			}>();
		expect(row).toEqual({
			status_code: 502,
			error_message: "Upstream returned an unexpected model",
			failure_attribution: "model_mismatch",
		});
	} finally {
		db.close();
	}
});
