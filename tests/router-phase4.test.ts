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

// Keys in these routing tests carry explicit gateway-default limits so
// the router's effective-limit reserve never throttles them.
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

async function seedKey(db: D1Database, platform: string): Promise<void> {
	await createApiKey(
		db,
		{
			userId: USER.id,
			platform,
			keyLabel: "test",
			rawKey: "sk-test-r17",
			...KEY_LIMITS,
		},
		SECRET,
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
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
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

// R17: a bare request names a logical model, so it matches by canonical
// id: "qwen3-8-flash" finds the row stored as "free/qwen3-8-flash".
test("bare request matches a row by canonical id", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await db.prepare("DELETE FROM models").run();
		await seedModel(db, "groq", "free/qwen3-8-flash");
		await seedKey(db, "groq");
		fetchImpl = async (_input, init) =>
			okCompletion(requestedModel(init), "ok");
		const result = await route(db, "qwen3-8-flash");
		expect(result.response.status).toBe(200);
		expect(result.modelId).toBe("free/qwen3-8-flash");
	} finally {
		db.close();
	}
});

// R17: a "platform/model" request stays pinned to that platform: the
// canonical fallback must not match the same model on other providers.
test("platform/model request does not match the same model elsewhere", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await db.prepare("DELETE FROM models").run();
		await seedModel(db, "groq", "model-a");
		await seedModel(db, "electronhub", "model-a");
		await seedKey(db, "groq");
		await seedKey(db, "electronhub");
		const attempted: string[] = [];
		fetchImpl = async (input, init) => {
			attempted.push(String(input));
			return okCompletion(requestedModel(init), "ok");
		};
		const result = await route(db, "groq/model-a");
		expect(result.response.status).toBe(200);
		expect(result.modelId).toBe("model-a");
		expect(result.platform).toBe("groq");
		expect(attempted).toHaveLength(1);
	} finally {
		db.close();
	}
});

// R17: a bare "auto" redirects to the curated shtora/auto router. The
// router member is tried first even though the non-member outranks it,
// and the non-member is never attempted while the member succeeds.
test("bare auto redirects to the shtora/auto router", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await db.prepare("DELETE FROM models").run();
		await db
			.prepare(
				"INSERT OR REPLACE INTO settings (key, value) VALUES ('routing_strategy', 'priority')",
			)
			.run();
		await seedModel(db, "groq", "model-a", 1);
		await seedModel(db, "groq", "qwen3-8-max", 2);
		await seedKey(db, "groq");
		const attempted: string[] = [];
		fetchImpl = async (_input, init) => {
			const model = requestedModel(init);
			attempted.push(model);
			return okCompletion(model, "ok");
		};
		const result = await route(db, "auto");
		expect(result.response.status).toBe(200);
		expect(result.modelId).toBe("qwen3-8-max");
		expect(attempted).toEqual(["qwen3-8-max"]);
	} finally {
		db.close();
	}
});

// R17: token counting needs a concrete model, so a bare "auto" (now the
// shtora/auto router) is rejected there instead of counting tokens for
// whichever model the router would pick.
test("bare auto is rejected for count_tokens", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db);
		await db.prepare("DELETE FROM models").run();
		await seedModel(db, "groq", "qwen3-8-max");
		await seedKey(db, "groq");
		fetchImpl = async () => {
			throw new Error("count_tokens must not reach an upstream");
		};
		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "auto",
				messages: [{ role: "user", content: "hi" }],
			},
			native: {
				body: {
					model: "auto",
					messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
				},
				headers: new Headers(),
				operation: "count_tokens",
				translated: {
					model: "auto",
					messages: [{ role: "user", content: "hi" }],
				},
				inputCharacters: 2,
				bound: false,
			},
		});
		expect(result.response.status).toBe(400);
		const body = (await result.response.json()) as {
			error: { message: string };
		};
		expect(body.error.message).toContain("require an explicit model");
	} finally {
		db.close();
	}
});
