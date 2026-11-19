import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	createApiKey,
	maybeDisableKeyAfterAuthFailures,
} from "../src/lib/key-store";
import { markModelSuspect } from "../src/lib/model-suspect";
import { reportFailure } from "../src/lib/quarantine";
import { routeChatCompletion } from "../src/lib/router";
import type { AppUser, D1Database } from "../src/lib/types";
import { MemoryD1 } from "./utils/d1-shim";
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
	limits?: { rpmLimit?: number },
): Promise<number> {
	// Gateway-default limits unless the caller overrides one: without
	// stored limits the provider catalog limit would apply (groq tpm
	// 6000) and a request without max_tokens reserves the 8192-token
	// default output, so the router would throttle the key.
	const key = await createApiKey(
		db,
		{
			userId: USER.id,
			platform,
			keyLabel: "test",
			rawKey,
			rpmLimit: 60,
			tpmLimit: 200_000,
			rpdLimit: 5_000,
			tpdLimit: 5_000_000,
			...limits,
		},
		SECRET,
	);
	return key.id;
}

/**
 * The suspect columns come from migration 0019 (parallel batch). The
 * tests must not depend on that file existing: add the columns here
 * when they are missing.
 */
async function ensureSuspectColumns(db: D1Database): Promise<void> {
	const columns = await db
		.prepare("PRAGMA table_info(models)")
		.all<{ name: string }>();
	const names = new Set(columns.results.map((column) => column.name));
	if (!names.has("suspect_reason"))
		await db.prepare("ALTER TABLE models ADD COLUMN suspect_reason TEXT").run();
	if (!names.has("suspect_since"))
		await db
			.prepare("ALTER TABLE models ADD COLUMN suspect_since INTEGER")
			.run();
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

async function routeExhaustedEvents(db: D1Database): Promise<
	{
		model: string;
		attempts: number;
		skipped_json: string;
		kinds_json: string;
		attempt_log_json: string;
	}[]
> {
	const rows = await db
		.prepare(
			"SELECT model, attempts, skipped_json, kinds_json, attempt_log_json FROM route_exhausted_events ORDER BY id",
		)
		.all<{
			model: string;
			attempts: number;
			skipped_json: string;
			kinds_json: string;
			attempt_log_json: string;
		}>();
	return rows.results;
}

async function cooldowns(
	db: D1Database,
): Promise<{ failure_count: number; cooldown_until_ms: number }[]> {
	const rows = await db
		.prepare(
			"SELECT failure_count, cooldown_until_ms FROM provider_rate_limit_cooldowns",
		)
		.all<{ failure_count: number; cooldown_until_ms: number }>();
	return rows.results;
}

async function keyHealth(
	db: D1Database,
	keyId: number,
): Promise<string | null> {
	const row = await db
		.prepare("SELECT last_health_check_status FROM api_keys WHERE id = ?")
		.bind(keyId)
		.first<{ last_health_check_status: string | null }>();
	return row?.last_health_check_status ?? null;
}

// R6: until migration 0019 lands, flagging a suspect model is a no-op
// instead of failing the request.
test("markModelSuspect without the suspect columns does not throw", async () => {
	const db = new MemoryD1();
	try {
		db.exec(
			"CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, model_id TEXT NOT NULL)",
		);
		await db
			.prepare("INSERT INTO models (platform, model_id) VALUES (?, ?)")
			.bind("groq", "model-a")
			.run();
		await expect(
			markModelSuspect(db, "groq", "model-a", "bad_request"),
		).resolves.toBeUndefined();
	} finally {
		db.close();
	}
});

// R1: the router's own 120 s timer abort is a timeout, not a network error.
// The timer aborts the fetch with this exact reason, so throwing it from
// the mocked fetch exercises the same catch path without waiting 120 s.
test("timer abort is logged as kind timeout with a non-null status", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		const keyId = await seedKey(db, "groq", "sk-test-timeout-1");
		fetchImpl = async () => {
			throw new DOMException("Upstream timed out", "TimeoutError");
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
		expect(result.response.status).toBe(502);
		expect(result.attemptLog).toHaveLength(1);
		expect(result.attemptLog?.[0]).toMatchObject({
			platform: "groq",
			modelId: "model-a",
			keyId,
			status: 504,
			kind: "timeout",
		});
		const requests = await db
			.prepare("SELECT status, status_code FROM provider_requests")
			.all<{ status: string; status_code: number | null }>();
		expect(requests.results).toEqual([{ status: "timeout", status_code: 504 }]);
		const events = await routeExhaustedEvents(db);
		expect(events).toHaveLength(1);
		expect(JSON.parse(events[0].kinds_json)).toEqual(["timeout"]);
	} finally {
		db.close();
	}
});

