import {
	ApiError,
	type Content,
	type FunctionDeclaration,
	type GenerateContentConfig,
	type GenerateContentResponse,
	GoogleGenAI,
	type Part,
	type Tool,
} from "@google/genai/web";
import { isValidTokenCount } from "../token-estimates";
import type {
	ChatCompletionResponse,
	ChatFinishReason,
	ChatMessage,
	ChatTool,
	ProviderCatalog,
	TokenUsage,
} from "../types";
import {
	hasImageContent,
	imageParts,
	parseInlineImage,
	textFromContent,
} from "./content";
import { classifyStatus, ProviderError } from "./errors";
import { checkReturnedModel } from "./model-identity";
import { openAiChunk, openAiUsageChunk, sseResponse } from "./sse";
import type { UpstreamChatInput } from "./types";

/**
 * The Google path talks to the Gemini API through the official SDK
 * (`@google/genai`, web entry — the only import in `dist/web/index.mjs`
 * besides the SDK itself is `p-retry`, no Node built-ins, so it bundles
 * for Cloudflare Workers). The SDK owns the HTTP layer (auth header,
 * `v1beta` path, SSE parsing, status errors); this file keeps only the
 * project-specific parts: translating the OpenAI-shaped `UpstreamChatInput`
 * into Gemini params — including the Gemini 3 `thoughtSignature` cache
 * and the Gemma system-instruction inline — and translating the Gemini
 * answer back into OpenAI-shaped chunks.
 *
 * Two SDK defaults are switched off on purpose: retries
 * (`httpOptions.retryOptions.attempts: 1`) so SDK retries never fight
 * the router's own failover, and automatic continuation
 * (`config.automaticContinuation: false`) so one call never silently
 * becomes several upstream requests. Wire behavior is otherwise the
 * same as the manual implementation: `x-goog-api-key`, POST to
 * `{baseUrl}/models/{model}:generateContent` (or `:streamGenerateContent`
 * with `?alt=sse`), same request body shape.
 */

const THOUGHT_SIGNATURE_TTL_MS = 30 * 60 * 1000;
const THOUGHT_SIGNATURE_LIMIT = 5000;
const THOUGHT_SIGNATURE_FALLBACK = "context_engineering_is_the_way_to_go";
const thoughtSignatures = new Map<
	string,
	{ signature: string; expiresAt: number }
>();

function stableArgs(args: unknown): string {
	return JSON.stringify(args ?? {});
}

function signatureKeys(
	id: string | undefined,
	name: string,
	args: unknown,
): string[] {
	return [...(id ? [`id:${id}`] : []), `call:${name}:${stableArgs(args)}`];
}

function rememberSignature(
	id: string | undefined,
	name: string,
	args: unknown,
	signature: string,
): void {
	for (const key of signatureKeys(id, name, args)) {
		if (
			!thoughtSignatures.has(key) &&
			thoughtSignatures.size >= THOUGHT_SIGNATURE_LIMIT
		) {
			const oldest = thoughtSignatures.keys().next().value;
			if (oldest !== undefined) thoughtSignatures.delete(oldest);
		}
		thoughtSignatures.set(key, {
			signature,
			expiresAt: Date.now() + THOUGHT_SIGNATURE_TTL_MS,
		});
	}
}

function getSignature(
	id: string | undefined,
	name: string,
	args: unknown,
): string {
	for (const key of signatureKeys(id, name, args)) {
		const entry = thoughtSignatures.get(key);
		if (!entry) continue;
		if (entry.expiresAt < Date.now()) {
			thoughtSignatures.delete(key);
			continue;
		}
		return entry.signature;
	}
	return THOUGHT_SIGNATURE_FALLBACK;
}

function geminiSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(geminiSchema);
	if (!value || typeof value !== "object") return value;
	const unsupported = new Set([
		"$schema",
		"$defs",
		"definitions",
		"additionalProperties",
		"patternProperties",
		"default",
		"examples",
		"title",
		"anyOf",
		"oneOf",
		"allOf",
		"not",
	]);
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (unsupported.has(key)) continue;
		result[key] = geminiSchema(child);
	}
	return result;
}

function parseArguments(raw: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new ProviderError(
			"Invalid function-call arguments",
			400,
			"bad_request",
		);
	}
	if (value && typeof value === "object" && !Array.isArray(value))
		return value as Record<string, unknown>;
	return { value };
}

