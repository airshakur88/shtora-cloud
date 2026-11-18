import { isValidTokenCount } from "../token-estimates";
import type {
	ChatCompletionResponse,
	ChatFinishReason,
	ChatMessage,
	ChatTool,
	TokenUsage,
} from "../types";
import {
	hasImageContent,
	imageParts,
	parseInlineImage,
	textFromContent,
} from "./content";
import { ProviderError, toProviderError } from "./errors";
import {
	openAiChunk,
	openAiUsageChunk,
	sseResponse,
	transformSseStream,
} from "./sse";
import type { UpstreamChatInput } from "./types";

interface GeminiPart {
	text?: string;
	thought?: boolean;
	inlineData?: { mimeType: string; data: string };
	thoughtSignature?: string;
	functionCall?: { id?: string; name?: string; args?: unknown };
	functionResponse?: { id?: string; name?: string; response?: unknown };
}

interface GeminiCandidate {
	content?: { parts?: GeminiPart[] };
	finishReason?: string;
}

interface GeminiData {
	candidates?: GeminiCandidate[];
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		totalTokenCount?: number;
	};
}

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

function geminiParts(message: ChatMessage): GeminiPart[] {
	if (message.role !== "user" && hasImageContent(message.content)) {
		throw new ProviderError(
			"Images are supported only in user messages",
			400,
			"bad_request",
		);
	}
	const parts: GeminiPart[] = [];
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

function geminiTool(tool: ChatTool): Record<string, unknown> {
	const parameters = geminiSchema(tool.function.parameters);
	return {
		name: tool.function.name,
		...(tool.function.description
			? { description: tool.function.description }
			: {}),
		parameters,
	};
}

function buildGeminiBody(input: UpstreamChatInput): Record<string, unknown> {
	const systemParts: { text: string }[] = [];
	const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
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
				contents[0].parts.unshift({ text: systemText });
			} else {
				contents.unshift({ role: "user", parts: [{ text: systemText }] });
			}
		} else {
			systemInstruction = { parts: systemParts };
		}
	}

	const body: Record<string, unknown> = { contents };
	if (systemInstruction) body.systemInstruction = systemInstruction;
	if (input.tools?.length) {
		body.tools = [{ functionDeclarations: input.tools.map(geminiTool) }];
	}
	const generationConfig: Record<string, unknown> = {};
	if (input.temperature !== undefined)
		generationConfig.temperature = input.temperature;
	if (input.maxTokens !== undefined)
		generationConfig.maxOutputTokens = input.maxTokens;
	if (input.stop !== undefined) {
		generationConfig.stopSequences = Array.isArray(input.stop)
			? input.stop
			: [input.stop];
	}
	if (Object.keys(generationConfig).length)
		body.generationConfig = generationConfig;
	return body;
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

function usage(data: GeminiData): TokenUsage | undefined {
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

function streamingUsage(data: GeminiData) {
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
	data: GeminiData,
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
	const calls: NonNullable<ChatMessage["tool_calls"]> = [];
	for (const part of candidate.content.parts) {
		if (typeof part.text === "string" && !part.thought) text.push(part.text);
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
	return {
		id: `gemini-${crypto.randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: modelId,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: text.join("") || null,
					...(calls.length ? { tool_calls: calls } : {}),
				},
				finish_reason: calls.length ? "tool_calls" : reason,
			},
		],
		...(reportedUsage ? { usage: reportedUsage } : {}),
	};
}

async function sendGeminiNonStream(
	input: UpstreamChatInput,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<Response> {
	const response = await fetch(
		`${baseUrl}/models/${input.modelId}:generateContent`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-goog-api-key": input.apiKey,
			},
			body: JSON.stringify(buildGeminiBody(input)),
			redirect: "manual",
			signal,
		},
	);
	if (!response.ok) throw await toProviderError(response);
	let data: GeminiData;
	try {
		data = (await response.json()) as GeminiData;
	} catch {
		throw new ProviderError(
			"Google returned an invalid response",
			502,
			"server",
		);
	}
	return Response.json(normalizeGeminiResponse(data, input.modelId));
}

function sendGeminiStream(
	input: UpstreamChatInput,
	upstream: ReadableStream<Uint8Array>,
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
	const body = transformSseStream(
		upstream,
		(event, controller) => {
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
			if (event.data === "[DONE]" || !event.data) return;
			let data: GeminiData;
			try {
				data = JSON.parse(event.data) as GeminiData;
			} catch {
				return;
			}
			const reportedUsage = streamingUsage(data);
			if (reportedUsage) {
				controller.enqueue(
					encoder.encode(
						openAiUsageChunk(id, created, input.modelId, reportedUsage),
					),
				);
			}
			const candidate = data.candidates?.[0];
			for (const part of candidate?.content?.parts ?? []) {
				if (typeof part.text === "string" && !part.thought) {
					controller.enqueue(
						encoder.encode(
							openAiChunk(
								id,
								created,
								input.modelId,
								{ content: part.text },
								null,
							),
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
												id: callId,
												type: "function",
												function: { name, arguments: "" },
											},
										],
									},
									null,
								),
							),
						);
					}
					const signature = part.thoughtSignature;
					if (signature)
						rememberSignature(callId, name, call.args ?? {}, signature);
					const args = JSON.stringify(call.args ?? {});
					controller.enqueue(
						encoder.encode(
							openAiChunk(
								id,
								created,
								input.modelId,
								{
									tool_calls: [{ index, function: { arguments: args } }],
								},
								null,
							),
						),
					);
					sawCall = true;
				}
			}
			if (candidate?.finishReason)
				finish = finishReason(candidate.finishReason);
		},
		(controller) => {
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
			}
			if (emittedDone) return;
			emittedDone = true;
			controller.enqueue(
				encoder.encode(
					openAiChunk(
						id,
						created,
						input.modelId,
						{},
						sawCall ? "tool_calls" : (finish ?? "stop"),
					),
				),
			);
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
		},
	);
	return sseResponse(body);
}

export async function sendGoogle(
	input: UpstreamChatInput,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<Response> {
	if (!input.stream) return sendGeminiNonStream(input, baseUrl, signal);
	const response = await fetch(
		`${baseUrl}/models/${input.modelId}:streamGenerateContent?alt=sse`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-goog-api-key": input.apiKey,
			},
			body: JSON.stringify(buildGeminiBody(input)),
			redirect: "manual",
			signal,
		},
	);
	if (!response.ok) throw await toProviderError(response);
	if (!response.body)
		throw new ProviderError("Google returned an empty stream", 502, "server");
	return sendGeminiStream(input, response.body);
}
