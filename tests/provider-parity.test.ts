import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { parseChatCompletionRequest } from "../src/lib/chat-request";
import { createApiKey } from "../src/lib/key-store";
import {
	getProviderConfig,
	listProviders,
	normalizeProviderKey,
} from "../src/lib/provider-catalog";
import { ProviderError, sendChat } from "../src/lib/providers";
import { routeChatCompletion } from "../src/lib/router";
import type {
	AppUser,
	ChatCompletionResponse,
	ProviderCatalog,
} from "../src/lib/types";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

const SECRET = "provider-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const USER: AppUser = {
	id: "provider-user",
	name: "Provider Test",
	username: "providertest",
	role: "user",
	passwordHash: "unused",
	createdAt: "2026-11-12 00:00:00",
	updatedAt: "2026-11-12 00:00:00",
};
const originalFetch = globalThis.fetch;

// Providers/models for the sendChat tests come from the migrated D1 catalog
// (migrations 0001-0010 applied to an in-memory database), never from JSON.
let db: MemoryD1;
beforeAll(async () => {
	db = await createParityDatabase();
});
afterAll(() => {
	db.close();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(
	handler: (url: string, init: RequestInit) => Response,
): string[] {
	const calls: string[] = [];
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		writable: true,
		value: async (
			input: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			calls.push(url);
			return handler(url, init ?? {});
		},
	});
	return calls;
}

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

function chatResponse(model: string, content = "ok"): ChatCompletionResponse {
	return {
		id: "chatcmpl-test",
		object: "chat.completion",
		created: 1,
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
	};
}

async function providerConfig(id: string): Promise<ProviderCatalog> {
	const result = await getProviderConfig(id, db);
	if (!result) throw new Error(`Missing test provider ${id}`);
	return result;
}

async function firstModelId(platform: string): Promise<string | null> {
	const row = await db
		.prepare(
			"SELECT model_id FROM models WHERE platform = ? ORDER BY id LIMIT 1",
		)
		.bind(platform)
		.first<{ model_id: string }>();
	return row?.model_id ?? null;
}

