import Anthropic, {
	type APIError as AnthropicAPIError,
} from "@anthropic-ai/sdk";
import { isValidTokenCount } from "../token-estimates";
import type {
	ChatCompletionResponse,
	ChatFinishReason,
	ChatMessage,
	ChatTool,
} from "../types";
import { hasImageContent, textFromContent } from "./content";
import { classifyStatus, ProviderError, parseRetryAfterMs } from "./errors";
import { openAiChunk, openAiUsageChunk, sseResponse } from "./sse";
import type { UpstreamChatInput } from "./types";

/**
 * The Anthropic path talks to the Messages API through the official SDK,
 * not through a hand-rolled fetch. The SDK owns the HTTP layer (auth
 * header, `anthropic-version`, SSE parsing, status errors); this file
 * keeps only the project-specific parts: translating the OpenAI-shaped
 * `UpstreamChatInput` into Messages params, and translating the
 * Anthropic answer back into OpenAI-shaped chunks. The native
 * byte-for-byte relay (`/v1/messages` passthrough in
 * `providers/index.ts:sendNativeMessages`) stays manual on purpose and
 * does not use this file.
 *
 * Wire behavior is unchanged from the manual implementation, with one
 * exception: `temperature` is no longer forwarded (see
 * `buildAnthropicParams` — the pinned API version does not accept it).
 * The SDK sends `Authorization: Bearer <key>` and `anthropic-version:
 * 2026-10-21` (its default since 1.10.0), and `maxRetries: 0` so SDK
 * retries never fight the router's own failover.
 */

function parseToolArguments(raw: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ProviderError(
			"Invalid function-call arguments",
			400,
			"bad_request",
		);
	}
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
		return parsed as Record<string, unknown>;
	return { value: parsed };
}

function appendMessage(
	messages: Anthropic.MessageParam[],
	role: "user" | "assistant",
	content: Anthropic.MessageParam["content"],
): void {
	const previous = messages[messages.length - 1];
	if (previous?.role === role) {
		const previousContent = previous.content;
		if (Array.isArray(previousContent) && Array.isArray(content))
			previousContent.push(...content);
	} else messages.push({ role, content } as Anthropic.MessageParam);
}

function buildAnthropicParams(
	input: UpstreamChatInput,
): Omit<Anthropic.MessageCreateParamsNonStreaming, "stream"> {
	const system: string[] = [];
	const messages: Anthropic.MessageParam[] = [];
	for (const message of input.messages) {
		if (message.role === "system") {
			if (hasImageContent(message.content))
				throw new ProviderError(
					"System messages cannot contain images",
					400,
					"bad_request",
				);
			const text = textFromContent(message.content);
			if (text) system.push(text);
			continue;
		}
		if (message.role === "tool") {
			if (!message.tool_call_id)
				throw new ProviderError(
					"Tool result is missing its function call",
					400,
					"bad_request",
				);
			appendMessage(messages, "user", [
				{
					type: "tool_result",
					tool_use_id: message.tool_call_id,
					content: textFromContent(message.content),
				},
			]);
			continue;
		}
		if (hasImageContent(message.content))
			throw new ProviderError(
				"Anthropic Messages image input is not yet supported",
				400,
				"bad_request",
			);
		const role = message.role === "assistant" ? "assistant" : "user";
		const blocks: Anthropic.ContentBlockParam[] = [];
		const text = textFromContent(message.content);
		if (text) blocks.push({ type: "text", text });
		if (message.role === "assistant") {
			for (const call of message.tool_calls ?? []) {
				blocks.push({
					type: "tool_use",
					id: call.id,
					name: call.function.name,
					input: parseToolArguments(call.function.arguments),
				});
			}
		}
		if (blocks.length) appendMessage(messages, role, blocks);
	}

	const params: Omit<Anthropic.MessageCreateParamsNonStreaming, "stream"> = {
		model: input.modelId,
		max_tokens: input.maxTokens ?? 1024,
		messages,
	};
	if (system.length) params.system = system.join("\n\n");
	// No temperature: the SDK targets anthropic-version 2026-10-21, which
	// does not accept temperature/top_p/top_k (the native request parser
	// rejects them for that version too), so the SDK has no such param.
	// The old manual code forwarded temperature and the real API answered
	// 400; dropping it makes the request succeed instead of failing over.
	if (input.stop !== undefined) {
		params.stop_sequences = Array.isArray(input.stop)
			? input.stop
			: [input.stop];
	}
	if (input.tools?.length) {
		params.tools = input.tools.map((tool: ChatTool) => ({
			name: tool.function.name,
			...(tool.function.description
				? { description: tool.function.description }
				: {}),
			input_schema: tool.function.parameters as Anthropic.Tool["input_schema"],
		}));
	}
	return params;
}