// R11: a second 429 with Retry-After on the same key+model must cool the
// key down for real. The old MIN compared a timestamp with the 1-day
// duration and returned 86_400_000 (02/01/1970).
test("second 429 with Retry-After cools down past now", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		const keyId = await seedKey(db, "groq", "sk-test-retry-1");
		for (let i = 0; i < 2; i++) {
			await reportFailure(db, {
				platform: "groq",
				modelId: "model-a",
				keyId,
				source: "rate_limit",
				reason: "Upstream 429",
				retryAfterMs: 90_000,
			});
		}
		const rows = await cooldowns(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].failure_count).toBe(2);
		expect(rows[0].cooldown_until_ms).toBeGreaterThan(Date.now());
	} finally {
		db.close();
	}
});

// R6: a 404 is a dead catalog row, not a dead key.
test("404 does not quarantine the key and flags the model row suspect", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await ensureSuspectColumns(db);
		await seedModel(db, "groq", "model-a");
		const keyId = await seedKey(db, "groq", "sk-test-404-1");
		fetchImpl = async () => new Response("not found", { status: 404 });
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
		expect(result.attemptLog?.[0]).toMatchObject({ kind: "bad_request" });
		expect(await cooldowns(db)).toHaveLength(0);
		expect(await keyHealth(db, keyId)).toBeNull();
		const model = await db
			.prepare(
				"SELECT suspect_reason, suspect_since FROM models WHERE platform = ? AND model_id = ?",
			)
			.bind("groq", "model-a")
			.first<{ suspect_reason: string | null; suspect_since: number | null }>();
		expect(model?.suspect_reason).toBe("bad_request");
		expect(model?.suspect_since).toBeGreaterThan(0);
	} finally {
		db.close();
	}
});

// R6: a model mismatch is a catalog problem, not a key problem.
test("model mismatch does not quarantine the key and flags the model row suspect", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await ensureSuspectColumns(db);
		await seedModel(db, "groq", "model-a");
		const keyId = await seedKey(db, "groq", "sk-test-mismatch-1");
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
		expect(result.attemptLog?.[0]).toMatchObject({ kind: "model_mismatch" });
		expect(await cooldowns(db)).toHaveLength(0);
		expect(await keyHealth(db, keyId)).toBeNull();
		const model = await db
			.prepare(
				"SELECT suspect_reason FROM models WHERE platform = ? AND model_id = ?",
			)
			.bind("groq", "model-a")
			.first<{ suspect_reason: string | null }>();
		expect(model?.suspect_reason).toBe("model_mismatch");
	} finally {
		db.close();
	}
});

// R6: a plain 403 takes the normal ladder from 90 s, not a full day.
test("plain 403 cools down for 90 seconds, not a day", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-403-1");
		fetchImpl = async () => new Response("forbidden", { status: 403 });
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
		expect(result.attemptLog?.[0]).toMatchObject({ kind: "forbidden" });
		const rows = await cooldowns(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].failure_count).toBe(1);
		expect(rows[0].cooldown_until_ms).toBeGreaterThan(Date.now());
		expect(rows[0].cooldown_until_ms).toBeLessThan(Date.now() + 3_600_000);
	} finally {
		db.close();
	}
});

// R6: a 403 that names a tier/billing problem keeps the 24 h cooldown.
test("403 naming a tier problem cools down for a day", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-403-tier-1");
		fetchImpl = async () =>
			new Response(
				JSON.stringify({
					error: { message: "Your account tier does not include this model" },
				}),
				{ status: 403 },
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
		expect(result.response.status).toBe(502);
		const rows = await cooldowns(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].cooldown_until_ms).toBeGreaterThan(
			Date.now() + 23 * 3_600_000,
		);
	} finally {
		db.close();
	}
});

