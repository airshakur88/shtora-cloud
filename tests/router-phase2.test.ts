import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runKeyProbe } from "../src/lib/jobs/key-probe";
import {
	CONSECUTIVE_FAILURES_TO_SUSPEND,
	createApiKey,
	KEY_SUSPENSION_MS,
	maybeSuspendKeyAfterFailures,
} from "../src/lib/key-store";
import { COOLDOWN_LADDER_MS, reportFailure } from "../src/lib/quarantine";
import { routeChatCompletion } from "../src/lib/router";
import type { AppUser, D1Database } from "../src/lib/types";
import { buildModelList } from "../src/lib/v1-http";
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
const DAY_MS = 24 * 60 * 60 * 1000;

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
	options?: { modality?: string; suspectReason?: string | null; rank?: number },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO models
			 (platform, model_id, name, context_window, intelligence_rank, tier, modality, suspect_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			platform,
			modelId,
			modelId,
			32768,
			options?.rank ?? 1,
			1,
			options?.modality ?? "chat",
			options?.suspectReason ?? null,
		)
		.run();
}

async function seedKey(
	db: D1Database,
	platform: string,
	rawKey: string,
): Promise<number> {
	// Explicit gateway-default limits: without stored limits the
	// provider catalog limit would apply (groq tpm 6000), and a
	// request without max_tokens reserves the 8192-token default
	// output, so the router would throttle the key before trying it.
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
		},
		SECRET,
	);
	return key.id;
}

async function seedAttempt(
	db: D1Database,
	keyId: number,
	platform: string,
	status: string,
	statusCode: number | null,
	options?: {
		failureAttribution?: string | null;
		errorMessage?: string | null;
		createdAt?: string;
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO provider_requests
			 (user_id, model_requested, model_routed, platform, key_id, status,
			  status_code, failure_attribution, error_message, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			USER.id,
			"model-x",
			"model-x",
			platform,
			keyId,
			status,
			statusCode,
			options?.failureAttribution ?? null,
			options?.errorMessage ?? null,
			options?.createdAt ??
				new Date().toISOString().replace("T", " ").slice(0, 19),
		)
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

async function keySuspension(
	db: D1Database,
	keyId: number,
): Promise<{
	suspended_until_ms: number | null;
	suspension_reason: string | null;
	enabled: number;
}> {
	const row = await db
		.prepare(
			"SELECT suspended_until_ms, suspension_reason, enabled FROM api_keys WHERE id = ?",
		)
		.bind(keyId)
		.first<{
			suspended_until_ms: number | null;
			suspension_reason: string | null;
			enabled: number;
		}>();
	if (!row) throw new Error(`key ${keyId} missing`);
	return row;
}

async function lastRouteExhaustedSkipped(
	db: D1Database,
): Promise<Record<string, number>> {
	const row = await db
		.prepare(
			"SELECT skipped_json FROM route_exhausted_events ORDER BY id DESC LIMIT 1",
		)
		.first<{ skipped_json: string }>();
	return JSON.parse(row?.skipped_json ?? "{}") as Record<string, number>;
}

function captureConsoleError(): { errors: unknown[]; restore: () => void } {
	const errors: unknown[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args[0]);
	};
	return {
		errors,
		restore: () => {
			console.error = originalError;
		},
	};
}

function loggedEvents(
	errors: unknown[],
	event: string,
): Record<string, unknown>[] {
	return errors
		.map((entry) => {
			try {
				return JSON.parse(String(entry)) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter(
			(entry): entry is Record<string, unknown> =>
				entry !== null && entry.event === event,
		);
}

/** Parity DB without migration 0019 (no modality/suspect/suspension columns). */
async function createPre0019Database(): Promise<MemoryD1> {
	const db = new MemoryD1();
	for (const migration of [
		"0001_initial_schema.sql",
		"0002_backend_parity.sql",
		"0003_usage_metrics.sql",
		"0004_usage_metrics_backfill.sql",
		"0005_anthropic_catalog.sql",
		"0006_fix_model_names.sql",
		"0007_playground_sessions.sql",
		"0008_user_access_keys.sql",
		"0009_remove_aclide.sql",
		"0010_providers.sql",
		"0011_clean_model_names_a.sql",
		"0012_clean_model_names_b.sql",
		"0013_clean_model_names_c.sql",
		"0014_clean_model_names_d.sql",
		"0015_anthropic_provider.sql",
		"0016_playground_image_ownership.sql",
		"0017_remove_unified_token.sql",
		"0018_route_exhausted_events.sql",
	]) {
		db.exec(
			readFileSync(resolve(process.cwd(), `migrations/${migration}`), "utf8"),
		);
	}
	return db;
}

// F.1.6 (R8): an image model asked for in /chat/completions is a 404.
test("image model requested in chat completions returns 404, not 502", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "cloudflare", "flux-test", { modality: "image" });
		await seedKey(db, "cloudflare", "sk-test-image-1");
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			throw new Error("must not be called");
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "cloudflare/flux-test",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(result.response.status).toBe(404);
		const body = (await result.response.json()) as {
			error: { message: string };
		};
		expect(body.error.message).toBe("Model does not support chat completions");
		expect(calls).toBe(0);
		expect(result.attempts).toBe(0);
	} finally {
		db.close();
	}
});

test("audio model requested in chat completions returns 404", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "google", "tts-test", { modality: "audio" });
		await seedKey(db, "google", "sk-test-audio-1");
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			throw new Error("must not be called");
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "google/tts-test",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(result.response.status).toBe(404);
		const body = (await result.response.json()) as {
			error: { message: string };
		};
		expect(body.error.message).toBe("Model does not support chat completions");
		expect(calls).toBe(0);
	} finally {
		db.close();
	}
});