test("chat catalog covers all feed chat providers and target-only direct providers", async () => {
	const providers = await listProviders(db);
	const ids = new Set(providers.map((item) => item.id));
	expect(ids.size).toBe(50);
	const modelCount = await db
		.prepare(
			"SELECT COUNT(*) AS count FROM models WHERE enabled = 1 AND platform IN (SELECT id FROM providers)",
		)
		.first<{ count: number }>();
	expect(modelCount?.count).toBe(307);
	const chatProviderCount = await db
		.prepare(
			"SELECT COUNT(*) AS count FROM (SELECT DISTINCT platform FROM models WHERE enabled = 1 AND platform IN (SELECT id FROM providers))",
		)
		.first<{ count: number }>();
	expect(chatProviderCount?.count).toBe(32);
	for (const id of [
		"agnes",
		"aihorde",
		"cloudflare",
		"cohere",
		"google",
		"moondream",
		"cerebras",
		"together",
		"xai",
	]) {
		expect(ids.has(id)).toBe(true);
	}
	// anthropic is a catalog provider since migration 0015 (C3); openai
	// still has no row in `providers`.
	expect(ids.has("anthropic")).toBe(true);
	for (const id of ["openai"]) {
		expect(ids.has(id)).toBe(false);
	}
	for (const id of ["cerebras", "together", "xai"]) {
		const count = await db
			.prepare("SELECT COUNT(*) AS count FROM models WHERE platform = ?")
			.bind(id)
			.first<{ count: number }>();
		expect(count?.count).toBe(0);
	}
	for (const id of ["speechify", "linkup", "pinecone"]) {
		expect(ids.has(id)).toBe(false);
	}
	for (const item of providers) {
		expect(item.protocol).toBeTruthy();
		expect(item.baseUrl).toBeTruthy();
	}
	const models = new Set(
		(
			await db
				.prepare("SELECT platform, model_id FROM models")
				.all<{ platform: string; model_id: string }>()
		).results.map((row) => `${row.platform}|${row.model_id}`),
	);
	// Models newly added by the 2026.11.13 feed snapshot that were absent before.
	for (const id of []) {
		expect(models.has(id)).toBe(true);
	}
	expect(models.has("google|gemini-3.5-flash")).toBe(true);
	for (const staleId of [
		"google|gemini-2.5-pro",
		"google|gemini-2.0-flash",
		"groq|llama-3.1-70b-instruct",
		"groq|llama-3-70b-sonnet",
		"groq|llama-4-maverick-17b-128e-instruct",
		"mistral|mistral-large-latest",
		"mistral|open-mistral-7b",
		"inferbase|bytedance-seed-1-8",
		"inferbase|bytedance-seed-2-0-mini",
		"anthropic|claude-haiku-4.5",
	]) {
		expect(models.has(staleId)).toBe(false);
	}
});
test("OpenAI-compatible chat forwards bearer auth and request body", async () => {
	const expected = chatResponse("llama-3.1-70b-instruct");
	const groq = await providerConfig("groq");
	const captured: {
		authorization: string | null;
		body?: Record<string, unknown>;
	} = {
		authorization: null,
	};
	const calls = mockFetch((url, init) => {
		expect(url).toBe(`${groq.baseUrl}/chat/completions`);
		captured.authorization = new Headers(init.headers).get("authorization");
		captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
		return jsonResponse(expected);
	});

	const response = await sendChat(
		{
			platform: "groq",
			modelId: "llama-3.1-70b-instruct",
			apiKey: "provider-secret",
			baseUrl: null,
			messages: [{ role: "user", content: "hello" }],
			stream: false,
		},
		undefined,
		db,
	);

	expect(response.status).toBe(200);
	expect(captured.authorization).toBe("Bearer provider-secret");
	expect(captured.body?.model).toBe("llama-3.1-70b-instruct");
	expect(captured.body?.messages).toEqual([{ role: "user", content: "hello" }]);
	expect(calls).toHaveLength(1);
});
test("every OpenAI-compatible catalog provider uses its configured endpoint and auth", async () => {
	const openAiProviders = (await listProviders(db)).filter(
		(item) => item.protocol === "openai_compatible",
	);
	for (const config of openAiProviders) {
		const modelId =
			(await firstModelId(config.id)) ?? `test-model/${config.id}`;
		const captured: {
			url: string;
			authorization: string | null;
			headers: Headers;
			body?: Record<string, unknown>;
		} = {
			url: "",
			authorization: null,
			headers: new Headers(),
		};
		mockFetch((url, init) => {
			captured.url = url;
			captured.headers = new Headers(init.headers);
			captured.authorization = captured.headers.get("authorization");
			captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
			return jsonResponse(chatResponse(String(captured.body.model)));
		});
		const response = await sendChat(
			{
				platform: config.id,
				modelId,
				apiKey: config.keyless ? "no-key" : "provider-test-key",
				baseUrl: null,
				messages: [{ role: "user", content: "test" }],
				stop: "END",
				stream: false,
			},
			undefined,
			db,
		);
		expect(response.status).toBe(200);
		expect(captured.body?.stop).toEqual(
			config.modelIdentity === "simplellm" ? ["END"] : "END",
		);
		expect(captured.url).toBe(`${config.baseUrl}/chat/completions`);
		expect(captured.authorization).toBe(
			config.keyless ? null : "Bearer provider-test-key",
		);
		for (const [name, value] of Object.entries(config.extraHeaders ?? {})) {
			expect(captured.headers.get(name)).toBe(value);
		}
	}
}, 30000);

