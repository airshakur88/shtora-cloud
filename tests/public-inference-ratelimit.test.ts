import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { createAccessKey } from "../src/lib/access-keys";
import { createApiKey } from "../src/lib/key-store";
import { PUBLIC_INFERENCE_LIMITS } from "../src/lib/ratelimit";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Route-level wiring for the public inference caps (A2). The helpers are
// unit-tested in tests/ratelimit-enforcement.test.ts; these tests call the
// real POST handlers and pin the answers clients see.
//
// The bodies are `{}` on purpose: a valid token passes auth and the
// public limit check, then the request fails body validation (400)
// without ever reaching the router or an upstream — so the 121st request
// proving the cap needs no working model or mocked fetch. An invalid
// token never reaches routing either: the first 20 attempts answer 401,
// the 21st answers 429.

const SECRET = "public-limit-test-secret-0123456789-abcdefghij";
let db: MemoryD1;
let token = "";
let accessKey = "";

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => SECRET,
	getImagesBucket: () => {
		throw new Error("IMAGES_BUCKET is unavailable in this test");
	},
}));

const v1Chat = await import("../src/app/v1/chat/completions/route");
const v1Messages = await import("../src/app/v1/messages/route");
const v1CountTokens = await import("../src/app/v1/messages/count_tokens/route");
const apiV1Chat = await import("../src/app/api/v1/chat/completions/route");

beforeEach(async () => {
	db = await createParityDatabase();
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES ('limit-user', 'Limit', 'limituser', 'hash')",
		)
		.run();
	const key = await createApiKey(
		db,
		{ userId: "limit-user", platform: "groq", rawKey: "groq-upstream" },
		SECRET,
	);
	token = key.unifiedToken as string;
	accessKey = (await createAccessKey(db, "limit-user", { name: "limit-key" }))
		.apiKey;
});

afterAll(() => {
	mock.restore();
	db.close();
});

function chatRequest(path: string, auth: string, ip: string): Request {
	return new Request(`https://gateway.test${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${auth}`,
			"content-type": "application/json",
			"cf-connecting-ip": ip,
		},
		body: "{}",
	});
}

function nativeRequest(path: string, auth: string, ip: string): Request {
	return new Request(`https://gateway.test${path}`, {
		method: "POST",
		headers: {
			"x-api-key": auth,
			"anthropic-version": "2026-10-21",
			"content-type": "application/json",
			"cf-connecting-ip": ip,
		},
		body: "{}",
	});
}

test("POST /v1/chat/completions: a valid token past its cap answers 429 with Retry-After", async () => {
	const ip = "203.0.113.1";
	for (let i = 0; i < PUBLIC_INFERENCE_LIMITS.perTokenRpm; i += 1) {
		expect(
			(await v1Chat.POST(chatRequest("/v1/chat/completions", token, ip)))
				.status,
		).toBe(400);
	}
	const blocked = await v1Chat.POST(
		chatRequest("/v1/chat/completions", token, ip),
	);
	expect(blocked.status).toBe(429);
	expect(blocked.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
	const body = (await blocked.json()) as {
		error: { message: string; type: string };
	};
	expect(body.error.type).toBe("rate_limit_error");
});

test("POST /v1/chat/completions: invalid-token probes answer 401, then 429", async () => {
	const ip = "203.0.113.2";
	for (let i = 0; i < PUBLIC_INFERENCE_LIMITS.invalidTokenRpm; i += 1) {
		expect(
			(
				await v1Chat.POST(
					chatRequest("/v1/chat/completions", "flmr-invalid-token", ip),
				)
			).status,
		).toBe(401);
	}
	const blocked = await v1Chat.POST(
		chatRequest("/v1/chat/completions", "flmr-invalid-token", ip),
	);
	expect(blocked.status).toBe(429);
	expect(blocked.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
	const body = (await blocked.json()) as {
		error: { message: string; type: string };
	};
	expect(body.error.type).toBe("rate_limit_error");
});

test("POST /v1/messages: a valid token past its cap answers 429 in the Anthropic shape", async () => {
	const ip = "203.0.113.3";
	for (let i = 0; i < PUBLIC_INFERENCE_LIMITS.perTokenRpm; i += 1) {
		expect(
			(await v1Messages.POST(nativeRequest("/v1/messages", token, ip))).status,
		).toBe(400);
	}
	const blocked = await v1Messages.POST(
		nativeRequest("/v1/messages", token, ip),
	);
	expect(blocked.status).toBe(429);
	expect(blocked.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
	const body = (await blocked.json()) as {
		type: string;
		error: { type: string; message: string };
	};
	expect(body.type).toBe("error");
	expect(body.error.type).toBe("rate_limit_error");
});

test("POST /v1/messages/count_tokens: invalid-token probes answer 401, then 429", async () => {
	const ip = "203.0.113.4";
	for (let i = 0; i < PUBLIC_INFERENCE_LIMITS.invalidTokenRpm; i += 1) {
		expect(
			(
				await v1CountTokens.POST(
					nativeRequest("/v1/messages/count_tokens", "invalid-token", ip),
				)
			).status,
		).toBe(401);
	}
	const blocked = await v1CountTokens.POST(
		nativeRequest("/v1/messages/count_tokens", "invalid-token", ip),
	);
	expect(blocked.status).toBe(429);
	const body = (await blocked.json()) as {
		type: string;
		error: { type: string; message: string };
	};
	expect(body.type).toBe("error");
	expect(body.error.type).toBe("rate_limit_error");
});

test("POST /api/v1/chat/completions: a valid access key past its cap answers 429", async () => {
	const ip = "203.0.113.5";
	for (let i = 0; i < PUBLIC_INFERENCE_LIMITS.perTokenRpm; i += 1) {
		expect(
			(
				await apiV1Chat.POST(
					chatRequest("/api/v1/chat/completions", accessKey, ip),
				)
			).status,
		).toBe(400);
	}
	const blocked = await apiV1Chat.POST(
		chatRequest("/api/v1/chat/completions", accessKey, ip),
	);
	expect(blocked.status).toBe(429);
	expect(blocked.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
	const body = (await blocked.json()) as {
		error: { message: string; type: string };
	};
	expect(body.error.type).toBe("rate_limit_error");
});

test("POST /api/v1/chat/completions: invalid access keys answer 401, then 429", async () => {
	const ip = "203.0.113.6";
	for (let i = 0; i < PUBLIC_INFERENCE_LIMITS.invalidTokenRpm; i += 1) {
		expect(
			(
				await apiV1Chat.POST(
					chatRequest("/api/v1/chat/completions", "ska-invalid-key", ip),
				)
			).status,
		).toBe(401);
	}
	const blocked = await apiV1Chat.POST(
		chatRequest("/api/v1/chat/completions", "ska-invalid-key", ip),
	);
	expect(blocked.status).toBe(429);
	const body = (await blocked.json()) as {
		error: { message: string; type: string };
	};
	expect(body.error.type).toBe("rate_limit_error");
});