function finishReason(reason: string | null | undefined): ChatFinishReason {
	if (reason === "max_tokens") return "length";
	if (reason === "tool_use") return "tool_calls";
	return "stop";
}

function normalizeAnthropicResponse(
	data: Anthropic.Message,
	modelId: string,
): ChatCompletionResponse {
	const text: string[] = [];
	const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
	for (const block of data.content ?? []) {
		if (block.type === "text" && typeof block.text === "string")
			text.push(block.text);
		if (block.type === "tool_use" && block.id && block.name) {
			toolCalls.push({
				id: block.id,
				type: "function",
				function: {
					name: block.name,
					arguments: JSON.stringify(block.input ?? {}),
				},
			});
		}
	}
	const prompt = isValidTokenCount(data.usage?.input_tokens)
		? data.usage.input_tokens
		: null;
	const completion = isValidTokenCount(data.usage?.output_tokens)
		? data.usage.output_tokens
		: null;
	const total =
		prompt !== null &&
		completion !== null &&
		Number.isSafeInteger(prompt + completion)
			? prompt + completion
			: undefined;
	const usage =
		prompt === null && completion === null
			? undefined
			: {
					...(prompt !== null ? { prompt_tokens: prompt } : {}),
					...(completion !== null ? { completion_tokens: completion } : {}),
					...(total !== undefined ? { total_tokens: total } : {}),
				};
	return {
		id: data.id ?? `anthropic-${crypto.randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: modelId,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: text.join("") || null,
					...(toolCalls.length ? { tool_calls: toolCalls } : {}),
				},
				finish_reason: finishReason(data.stop_reason),
			},
		],
		...(usage ? { usage } : {}),
	};
}

/**
 * SDK stream errors surface differently from the old manual SSE mapper:
 * an upstream `error` SSE event makes the SDK throw an `APIError`
 * instead of yielding an event, so the loop catches it and emits the
 * same error chunk + `[DONE]` the manual mapper emitted. An abort (the
 * router's timeout signal) just closes the stream without `[DONE]`,
 * same as a cut connection.
 */
function streamAnthropicResponse(
	input: UpstreamChatInput,
	stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
): Response {
	const id = `anthropic-${crypto.randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	const encoder = new TextEncoder();
	const toolIndexes = new Map<number, number>();
	let nextToolIndex = 0;
	let finalReason: ChatFinishReason | null = null;
	let emittedRole = false;
	let finished = false;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit = (text: string) => controller.enqueue(encoder.encode(text));
			const emitRole = () => {
				if (emittedRole) return;
				emittedRole = true;
				emit(
					openAiChunk(id, created, input.modelId, { role: "assistant" }, null),
				);
			};
			const finish = () => {
				if (finished) return;
				finished = true;
				emit(
					openAiChunk(id, created, input.modelId, {}, finalReason ?? "stop"),
				);
				emit("data: [DONE]\n\n");
			};
			try {
				for await (const event of stream) {
					emitRole();
					if (event.type === "message_start") {
						const inputTokens = event.message.usage?.input_tokens;
						if (isValidTokenCount(inputTokens)) {
							emit(
								openAiUsageChunk(id, created, input.modelId, {
									prompt_tokens: inputTokens,
								}),
							);
						}
					} else if (event.type === "content_block_start") {
						const block = event.content_block;
						if (
							block?.type === "tool_use" &&
							typeof event.index === "number" &&
							block.id &&
							block.name
						) {
							const index = nextToolIndex++;
							toolIndexes.set(event.index, index);
							emit(
								openAiChunk(
									id,
									created,
									input.modelId,
									{
										tool_calls: [
											{
												index,
												id: block.id,
												type: "function",
												function: { name: block.name, arguments: "" },
											},
										],
									},
									null,
								),
							);
						}
					} else if (event.type === "content_block_delta") {
						const delta = event.delta;
						if (
							delta?.type === "text_delta" &&
							typeof delta.text === "string"
						) {
							emit(
								openAiChunk(
									id,
									created,
									input.modelId,
									{ content: delta.text },
									null,
								),
							);
						} else if (
							delta?.type === "input_json_delta" &&
							typeof delta.partial_json === "string" &&
							typeof event.index === "number"
						) {
							const index = toolIndexes.get(event.index);
							if (index !== undefined) {
								emit(
									openAiChunk(
										id,
										created,
										input.modelId,
										{
											tool_calls: [
												{
													index,
													function: { arguments: delta.partial_json },
												},
											],
										},
										null,
									),
								);
							}
						}
					} else if (event.type === "message_delta") {
						if (typeof event.delta?.stop_reason === "string")
							finalReason = finishReason(event.delta.stop_reason);
						const outputTokens = event.usage?.output_tokens;
						if (isValidTokenCount(outputTokens)) {
							emit(
								openAiUsageChunk(id, created, input.modelId, {
									completion_tokens: outputTokens,
								}),
							);
						}
					} else if (event.type === "message_stop") {
						finish();
					}
				}
			} catch (error) {
				if (
					error instanceof Anthropic.APIUserAbortError ||
					(error instanceof Error && error.name === "AbortError")
				) {
					controller.close();
					return;
				}
				emitRole();
				emit(
					`data: ${JSON.stringify({ error: { message: "Upstream provider error", type: "server_error" } })}\n\n`,
				);
				finish();
				controller.close();
				return;
			}
			emitRole();
			finish();
			controller.close();
		},
	});
	return sseResponse(body);
}

