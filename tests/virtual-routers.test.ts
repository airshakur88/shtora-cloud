import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApiKey } from "../src/lib/key-store";
import { canonicalModelId } from "../src/lib/model-canonical";
import { routeChatCompletion } from "../src/lib/router";
import type { AppUser, D1Database } from "../src/lib/types";
import {
	VIRTUAL_ROUTER_FALLBACK_MODELS,
	VIRTUAL_ROUTERS,
} from "../src/lib/virtual-routers";
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
	// Fixtures replace the migrated catalog: the router tests pin exact
	// models/ranks, so the 303 catalog rows must not compete with them.
	await db.prepare("DELETE FROM models").run();
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(USER.id, USER.name, USER.username, USER.passwordHash)
		.run();
	const models: Array<[string, string, string, number, number]> = [
		// [platform, model_id, name, intelligence_rank, tier]
		["kilo", "kilo-auto/free", "Kilo Auto Free", 50, 1],
		["groq", "qwen3-coder-plus", "Qwen3 Coder Plus", 85, 1],
		["groq", "model-x", "Model X", 1, 1],
		["groq", "auto", "Upstream Auto", 1, 1],
		["groq", "qwen3-8-max", "Qwen3 8 Max", 17, 1],
	];
	for (const [platform, modelId, name, rank, tier] of models) {
		await db
			.prepare(
				"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier, supports_tools, supports_vision) VALUES (?, ?, ?, ?, ?, ?, 1, 1)",
			)
			.bind(platform, modelId, name, 32768, rank, tier)
			.run();
	}
	for (const platform of ["kilo", "groq"]) {
		await createApiKey(
			db,
			{
				userId: USER.id,
				platform,
				keyLabel: "test",
				rawKey: "sk-test-upstream-key",
			},
			SECRET,
		);
	}
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

/** Upstream mock that echoes the requested model back as a success. */
function successFetch(): (
	input: string,
	init?: RequestInit,
) => Promise<Response> {
	return async (_input, init) => {
		let model = "echo";
		try {
			const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
			if (body.model) model = body.model;
		} catch {
			// Keep the fallback model.
		}
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
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};
}

async function route(db: D1Database, model: string) {
	return routeChatCompletion({
		db,
		secret: SECRET,
		user: USER,
		request: {
			model,
			messages: [{ role: "user", content: "hi" }],
		},
	});
}

test("shtora/kilo-free routes to the Kilo free-router row", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		fetchImpl = successFetch();
		const result = await route(db, "shtora/kilo-free");
		expect(result.response.status).toBe(200);
		expect(result.modelId).toBe("kilo-auto/free");
		expect(result.platform).toBe("kilo");
	} finally {
		db.close();
	}
});

test("shtora/coding routes to a coder member, not to a better-ranked non-member", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		fetchImpl = successFetch();
		const result = await route(db, "shtora/coding");
		expect(result.response.status).toBe(200);
		// Both qwen3-coder-plus and qwen3-8-max are coding members; the
		// guarantee is that a member wins over the better-ranked non-member.
		expect(["qwen3-coder-plus", "qwen3-8-max"]).toContain(result.modelId);
		expect(result.modelId).not.toBe("model-x");
	} finally {
		db.close();
	}
});

test("shtora/auto routes to a virtual member, never to an upstream auto row", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		fetchImpl = successFetch();
		const result = await route(db, "shtora/auto");
		expect(result.response.status).toBe(200);
		expect(result.modelId).toBe("qwen3-8-max");
		expect(result.modelId).not.toBe("auto");
	} finally {
		db.close();
	}
});

test("shtora/3d routes to a 3d member", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		fetchImpl = successFetch();
		const result = await route(db, "shtora/3d");
		expect(result.response.status).toBe(200);
		// Both qwen3-coder-plus and qwen3-8-max are 3d members; the
		// guarantee is that a member wins over the better-ranked non-member.
		expect(["qwen3-coder-plus", "qwen3-8-max"]).toContain(result.modelId);
		expect(result.modelId).not.toBe("model-x");
	} finally {
		db.close();
	}
});

test("every virtual router member exists in the migrated catalog", async () => {
	// A member with no catalog row is dead weight: the router silently
	// skips it, so membership must be checked against the real migrations.
	const db = await createParityDatabase();
	try {
		const result = await db.prepare("SELECT model_id FROM models").all();
		const canonicals = new Set(
			(result.results as Array<{ model_id: string }>).map((row) =>
				canonicalModelId(row.model_id),
			),
		);
		for (const router of Object.values(VIRTUAL_ROUTERS)) {
			for (const member of router.members) {
				expect(canonicals.has(member)).toBe(true);
			}
		}
	} finally {
		db.close();
	}
});

