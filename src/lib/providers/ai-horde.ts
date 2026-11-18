import { KEYLESS_API_KEY } from "../provider-catalog";
import { estimateTokensFromCharacters } from "../token-estimates";
import type { ChatCompletionResponse, ChatMessage, TokenUsage } from "../types";
import { hasImageContent, textFromContent } from "./content";
import { ProviderError, toProviderError } from "./errors";
import { openAiChunk, openAiUsageChunk, sseResponse } from "./sse";
import type { UpstreamChatInput } from "./types";

const ANONYMOUS_KEY = "0000000000";
const DEFAULT_MAX_TOKENS = 512;

function prepareMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.map((message) => {
		if (message.tool_calls?.length || message.role === "tool")
			throw new ProviderError(
				"AI Horde does not support function calling",
				400,
				"bad_request",
			);
		if (hasImageContent(message.content))
			throw new ProviderError(
				"AI Horde supports text messages only",
				400,
				"bad_request",
			);
		return { role: message.role, content: textFromContent(message.content) };
	});
}

function estimateUsage(messages: ChatMessage[], content: string): TokenUsage {
	const prompt = messages.reduce(
		(sum, message) =>
			sum +
			estimateTokensFromCharacters(textFromContent(message.content).length),
		0,
	);
	const completion = estimateTokensFromCharacters(content.length);
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
		estimated: true,
	};
}

function normalizeResponse(
	data: Record<string, unknown>,
	input: UpstreamChatInput,
): ChatCompletionResponse {
	const choices = Array.isArray(data.choices) ? data.choices : [];
	const first = choices[0] as Record<string, unknown> | undefined;
	const sourceMessage = first?.message as Record<string, unknown> | undefined;
	const content =
		typeof sourceMessage?.content === "string" ? sourceMessage.content : "";
	const usage = estimateUsage(input.messages, content);
	return {
		id:
			typeof data.id === "string" ? data.id : `aihorde-${crypto.randomUUID()}`,
		object: "chat.completion",
		created:
			typeof data.created === "number"
				? data.created
				: Math.floor(Date.now() / 1000),
		model: input.modelId,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content },
				finish_reason: first?.finish_reason === "length" ? "length" : "stop",
			},
		],
		usage,
	};
}

function streamResponse(data: ChatCompletionResponse): Response {
	const encoder = new TextEncoder();
	const choice = data.choices[0];
	const chunks = [
		openAiChunk(data.id, data.created, data.model, { role: "assistant" }, null),
		...(typeof choice.message.content === "string" && choice.message.content
			? [
					openAiChunk(
						data.id,
						data.created,
						data.model,
						{ content: choice.message.content },
						null,
					),
				]
			: []),
		openAiChunk(data.id, data.created, data.model, {}, choice.finish_reason),
		openAiUsageChunk(data.id, data.created, data.model, data.usage ?? {}),
		"data: [DONE]\n\n",
	];
	return sseResponse(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
	);
}

export async function sendAiHorde(
	input: UpstreamChatInput,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<Response> {
	if (input.tools?.length)
		throw new ProviderError(
			"AI Horde does not support function calling",
			400,
			"bad_request",
		);
	const messages = prepareMessages(input.messages);
	const body: Record<string, unknown> = {
		model: input.modelId,
		messages,
		max_tokens: Math.max(16, input.maxTokens ?? DEFAULT_MAX_TOKENS),
	};
	if (input.temperature !== undefined) body.temperature = input.temperature;
	if (input.stop !== undefined) {
		body.stop = Array.isArray(input.stop) ? input.stop : [input.stop];
	}

	const bearer =
		input.apiKey && input.apiKey !== KEYLESS_API_KEY
			? input.apiKey.trim()
			: ANONYMOUS_KEY;
	const response = await fetch(
		`${baseUrl.replace(/\/+$/, "")}/chat/completions`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${bearer}`,
			},
			body: JSON.stringify(body),
			redirect: "manual",
			signal,
		},
	);
	if (!response.ok) throw await toProviderError(response);
	let raw: Record<string, unknown>;
	try {
		raw = (await response.json()) as Record<string, unknown>;
	} catch {
		throw new ProviderError(
			"AI Horde returned an invalid response",
			502,
			"server",
		);
	}
	const normalized = normalizeResponse(raw, input);
	return input.stream ? streamResponse(normalized) : Response.json(normalized);
}
