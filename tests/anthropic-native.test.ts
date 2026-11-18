import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { createApiKey, sha256Hex } from "../src/lib/key-store";
import {
	canMakeRequest,
	finalizeUsage,
	recordUsage,
} from "../src/lib/ratelimit";
import {
	observeStreamUsage,
	type StreamUsageResult,
} from "../src/lib/stream-usage";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

interface NativeReply {
	type: string;
	content: Array<{ text?: string }>;
	usage: {
		output_tokens: number;
		shtora_estimated: { input_tokens: boolean; output_tokens: boolean };
	};
}
const SECRET = "native-contract-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
let db: MemoryD1;
let token = "";
const originalFetch = globalThis.fetch;
mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => SECRET,
	getImagesBucket: () => {
		throw new Error("IMAGES_BUCKET is unavailable in this test");
	},
}));
// Load routes only after replacing their unavailable Cloudflare binding module.
const { POST } = await import("../src/app/v1/messages/route");
const { POST: countTokens } = await import(
	"../src/app/v1/messages/count_tokens/route"
);
const { GET: listModels } = await import("../src/app/v1/models/route");
const { GET: getModel } = await import("../src/app/v1/models/[...model]/route");

beforeEach(async () => {
	db = await createParityDatabase();
	// The native endpoint lists every enabled model ordered by platform, so
	// the tests pin a minimal catalog: keep only the Anthropic rows from
	// migration 0005 (the endpoint's own models) and the groq fixture below.
	// Without this, the 303 migrated catalog rows sort first (platform
	// `agnes`, ...) and change pagination/routing assertions.
	await db.prepare("DELETE FROM models WHERE platform != 'anthropic'").run();
	await db
		.prepare(
			"INSERT INTO user (id,name,username,password_hash) VALUES ('native-user','Native','native','unused')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO user (id,name,username,password_hash) VALUES ('foreign-user','Foreign','foreign','unused')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO models (platform,model_id,name,context_window,supports_tools,supports_vision) VALUES ('groq','common-model','Common',32000,1,1)",
		)
		.run();
	const key = await createApiKey(
		db,
		{ userId: "native-user", platform: "groq", rawKey: "groq-upstream" },
		SECRET,
	);
	token = key.unifiedToken as string;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	db.close();
});
afterAll(() => {
	mock.restore();
});

function request(
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
) {
	return new Request("https://gateway.test/v1/messages?beta=true", {
		method: "POST",
		headers: {
			"x-api-key": token,
			"anthropic-version": "2026-10-21",
			"content-type": "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	});
}
const input = {
	model: "groq/common-model",
	max_tokens: 128,
	messages: [{ role: "user", content: "Hello" }],
};
function completion(usage?: Record<string, unknown>) {
	return Response.json({
		id: "chat-1",
		model: "common-model",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: "Hello world" },
				finish_reason: "stop",
			},
		],
		...(usage ? { usage } : {}),
	});
}
function upstream(
	fn: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) =>
		fn(String(url), init ?? {})) as typeof fetch;
}
async function directKey() {
	return createApiKey(
		db,
		{ userId: "native-user", platform: "anthropic", rawKey: "native-upstream" },
		SECRET,
	);
}
function sse(type: string, body: Record<string, unknown> = {}) {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
}

test("public native route translates ordinary messages and marks unknown token counts", async () => {
	let calls = 0;
	upstream((url, init) => {
		calls++;
		expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
		expect(new Headers(init.headers).get("authorization")).toBe(
			"Bearer groq-upstream",
		);
		expect(JSON.parse(String(init.body)).messages).toEqual(input.messages);
		return completion();
	});
	const response = await POST(request(input));
	expect(response.status).toBe(200);
	const body = (await response.json()) as NativeReply;
	expect(body.type).toBe("message");
	expect(body.content[0].text).toBe("Hello world");
	expect(body.usage.output_tokens).toBeGreaterThan(0);
	expect(body.usage.shtora_estimated).toEqual({
		input_tokens: true,
		output_tokens: true,
	});
	expect(calls).toBe(1);
	const metrics = await db
		.prepare(
			"SELECT requests,successful_requests,output_tokens FROM user_usage_metrics WHERE user_id='native-user'",
		)
		.first();
	expect(metrics).toMatchObject({
		requests: 1,
		successful_requests: 1,
		output_tokens: 3,
	});
});