test("every virtual router fallback model exists in the migrated catalog with tools and vision", async () => {
	// Same pattern as the router-member check: a fallback model with no
	// catalog row, or with no tools/vision row, can never rescue a request.
	const db = await createParityDatabase();
	try {
		const result = await db
			.prepare("SELECT model_id, supports_tools, supports_vision FROM models")
			.all();
		const byCanonical = new Map<
			string,
			Array<{ supports_tools: number; supports_vision: number }>
		>();
		for (const row of result.results as Array<{
			model_id: string;
			supports_tools: number;
			supports_vision: number;
		}>) {
			const canonical = canonicalModelId(row.model_id);
			const rows = byCanonical.get(canonical) ?? [];
			rows.push(row);
			byCanonical.set(canonical, rows);
		}
		for (const member of VIRTUAL_ROUTER_FALLBACK_MODELS) {
			const rows = byCanonical.get(member) ?? [];
			expect(rows.length).toBeGreaterThan(0);
			expect(
				rows.some(
					(row) => row.supports_tools === 1 && row.supports_vision === 1,
				),
			).toBe(true);
		}
	} finally {
		db.close();
	}
});

async function seedFallbackDb(db: D1Database): Promise<void> {
	// Fixtures replace the migrated catalog so the chain holds exactly
	// what the test pins: six shtora/auto members on groq, plus one
	// fallback model (mistral-large-2512, not an auto member) on
	// electronhub. No other model can answer the request.
	await db.prepare("DELETE FROM models").run();
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(USER.id, USER.name, USER.username, USER.passwordHash)
		.run();
	const members: Array<[string, string, number]> = [
		["qwen3-8-max", "Qwen3 8 Max", 1],
		["qwen3-8-flash", "Qwen3 8 Flash", 2],
		["qwen3-8-omni-flash", "Qwen3 8 Omni Flash", 3],
		["gpt-5-6-luna", "GPT 5.6 Luna", 4],
		["gemini-3-5-flash", "Gemini 3.5 Flash", 5],
		["minimax-m3", "MiniMax M3", 6],
	];
	for (const [modelId, name, rank] of members) {
		await db
			.prepare(
				"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier, supports_tools, supports_vision) VALUES (?, ?, ?, ?, ?, ?, 1, 1)",
			)
			.bind("groq", modelId, name, 32768, rank, 1)
			.run();
	}
	await db
		.prepare(
			"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier, supports_tools, supports_vision) VALUES (?, ?, ?, ?, ?, ?, 1, 1)",
		)
		.bind("electronhub", "mistral-large-2512", "Mistral Large 3", 262144, 7, 1)
		.run();
	for (const platform of ["groq", "electronhub"]) {
		await createApiKey(
			db,
			{
				userId: USER.id,
				platform,
				keyLabel: "test",
				rawKey: "sk-test-upstream-key",
			},
			SECRET,
		);
	}
}

test("shtora/auto reaches the fallback chain after all members fail", async () => {
	const db = await createParityDatabase();
	try {
		await seedFallbackDb(db);
		const attempted: string[] = [];
		fetchImpl = async (_input, init) => {
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
			if (model !== "mistral-large-2512")
				return new Response("boom", { status: 500 });
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
		const result = await route(db, "shtora/auto");
		// Six member attempts exhaust the member budget; the seventh
		// attempt must be a fallback model, not a 502.
		expect(result.response.status).toBe(200);
		expect(result.modelId).toBe("mistral-large-2512");
		expect(result.platform).toBe("electronhub");
		expect(attempted).toHaveLength(7);
		expect(new Set(attempted.slice(0, 6))).toEqual(
			new Set([
				"qwen3-8-max",
				"qwen3-8-flash",
				"qwen3-8-omni-flash",
				"gpt-5-6-luna",
				"gemini-3-5-flash",
				"minimax-m3",
			]),
		);
		expect(attempted[6]).toBe("mistral-large-2512");
	} finally {
		db.close();
	}
});

test("bare auto still works as the internal fallback", async () => {
	const db = await createParityDatabase();
	try {
		await seedDb(db);
		fetchImpl = successFetch();
		const result = await route(db, "auto");
		expect(result.response.status).toBe(200);
		expect(result.modelId).toBe("auto");
	} finally {
		db.close();
	}
});