function geminiParts(message: ChatMessage): Part[] {
	if (message.role !== "user" && hasImageContent(message.content)) {
		throw new ProviderError(
			"Images are supported only in user messages",
			400,
			"bad_request",
		);
	}
	const parts: Part[] = [];
	const text = textFromContent(message.content);
	if (text) parts.push({ text });
	for (const part of imageParts(message.content)) {
		const image = parseInlineImage(part.image_url.url);
		if (!image) {
			throw new ProviderError(
				"Google vision requires a base64 image data URL",
				400,
				"bad_request",
			);
		}
		parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
	}
	return parts;
}

function geminiTool(tool: ChatTool): FunctionDeclaration {
	const parameters = geminiSchema(tool.function.parameters);
	return {
		name: tool.function.name,
		...(tool.function.description
			? { description: tool.function.description }
			: {}),
		parameters: parameters as FunctionDeclaration["parameters"],
	};
}

function buildGenerateContentParams(
	input: UpstreamChatInput,
	signal?: AbortSignal,
): {
	model: string;
	contents: Content[];
	config: GenerateContentConfig;
} {
	const systemParts: { text: string }[] = [];
	const contents: Content[] = [];
	const toolNames = new Map<string, string>();
	const isGemini3 = /gemini-3(?:[.-]|$)/i.test(input.modelId);
	for (const message of input.messages) {
		if (message.role === "system") {
			if (hasImageContent(message.content))
				throw new ProviderError(
					"System messages cannot contain images",
					400,
					"bad_request",
				);
			const text = textFromContent(message.content);
			if (text) systemParts.push({ text });
			continue;
		}
		if (message.role === "tool") {
			if (hasImageContent(message.content))
				throw new ProviderError(
					"Tool results cannot contain images",
					400,
					"bad_request",
				);
			const callId = message.tool_call_id;
			const name = callId ? toolNames.get(callId) : undefined;
			if (!callId || !name)
				throw new ProviderError(
					"Tool result is missing its function call",
					400,
					"bad_request",
				);
			contents.push({
				role: "user",
				parts: [
					{
						functionResponse: {
							id: callId,
							name,
							response: { result: textFromContent(message.content) },
						},
					},
				],
			});
			continue;
		}
		const parts = geminiParts(message);
		if (message.role === "assistant") {
			for (const call of message.tool_calls ?? []) {
				const args = parseArguments(call.function.arguments);
				toolNames.set(call.id, call.function.name);
				parts.push({
					functionCall: { id: call.id, name: call.function.name, args },
					...(isGemini3
						? {
								thoughtSignature: getSignature(
									call.id,
									call.function.name,
									args,
								),
							}
						: {}),
				});
			}
		}
		if (parts.length > 0) {
			contents.push({
				role: message.role === "assistant" ? "model" : "user",
				parts,
			});
		}
	}

	const normalizedModel = input.modelId.toLowerCase().replace(/^models\//, "");
	const isGemma = /(?:^|[/.:])gemma[-_]/.test(normalizedModel);
	let systemInstruction: { parts: { text: string }[] } | undefined;
	if (systemParts.length > 0) {
		if (isGemma) {
			const systemText = systemParts.map((part) => part.text).join("\n\n");
			if (contents[0]?.role === "user") {
				contents[0].parts?.unshift({ text: systemText });
			} else {
				contents.unshift({ role: "user", parts: [{ text: systemText }] });
			}
		} else {
			systemInstruction = { parts: systemParts };
		}
	}

	const config: GenerateContentConfig = {
		automaticContinuation: false,
		...(signal ? { abortSignal: signal } : {}),
	};
	if (systemInstruction) config.systemInstruction = systemInstruction;
	if (input.tools?.length) {
		const tools: Tool[] = [
			{ functionDeclarations: input.tools.map(geminiTool) },
		];
		config.tools = tools;
	}
	if (input.temperature !== undefined) config.temperature = input.temperature;
	if (input.maxTokens !== undefined) config.maxOutputTokens = input.maxTokens;
	if (input.stop !== undefined) {
		config.stopSequences = Array.isArray(input.stop)
			? input.stop
			: [input.stop];
	}
	return { model: input.modelId, contents, config };
}

function finishReason(reason: string | undefined): ChatFinishReason {
	if (reason === "MAX_TOKENS") return "length";
	if (
		[
			"SAFETY",
			"RECITATION",
			"BLOCKLIST",
			"PROHIBITED_CONTENT",
			"SPII",
		].includes(reason ?? "")
	)
		return "content_filter";
	return "stop";
}

function usage(data: GenerateContentResponse): TokenUsage | undefined {
	const prompt = isValidTokenCount(data.usageMetadata?.promptTokenCount)
		? data.usageMetadata.promptTokenCount
		: null;
	const completion = isValidTokenCount(data.usageMetadata?.candidatesTokenCount)
		? data.usageMetadata.candidatesTokenCount
		: null;
	if (prompt === null && completion === null) return undefined;
	const reportedTotal = data.usageMetadata?.totalTokenCount;
	const total = isValidTokenCount(reportedTotal)
		? reportedTotal
		: prompt !== null &&
				completion !== null &&
				isValidTokenCount(prompt + completion)
			? prompt + completion
			: undefined;
	return {
		...(prompt !== null ? { prompt_tokens: prompt } : {}),
		...(completion !== null ? { completion_tokens: completion } : {}),
		...(total !== undefined ? { total_tokens: total } : {}),
	};
}

function streamingUsage(data: GenerateContentResponse) {
	const prompt = data.usageMetadata?.promptTokenCount;
	const completion = data.usageMetadata?.candidatesTokenCount;
	if (!isValidTokenCount(prompt) && !isValidTokenCount(completion)) return null;
	const total = data.usageMetadata?.totalTokenCount;
	return {
		...(isValidTokenCount(prompt) ? { prompt_tokens: prompt } : {}),
		...(isValidTokenCount(completion) ? { completion_tokens: completion } : {}),
		...(isValidTokenCount(total) ? { total_tokens: total } : {}),
	};
}

function normalizeGeminiResponse(
	data: GenerateContentResponse,
	modelId: string,
): ChatCompletionResponse {
	const candidate = data.candidates?.[0];
	if (!candidate?.content || !Array.isArray(candidate.content.parts))
		throw new ProviderError(
			"Google returned an empty completion",
			502,
			"server",
		);
	const text: string[] = [];
	const reasoning: string[] = [];
	const calls: NonNullable<ChatMessage["tool_calls"]> = [];
	for (const part of candidate.content.parts) {
		if (typeof part.text === "string" && !part.thought) text.push(part.text);
		if (typeof part.text === "string" && part.thought)
			reasoning.push(part.text);
		const functionCall = part.functionCall;
		if (functionCall?.name) {
			const callId = functionCall.id ?? `call_${crypto.randomUUID()}`;
			const args = functionCall.args ?? {};
			const signature = part.thoughtSignature;
			if (signature)
				rememberSignature(callId, functionCall.name, args, signature);
			calls.push({
				id: callId,
				type: "function",
				function: { name: functionCall.name, arguments: JSON.stringify(args) },
			});
		}
	}
	const reason = finishReason(candidate.finishReason);
	const reportedUsage = usage(data);
	// The upstream echo, not the requested id: the router's post-parse
	// check compares this against the requested model (an alias request
	// answers with the versioned id in `modelVersion`, which the shared
	// validator accepts). The thinking parts the old code dropped are
	// kept as `reasoning_content`, so the router's empty check can see
	// that the model spent the call reasoning.
	return {
		id: `gemini-${crypto.randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: data.modelVersion ?? modelId,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: text.join("") || null,
					...(reasoning.length
						? { reasoning_content: reasoning.join("") }
						: {}),
					...(calls.length ? { tool_calls: calls } : {}),
				},
				finish_reason: calls.length ? "tool_calls" : reason,
			},
		],
		...(reportedUsage ? { usage: reportedUsage } : {}),
	};
}

function streamGeminiResponse(
	input: UpstreamChatInput,
	stream: AsyncIterable<GenerateContentResponse>,
	provider?: ProviderCatalog,
): Response {
	const id = `gemini-${crypto.randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	const encoder = new TextEncoder();
	const toolIndexes = new Map<string, number>();
	let nextToolIndex = 0;
	let finish: ChatFinishReason | null = null;
	let sawCall = false;
	let emittedDone = false;
	let emittedRole = false;
	let echoChecked = false;
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
			const finishStream = () => {
				if (emittedDone) return;
				emittedDone = true;
				emit(
					openAiChunk(
						id,
						created,
						input.modelId,
						{},
						sawCall ? "tool_calls" : (finish ?? "stop"),
					),
				);
				emit("data: [DONE]\n\n");
			};
			try {
				for await (const chunk of stream) {
					// The echo is checked before the first byte is
					// emitted, so a mismatch errors the stream before
					// the router commits to it and can still fail over.
					if (!echoChecked && chunk.modelVersion !== undefined) {
						echoChecked = true;
						checkReturnedModel(provider, input.modelId, chunk.modelVersion);
					}
					emitRole();
					const reportedUsage = streamingUsage(chunk);
					if (reportedUsage) {
						emit(openAiUsageChunk(id, created, input.modelId, reportedUsage));
					}
					const candidate = chunk.candidates?.[0];
					for (const part of candidate?.content?.parts ?? []) {
						if (typeof part.text === "string" && !part.thought) {
							emit(
								openAiChunk(
									id,
									created,
									input.modelId,
									{ content: part.text },
									null,
								),
							);
						}
						if (part.functionCall?.name) {
							const call = part.functionCall;
							const name = call.name;
							if (!name) continue;
							const callId = call.id ?? `${id}_call_${nextToolIndex}`;
							let index = toolIndexes.get(callId);
							if (index === undefined) {
								index = nextToolIndex++;
								toolIndexes.set(callId, index);
								emit(
									openAiChunk(
										id,
										created,
										input.modelId,
										{
											tool_calls: [
												{
													index,
													id: callId,
													type: "function",
													function: { name, arguments: "" },
												},
											],
										},
										null,
									),
								);
							}
							const signature = part.thoughtSignature;
							if (signature)
								rememberSignature(callId, name, call.args ?? {}, signature);
							const args = JSON.stringify(call.args ?? {});
							emit(
								openAiChunk(
									id,
									created,
									input.modelId,
									{
										tool_calls: [{ index, function: { arguments: args } }],
									},
									null,
								),
							);
							sawCall = true;
						}
					}
					if (candidate?.finishReason)
						finish = finishReason(candidate.finishReason);
				}
			} catch (error) {
				// The manual SSE mapper errored the stream on an upstream
				// failure; same here — an abort just ends the stream.
				if (error instanceof Error && error.name === "AbortError") {
					controller.close();
					return;
				}
				controller.error(error);
				return;
			}
			emitRole();
			finishStream();
			controller.close();
		},
	});
	return sseResponse(body);
}

