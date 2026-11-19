import { expect, test } from "bun:test";
import {
	type ChatAttempt,
	ChatResponseError,
	readChatResponse,
} from "./chat-response";

function streamResponse(text: string, chunkSize = 1) {
	const bytes = new TextEncoder().encode(text);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < bytes.length; offset += chunkSize) {
					controller.enqueue(bytes.slice(offset, offset + chunkSize));
				}
				controller.close();
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

test("reads split UTF-8, CRLF, multiline data, and OpenAI deltas", async () => {
	const updates: string[] = [];
	const response = streamResponse(
		': heartbeat\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"Hello 🌍"}}]}\r\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n',
	);
	expect(await readChatResponse(response, (text) => updates.push(text))).toBe(
		"Hello 🌍!",
	);
	expect(updates).toEqual(["Hello 🌍", "Hello 🌍!"]);
});

test("stops at DONE without waiting for the upstream connection to close", async () => {
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\ndata: {ignored}\n\n',
					),
				);
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
	expect(await readChatResponse(response, () => {})).toBe("Done");
}, 1000);

test("reports stream errors after partial text", async () => {
	const updates: string[] = [];
	const response = streamResponse(
		'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\nevent: error\ndata: {"error":{"message":"Provider disconnected"}}\n\n',
		7,
	);
	await expect(
		readChatResponse(response, (text) => updates.push(text)),
	).rejects.toThrow("Provider disconnected");
	expect(updates).toEqual(["Partial"]);
});

test("rejects a stream that ends without completion", async () => {
	await expect(
		readChatResponse(
			streamResponse('data: {"choices":[{"delta":{"content":"Cut off"}}]}\n\n'),
			() => {},
		),
	).rejects.toThrow("ended before it completed");
});

test("rejects malformed events rather than silently losing output", async () => {
	await expect(
		readChatResponse(
			streamResponse("data: {invalid}\n\ndata: [DONE]\n\n"),
			() => {},
		),
	).rejects.toThrow("invalid response");
});

test("accepts a non-streamed completion and rejects JSON errors even with HTTP 200", async () => {
	const completion = Response.json({
		choices: [{ message: { content: "Complete answer" } }],
	});
	expect(await readChatResponse(completion, () => {})).toBe("Complete answer");
	await expect(
		readChatResponse(
			Response.json({ error: { message: "No available keys" } }),
			() => {},
		),
	).rejects.toThrow("No available keys");
});

test("reports non-JSON HTTP failures and empty completions", async () => {
	await expect(
		readChatResponse(new Response("Bad gateway", { status: 502 }), () => {}),
	).rejects.toThrow("502");
	await expect(
		readChatResponse(streamResponse("data: [DONE]\n\n"), () => {}),
	).rejects.toThrow("no text");
});

test("error bodies with a debug attempt log throw ChatResponseError", async () => {
	const attempts: ChatAttempt[] = [
		{
			platform: "groq",
			modelId: "model-a",
			status: 500,
			kind: "server",
			latencyMs: 120,
			phase: "member",
		},
	];
	const response = Response.json(
		{
			error: { message: "All configured upstream providers are unavailable." },
			debug: { attempts },
		},
		{ status: 502 },
	);
	let caught: unknown;
	try {
		await readChatResponse(response, () => {});
	} catch (cause) {
		caught = cause;
	}
	expect(caught).toBeInstanceOf(ChatResponseError);
	expect((caught as ChatResponseError).attempts).toEqual(attempts);
	expect((caught as Error).message).toBe(
		"All configured upstream providers are unavailable.",
	);
});

test("malformed debug attempts fall back to a plain error", async () => {
	const response = Response.json(
		{
			error: { message: "All configured upstream providers are unavailable." },
			debug: { attempts: [{ platform: "groq" }] },
		},
		{ status: 502 },
	);
	let caught: unknown;
	try {
		await readChatResponse(response, () => {});
	} catch (cause) {
		caught = cause;
	}
	expect(caught).toBeInstanceOf(Error);
	expect(caught).not.toBeInstanceOf(ChatResponseError);
});
