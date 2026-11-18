import { InferenceHttpError } from "./inference-http";
import { isRecord } from "./token-estimates";
import type {
	ChatCompletionRequest,
	ChatContentPart,
	ChatMessage,
	ChatTool,
	ProviderCatalog,
} from "./types";

export interface NativeMessagesRequest {
	body: Record<string, unknown> & {
		model: string;
		messages: Record<string, unknown>[];
	};
	headers: Headers;
	operation: "messages" | "count_tokens";
	translated: ChatCompletionRequest | null;
	inputCharacters: number;
	bound: boolean;
}

const COMMON_FIELDS: Record<string, true> = {
	model: true,
	messages: true,
	max_tokens: true,
	stream: true,
	system: true,
	tools: true,
	tool_choice: true,
	temperature: true,
};
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function contentParts(blocks: unknown[]): ChatContentPart[] | null {
	const parts: ChatContentPart[] = [];
	for (const block of blocks) {
		if (!isRecord(block)) return null;
		if (
			block.type === "text" &&
			typeof block.text === "string" &&
			onlyKeys(block, ["type", "text"])
		) {
			parts.push({ type: "text", text: block.text });
		} else if (
			block.type === "image" &&
			isRecord(block.source) &&
			onlyKeys(block, ["type", "source"])
		) {
			const source = block.source;
			if (
				source.type === "url" &&
				typeof source.url === "string" &&
				onlyKeys(source, ["type", "url"])
			) {
				parts.push({ type: "image_url", image_url: { url: source.url } });
			} else if (
				source.type === "base64" &&
				typeof source.data === "string" &&
				typeof source.media_type === "string" &&
				/^image\/(png|jpeg|gif|webp)$/.test(source.media_type) &&
				onlyKeys(source, ["type", "data", "media_type"])
			) {
				parts.push({
					type: "image_url",
					image_url: { url: `data:${source.media_type};base64,${source.data}` },
				});
			} else return null;
		} else return null;
	}
	return parts;
}

function translateMessages(
	body: NativeMessagesRequest["body"],
): ChatCompletionRequest | null {
	if (
		Object.keys(body).some((key) => !Object.hasOwn(COMMON_FIELDS, key)) ||
		body.max_tokens === 0
	)
		return null;
	const messages: ChatMessage[] = [];
	if (body.system !== undefined) {
		const system =
			typeof body.system === "string"
				? body.system
				: Array.isArray(body.system)
					? contentParts(body.system)
					: null;
		if (
			system === null ||
			(Array.isArray(system) && system.some((part) => part.type !== "text"))
		)
			return null;
		messages.push({ role: "system", content: system });
	}
	for (const message of body.messages) {
		if (
			!onlyKeys(message, ["role", "content"]) ||
			(message.role !== "user" && message.role !== "assistant")
		)
			return null;
		const role = message.role;
		if (typeof message.content === "string") {
			messages.push({ role, content: message.content });
			continue;
		}
		if (!Array.isArray(message.content)) return null;
		const remaining: unknown[] = [];
		const calls: NonNullable<ChatMessage["tool_calls"]> = [];
		let sawOrdinary = false;
		for (const block of message.content) {
			if (!isRecord(block)) return null;
			if (
				block.type === "tool_result" &&
				role === "user" &&
				!sawOrdinary &&
				onlyKeys(block, ["type", "tool_use_id", "content"]) &&
				typeof block.tool_use_id === "string"
			) {
				const content =
					block.content === undefined
						? ""
						: typeof block.content === "string"
							? block.content
							: Array.isArray(block.content)
								? contentParts(block.content)
								: null;
				if (
					content === null ||
					(Array.isArray(content) &&
						content.some((part) => part.type !== "text"))
				)
					return null;
				messages.push({
					role: "tool",
					tool_call_id: block.tool_use_id,
					content,
				});
			} else if (
				block.type === "tool_use" &&
				role === "assistant" &&
				onlyKeys(block, ["type", "id", "name", "input"]) &&
				typeof block.id === "string" &&
				typeof block.name === "string" &&
				isRecord(block.input)
			) {
				calls.push({
					id: block.id,
					type: "function",
					function: {
						name: block.name,
						arguments: JSON.stringify(block.input),
					},
				});
			} else {
				if (calls.length) return null;
				sawOrdinary = true;
				remaining.push(block);
			}
		}
		const content = contentParts(remaining);
		if (content === null) return null;
		if (content.length || calls.length)
			messages.push({
				role,
				content: content.length ? content : null,
				...(calls.length ? { tool_calls: calls } : {}),
			});
	}
	const tools: ChatTool[] = [];
	if (body.tools !== undefined) {
		if (!Array.isArray(body.tools)) return null;
		for (const tool of body.tools) {
			if (
				!isRecord(tool) ||
				!onlyKeys(tool, ["name", "description", "input_schema"]) ||
				typeof tool.name !== "string" ||
				!isRecord(tool.input_schema) ||
				(tool.description !== undefined && typeof tool.description !== "string")
			)
				return null;
			tools.push({
				type: "function",
				function: {
					name: tool.name,
					parameters: tool.input_schema,
					...(typeof tool.description === "string"
						? { description: tool.description }
						: {}),
				},
			});
		}
	}
	let toolChoice: ChatCompletionRequest["tool_choice"];
	let parallel: boolean | undefined;
	if (body.tool_choice !== undefined) {
		const choice = body.tool_choice;
		if (
			!isRecord(choice) ||
			!onlyKeys(choice, ["type", "name", "disable_parallel_tool_use"])
		)
			return null;
		if (
			choice.disable_parallel_tool_use !== undefined &&
			typeof choice.disable_parallel_tool_use !== "boolean"
		)
			return null;
		if (choice.type !== "tool" && choice.name !== undefined) return null;
		if (choice.disable_parallel_tool_use !== undefined)
			parallel = !choice.disable_parallel_tool_use;
		if (choice.type === "auto" || choice.type === "none")
			toolChoice = choice.type;
		else if (choice.type === "any") toolChoice = "required";
		else if (choice.type === "tool" && typeof choice.name === "string")
			toolChoice = { type: "function", function: { name: choice.name } };
		else return null;
	}
	return {
		model: body.model,
		messages,
		...(tools.length ? { tools } : {}),
		...(typeof body.max_tokens === "number"
			? { max_tokens: body.max_tokens }
			: {}),
		...(typeof body.temperature === "number"
			? { temperature: body.temperature }
			: {}),
		stream: body.stream === true,
		...(toolChoice ? { tool_choice: toolChoice } : {}),
		...(parallel !== undefined ? { parallel_tool_calls: parallel } : {}),
	};
}

