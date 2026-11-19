import { expect, mock, test } from "bun:test";
import { createAccessKey } from "../src/lib/access-keys";
import { createApiKey } from "../src/lib/key-store";
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

interface ModelListResponse {
	object: string;
	data: Array<{ id: string }>;
	has_more: boolean;
}

async function getModels(
	token: string,
	query = "",
): Promise<ModelListResponse> {
	const response = await v1Models.GET(
		new Request(`http://localhost/v1/models${query}`, {
			headers: { Authorization: `Bearer ${token}` },
		}),
	);
	expect(response.status).toBe(200);
	return (await response.json()) as ModelListResponse;
}

test("GET /v1/models lists virtual routers before ordinary models", async () => {
	db = await createParityDatabase();
	await db.prepare("DELETE FROM models").run();
	await db
		.prepare(
			"INSERT INTO user (id,name,username,password_hash) VALUES ('u1','Test User','testuser','unused')",
		)
		.run();
	for (const [modelId, name] of [
		["llama-4", "Llama 4"],
		["gpt-4o", "GPT-4o"],
		["qwen3-coder-plus", "Qwen3 Coder Plus"],
		["qwen3-8-max", "Qwen3 8 Max"],
		["gpt-5-4-mini", "GPT 5.4 Mini"],
	] as const) {
		await db
			.prepare(
				"INSERT INTO models (platform,model_id,name,context_window,supports_tools,supports_vision,enabled) VALUES ('groq',?,?,32768,1,1,1)",
			)
			.bind(modelId, name)
			.run();
	}
	await createApiKey(
		db,
		{
			userId: "u1",
			platform: "groq",
			keyLabel: "test",
			rawKey: "sk-test-models-order",
		},
		SECRET,
	);
	const { apiKey: token } = await createAccessKey(db, "u1", {
		name: "models-order",
	});

	// Routers present: auto, coding, smart, vision, 3d. Fast has no member
	// here, so it stays out of the listing.
	const body = await getModels(token);
	expect(body.object).toBe("list");
	const ids = body.data.map((model) => model.id);
	expect(ids.slice(0, 5)).toEqual([
		"shtora/auto",
		"shtora/coding",
		"shtora/smart",
		"shtora/vision",
		"shtora/3d",
	]);
	// Ordinary models follow, in canonical order.
	expect(ids.slice(5)).toEqual([
		"shtora/gpt-4o",
		"shtora/gpt-5-4-mini",
		"shtora/llama-4",
		"shtora/qwen3-8-max",
		"shtora/qwen3-coder-plus",
	]);
	expect(body.has_more).toBe(false);

	// Pagination counts routers in the page: limit=2 returns only routers.
	const firstPage = await getModels(token, "?limit=2");
	expect(firstPage.data.map((model) => model.id)).toEqual([
		"shtora/auto",
		"shtora/coding",
	]);
	expect(firstPage.has_more).toBe(true);

	// Offset past the routers returns ordinary models only.
	const rest = await getModels(token, "?limit=100&offset=5");
	expect(rest.data.map((model) => model.id)).toEqual(ids.slice(5));
	expect(rest.has_more).toBe(false);
});