test("native auth rejects conflicts/foreign keys and malformed/oversized bodies without upstream calls", async () => {
	upstream(() => {
		throw new Error("Must not call upstream");
	});
	expect(
		(await POST(request(input, { authorization: "Bearer different" }))).status,
	).toBe(401);
	expect((await POST(request(input, { "x-api-key": "invalid" }))).status).toBe(
		401,
	);
	const malformed = new Request("https://gateway.test/v1/messages", {
		method: "POST",
		headers: { "x-api-key": token, "anthropic-version": "2026-10-21" },
		body: "{",
	});
	expect((await POST(malformed)).status).toBe(400);
	const response = await POST(
		request({ ...input, extra: "x".repeat(1_000_000) }),
	);
	expect(response.status).toBe(413);
	expect(
		((await response.json()) as { error: { type: string } }).error.type,
	).toBe("request_too_large");
	await createApiKey(
		db,
		{
			userId: "foreign-user",
			platform: "anthropic",
			rawKey: "foreign-upstream",
		},
		SECRET,
	);
	const unavailable = await POST(
		request({
			...input,
			model: "anthropic/claude-opus-5-5",
			thinking: { type: "adaptive" },
		}),
	);
	expect(unavailable.status).toBe(502);
});

test("native pass-through retains opaque options/content/headers and rejects lossy targets", async () => {
	await directKey();
	const body = {
		model: "anthropic/claude-opus-5-5",
		max_tokens: 0,
		system: [
			{ type: "text", text: "System", cache_control: { type: "ephemeral" } },
		],
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private", signature: "signed" },
					{ type: "tool_use", id: "t1", name: "f", input: {} },
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						is_error: true,
						content: [{ type: "text", text: "failed" }],
					},
				],
			},
		],
		thinking: { type: "adaptive" },
		output_config: { effort: "high" },
		future_option: { opaque: true },
	};
	const native = {
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "claude-opus-5-5",
		content: [{ type: "redacted_thinking", data: "opaque" }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: 4,
			cache_read_input_tokens: 10,
			cache_creation_input_tokens: 2,
			output_tokens: 1,
		},
	};
	upstream((url, init) => {
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		expect(JSON.parse(String(init.body))).toEqual({
			...body,
			model: "claude-opus-5-5",
		});
		const h = new Headers(init.headers);
		expect(h.get("anthropic-beta")).toBe("future-beta");
		expect(h.get("anthropic-workspace-id")).toBe("workspace");
		expect(h.get("authorization")).toBe("Bearer native-upstream");
		expect(h.has("x-api-key")).toBe(false);
		return Response.json(native);
	});
	expect(
		await (
			await POST(
				request(body, {
					"anthropic-beta": "future-beta",
					"anthropic-workspace-id": "workspace",
				}),
			)
		).json(),
	).toEqual(native);
	expect(
		await db
			.prepare(
				"SELECT input_tokens FROM provider_requests WHERE status='success'",
			)
			.first(),
	).toMatchObject({ input_tokens: 16 });
	expect(
		(await POST(request({ ...body, model: "groq/common-model" }))).status,
	).toBe(400);
});

