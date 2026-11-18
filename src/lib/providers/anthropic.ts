import { isValidTokenCount } from "../token-estimates";
import type {
	ChatCompletionResponse,
	ChatFinishReason,
	ChatMessage,
	ChatTool,
} from "../types";
import { hasImageContent, textFromContent } from "./content";
import { ProviderError, toProviderError } from "./errors";
import {
	openAiChunk,
	openAiUsageChunk,
	sseResponse,
	transformSseStream,
} from "./sse";
import type { UpstreamChatInput } from "./types";

interface AnthropicBlock {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

interface AnthropicMessage {
	id?: string;
	model?: string;
	content?: AnthropicBlock[];
	stop_reason?: string | null;
	usage?: { input_tokens?: number; output_tokens?: number };
}

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
	messages: Array<{ role: "user" | "assistant"; content: unknown[] }>,
	role: "user" | "assistant",
	content: unknown[],
): void {
	const previous = messages[messages.length - 1];
	if (previous?.role === role) previous.content.push(...content);
	else messages.push({ role, content });
}

function buildAnthropicBody(input: UpstreamChatInput): Record<string, unknown> {
	const system: string[] = [];
	const messages: Array<{ role: "user" | "assistant"; content: unknown[] }> =
		[];
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
		const blocks: unknown[] = [];
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

	const body: Record<string, unknown> = {
		model: input.modelId,
		max_tokens: input.maxTokens ?? 1024,
		messages,
	};
	if (system.length) body.system = system.join("\n\n");
	if (input.temperature !== undefined) body.temperature = input.temperature;
	if (input.stop !== undefined) {
		body.stop_sequences = Array.isArray(input.stop) ? input.stop : [input.stop];
	}
	if (input.tools?.length) {
		body.tools = input.tools.map((tool: ChatTool) => ({
			name: tool.function.name,
			...(tool.function.description
				? { description: tool.function.description }
				: {}),
			input_schema: tool.function.parameters,
		}));
	}
	if (input.stream) body.stream = true;
	return body;
}

function finishReason(reason: string | null | undefined): ChatFinishReason {
	if (reason === "max_tokens") return "length";
	if (reason === "tool_use") return "tool_calls";
	return "stop";
}

function normalizeAnthropicResponse(
	data: AnthropicMessage,
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

function parseEventData(data: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(data) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function streamAnthropicResponse(
	input: UpstreamChatInput,
	upstream: ReadableStream<Uint8Array>,
): Response {
	const id = `anthropic-${crypto.randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	const encoder = new TextEncoder();
	const toolIndexes = new Map<number, number>();
	let nextToolIndex = 0;
	let finalReason: ChatFinishReason | null = null;
	let emittedRole = false;
	let finished = false;
	const body = transformSseStream(
		upstream,
		(event, controller) => {
			const payload = parseEventData(event.data);
			if (!payload) return;
			if (!emittedRole) {
				controller.enqueue(
					encoder.encode(
						openAiChunk(
							id,
							created,
							input.modelId,
							{ role: "assistant" },
							null,
						),
					),
				);
				emittedRole = true;
			}
			if (event.event === "message_start") {
				const message = payload.message;
				if (message && typeof message === "object" && !Array.isArray(message)) {
					const usage = (message as Record<string, unknown>).usage;
					if (usage && typeof usage === "object" && !Array.isArray(usage)) {
						const inputTokens = (usage as Record<string, unknown>).input_tokens;
						if (isValidTokenCount(inputTokens)) {
							controller.enqueue(
								encoder.encode(
									openAiUsageChunk(id, created, input.modelId, {
										prompt_tokens: inputTokens,
									}),
								),
							);
						}
					}
				}
				return;
			}
			if (event.event === "content_block_start") {
				const block = payload.content_block as AnthropicBlock | undefined;
				const blockIndex = payload.index;
				if (
					block?.type === "tool_use" &&
					typeof blockIndex === "number" &&
					block.id &&
					block.name
				) {
					const index = nextToolIndex++;
					toolIndexes.set(blockIndex, index);
					controller.enqueue(
						encoder.encode(
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
						),
					);
				}
				return;
			}
			if (event.event === "content_block_delta") {
				const delta = payload.delta as Record<string, unknown> | undefined;
				if (delta?.type === "text_delta" && typeof delta.text === "string") {
					controller.enqueue(
						encoder.encode(
							openAiChunk(
								id,
								created,
								input.modelId,
								{ content: delta.text },
								null,
							),
						),
					);
				} else if (
					delta?.type === "input_json_delta" &&
					typeof delta.partial_json === "string" &&
					typeof payload.index === "number"
				) {
					const index = toolIndexes.get(payload.index);
					if (index !== undefined) {
						controller.enqueue(
							encoder.encode(
								openAiChunk(
									id,
									created,
									input.modelId,
									{
										tool_calls: [
											{ index, function: { arguments: delta.partial_json } },
										],
									},
									null,
								),
							),
						);
					}
				}
				return;
			}
			if (event.event === "message_delta") {
				const delta = payload.delta as Record<string, unknown> | undefined;
				if (typeof delta?.stop_reason === "string")
					finalReason = finishReason(delta.stop_reason);
				const usage = payload.usage;
				if (usage && typeof usage === "object" && !Array.isArray(usage)) {
					const outputTokens = (usage as Record<string, unknown>).output_tokens;
					if (isValidTokenCount(outputTokens)) {
						controller.enqueue(
							encoder.encode(
								openAiUsageChunk(id, created, input.modelId, {
									completion_tokens: outputTokens,
								}),
							),
						);
					}
				}
				return;
			}
			if (event.event === "error") {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ error: { message: "Upstream provider error", type: "server_error" } })}\n\n`,
					),
				);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				finished = true;
				return;
			}
			if (event.event === "message_stop" && !finished) {
				controller.enqueue(
					encoder.encode(
						openAiChunk(id, created, input.modelId, {}, finalReason ?? "stop"),
					),
				);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				finished = true;
			}
		},
		(controller) => {
			if (!emittedRole)
				controller.enqueue(
					encoder.encode(
						openAiChunk(
							id,
							created,
							input.modelId,
							{ role: "assistant" },
							null,
						),
					),
				);
			if (!finished) {
				controller.enqueue(
					encoder.encode(
						openAiChunk(id, created, input.modelId, {}, finalReason ?? "stop"),
					),
				);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			}
		},
	);
	return sseResponse(body);
}

export async function sendAnthropic(
	input: UpstreamChatInput,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<Response> {
	const response = await fetch(`${baseUrl}/messages`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${input.apiKey}`,
			"anthropic-version": "2026-10-21",
			Accept: input.stream ? "text/event-stream" : "application/json",
		},
		body: JSON.stringify(buildAnthropicBody(input)),
		redirect: "manual",
		signal,
	});
	if (!response.ok) throw await toProviderError(response);
	if (input.stream) {
		if (!response.body)
			throw new ProviderError(
				"Anthropic returned an empty stream",
				502,
				"server",
			);
		return streamAnthropicResponse(input, response.body);
	}
	let data: AnthropicMessage;
	try {
		data = (await response.json()) as AnthropicMessage;
	} catch {
		throw new ProviderError(
			"Anthropic returned an invalid response",
			502,
			"server",
		);
	}
	return Response.json(normalizeAnthropicResponse(data, input.modelId));
}
