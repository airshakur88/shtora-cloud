import type { ChatMessage } from "./types";
export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isValidTokenCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseReportedTokenCounts(usage: unknown): {
	inputTokens: number | null;
	outputTokens: number | null;
	estimated: boolean;
} {
	if (!isRecord(usage))
		return { inputTokens: null, outputTokens: null, estimated: false };
	return {
		inputTokens: isValidTokenCount(usage.prompt_tokens)
			? usage.prompt_tokens
			: null,
		outputTokens: isValidTokenCount(usage.completion_tokens)
			? usage.completion_tokens
			: null,
		estimated: usage.estimated === true,
	};
}
export function parseCompletionTokenCounts(response: unknown): {
	inputTokens: number | null;
	outputTokens: number | null;
	estimated: boolean;
} {
	return parseReportedTokenCounts(isRecord(response) ? response.usage : null);
}

export function estimateTokensFromCharacters(characters: number): number {
	return Math.ceil(characters / 4);
}
export function promptInputCharacters(messages: ChatMessage[]): number {
	return messages.reduce(
		(total, message) =>
			total +
			contentCharacters(message.content) +
			toolCallCharacters(message.tool_calls),
		0,
	);
}

function contentCharacters(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (!Array.isArray(value)) return 0;
	return value.reduce(
		(total, part) =>
			total +
			(isRecord(part) && typeof part.text === "string" ? part.text.length : 0),
		0,
	);
}

function toolCallCharacters(value: unknown): number {
	if (!Array.isArray(value)) return 0;
	return value.reduce((total, call) => {
		if (!isRecord(call) || !isRecord(call.function)) return total;
		return (
			total +
			(typeof call.function.arguments === "string"
				? call.function.arguments.length
				: 0)
		);
	}, 0);
}

export function completionOutputCharacters(response: unknown): number {
	if (!isRecord(response) || !Array.isArray(response.choices)) return 0;
	return response.choices.reduce((total, choice) => {
		if (!isRecord(choice) || !isRecord(choice.message)) return total;
		return (
			total +
			contentCharacters(choice.message.content) +
			toolCallCharacters(choice.message.tool_calls) +
			(isRecord(choice.message.function_call) &&
			typeof choice.message.function_call.arguments === "string"
				? choice.message.function_call.arguments.length
				: 0)
		);
	}, 0);
}

export function deltaOutputCharacters(delta: unknown): number {
	if (!isRecord(delta)) return 0;
	return (
		contentCharacters(delta.content) +
		toolCallCharacters(delta.tool_calls) +
		(isRecord(delta.function_call) &&
		typeof delta.function_call.arguments === "string"
			? delta.function_call.arguments.length
			: 0)
	);
}