test("parallel tool calls/results preserve IDs, user text and explicit tool choice", async () => {
	const body = {
		...input,
		tools: [{ name: "f", input_schema: { type: "object" } }],
		tool_choice: { type: "any", disable_parallel_tool_use: false },
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Calling" },
					{ type: "tool_use", id: "a", name: "f", input: { n: 1 } },
					{ type: "tool_use", id: "b", name: "f", input: { n: 2 } },
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "a", content: "one" },
					{ type: "tool_result", tool_use_id: "b", content: "two" },
					{ type: "text", text: "Continue" },
				],
			},
		],
	};
	upstream((_url, init) => {
		const data = JSON.parse(String(init.body));
		expect(data.tool_choice).toBe("required");
		expect(data.parallel_tool_calls).toBe(true);
		expect(
			data.messages.map((message: { role: string }) => message.role),
		).toEqual(["assistant", "tool", "tool", "user"]);
		expect(
			data.messages[0].tool_calls.map((call: { id: string }) => call.id),
		).toEqual(["a", "b"]);
		return completion({ prompt_tokens: 12, completion_tokens: 5 });
	});
	const response = await POST(request(body));
	expect(response.status).toBe(200);
	expect(
		((await response.json()) as NativeReply).usage.shtora_estimated,
	).toEqual({
		input_tokens: false,
		output_tokens: false,
	});
});

