import type {
	ChatCompletionRequest,
	ChatContent,
	ChatContentPart,
	ChatMessage,
	ChatRole,
	ChatTool,
} from "./types";

export const MAX_BODY_BYTES = 1_000_000;

const VALID_ROLES = new Set<ChatRole>(["system", "user", "assistant", "tool"]);

function parseContent(value: unknown): ChatContent | undefined {
	if (typeof value === "string") {
		return value.length <= MAX_BODY_BYTES ? value : undefined;
	}
	if (!Array.isArray(value) || value.length > 128) return undefined;
	const parts: ChatContentPart[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item))
			return undefined;
		const part = item as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string") {
			if (part.text.length > MAX_BODY_BYTES) return undefined;
			parts.push({ type: "text", text: part.text });
			continue;
		}
		if (
			part.type !== "image_url" ||
			!part.image_url ||
			typeof part.image_url !== "object"
		)
			return undefined;
		const image = part.image_url as Record<string, unknown>;
		if (typeof image.url !== "string" || image.url.length > MAX_BODY_BYTES)
			return undefined;
		if (
			image.detail !== undefined &&
			image.detail !== "auto" &&
			image.detail !== "low" &&
			image.detail !== "high"
		)
			return undefined;
		parts.push({
			type: "image_url",
			image_url: {
				url: image.url,
				...(image.detail ? { detail: image.detail } : {}),
			},
		});
	}
	return parts;
}

function parseToolCalls(value: unknown): ChatMessage["tool_calls"] | null {
	if (!Array.isArray(value) || value.length > 128) return null;
	const calls: NonNullable<ChatMessage["tool_calls"]> = [];
	for (const candidate of value) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			return null;
		const call = candidate as Record<string, unknown>;
		if (
			call.type !== "function" ||
			typeof call.id !== "string" ||
			call.id.length > 256 ||
			!call.function ||
			typeof call.function !== "object" ||
			Array.isArray(call.function)
		)
			return null;
		const fn = call.function as Record<string, unknown>;
		if (
			typeof fn.name !== "string" ||
			fn.name.length === 0 ||
			fn.name.length > 128 ||
			typeof fn.arguments !== "string" ||
			fn.arguments.length > MAX_BODY_BYTES
		)
			return null;
		calls.push({
			id: call.id,
			type: "function",
			function: { name: fn.name, arguments: fn.arguments },
		});
	}
	return calls;
}

function parseMessage(value: unknown): ChatMessage | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const message = value as Record<string, unknown>;
	if (
		typeof message.role !== "string" ||
		!VALID_ROLES.has(message.role as ChatRole)
	)
		return null;
	if (
		message.name !== undefined &&
		(typeof message.name !== "string" || message.name.length > 256)
	)
		return null;
	if (
		message.tool_call_id !== undefined &&
		(typeof message.tool_call_id !== "string" ||
			message.tool_call_id.length > 256)
	)
		return null;
	const toolCalls =
		message.tool_calls === undefined
			? undefined
			: parseToolCalls(message.tool_calls);
	if (toolCalls === null) return null;
	const content =
		message.content === null &&
		message.role === "assistant" &&
		toolCalls?.length
			? null
			: parseContent(message.content);
	if (content === undefined) return null;
	return {
		role: message.role as ChatRole,
		content,
		...(typeof message.name === "string" ? { name: message.name } : {}),
		...(typeof message.tool_call_id === "string"
			? { tool_call_id: message.tool_call_id }
			: {}),
		...(toolCalls ? { tool_calls: toolCalls } : {}),
	};
}

function parseTool(value: unknown): ChatTool | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const tool = value as Record<string, unknown>;
	if (
		tool.type !== "function" ||
		!tool.function ||
		typeof tool.function !== "object" ||
		Array.isArray(tool.function)
	)
		return null;
	const fn = tool.function as Record<string, unknown>;
	if (
		typeof fn.name !== "string" ||
		!fn.name ||
		fn.name.length > 128 ||
		!fn.parameters ||
		typeof fn.parameters !== "object" ||
		Array.isArray(fn.parameters)
	)
		return null;
	if (
		fn.description !== undefined &&
		(typeof fn.description !== "string" || fn.description.length > 4096)
	)
		return null;
	if (
		fn.required !== undefined &&
		fn.required !== null &&
		(!Array.isArray(fn.required) ||
			fn.required.some((item) => typeof item !== "string"))
	)
		return null;
	return {
		type: "function",
		function: {
			name: fn.name,
			parameters: fn.parameters,
			...(typeof fn.description === "string"
				? { description: fn.description }
				: {}),
			...(Array.isArray(fn.required)
				? { required: fn.required as string[] }
				: {}),
		},
	};
}

export function parseChatCompletionRequest(
	value: unknown,
): ChatCompletionRequest | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const body = value as Record<string, unknown>;
	if (
		typeof body.model !== "string" ||
		body.model.trim().length === 0 ||
		body.model.length > 256
	)
		return null;
	if (
		!Array.isArray(body.messages) ||
		body.messages.length === 0 ||
		body.messages.length > 1000
	)
		return null;
	const messages = body.messages.map(parseMessage);
	if (messages.some((message) => message === null)) return null;
	if (body.stream !== undefined && typeof body.stream !== "boolean")
		return null;
	if (
		body.temperature !== undefined &&
		(typeof body.temperature !== "number" ||
			!Number.isFinite(body.temperature) ||
			body.temperature < 0 ||
			body.temperature > 2)
	)
		return null;
	if (
		body.max_tokens !== undefined &&
		(typeof body.max_tokens !== "number" ||
			!Number.isInteger(body.max_tokens) ||
			body.max_tokens < 1 ||
			body.max_tokens > 100_000)
	)
		return null;
	let stop: string | string[] | undefined;
	if (body.stop !== undefined) {
		if (typeof body.stop === "string") {
			if (body.stop.length > 512) return null;
			stop = body.stop;
		} else if (
			Array.isArray(body.stop) &&
			body.stop.length <= 4 &&
			body.stop.every(
				(value) => typeof value === "string" && value.length <= 512,
			)
		) {
			stop = body.stop as string[];
		} else {
			return null;
		}
	}
	let tools: ChatTool[] | undefined;
	if (body.tools !== undefined) {
		if (!Array.isArray(body.tools) || body.tools.length > 128) return null;
		const parsedTools = body.tools.map(parseTool);
		if (parsedTools.some((tool) => tool === null)) return null;
		tools = parsedTools as ChatTool[];
	}
	return {
		model: body.model.trim(),
		messages: messages as ChatMessage[],
		...(tools ? { tools } : {}),
		...(typeof body.temperature === "number"
			? { temperature: body.temperature }
			: {}),
		...(typeof body.max_tokens === "number"
			? { max_tokens: body.max_tokens }
			: {}),
		...(typeof body.stream === "boolean" ? { stream: body.stream } : {}),
		...(stop !== undefined ? { stop } : {}),
	};
}