test("native request for an image model returns 404", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "cloudflare", "flux-test", { modality: "image" });
		await seedKey(db, "cloudflare", "sk-test-image-1");
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			throw new Error("must not be called");
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "cloudflare/flux-test",
				messages: [{ role: "user", content: "hi" }],
			},
			native: {
				body: {
					model: "cloudflare/flux-test",
					messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
					max_tokens: 1024,
				},
				headers: new Headers(),
				operation: "messages",
				translated: {
					model: "cloudflare/flux-test",
					messages: [{ role: "user", content: "hi" }],
				},
				inputCharacters: 2,
				bound: false,
			},
		});
		expect(result.response.status).toBe(404);
		const body = (await result.response.json()) as {
			error: { message: string };
		};
		expect(body.error.message).toBe("Model does not support chat completions");
		expect(calls).toBe(0);
	} finally {
		db.close();
	}
});

// F.1.6 (R8): non-chat rows are out of the public model listing.
test("image, audio and suspect models are excluded from /v1/models", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "chat-model");
		await seedModel(db, "groq", "image-model", { modality: "image" });
		await seedModel(db, "groq", "audio-model", { modality: "audio" });
		await seedModel(db, "groq", "suspect-model", {
			suspectReason: "bad_request",
		});
		await seedKey(db, "groq", "sk-test-list-1");
		const entries = await buildModelList(db);
		const ids = entries.map((entry) => entry.id);
		expect(ids).toContain("shtora/chat-model");
		expect(ids).not.toContain("shtora/image-model");
		expect(ids).not.toContain("shtora/audio-model");
		expect(ids).not.toContain("shtora/suspect-model");
	} finally {
		db.close();
	}
});

// Suspect rows are out of the chain: a direct request is a 404 with no attempt.
test("direct request for a suspect model returns 404 and makes no upstream call", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a", { suspectReason: "bad_request" });
		await seedKey(db, "groq", "sk-test-suspect-1");
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
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
		expect(result.response.status).toBe(404);
		const body = (await result.response.json()) as {
			error: { message: string };
		};
		expect(body.error.message).toBe("Unknown or disabled model");
		expect(calls).toBe(0);
		expect(result.attempts).toBe(0);
	} finally {
		db.close();
	}
});

// Suspect members drop out of virtual routers; the healthy member serves.
test("suspect member of a virtual router is skipped, the healthy member serves", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "qwen3-8-flash", {
			suspectReason: "model_mismatch",
			rank: 1,
		});
		await seedModel(db, "groq", "glm-5-3-flash", { rank: 2 });
		await seedKey(db, "groq", "sk-test-router-1");
		fetchImpl = async (_input, init) =>
			okCompletion(requestedModel(init), "ok");
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "shtora/fast",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(result.response.status).toBe(200);
		expect(result.attempts).toBe(1);
		const requests = await db
			.prepare("SELECT model_routed FROM provider_requests")
			.all<{ model_routed: string }>();
		expect(requests.results).toEqual([{ model_routed: "glm-5-3-flash" }]);
	} finally {
		db.close();
	}
});