function toProviderError(error: AnthropicAPIError): ProviderError {
	const status = error.status ?? 502;
	const retryAfterMs =
		status === 429
			? parseRetryAfterMs(error.headers?.get("retry-after") ?? null)
			: undefined;
	return new ProviderError(
		`Upstream ${status}`,
		status,
		classifyStatus(status),
		retryAfterMs,
	);
}

function anthropicClient(input: UpstreamChatInput, baseUrl: string): Anthropic {
	// The SDK appends `/v1/messages` to baseURL itself, so the catalog
	// base URL (`https://api.anthropic.com/v1`) has its trailing `/v1`
	// stripped; anything else is used as the API root as-is.
	return new Anthropic({
		apiKey: input.apiKey,
		baseURL: baseUrl.replace(/\/v1\/?$/, ""),
		maxRetries: 0,
	});
}

export async function sendAnthropic(
	input: UpstreamChatInput,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<Response> {
	const client = anthropicClient(input, baseUrl);
	const params = buildAnthropicParams(input);
	if (input.stream) {
		let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
		try {
			stream = await client.messages.create(
				{ ...params, stream: true },
				{ signal, maxRetries: 0 },
			);
		} catch (error) {
			if (error instanceof Anthropic.APIError) throw toProviderError(error);
			throw error;
		}
		return streamAnthropicResponse(input, stream);
	}
	let message: Anthropic.Message;
	try {
		message = await client.messages.create(
			{ ...params, stream: false },
			{ signal, maxRetries: 0 },
		);
	} catch (error) {
		if (error instanceof Anthropic.APIError) throw toProviderError(error);
		throw error;
	}
	return Response.json(normalizeAnthropicResponse(message, input.modelId));
}