test("OpenAI-compatible streaming response is passed through unchanged", async () => {
	const upstream = [
		`data: ${JSON.stringify({
			id: "stream-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "llama-3.1-70b-instruct",
			choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
		})}\n\n`,
		"data: [DONE]\n\n",
	].join("");
	mockFetch(
		() =>
			new Response(upstream, {
				headers: { "Content-Type": "text/event-stream" },
			}),
	);
	const response = await sendChat(
		{
			platform: "groq",
			modelId: "llama-3.1-70b-instruct",
			apiKey: "provider-test-key",
			baseUrl: null,
			messages: [{ role: "user", content: "test" }],
			stream: true,
		},
		undefined,
		db,
	);
	expect(await response.text()).toBe(upstream);
});

test("Router9 streams receive a single OpenAI completion sentinel", async () => {
	const config = await providerConfig("router9");
	const modelId = await firstModelId("router9");
	if (!modelId) throw new Error("Missing test model for router9");
	const upstream = `data: ${JSON.stringify({
		id: "router9-stream",
		object: "chat.completion.chunk",
		created: 1,
		model: modelId,
		choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
	})}\n\n`;
	mockFetch(
		() =>
			new Response(upstream, {
				headers: { "Content-Type": "text/event-stream" },
			}),
	);
	const response = await sendChat(
		{
			platform: config.id,
			modelId,
			apiKey: "router9-key",
			baseUrl: null,
			messages: [{ role: "user", content: "test" }],
			stream: true,
		},
		undefined,
		db,
	);
	const stream = await response.text();
	expect(stream).toContain('"content":"hi"');
	expect(stream.match(/data: \[DONE\]/g)).toHaveLength(1);
});

test("ElectronHub streaming proxy errors fail before returning a completion", async () => {
	const chunks = [
		`data: ${JSON.stringify({
			choices: [{ index: 0, delta: { content: "### **Proxy error (HTTP " } }],
		})}\n\n`,
		`data: ${JSON.stringify({
			choices: [
				{ index: 0, delta: { content: "502) private upstream detail" } },
			],
		})}\n\n`,
	].join("");
	mockFetch(
		() =>
			new Response(chunks, {
				headers: { "Content-Type": "text/event-stream" },
			}),
	);
	await expect(
		sendChat(
			{
				platform: "electronhub",
				modelId:
					(await firstModelId("electronhub")) ?? "test-model/electronhub",
				apiKey: "electronhub-key",
				baseUrl: null,
				messages: [{ role: "user", content: "test" }],
				stream: true,
			},
			undefined,
			db,
		),
	).rejects.toMatchObject({
		status: 502,
		message: "Upstream proxy failed",
	});
});

test("chat parser accepts standard multimodal content and tool-call history", () => {
	const parsed = parseChatCompletionRequest({
		model: "gemini-3.5-flash",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Describe this" },
					{
						type: "image_url",
						image_url: { url: "data:image/png;base64,AQID" },
					},
				],
			},
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call-1",
						type: "function",
						function: { name: "weather", arguments: '{"city":"Lima"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call-1", content: '{"temperature":18}' },
		],
		stop: ["END"],
	});
	expect(parsed?.messages[0].content).toEqual([
		{ type: "text", text: "Describe this" },
		{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
	]);
	expect(parsed?.messages[1].content).toBeNull();
	expect(parsed?.messages[2].tool_call_id).toBe("call-1");
	expect(parsed?.stop).toEqual(["END"]);
	expect(
		parseChatCompletionRequest({
			model: "x",
			messages: [{ role: "user", content: [{ type: "video", url: "x" }] }],
		}),
	).toBeNull();
});

test("keyless credentials are optional only for configured providers", async () => {
	expect(await normalizeProviderKey("aihorde", "", undefined, db)).toBe(
		"no-key",
	);
	expect(await normalizeProviderKey("kilo", undefined, undefined, db)).toBe(
		"no-key",
	);
	expect(await normalizeProviderKey("groq", "", undefined, db)).toBeNull();
});