function inspectInput(root: unknown): { characters: number; bound: boolean } {
	const pending: unknown[] = [root];
	let characters = 0;
	let bound = false;
	while (pending.length) {
		const value = pending.pop();
		if (typeof value === "string") {
			characters += value.length;
			continue;
		}
		if (Array.isArray(value)) {
			pending.push(...value);
			continue;
		}
		if (!isRecord(value)) continue;
		if (
			[
				"thinking",
				"redacted_thinking",
				"file",
				"server_tool_use",
				"tool_reference",
			].includes(String(value.type))
		)
			bound = true;
		for (const [key, item] of Object.entries(value)) {
			if (key === "container" && item !== null) bound = true;
			if (key !== "data" && key !== "signature") pending.push(item);
		}
	}
	return { characters, bound };
}

export function parseNativeMessages(
	value: unknown,
	headers: Headers,
	operation: NativeMessagesRequest["operation"],
): NativeMessagesRequest {
	if (
		!isRecord(value) ||
		typeof value.model !== "string" ||
		!value.model.trim() ||
		value.model.length > 256 ||
		!Array.isArray(value.messages) ||
		!value.messages.length ||
		value.messages.some(
			(message) =>
				!isRecord(message) ||
				typeof message.role !== "string" ||
				(typeof message.content !== "string" &&
					!Array.isArray(message.content)),
		)
	)
		throw new InferenceHttpError("model and nonempty messages are required");
	if (
		operation === "messages" &&
		(!Number.isSafeInteger(value.max_tokens) ||
			(value.max_tokens as number) < 0)
	)
		throw new InferenceHttpError("max_tokens must be a nonnegative integer");
	if (value.stream !== undefined && typeof value.stream !== "boolean")
		throw new InferenceHttpError("stream must be a boolean");
	const version = headers.get("anthropic-version");
	if (version !== "2023-06-01" && version !== "2026-10-21")
		throw new InferenceHttpError(
			"Supported anthropic-version values: 2023-06-01, 2026-10-21",
		);
	if (
		version === "2026-10-21" &&
		["temperature", "top_p", "top_k"].some((key) => key in value)
	)
		throw new InferenceHttpError(
			"temperature, top_p and top_k are not supported in API version 2026-10-21",
		);
	if (
		value.temperature !== undefined &&
		(typeof value.temperature !== "number" ||
			!Number.isFinite(value.temperature) ||
			value.temperature < 0 ||
			value.temperature > 1)
	)
		throw new InferenceHttpError("temperature must be between 0 and 1");
	const body = value as NativeMessagesRequest["body"];
	const nativeHeaders = [...headers.keys()].some(
		(name) =>
			name.startsWith("anthropic-") &&
			name !== "anthropic-version" &&
			name !== "anthropic-dangerous-direct-browser-access",
	);
	const inspected = inspectInput({
		messages: body.messages,
		system: body.system,
		tools: body.tools,
		...(body.container ? { container: body.container } : {}),
	});
	return {
		body,
		headers,
		operation,
		translated:
			operation === "messages" && !nativeHeaders
				? translateMessages(body)
				: null,
		inputCharacters: inspected.characters,
		bound: inspected.bound,
	};
}

export function canTranslateNative(
	request: NativeMessagesRequest,
	provider?: ProviderCatalog,
): boolean {
	const translated = request.translated;
	if (!translated) return false;
	const needsTools =
		translated.tools?.length ||
		translated.messages.some(
			(message) => message.tool_calls?.length || message.role === "tool",
		);
	if (
		needsTools ||
		translated.tool_choice ||
		translated.parallel_tool_calls !== undefined
	) {
		return (
			provider?.protocol === "openai_compatible" &&
			(!provider.forceSingleToolCall ||
				translated.parallel_tool_calls === false)
		);
	}
	return (
		provider?.protocol !== "anthropic_messages" &&
		provider?.protocol !== "ai_horde"
	);
}