// Non-chat members drop out of virtual routers the same way.
test("non-chat member of a virtual router is skipped", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "qwen3-8-flash", {
			modality: "image",
			rank: 1,
		});
		await seedModel(db, "groq", "glm-5-3-flash", { rank: 2 });
		await seedKey(db, "groq", "sk-test-router-2");
		fetchImpl = async (_input, init) =>
			okCompletion(requestedModel(init), "ok");
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "shtora/fast",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(result.response.status).toBe(200);
		const requests = await db
			.prepare("SELECT model_routed FROM provider_requests")
			.all<{ model_routed: string }>();
		expect(requests.results).toEqual([{ model_routed: "glm-5-3-flash" }]);
	} finally {
		db.close();
	}
});

// Tolerant fallback: without the 0019 columns every row reads as chat.
test("database without the modality columns treats every row as chat", async () => {
	const db = await createPre0019Database();
	try {
		await seedUser(db);
		await db
			.prepare(
				"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind("groq", "model-a", "model-a", 32768, 1, 1)
			.run();
		await seedKey(db, "groq", "sk-test-old-db-1");
		const entries = await buildModelList(db);
		expect(entries.map((entry) => entry.id)).toContain("shtora/model-a");
		fetchImpl = async (_input, init) =>
			okCompletion(requestedModel(init), "ok");
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
	} finally {
		db.close();
	}
});

// F.1.10 (R7): five consecutive 500s suspend the key for 24 h.
test("five consecutive 500s suspend the key for 24h", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		for (let i = 1; i <= 5; i++)
			await seedModel(db, "groq", `model-s${i}`, { rank: i });
		const keyId = await seedKey(db, "groq", "sk-test-suspend-1");
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
			return new Response("boom", { status: 500 });
		};
		const before = Date.now();
		for (let i = 1; i <= 5; i++) {
			const result = await routeChatCompletion({
				db,
				secret: SECRET,
				user: USER,
				request: {
					model: `groq/model-s${i}`,
					messages: [{ role: "user", content: "hi" }],
				},
			});
			expect(result.response.status).toBe(502);
		}
		expect(calls).toBe(5);
		const row = await keySuspension(db, keyId);
		expect(row.enabled).toBe(1);
		expect(row.suspension_reason).toBe("consecutive_failures");
		expect(row.suspended_until_ms).not.toBeNull();
		expect(row.suspended_until_ms as number).toBeGreaterThanOrEqual(
			before + KEY_SUSPENSION_MS,
		);
		expect(row.suspended_until_ms as number).toBeLessThanOrEqual(
			Date.now() + KEY_SUSPENSION_MS,
		);
		// A sixth model is not attempted: the key is out of the pool.
		await seedModel(db, "groq", "model-s6", { rank: 6 });
		const sixth = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "groq/model-s6",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(sixth.response.status).toBe(502);
		expect(sixth.attempts).toBe(0);
		expect(calls).toBe(5);
		expect(await lastRouteExhaustedSkipped(db)).toEqual({
			noKey: 0,
			quarantined: 0,
			rateLimited: 0,
			suspended: 1,
		});
	} finally {
		db.close();
	}
});

// F.1.10 (R7): a successful probe re-enables an expired suspension.
test("probe success re-enables an expired suspension", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		for (let i = 1; i <= 5; i++)
			await seedModel(db, "groq", `model-p${i}`, { rank: i });
		const keyId = await seedKey(db, "groq", "sk-test-reenable-1");
		fetchImpl = async () => new Response("boom", { status: 500 });
		for (let i = 1; i <= 5; i++) {
			await routeChatCompletion({
				db,
				secret: SECRET,
				user: USER,
				request: {
					model: `groq/model-p${i}`,
					messages: [{ role: "user", content: "hi" }],
				},
			});
		}
		expect((await keySuspension(db, keyId)).suspended_until_ms).not.toBeNull();
		// Expire the suspension: the probe only re-enables expired ones.
		const now = Date.now();
		await db
			.prepare("UPDATE api_keys SET suspended_until_ms = ? WHERE id = ?")
			.bind(now - 1000, keyId)
			.run();
		fetchImpl = async () =>
			new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
				status: 200,
			});
		const summary = await runKeyProbe(db, {
			now,
			encryptionSecret: SECRET,
		});
		expect(summary).toMatchObject({ healthy: 1, reenabled: 1 });
		const row = await keySuspension(db, keyId);
		expect(row.suspended_until_ms).toBeNull();
		expect(row.suspension_reason).toBeNull();
	} finally {
		db.close();
	}
});