test("keyless OpenAI-compatible providers omit bearer auth for the sentinel", async () => {
	const captured: { authorization: string | null } = {
		authorization: "unexpected",
	};
	mockFetch((_url, init) => {
		captured.authorization = new Headers(init.headers).get("authorization");
		return jsonResponse(chatResponse("kilo-auto/free"));
	});

	await sendChat(
		{
			platform: "kilo",
			modelId: "kilo-auto/free",
			apiKey: "no-key",
			baseUrl: null,
			messages: [{ role: "user", content: "hello" }],
			stream: false,
		},
		undefined,
		db,
	);

	expect(captured.authorization).toBeNull();
});

test("Cloudflare Workers AI splits account id from token and uses the account URL", async () => {
	const captured: {
		authorization: string | null;
		requestModel?: unknown;
		body?: Record<string, unknown>;
	} = { authorization: null };
	mockFetch((url, init) => {
		expect(url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions",
		);
		captured.authorization = new Headers(init.headers).get("authorization");
		captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
		captured.requestModel = captured.body.model;
		return jsonResponse(chatResponse("@cf/openai/gpt-oss-20b"));
	});

	await sendChat(
		{
			platform: "cloudflare",
			modelId: "@cf/openai/gpt-oss-20b",
			apiKey: "0123456789abcdef0123456789abcdef:cf-api-token",
			baseUrl: null,
			messages: [{ role: "user", content: "hello" }],
			stop: "END",
			stream: false,
		},
		undefined,
		db,
	);

	expect(captured.authorization).toBe("Bearer cf-api-token");
	expect(captured.requestModel).toBe("@cf/openai/gpt-oss-20b");
	expect(captured.body?.stop).toBe("END");
});

test("Google translates chat messages, image data and tools, then maps function calls back", async () => {
	const captured: { body?: Record<string, unknown>; apiKey: string | null } = {
		apiKey: null,
	};
	const calls = mockFetch((_url, init) => {
		captured.apiKey = new Headers(init.headers).get("x-goog-api-key");
		captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
		return jsonResponse({
			candidates: [
				{
					content: {
						parts: [
							{
								functionCall: {
									id: "call-1",
									name: "weather",
									args: { city: "Lima" },
									thoughtSignature: "sig-1",
								},
							},
						],
					},
					finishReason: "STOP",
				},
			],
			usageMetadata: {
				promptTokenCount: 8,
				candidatesTokenCount: 4,
				totalTokenCount: 12,
			},
		});
	});

	const response = await sendChat(
		{
			platform: "google",
			modelId: "gemini-2.5-flash",
			apiKey: "google-key",
			baseUrl: null,
			messages: [
				{ role: "system", content: "Be concise." },
				{
					role: "user",
					content: [
						{ type: "text", text: "What is this?" },
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,AQID" },
						},
					],
				},
			],
			tools: [
				{
					type: "function",
					function: {
						name: "weather",
						parameters: {
							type: "object",
							properties: { city: { type: "string" } },
						},
					},
				},
			],
			stop: "END",
			stream: false,
		},
		undefined,
		db,
	);
	const result = (await response.json()) as ChatCompletionResponse;

	expect(calls[0]).toBe(
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
	);
	expect(captured.apiKey).toBe("google-key");
	expect(captured.body?.systemInstruction).toEqual({
		parts: [{ text: "Be concise." }],
	});
	// The SDK normalizes JSON-schema `type` values to the Gemini API's
	// uppercase Type enum (STRING, OBJECT, ...) — the manual fetch code
	// passed the client's lowercase values through verbatim.
	expect(captured.body?.tools).toEqual([
		{
			functionDeclarations: [
				{
					name: "weather",
					parameters: {
						type: "OBJECT",
						properties: { city: { type: "STRING" } },
					},
				},
			],
		},
	]);
	expect(captured.body?.generationConfig).toMatchObject({
		stopSequences: ["END"],
	});
	const sentBody = captured.body;
	if (!sentBody) throw new Error("Google request body was not captured");
	const sentContents = sentBody.contents as Array<{
		parts: Array<Record<string, unknown>>;
	}>;
	expect(sentContents[0].parts[1]).toEqual({
		inlineData: { mimeType: "image/png", data: "AQID" },
	});
	expect(result.choices[0].message.tool_calls?.[0]).toEqual({
		id: "call-1",
		type: "function",
		function: { name: "weather", arguments: JSON.stringify({ city: "Lima" }) },
	});
	expect(result.usage?.total_tokens).toBe(12);
});