// R3: a gateway rate limit on one key must not mask real 500s on another.
test("partial gateway throttling with real 500s returns 502, not 429", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		// rpm 0: the gateway limiter never lets this key through.
		await seedKey(db, "groq", "sk-test-throttled-1", { rpmLimit: 0 });
		await seedKey(db, "groq", "sk-test-throttled-2");
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
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(result.response.status).toBe(502);
		expect(result.attempts).toBe(1);
		expect(calls).toBe(1);
		const events = await routeExhaustedEvents(db);
		expect(events).toHaveLength(1);
		expect(JSON.parse(events[0].skipped_json)).toEqual({
			noKey: 0,
			quarantined: 0,
			rateLimited: 1,
			suspended: 0,
		});
	} finally {
		db.close();
	}
});

// R14: every real attempt failing on the upstream rate limit is a 429
// with the longest Retry-After seen.
test("all attempts rate limited returns 429 with the longest Retry-After", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-rl-1");
		await seedKey(db, "groq", "sk-test-rl-2");
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			return new Response(JSON.stringify({ error: { message: "slow down" } }), {
				status: 429,
				headers: { "Retry-After": calls === 1 ? "60" : "120" },
			});
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
		expect(result.response.status).toBe(429);
		expect(result.response.headers.get("Retry-After")).toBe("120");
		const body = (await result.response.json()) as {
			error: { type: string; code: string };
		};
		expect(body.error).toMatchObject({
			type: "rate_limit_error",
			code: "rate_limited",
		});
		expect(result.attempts).toBe(2);
		expect(calls).toBe(2);
		const events = await routeExhaustedEvents(db);
		expect(events).toHaveLength(1);
		expect(JSON.parse(events[0].kinds_json)).toEqual(["rate_limit"]);
	} finally {
		db.close();
	}
});

// R20: a client abort on the OpenAI path answers 499 in the OpenAI
// envelope, not the Anthropic one.
test("client abort on the OpenAI path returns 499 in the OpenAI envelope", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-abort-1");
		fetchImpl = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject((init.signal as AbortSignal).reason);
				});
			});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
			},
			signal: controller.signal,
		});
		expect(result.response.status).toBe(499);
		const body = (await result.response.json()) as unknown;
		expect(body).toEqual({
			error: {
				message: "Request cancelled",
				type: "request_cancelled",
				code: "request_cancelled",
			},
		});
		const requests = await db
			.prepare("SELECT status, status_code FROM provider_requests")
			.all<{ status: string; status_code: number | null }>();
		expect(requests.results).toEqual([{ status: "error", status_code: 499 }]);
	} finally {
		db.close();
	}
});

// R20: 499s neither count toward nor break the Fix C window: three 401s
// with a 499 between them still disable the key.
test("499 rows are ignored by the auth-failure disable check", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		const keyId = await seedKey(db, "groq", "sk-test-499-1");
		const otherKeyId = await seedKey(db, "groq", "sk-test-499-2");
		for (const [id, statusCode] of [
			[keyId, 401],
			[keyId, 401],
			[keyId, 499],
			[keyId, 401],
		] as const) {
			await db
				.prepare(
					"INSERT INTO provider_requests (user_id, model_requested, model_routed, platform, key_id, status, status_code) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(USER.id, "model-a", "model-a", "groq", id, "error", statusCode)
				.run();
		}
		expect(await maybeDisableKeyAfterAuthFailures(db, "groq", keyId)).toBe(
			true,
		);
		const row = await db
			.prepare("SELECT enabled FROM api_keys WHERE id = ?")
			.bind(keyId)
			.first<{ enabled: number }>();
		expect(row?.enabled).toBe(0);
		// Control: two 401s split by a 499 are not three in a row.
		for (const statusCode of [401, 499, 401]) {
			await db
				.prepare(
					"INSERT INTO provider_requests (user_id, model_requested, model_routed, platform, key_id, status, status_code) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					USER.id,
					"model-a",
					"model-a",
					"groq",
					otherKeyId,
					"error",
					statusCode,
				)
				.run();
		}
		expect(await maybeDisableKeyAfterAuthFailures(db, "groq", otherKeyId)).toBe(
			false,
		);
	} finally {
		db.close();
	}
});