test("token counting is real, model-specific and never counted as inference", async () => {
	await directKey();
	upstream((url) => {
		expect(url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
		return Response.json({ input_tokens: 37 });
	});
	const response = await countTokens(
		request({ model: "anthropic/claude-opus-5-5", messages: input.messages }),
	);
	expect(await response.json()).toEqual({ input_tokens: 37 });
	expect(
		await db.prepare("SELECT COUNT(*) AS n FROM provider_requests").first(),
	).toMatchObject({ n: 0 });
	expect(
		(
			await countTokens(
				request({ model: "groq/common-model", messages: input.messages }),
			)
		).status,
	).toBe(400);
});

test("native errors retain validation wording/retry/request ID without leaking selected key", async () => {
	await directKey();
	upstream(() =>
		Response.json(
			{
				type: "error",
				error: {
					type: "invalid_request_error",
					message:
						"context_management: Extra inputs are not permitted native-upstream",
				},
				request_id: "req_vendor",
			},
			{
				status: 400,
				headers: { "request-id": "req_vendor", "retry-after": "2" },
			},
		),
	);
	const response = await POST(
		request({
			...input,
			model: "anthropic/claude-opus-5-5",
			context_management: {},
		}),
	);
	expect(response.status).toBe(400);
	expect(response.headers.get("request-id")).toBe("req_vendor");
	expect(response.headers.get("retry-after")).toBe("2");
	expect(
		((await response.json()) as { error: { message: string } }).error.message,
	).toBe("context_management: Extra inputs are not permitted [redacted]");
});

test("native SSE relays byte-for-byte, cumulative cache usage replaces earlier counters, failed TTFT excluded", async () => {
	await directKey();
	for (const complete of [true, false]) {
		const wire =
			sse("message_start", {
				message: {
					usage: {
						input_tokens: 2,
						cache_read_input_tokens: 3,
						output_tokens: 1,
					},
				},
			}) +
			sse("ping") +
			sse("content_block_delta", {
				index: 0,
				delta: { type: "thinking_delta", thinking: "ação" },
			}) +
			sse("content_block_delta", {
				index: 0,
				delta: { type: "signature_delta", signature: "signed" },
			}) +
			sse("future_event", { opaque: true }) +
			sse("message_delta", {
				delta: { stop_reason: "end_turn" },
				usage: {
					input_tokens: 7,
					cache_read_input_tokens: 5,
					cache_creation_input_tokens: 4,
					output_tokens: 9,
				},
			}) +
			(complete
				? sse("message_stop")
				: sse("error", {
						error: { type: "overloaded_error", message: "Unavailable" },
					}));
		const bytes = new TextEncoder().encode(wire);
		upstream(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (let i = 0; i < bytes.length; i += 7)
								controller.enqueue(bytes.slice(i, i + 7));
							controller.close();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const response = await POST(
			request({
				...input,
				model: "anthropic/claude-opus-5-5",
				stream: true,
				thinking: { type: "adaptive" },
			}),
		);
		expect(await response.text()).toBe(wire);
		const row = await db
			.prepare(
				"SELECT input_tokens,output_tokens,status,ttft_ms FROM provider_requests ORDER BY id DESC LIMIT 1",
			)
			.first();
		expect(row).toMatchObject({
			input_tokens: 16,
			output_tokens: 9,
			status: complete ? "success" : "error",
		});
		expect(row?.ttft_ms === null).toBe(!complete);
	}
	expect(
		await db
			.prepare(
				"SELECT requests,successful_requests,ttft_count FROM user_usage_metrics WHERE user_id='native-user'",
			)
			.first(),
	).toMatchObject({ requests: 2, successful_requests: 1, ttft_count: 1 });
});

test("translated SSE waits for final usage; truncation emits error without fabricated message_stop", async () => {
	for (const done of [true, false]) {
		const wire =
			'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n' +
			'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
			(done
				? 'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":8}}\n\ndata: [DONE]\n\n'
				: "");
		upstream(
			() =>
				new Response(wire, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const response = await POST(request({ ...input, stream: true }));
		const text = await response.text();
		expect(text.includes("event: message_stop")).toBe(done);
		expect(text.includes("event: error")).toBe(!done);
		if (done) expect(text).toContain('"output_tokens":8');
	}
});

test("observer cancellation finalizes once and never claims successful TTFT", async () => {
	let cancelled = false;
	const results: StreamUsageResult[] = [];
	const stream = observeStreamUsage(
		new ReadableStream({
			pull(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						sse("content_block_delta", {
							delta: { type: "text_delta", text: "first" },
						}),
					),
				);
			},
			cancel() {
				cancelled = true;
			},
		}),
		8,
		performance.now(),
		(usage) => {
			results.push(usage);
		},
		"anthropic",
	);
	const reader = stream.getReader();
	await reader.read();
	await reader.cancel();
	expect(cancelled).toBe(true);
	expect(results).toHaveLength(1);
	expect(results[0].completed).toBe(false);
});

test("original token receipt survives reset and cannot modify concurrent reservations", async () => {
	const key = await db
		.prepare("SELECT id FROM api_keys WHERE unified_token = ?")
		.bind(await sha256Hex(token))
		.first<{ id: number }>();
	if (!key) throw new Error("Missing key");
	const clock = spyOn(Date, "now").mockReturnValue(
		Date.parse("2026-11-13T23:59:59Z"),
	);
	try {
		const receipt = await recordUsage(db, {
			platform: "groq",
			modelId: "common-model",
			keyId: key.id,
			inputTokens: 4,
			outputTokens: 0,
		});
		clock.mockReturnValue(Date.parse("2026-11-14T00:01:01Z"));
		const concurrent = await recordUsage(db, {
			platform: "groq",
			modelId: "common-model",
			keyId: key.id,
			inputTokens: 7,
			outputTokens: 1,
		});
		await finalizeUsage(db, receipt, 20);
		await finalizeUsage(db, receipt, 20);
		expect(
			await db
				.prepare(
					"SELECT tokens,created_at_ms FROM provider_rate_limit_usage WHERE rowid=?",
				)
				.bind(receipt.rowId)
				.first(),
		).toMatchObject({ tokens: 20, created_at_ms: receipt.createdAtMs });
		expect(
			await db
				.prepare("SELECT tokens FROM provider_rate_limit_usage WHERE rowid=?")
				.bind(concurrent.rowId)
				.first(),
		).toMatchObject({ tokens: 8 });
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM provider_rate_limit_usage WHERE kind='request'",
				)
				.first(),
		).toMatchObject({ n: 2 });
		expect(
			(
				await canMakeRequest(db, {
					platform: "groq",
					modelId: "common-model",
					keyId: key.id,
					estTokens: 2,
					tpmLimit: 10,
					tpdLimit: 10,
				})
			).ok,
		).toBe(true);
		expect(
			(
				await canMakeRequest(db, {
					platform: "groq",
					modelId: "common-model",
					keyId: key.id,
					estTokens: 3,
					tpmLimit: 10,
					tpdLimit: 10,
				})
			).ok,
		).toBe(false);
		await expect(finalizeUsage(db, receipt, -1)).rejects.toThrow(
			"Invalid token total",
		);
		await db.prepare("DELETE FROM provider_rate_limit_usage").run();
		const reused = await recordUsage(db, {
			platform: "groq",
			modelId: "common-model",
			keyId: key.id,
			inputTokens: 7,
			outputTokens: 1,
		});
		expect(reused.rowId).toBe(receipt.rowId);
		await finalizeUsage(db, receipt, 99);
		expect(
			await db
				.prepare("SELECT tokens FROM provider_rate_limit_usage WHERE rowid=?")
				.bind(reused.rowId)
				.first(),
		).toMatchObject({ tokens: 8 });
	} finally {
		clock.mockRestore();
	}
});