function toProviderError(error: ApiError): ProviderError {
	const status = error.status;
	return new ProviderError(
		`Upstream ${status}`,
		status,
		classifyStatus(status),
	);
}

function googleClient(input: UpstreamChatInput, baseUrl: string): GoogleGenAI {
	// The SDK appends `/{apiVersion}/models/...` to baseUrl itself, so
	// the catalog base URL (`https://generativelanguage.googleapis.com/v1beta`)
	// has its trailing `/v1beta` stripped; anything else is used as the
	// API root as-is.
	return new GoogleGenAI({
		apiKey: input.apiKey,
		httpOptions: {
			baseUrl: baseUrl.replace(/\/v1beta\/?$/, ""),
			apiVersion: "v1beta",
			retryOptions: { attempts: 1 },
		},
	});
}

async function sendGeminiNonStream(
	input: UpstreamChatInput,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<Response> {
	const client = googleClient(input, baseUrl);
	const params = buildGenerateContentParams(input, signal);
	let data: GenerateContentResponse;
	try {
		data = await client.models.generateContent(params);
	} catch (error) {
		if (error instanceof ApiError) throw toProviderError(error);
		throw error;
	}
	return Response.json(normalizeGeminiResponse(data, input.modelId));
}

async function sendGeminiStream(
	input: UpstreamChatInput,
	baseUrl: string,
	signal?: AbortSignal,
	provider?: ProviderCatalog,
): Promise<Response> {
	const client = googleClient(input, baseUrl);
	const params = buildGenerateContentParams(input, signal);
	let stream: AsyncIterable<GenerateContentResponse>;
	try {
		stream = await client.models.generateContentStream(params);
	} catch (error) {
		if (error instanceof ApiError) throw toProviderError(error);
		throw error;
	}
	return streamGeminiResponse(input, stream, provider);
}

export async function sendGoogle(
	input: UpstreamChatInput,
	baseUrl: string,
	signal?: AbortSignal,
	provider?: ProviderCatalog,
): Promise<Response> {
	if (!input.stream) return sendGeminiNonStream(input, baseUrl, signal);
	return sendGeminiStream(input, baseUrl, signal, provider);
}
