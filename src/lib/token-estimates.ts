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

/**
 * Token estimate for a known string, with documented corrections for the
 * scripts the 4-chars-per-token baseline undercounts:
 * - CJK characters carry roughly one token each, so they are charged at
 *   1.5 chars per token while everything else keeps the baseline.
 * - Code/JSON lines are denser than prose in BPE tokenizers (braces,
 *   quotes and punctuation each tend to become their own token), so a
 *   line that contains a structural bracket plus at least two other
 *   symbols is charged at 2 chars per token. The 2-char rate is a
 *   conservative planning estimate, not a tokenizer: very dense code
 *   still reserves less than it spends, but far less than at 4 chars.
 * This is a planning estimate for rate-limit reservation, not a
 * tokenizer.
 */
const CJK_PATTERN =
	/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
const CODE_BRACKET_PATTERN = /[{}[\]]/;

function isCodeLine(line: string): boolean {
	if (!CODE_BRACKET_PATTERN.test(line)) return false;
	let symbols = 0;
	for (const char of line) {
		if (!/[\p{L}\p{N}\s]/u.test(char)) {
			symbols += 1;
			if (symbols >= 2) return true;
		}
	}
	return false;
}

function tokenWeight(text: string): number {
	const cjk = text.match(CJK_PATTERN)?.length ?? 0;
	const rest = text.replace(CJK_PATTERN, "");
	const lines = rest.split("\n");
	let weight = cjk / 1.5 + (lines.length - 1) / 4;
	for (const line of lines) {
		weight += line.length / (isCodeLine(line) ? 2 : 4);
	}
	return weight;
}

export function estimateTokensFromText(text: string): number {
	return Math.ceil(tokenWeight(text));
}

/**
 * Every prompt string that counts toward the input estimate: message text,
 * message `name`, tool-call arguments, `stop` sequences, and the text of a
 * remote `image_url`. A `data:` URL contributes nothing — its payload is
 * image bytes, not text, and counting base64 as tokens would reserve the
 * whole minute budget for one attachment.
 */
function promptTextParts(
	messages: ChatMessage[],
	stop?: string | string[],
): string[] {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.name) parts.push(message.name);
		if (typeof message.content === "string") {
			parts.push(message.content);
		} else if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (!isRecord(part)) continue;
				if (part.type === "text" && typeof part.text === "string") {
					parts.push(part.text);
				} else if (
					part.type === "image_url" &&
					isRecord(part.image_url) &&
					typeof part.image_url.url === "string" &&
					!part.image_url.url.startsWith("data:")
				) {
					parts.push(part.image_url.url);
				}
			}
		}
		if (Array.isArray(message.tool_calls)) {
			for (const call of message.tool_calls) {
				if (
					isRecord(call) &&
					isRecord(call.function) &&
					typeof call.function.arguments === "string"
				)
					parts.push(call.function.arguments);
			}
		}
	}
	if (stop !== undefined) parts.push(...(Array.isArray(stop) ? stop : [stop]));
	return parts;
}

export function estimatePromptTokens(
	messages: ChatMessage[],
	stop?: string | string[],
): number {
	const weight = promptTextParts(messages, stop).reduce(
		(total, text) => total + tokenWeight(text),
		0,
	);
	return Math.ceil(weight);
}

export function promptInputCharacters(
	messages: ChatMessage[],
	stop?: string | string[],
): number {
	return promptTextParts(messages, stop).reduce(
		(total, text) => total + text.length,
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