// A suspended key is skipped without an attempt and counted (R13 tally).
test("actively suspended key is skipped without an attempt and counted", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		const keyId = await seedKey(db, "groq", "sk-test-skip-1");
		await db
			.prepare(
				"UPDATE api_keys SET suspended_until_ms = ?, suspension_reason = ? WHERE id = ?",
			)
			.bind(Date.now() + DAY_MS, "consecutive_failures", keyId)
			.run();
		let calls = 0;
		fetchImpl = async () => {
			calls += 1;
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
		expect(calls).toBe(0);
		expect(await lastRouteExhaustedSkipped(db)).toEqual({
			noKey: 0,
			quarantined: 0,
			rateLimited: 0,
			suspended: 1,
		});
	} finally {
		db.close();
	}
});

test("expired suspension lets the key serve again", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		const keyId = await seedKey(db, "groq", "sk-test-expired-1");
		await db
			.prepare(
				"UPDATE api_keys SET suspended_until_ms = ?, suspension_reason = ? WHERE id = ?",
			)
			.bind(Date.now() - 1000, "consecutive_failures", keyId)
			.run();
		let calls = 0;
		fetchImpl = async (_input, init) => {
			calls += 1;
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
		expect(calls).toBe(1);
	} finally {
		db.close();
	}
});

// R15: the ladder is the documented seven rungs, 90 s to 24 h.
test("COOLDOWN_LADDER_MS matches the documented seven-rung ladder", () => {
	expect(COOLDOWN_LADDER_MS).toEqual([
		90_000, 300_000, 600_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000,
	]);
	expect(CONSECUTIVE_FAILURES_TO_SUSPEND).toBe(5);
	expect(KEY_SUSPENSION_MS).toBe(DAY_MS);
});

// R15: a stale failure count decays — the next failure restarts at 90 s.
test("failure_count decays when the last failure is more than 24h old", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		const keyId = await seedKey(db, "groq", "sk-test-decay-1");
		const stale = Date.now() - 25 * 60 * 60 * 1000;
		await db
			.prepare(
				`INSERT INTO provider_rate_limit_cooldowns
				 (platform, model_id, key_id, failure_count, cooldown_until_ms, reason, source)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind("groq", "model-a", keyId, 6, stale, "old", "server_error")
			.run();
		const before = Date.now();
		await reportFailure(db, {
			platform: "groq",
			modelId: "model-a",
			keyId,
			source: "server_error",
			reason: "Upstream 500",
		});
		const row = await db
			.prepare(
				"SELECT failure_count, cooldown_until_ms FROM provider_rate_limit_cooldowns WHERE key_id = ?",
			)
			.bind(keyId)
			.first<{ failure_count: number; cooldown_until_ms: number }>();
		expect(row?.failure_count).toBe(1);
		expect(row?.cooldown_until_ms).toBeGreaterThanOrEqual(before + 90_000);
		expect(row?.cooldown_until_ms).toBeLessThanOrEqual(Date.now() + 90_000);
	} finally {
		db.close();
	}
});

// R15 control: a recent failure count keeps climbing the ladder.
test("failure_count keeps climbing when the last failure is recent", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		const keyId = await seedKey(db, "groq", "sk-test-nodecay-1");
		const recent = Date.now() - 60 * 60 * 1000;
		await db
			.prepare(
				`INSERT INTO provider_rate_limit_cooldowns
				 (platform, model_id, key_id, failure_count, cooldown_until_ms, reason, source)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind("groq", "model-a", keyId, 6, recent, "recent", "server_error")
			.run();
		const before = Date.now();
		await reportFailure(db, {
			platform: "groq",
			modelId: "model-a",
			keyId,
			source: "server_error",
			reason: "Upstream 500",
		});
		const row = await db
			.prepare(
				"SELECT failure_count, cooldown_until_ms FROM provider_rate_limit_cooldowns WHERE key_id = ?",
			)
			.bind(keyId)
			.first<{ failure_count: number; cooldown_until_ms: number }>();
		expect(row?.failure_count).toBe(7);
		expect(row?.cooldown_until_ms).toBeGreaterThanOrEqual(
			before + DAY_MS - 60_000,
		);
	} finally {
		db.close();
	}
});