test("Google rejects remote and file image URLs without fetching them", async () => {
	const calls = mockFetch(() => {
		throw new Error("Disallowed image URL reached fetch");
	});
	for (const url of [
		"https://images.example.test/photo.png",
		"file:///tmp/photo.png",
	]) {
		await expect(
			sendChat(
				{
					platform: "google",
					modelId: "gemini-2.5-flash",
					apiKey: "google-key",
					baseUrl: null,
					messages: [
						{
							role: "user",
							content: [{ type: "image_url", image_url: { url } }],
						},
					],
					stream: false,
				},
				undefined,
				db,
			),
		).rejects.toMatchObject({ status: 400, kind: "bad_request" });
	}
	expect(calls).toHaveLength(0);
});

test("Google round-trips assistant tool calls and tool results", async () => {
	let body: Record<string, unknown> | undefined;
	mockFetch((_url, init) => {
		body = JSON.parse(String(init.body)) as Record<string, unknown>;
		return jsonResponse({
			candidates: [
				{
					content: { parts: [{ text: "It is sunny." }] },
					finishReason: "STOP",
				},
			],
		});
	});
	await sendChat(
		{
			platform: "google",
			modelId: "gemini-3.5-flash",
			apiKey: "google-key",
			baseUrl: null,
			messages: [
				{ role: "user", content: "What is the weather?" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-weather",
							type: "function",
							function: { name: "get_weather", arguments: '{"city":"Lima"}' },
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "call-weather",
					content: "18C and sunny",
				},
			],
			tools: [
				{
					type: "function",
					function: { name: "get_weather", parameters: { type: "object" } },
				},
			],
			stream: false,
		},
		undefined,
		db,
	);
	const contents = body?.contents as Array<{
		role: string;
		parts: Array<Record<string, unknown>>;
	}>;
	expect(contents[1].parts[0]).toMatchObject({
		functionCall: {
			id: "call-weather",
			name: "get_weather",
			args: { city: "Lima" },
		},
		thoughtSignature: "context_engineering_is_the_way_to_go",
	});
	expect(contents[2].parts[0]).toEqual({
		functionResponse: {
			id: "call-weather",
			name: "get_weather",
			response: { result: "18C and sunny" },
		},
	});
});

