import { expect, mock, test } from "bun:test";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

const SECRET = "v1-methods-test-secret-0123456789-abcdefghij";
let db: MemoryD1;

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => SECRET,
	getImagesBucket: () => {
		throw new Error("IMAGES_BUCKET is unavailable in this test");
	},
}));

// Dynamic imports needed because env.ts depends on cloudflare:workers,
// which is only available under the mock at runtime.
const v1Index = await import("../src/app/v1/route");
const v1Chat = await import("../src/app/v1/chat/completions/route");
const v1Models = await import("../src/app/v1/models/route");
const v1ModelById = await import("../src/app/v1/models/[...model]/route");
const v1Messages = await import("../src/app/v1/messages/route");
const v1CountTokens = await import("../src/app/v1/messages/count_tokens/route");
const apiV1Chat = await import("../src/app/api/v1/chat/completions/route");
const apiV1Models = await import("../src/app/api/v1/models/route");

test("GET /v1 returns a JSON index of the public API", async () => {
	const response = v1Index.GET();
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		object: string;
		service: string;
		endpoints: Array<{ method: string; path: string }>;
	};
	expect(body.object).toBe("api");
	expect(body.service).toBe("shtora");
	expect(body.endpoints).toEqual([
		{ method: "POST", path: "/v1/chat/completions" },
		{ method: "GET", path: "/v1/models" },
		{ method: "GET", path: "/v1/models/{model}" },
		{ method: "POST", path: "/v1/messages" },
		{ method: "POST", path: "/v1/messages/count_tokens" },
	]);
});

test("GET /v1/chat/completions returns 405 JSON with Allow", async () => {
	const response = v1Chat.GET();
	expect(response.status).toBe(405);
	expect(response.headers.get("Allow")).toBe("OPTIONS, POST");
	const body = (await response.json()) as {
		error: { message: string; type: string; code: unknown };
	};
	expect(body.error.type).toBe("invalid_request_error");
	expect(body.error.message).toContain("POST");
	expect(body.error.code).toBeNull();
});

test("POST /v1/models returns 405 JSON with Allow", async () => {
	const response = v1Models.POST();
	expect(response.status).toBe(405);
	expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
	const body = (await response.json()) as {
		error: { message: string; type: string };
	};
	expect(body.error.message).toContain("GET");
});

test("POST /v1/models/{model} returns 405 JSON with Allow", async () => {
	const response = v1ModelById.POST();
	expect(response.status).toBe(405);
	expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
});

test("GET /v1/messages returns 405 in the Anthropic error shape", async () => {
	const response = v1Messages.GET();
	expect(response.status).toBe(405);
	expect(response.headers.get("Allow")).toBe("OPTIONS, POST");
	const body = (await response.json()) as {
		type: string;
		error: { type: string; message: string };
	};
	expect(body.type).toBe("error");
	expect(body.error.type).toBe("invalid_request_error");
	expect(body.error.message).toContain("POST");
});

test("GET /v1/messages/count_tokens returns 405 with Allow", async () => {
	const response = v1CountTokens.GET();
	expect(response.status).toBe(405);
	expect(response.headers.get("Allow")).toBe("OPTIONS, POST");
});

test("OPTIONS returns 204 with Allow and no body", async () => {
	const response = v1Chat.OPTIONS();
	expect(response.status).toBe(204);
	expect(response.headers.get("Allow")).toBe("OPTIONS, POST");
	expect(await response.text()).toBe("");
	const modelsResponse = v1Models.OPTIONS();
	expect(modelsResponse.status).toBe(204);
	expect(modelsResponse.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
});

test("HEAD on a POST-only route returns 405 with Allow and no body", async () => {
	const response = v1Chat.HEAD();
	expect(response.status).toBe(405);
	expect(response.headers.get("Allow")).toBe("OPTIONS, POST");
	expect(await response.text()).toBe("");
});

test("GET /api/v1/chat/completions returns 405 JSON with Allow", async () => {
	const response = apiV1Chat.GET();
	expect(response.status).toBe(405);
	expect(response.headers.get("Allow")).toBe("OPTIONS, POST");
});

test("POST /api/v1/models returns 405 JSON with Allow", async () => {
	const response = apiV1Models.POST();
	expect(response.status).toBe(405);
	expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
});

test("POST /v1/chat/completions with an invalid key still returns 401", async () => {
	db = await createParityDatabase();
	const request = new Request("http://localhost/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: "Bearer invalid-key",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model: "shtora/auto", messages: [] }),
	});
	const response = await v1Chat.POST(request);
	expect(response.status).toBe(401);
	const body = (await response.json()) as {
		error: { message: string; type: string };
	};
	expect(body.error.type).toBe("authentication_error");
});

test("GET /v1/models without a key still returns 401", async () => {
	const request = new Request("http://localhost/v1/models");
	const response = await v1Models.GET(request);
	expect(response.status).toBe(401);
});