// R15: the second failure cools down for 5 minutes, the ladder's second rung.
test("second consecutive failure cools down for five minutes", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await seedModel(db, "groq", "model-a");
		const keyId = await seedKey(db, "groq", "sk-test-ladder-1");
		const first = Date.now();
		await reportFailure(db, {
			platform: "groq",
			modelId: "model-a",
			keyId,
			source: "server_error",
			reason: "Upstream 500",
		});
		const firstRow = await db
			.prepare(
				"SELECT failure_count, cooldown_until_ms FROM provider_rate_limit_cooldowns WHERE key_id = ?",
			)
			.bind(keyId)
			.first<{ failure_count: number; cooldown_until_ms: number }>();
		expect(firstRow?.failure_count).toBe(1);
		expect(firstRow?.cooldown_until_ms).toBeGreaterThanOrEqual(first + 90_000);
		const second = Date.now();
		await reportFailure(db, {
			platform: "groq",
			modelId: "model-a",
			keyId,
			source: "server_error",
			reason: "Upstream 500",
		});
		const secondRow = await db
			.prepare(
				"SELECT failure_count, cooldown_until_ms FROM provider_rate_limit_cooldowns WHERE key_id = ?",
			)
			.bind(keyId)
			.first<{ failure_count: number; cooldown_until_ms: number }>();
		expect(secondRow?.failure_count).toBe(2);
		expect(secondRow?.cooldown_until_ms).toBeGreaterThanOrEqual(
			second + 300_000,
		);
		expect(secondRow?.cooldown_until_ms).toBeLessThanOrEqual(
			Date.now() + 300_000,
		);
	} finally {
		db.close();
	}
});

// Episode guard: every enabled key of the platform 401s at once.
test("provider-wide 401 episode suspends nothing and logs provider_auth_episode", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		const keyA = await seedKey(db, "groq", "sk-test-episode-a");
		const keyB = await seedKey(db, "groq", "sk-test-episode-b");
		const now = Date.now();
		// Newest first: three 401s for A, then an older 401 for B inside
		// the 10-minute window (seeded in reverse: B first, then A).
		await seedAttempt(db, keyB, "groq", "error", 401);
		for (let i = 0; i < 3; i++)
			await seedAttempt(db, keyA, "groq", "error", 401);
		const captured = captureConsoleError();
		try {
			expect(await maybeSuspendKeyAfterFailures(db, "groq", keyA, now)).toBe(
				false,
			);
		} finally {
			captured.restore();
		}
		expect((await keySuspension(db, keyA)).suspended_until_ms).toBeNull();
		const episodes = loggedEvents(captured.errors, "provider_auth_episode");
		expect(episodes).toHaveLength(1);
		expect(episodes[0]).toMatchObject({ platform: "groq", keyId: keyA });
	} finally {
		db.close();
	}
});

test("without an episode, three consecutive 401s suspend the key", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		const keyA = await seedKey(db, "groq", "sk-test-noepisode-a");
		const keyB = await seedKey(db, "groq", "sk-test-noepisode-b");
		const now = Date.now();
		// B's only 401 is two hours old: outside the episode window.
		const old = new Date(now - 2 * 60 * 60 * 1000)
			.toISOString()
			.replace("T", " ")
			.slice(0, 19);
		await seedAttempt(db, keyB, "groq", "error", 401, { createdAt: old });
		for (let i = 0; i < 3; i++)
			await seedAttempt(db, keyA, "groq", "error", 401);
		const captured = captureConsoleError();
		try {
			expect(await maybeSuspendKeyAfterFailures(db, "groq", keyA, now)).toBe(
				true,
			);
		} finally {
			captured.restore();
		}
		const row = await keySuspension(db, keyA);
		expect(row.suspended_until_ms).toBe(now + KEY_SUSPENSION_MS);
		expect(row.suspension_reason).toBe("consecutive_failures");
		expect(loggedEvents(captured.errors, "provider_auth_episode")).toHaveLength(
			0,
		);
	} finally {
		db.close();
	}
});