// R21: a 200 with an invalid JSON body is a server failure, not a
// success. Together has no model_identity, so sendChat passes the body
// through and the router is the one that has to catch it.
test("200 with invalid JSON fails over to the next key", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "together", "model-t");
		await seedKey(db, "together", "sk-test-badjson-1");
		await seedKey(db, "together", "sk-test-badjson-2");
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			if (calls === 1)
				return new Response("this is not json{{{", { status: 200 });
			return okCompletion(requestedModel(init), "ok");
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "together/model-t",
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
				"SELECT status, status_code, error_message FROM provider_requests ORDER BY id",
			)
			.all<{
				status: string;
				status_code: number | null;
				error_message: string | null;
			}>();
		expect(requests.results).toHaveLength(2);
		expect(requests.results[0]).toMatchObject({
			status: "error",
			status_code: 502,
			// Generic message by design: handleFailure never leaks the
			// upstream body, so an invalid body is recorded as Upstream 502.
			error_message: "Upstream 502",
		});
		expect(requests.results[1].status).toBe("success");
	} finally {
		db.close();
	}
});

// R21: a 200 with valid JSON but no choices is the same failure.
test("200 with valid JSON but no choices fails over to the next key", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "together", "model-t");
		await seedKey(db, "together", "sk-test-nochoices-1");
		await seedKey(db, "together", "sk-test-nochoices-2");
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
			if (calls === 1)
				return new Response(
					JSON.stringify({
						id: "nochoices",
						object: "chat.completion",
						created: 0,
						model: requestedModel(init),
						choices: [],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 0,
							total_tokens: 10,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			return okCompletion(requestedModel(init), "ok");
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "together/model-t",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(result.response.status).toBe(200);
		expect(result.attempts).toBe(2);
		expect(calls).toBe(2);
		const requests = await db
			.prepare("SELECT status, status_code FROM provider_requests ORDER BY id")
			.all<{ status: string; status_code: number | null }>();
		expect(requests.results).toEqual([
			{ status: "error", status_code: 502 },
			{ status: "success", status_code: 200 },
		]);
	} finally {
		db.close();
	}
});

// R13: the attempt log carries the key id, and the exhaustion aggregate
// is persisted in D1.
test("attempt log carries keyId and the exhaustion is persisted", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		const keyId = await seedKey(db, "groq", "sk-test-keyid-1");
		fetchImpl = async () => new Response("boom", { status: 500 });
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
		expect(result.attemptLog?.[0]).toMatchObject({
			platform: "groq",
			modelId: "model-a",
			keyId,
			status: 500,
			kind: "server",
		});
		const events = await routeExhaustedEvents(db);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ model: "groq/model-a", attempts: 1 });
		expect(JSON.parse(events[0].skipped_json)).toEqual({
			noKey: 0,
			quarantined: 0,
			rateLimited: 0,
			suspended: 0,
		});
		expect(JSON.parse(events[0].kinds_json)).toEqual(["server"]);
		const logged = JSON.parse(events[0].attempt_log_json) as {
			keyId: number;
			kind: string;
		}[];
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({ keyId, kind: "server" });
	} finally {
		db.close();
	}
});

// R13: a model row with no enabled key is a counted skip, not a silent gap.
test("model with no key is persisted as a no-key skip", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		fetchImpl = async () => {
			throw new Error("must not be called");
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
		expect(result.response.status).toBe(502);
		expect(result.attempts).toBe(0);
		expect(result.attemptLog).toHaveLength(0);
		const events = await routeExhaustedEvents(db);
		expect(events).toHaveLength(1);
		expect(events[0].attempts).toBe(0);
		expect(JSON.parse(events[0].skipped_json)).toEqual({
			noKey: 1,
			quarantined: 0,
			rateLimited: 0,
			suspended: 0,
		});
		expect(JSON.parse(events[0].kinds_json)).toEqual([]);
	} finally {
		db.close();
	}
});

// R13: quarantined keys are skipped and counted on the next request.
test("quarantined keys are counted as skips on the next request", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		await seedKey(db, "groq", "sk-test-quar-1");
		await seedKey(db, "groq", "sk-test-quar-2");
		fetchImpl = async () => new Response("boom", { status: 500 });
		const first = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(first.response.status).toBe(502);
		expect(first.attempts).toBe(2);
		expect(await cooldowns(db)).toHaveLength(2);
		const second = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-a",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(second.response.status).toBe(502);
		expect(second.attempts).toBe(0);
		const events = await routeExhaustedEvents(db);
		expect(events).toHaveLength(2);
		expect(JSON.parse(events[1].skipped_json)).toEqual({
			noKey: 0,
			quarantined: 2,
			rateLimited: 0,
			suspended: 0,
		});
	} finally {
		db.close();
	}
});