test("native model pagination/retrieval coexists with unchanged OpenAI list", async () => {
	const native = await listModels(
		new Request("https://gateway.test/v1/models?limit=2", {
			headers: {
				authorization: `Bearer ${token}`,
				"anthropic-version": "2026-10-21",
			},
		}),
	);
	const page = (await native.json()) as {
		data: Array<{ type: string; max_tokens: number }>;
		has_more: boolean;
	};
	expect(page.data).toHaveLength(2);
	expect(page.has_more).toBe(true);
	expect(page.data[0].type).toBe("model");
	expect(page.data[0].max_tokens).toBe(128000);
	const retrieve = await getModel(
		new Request("https://gateway.test/v1/models/anthropic%2Fclaude-opus-5-5", {
			headers: { "x-api-key": token },
		}),
		{ params: Promise.resolve({ model: ["anthropic/claude-opus-5-5"] }) },
	);
	expect(((await retrieve.json()) as { id: string }).id).toBe(
		"anthropic/claude-opus-5-5",
	);
	const openai = await listModels(
		new Request("https://gateway.test/v1/models", {
			headers: { authorization: `Bearer ${token}` },
		}),
	);
	expect(((await openai.json()) as { object: string }).object).toBe("list");
});

test("forward catalog migration preserves active enabled state and frozen historical rates", async () => {
	await db
		.prepare(
			"UPDATE models SET enabled=0 WHERE platform='anthropic' AND model_id='claude-opus-5-5'",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO models (platform,model_id,name,context_window) VALUES ('anthropic','claude-3-7-sonnet-20250219','Retired',200000)",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO provider_requests (user_id,model_requested,model_routed,platform,key_id,status,input_tokens,output_tokens,input_rate_usd_per_million,output_rate_usd_per_million) VALUES ('native-user','claude-opus-5-5','claude-opus-5-5','anthropic',1,'success',10,5,9,11)",
		)
		.run();
	db.exec(readFileSync("migrations/0005_anthropic_catalog.sql", "utf8"));
	expect(
		await db
			.prepare("SELECT enabled FROM models WHERE model_id='claude-opus-5-5'")
			.first(),
	).toMatchObject({ enabled: 0 });
	expect(
		await db
			.prepare(
				"SELECT enabled FROM models WHERE model_id='claude-3-7-sonnet-20250219'",
			)
			.first(),
	).toMatchObject({ enabled: 0 });
	expect(
		await db
			.prepare(
				"SELECT input_usd_per_million,output_usd_per_million FROM usage_metric_pricing WHERE model_routed='claude-opus-5-5'",
			)
			.first(),
	).toMatchObject({ input_usd_per_million: 4, output_usd_per_million: 20 });
	expect(
		await db
			.prepare(
				"SELECT input_rate_usd_per_million,output_rate_usd_per_million FROM provider_requests",
			)
			.first(),
	).toMatchObject({
		input_rate_usd_per_million: 9,
		output_rate_usd_per_million: 11,
	});
});

test("unknown native IDs return404, explicit IDs stay pinned, auto alone uses the pool", async () => {
	let calls = 0;
	upstream(() => {
		calls++;
		return completion({ prompt_tokens: 4, completion_tokens: 2 });
	});
	expect(
		(await POST(request({ ...input, model: "missing-model" }))).status,
	).toBe(404);
	expect(calls).toBe(0);
	expect((await POST(request({ ...input, model: "auto" }))).status).toBe(200);
	expect(calls).toBe(1);
	await directKey();
	upstream((url) => {
		expect(url).toContain("api.groq.com");
		return new Response("failure", { status: 500 });
	});
	expect((await POST(request(input))).status).toBe(502);
});