// Catalog rows never count toward suspension: 404s, mismatches and
// empty replies are skipped, so a dead model cannot suspend its keys.
test("catalog-attributed rows do not count toward suspension", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		const keyId = await seedKey(db, "groq", "sk-test-catalog-1");
		const now = Date.now();
		// Newest first: 500, 500, 404, 500, 500, 500 — the 404 is
		// skipped, so five 500s count and the key suspends.
		const sequence: {
			status: string;
			code: number | null;
			attribution?: string | null;
			message?: string | null;
		}[] = [
			{ status: "error", code: 500 },
			{ status: "error", code: 500 },
			{ status: "error", code: 500 },
			{ status: "error", code: 404 },
			{ status: "error", code: 500 },
			{ status: "error", code: 500 },
		];
		for (const attempt of [...sequence].reverse())
			await seedAttempt(db, keyId, "groq", attempt.status, attempt.code);
		expect(await maybeSuspendKeyAfterFailures(db, "groq", keyId, now)).toBe(
			true,
		);
	} finally {
		db.close();
	}
});

test("model_mismatch rows do not count toward suspension", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		const keyId = await seedKey(db, "groq", "sk-test-mismatch-1");
		const now = Date.now();
		// Newest first: 500, 500, mismatch, 500, 500 — only four
		// key-blamed failures, below the five needed.
		const sequence: {
			status: string;
			code: number | null;
			attribution?: string | null;
		}[] = [
			{ status: "error", code: 500 },
			{ status: "error", code: 500 },
			{
				status: "error",
				code: 502,
				attribution: "model_mismatch",
			},
			{ status: "error", code: 500 },
			{ status: "error", code: 500 },
		];
		for (const attempt of [...sequence].reverse())
			await seedAttempt(db, keyId, "groq", attempt.status, attempt.code, {
				failureAttribution: attempt.attribution ?? null,
			});
		expect(await maybeSuspendKeyAfterFailures(db, "groq", keyId, now)).toBe(
			false,
		);
		expect((await keySuspension(db, keyId)).suspended_until_ms).toBeNull();
	} finally {
		db.close();
	}
});

test("a success breaks the suspension streak", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		const keyId = await seedKey(db, "groq", "sk-test-break-1");
		const now = Date.now();
		// Newest first: 500, 500, success, 500, 500, 500.
		const sequence: { status: string; code: number | null }[] = [
			{ status: "error", code: 500 },
			{ status: "error", code: 500 },
			{ status: "success", code: 200 },
			{ status: "error", code: 500 },
			{ status: "error", code: 500 },
			{ status: "error", code: 500 },
		];
		for (const attempt of [...sequence].reverse())
			await seedAttempt(db, keyId, "groq", attempt.status, attempt.code);
		expect(await maybeSuspendKeyAfterFailures(db, "groq", keyId, now)).toBe(
			false,
		);
	} finally {
		db.close();
	}
});

test("499s neither count nor break the suspension streak", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		const keyId = await seedKey(db, "groq", "sk-test-499-1");
		const now = Date.now();
		// Newest first: 500, 499, 500, 500, 500, 500 — five counted.
		const sequence: { status: string; code: number | null }[] = [
			{ status: "error", code: 500 },
			{ status: "error", code: 499 },
			{ status: "error", code: 500 },
			{ status: "error", code: 500 },
			{ status: "error", code: 500 },
			{ status: "error", code: 500 },
		];
		for (const attempt of [...sequence].reverse())
			await seedAttempt(db, keyId, "groq", attempt.status, attempt.code);
		expect(await maybeSuspendKeyAfterFailures(db, "groq", keyId, now)).toBe(
			true,
		);
	} finally {
		db.close();
	}
});

test("three 500s do not suspend the key", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		const keyId = await seedKey(db, "groq", "sk-test-three-1");
		const now = Date.now();
		for (let i = 0; i < 3; i++)
			await seedAttempt(db, keyId, "groq", "error", 500);
		expect(await maybeSuspendKeyAfterFailures(db, "groq", keyId, now)).toBe(
			false,
		);
		expect((await keySuspension(db, keyId)).suspended_until_ms).toBeNull();
	} finally {
		db.close();
	}
});