test("Google streams text and function-call deltas as OpenAI SSE", async () => {
	const data = JSON.stringify({
		candidates: [
			{
				content: {
					parts: [
						{ text: "hello" },
						{
							functionCall: {
								id: "call-2",
								name: "weather",
								args: { city: "Lima" },
								thoughtSignature: "sig-2",
							},
						},
					],
				},
				finishReason: "STOP",
			},
		],
	});
	mockFetch(
		() =>
			new Response(`data: ${data}\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			}),
	);

	const response = await sendChat(
		{
			platform: "google",
			modelId: "gemini-2.5-flash",
			apiKey: "google-key",
			baseUrl: null,
			messages: [{ role: "user", content: "hi" }],
			tools: [
				{
					type: "function",
					function: { name: "weather", parameters: { type: "object" } },
				},
			],
			stream: true,
		},
		undefined,
		db,
	);
	const stream = await response.text();

	expect(response.headers.get("content-type")).toContain("text/event-stream");
	expect(stream).toContain('"content":"hello"');
	expect(stream).toContain('"tool_calls"');
	expect(stream).toContain('"finish_reason":"tool_calls"');
	expect(stream).toContain("data: [DONE]");
});

test("Anthropic Messages maps system, tools, output blocks and auth", async () => {
	const captured: { body?: Record<string, unknown>; headers?: Headers } = {};
	const calls = mockFetch((url, init) => {
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		captured.headers = new Headers(init.headers);
		captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
		return jsonResponse({
			id: "msg_1",
			model: "claude-3-7-sonnet-20250219",
			content: [
				{ type: "text", text: "Checking." },
				{
					type: "tool_use",
					id: "toolu_1",
					name: "weather",
					input: { city: "Lima" },
				},
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 5, output_tokens: 7 },
		});
	});

	const response = await sendChat(
		{
			platform: "anthropic",
			modelId: "claude-3-7-sonnet-20250219",
			apiKey: "anthropic-key",
			baseUrl: null,
			messages: [
				{ role: "system", content: "Be concise." },
				{ role: "user", content: "What is the weather?" },
			],
			tools: [
				{
					type: "function",
					function: {
						name: "weather",
						description: "Weather",
						parameters: { type: "object" },
					},
				},
			],
			stop: ["STOP"],
			stream: false,
		},
		undefined,
		db,
	);
	const result = (await response.json()) as ChatCompletionResponse;

	expect(calls).toHaveLength(1);
	expect(captured.headers?.get("authorization")).toBe("Bearer anthropic-key");
	expect(captured.headers?.get("anthropic-version")).toBe("2026-10-21");
	expect(captured.body?.system).toBe("Be concise.");
	expect(captured.body?.max_tokens).toBeGreaterThan(0);
	expect(captured.body?.stop_sequences).toEqual(["STOP"]);
	expect(result.choices[0].message.content).toBe("Checking.");
	expect(result.choices[0].message.tool_calls?.[0].id).toBe("toolu_1");
	expect(result.choices[0].finish_reason).toBe("tool_calls");
	expect(result.usage?.total_tokens).toBe(12);
});

test("Anthropic streaming events become OpenAI SSE chunks", async () => {
	const events = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_s",
					model: "claude-3-7-sonnet-20250219",
					usage: { input_tokens: 2 },
				},
			},
		],
		[
			"content_block_start",
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
		],
		[
			"content_block_delta",
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hi" },
			},
		],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			},
		],
		["message_stop", { type: "message_stop" }],
	] as const;
	const sse = events
		.map(
			([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
		)
		.join("");
	mockFetch(
		() =>
			new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
	);

	const response = await sendChat(
		{
			platform: "anthropic",
			modelId: "claude-3-7-sonnet-20250219",
			apiKey: "anthropic-key",
			baseUrl: null,
			messages: [{ role: "user", content: "hi" }],
			stream: true,
		},
		undefined,
		db,
	);
	const stream = await response.text();

	expect(stream).toContain('"content":"hi"');
	expect(stream).toContain('"finish_reason":"stop"');
	expect(stream).toContain("data: [DONE]");
});

test("AI Horde uses its anonymous sentinel and emits a buffered OpenAI stream", async () => {
	const captured: {
		authorization: string | null;
		body?: Record<string, unknown>;
	} = {
		authorization: null,
	};
	mockFetch((_url, init) => {
		captured.authorization = new Headers(init.headers).get("authorization");
		captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
		return jsonResponse({
			id: "horde_1",
			model: "aphrodite/TheDrummer/Cydonia-24B-v4.3",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "queued" },
					finish_reason: "stop",
				},
			],
			usage: { kudos: 1 },
		});
	});

	const response = await sendChat(
		{
			platform: "aihorde",
			modelId: "aphrodite/TheDrummer/Cydonia-24B-v4.3",
			apiKey: "no-key",
			baseUrl: null,
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			stop: "STOP",
		},
		undefined,
		db,
	);
	const stream = await response.text();

	expect(captured.authorization).toBe("Bearer 0000000000");
	expect(captured.body?.stream).toBeUndefined();
	expect(captured.body?.max_tokens).toBeGreaterThanOrEqual(16);
	expect(captured.body?.stop).toEqual(["STOP"]);
	expect(stream).toContain('"content":"queued"');
	expect(stream).toContain("data: [DONE]");
});

test("Cohere uses its compatibility path and removes unsupported tool schema keys", async () => {
	const captured: {
		url: string;
		authorization: string | null;
		body?: Record<string, unknown>;
	} = { url: "", authorization: null };
	mockFetch((requestUrl, init) => {
		captured.url = requestUrl;
		captured.authorization = new Headers(init.headers).get("authorization");
		captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
		return jsonResponse(chatResponse("command-a-reasoning-08-2025"));
	});
	await sendChat(
		{
			platform: "cohere",
			modelId: "command-a-reasoning-08-2025",
			apiKey: "cohere-key",
			baseUrl: null,
			messages: [{ role: "user", content: "hi" }],
			tools: [
				{
					type: "function",
					function: {
						name: "f",
						parameters: {
							type: "object",
							$schema: "ignored",
							additionalProperties: false,
							properties: { city: { type: "string" } },
						},
					},
				},
			],
			stream: false,
		},
		undefined,
		db,
	);

	expect(captured.url).toBe(
		"https://api.cohere.ai/compatibility/v1/chat/completions",
	);
	expect(captured.authorization).toBe("Bearer cohere-key");
	const sentBody = captured.body;
	if (
		!sentBody ||
		!Array.isArray(sentBody.tools) ||
		sentBody.tools.length === 0
	) {
		throw new Error("Cohere request tools were not captured");
	}
	const sentTools = sentBody.tools as Array<{
		function: { parameters: Record<string, unknown> };
	}>;
	expect(sentTools[0].function.parameters).toEqual({
		type: "object",
		properties: { city: { type: "string" } },
	});
});

test("Moondream rejects tool calls and remote image URLs instead of silently dropping them", async () => {
	let calls = 0;
	mockFetch(() => {
		calls += 1;
		return jsonResponse(chatResponse("moondream3.1-9B-A2B"));
	});

	await expect(
		sendChat(
			{
				platform: "moondream",
				modelId: "moondream3.1-9B-A2B",
				apiKey: "moondream-key",
				baseUrl: null,
				messages: [{ role: "user", content: "hi" }],
				tools: [
					{
						type: "function",
						function: { name: "f", parameters: { type: "object" } },
					},
				],
				stream: false,
			},
			undefined,
			db,
		),
	).rejects.toBeInstanceOf(ProviderError);

	await expect(
		sendChat(
			{
				platform: "moondream",
				modelId: "moondream3.1-9B-A2B",
				apiKey: "moondream-key",
				baseUrl: null,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image_url",
								image_url: { url: "https://example.com/image.png" },
							},
						],
					},
				],
				stream: false,
			},
			undefined,
			db,
		),
	).rejects.toBeInstanceOf(ProviderError);

	await expect(
		sendChat(
			{
				platform: "moondream",
				modelId: "moondream3.1-9B-A2B",
				apiKey: "moondream-key",
				baseUrl: null,
				messages: [{ role: "user", content: "hi" }],
				stop: "STOP",
				stream: false,
			},
			undefined,
			db,
		),
	).rejects.toMatchObject({ status: 400, kind: "bad_request" });
	expect(calls).toBe(0);
});

test("Moondream forwards inline vision over its OpenAI-compatible transport", async () => {
	const captured: {
		url: string;
		authorization: string | null;
		body?: Record<string, unknown>;
	} = {
		url: "",
		authorization: null,
	};
	mockFetch((url, init) => {
		captured.url = url;
		captured.authorization = new Headers(init.headers).get("authorization");
		captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
		return jsonResponse(
			chatResponse("moondream3.1-9B-A2B", "looks like a cat"),
		);
	});
	const response = await sendChat(
		{
			platform: "moondream",
			modelId: "moondream3.1-9B-A2B",
			apiKey: "moondream-key",
			baseUrl: null,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,AQID" },
						},
					],
				},
			],
			stream: false,
		},
		undefined,
		db,
	);
	const result = (await response.json()) as ChatCompletionResponse;
	expect(captured.url).toBe("https://api.moondream.ai/v1/chat/completions");
	expect(captured.authorization).toBe("Bearer moondream-key");
	expect(captured.body?.messages).toEqual([
		{
			role: "user",
			content: [
				{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
			],
		},
	]);
	expect(result.choices[0].message.content).toBe("looks like a cat");
});

test("routing skips a provider model that cannot accept requested tools", async () => {
	const db = await createParityDatabase();
	let calls = 0;
	mockFetch(() => {
		calls += 1;
		return jsonResponse(chatResponse("model-tools"));
	});
	try {
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind(USER.id, USER.name, USER.username, USER.passwordHash)
			.run();
		await db
			.prepare(
				"INSERT INTO models (platform, model_id, name, context_window, supports_tools, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind("aihorde", "model-text-only", "Text only", 8192, 0, 1, 1)
			.run();
		await db
			.prepare(
				"INSERT INTO models (platform, model_id, name, context_window, supports_tools, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind("groq", "model-tools", "Tools", 8192, 1, 2, 1)
			.run();
		const hordeKey = await createApiKey(
			db,
			{
				userId: USER.id,
				platform: "aihorde",
				rawKey: "no-key",
				keyLabel: null,
			},
			SECRET,
		);
		expect(hordeKey.maskedKey).toBe("No key");
		await createApiKey(
			db,
			{
				userId: USER.id,
				platform: "groq",
				rawKey: "provider-key",
				keyLabel: null,
			},
			SECRET,
		);

		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "model-text-only",
				messages: [{ role: "user", content: "hi" }],
				tools: [
					{
						type: "function",
						function: { name: "f", parameters: { type: "object" } },
					},
				],
			},
		});

		expect(result.response.status).toBe(200);
		expect(result.modelId).toBe("model-tools");
		expect(calls).toBe(1);
	} finally {
		db.close();
	}
});

test("routing skips models that cannot accept inline vision", async () => {
	const db = await createParityDatabase();
	const googleModel = {
		id: "gemini-vision-fixture",
		name: "Vision fixture",
		contextWindow: 32000,
		supportsFunctions: true,
		intelligenceRank: null,
	};
	const urls = mockFetch((_url) => {
		return jsonResponse({
			candidates: [
				{
					content: { parts: [{ text: "looks like a cat" }] },
					finishReason: "STOP",
				},
			],
			usageMetadata: {
				promptTokenCount: 4,
				candidatesTokenCount: 3,
				totalTokenCount: 7,
			},
		});
	});
	try {
		await db
			.prepare(
				"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
			)
			.bind(USER.id, USER.name, USER.username, USER.passwordHash)
			.run();
		await db
			.prepare(
				"INSERT INTO models (platform, model_id, name, context_window, supports_tools, supports_vision, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.bind("groq", "model-text", "Text only", 8192, 0, 0, 1, 1)
			.run();
		await db
			.prepare(
				"INSERT INTO models (platform, model_id, name, context_window, supports_tools, supports_vision, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				"google",
				googleModel.id,
				googleModel.name,
				googleModel.contextWindow ?? 0,
				Number(googleModel.supportsFunctions),
				1,
				googleModel.intelligenceRank ?? null,
				1,
			)
			.run();
		await createApiKey(
			db,
			{ userId: USER.id, platform: "groq", rawKey: "groq-key", keyLabel: null },
			SECRET,
		);
		await createApiKey(
			db,
			{
				userId: USER.id,
				platform: "google",
				rawKey: "google-key",
				keyLabel: null,
			},
			SECRET,
		);

		const result = await routeChatCompletion({
			db,
			secret: SECRET,
			user: USER,
			request: {
				model: "model-text",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image_url",
								image_url: { url: "data:image/png;base64,AQID" },
							},
						],
					},
				],
			},
		});
		expect(result.response.status).toBe(200);
		expect(result.platform).toBe("google");
		expect(result.modelId).toBe(googleModel.id);
		expect(urls).toEqual([
			`https://generativelanguage.googleapis.com/v1beta/models/${googleModel.id}:generateContent`,
		]);
	} finally {
		db.close();
	}
});
