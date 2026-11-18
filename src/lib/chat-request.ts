import { z } from "zod";
import type {
	ChatCompletionRequest,
	ChatContent,
	ChatMessage,
	ChatTool,
} from "./types";

export const MAX_BODY_BYTES = 1_000_000;

const contentPartSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string().max(MAX_BODY_BYTES) }),
	z.object({
		type: z.literal("image_url"),
		image_url: z.object({
			url: z.string().max(MAX_BODY_BYTES),
			detail: z.enum(["auto", "low", "high"]).optional(),
		}),
	}),
]);

const toolCallSchema = z.object({
	id: z.string().max(256),
	type: z.literal("function"),
	function: z.object({
		name: z.string().min(1).max(128),
		arguments: z.string().max(MAX_BODY_BYTES),
	}),
});

const messageSchema = z
	.object({
		role: z.enum(["system", "user", "assistant", "tool"]),
		content: z.union([
			z.string().max(MAX_BODY_BYTES),
			z.array(contentPartSchema).max(128),
			z.null(),
		]),
		name: z.string().max(256).optional(),
		tool_call_id: z.string().max(256).optional(),
		tool_calls: z.array(toolCallSchema).max(128).optional(),
	})
	.refine(
		(message) =>
			message.content !== null ||
			(message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0),
	);

const toolSchema = z.object({
	type: z.literal("function"),
	function: z
		.object({
			name: z.string().min(1).max(128),
			parameters: z.record(z.string(), z.unknown()),
			description: z.string().max(4096).optional(),
			required: z.array(z.string()).nullish(),
		})
		.transform((fn) => ({
			name: fn.name,
			parameters: fn.parameters,
			...(fn.description !== undefined ? { description: fn.description } : {}),
			...(Array.isArray(fn.required) ? { required: fn.required } : {}),
		})),
});

const chatCompletionRequestSchema = z.object({
	model: z
		.string()
		.max(256)
		.refine((model) => model.trim().length > 0)
		.transform((model) => model.trim()),
	messages: z.array(messageSchema).min(1).max(1000),
	stream: z.boolean().optional(),
	temperature: z.number().min(0).max(2).optional(),
	max_tokens: z.number().int().min(1).max(100_000).optional(),
	stop: z
		.union([z.string().max(512), z.array(z.string().max(512)).max(4)])
		.optional(),
	tools: z.array(toolSchema).max(128).optional(),
});

export function parseChatCompletionRequest(
	value: unknown,
): ChatCompletionRequest | null {
	const parsed = chatCompletionRequestSchema.safeParse(value);
	if (!parsed.success) return null;
	const data = parsed.data;
	const messages: ChatMessage[] = data.messages.map((message) => ({
		role: message.role,
		content: message.content as ChatContent,
		...(message.name !== undefined ? { name: message.name } : {}),
		...(message.tool_call_id !== undefined
			? { tool_call_id: message.tool_call_id }
			: {}),
		...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
	}));
	const tools: ChatTool[] | undefined = data.tools?.map((tool) => ({
		type: "function" as const,
		function: tool.function,
	}));
	return {
		model: data.model,
		messages,
		...(tools ? { tools } : {}),
		...(data.temperature !== undefined
			? { temperature: data.temperature }
			: {}),
		...(data.max_tokens !== undefined ? { max_tokens: data.max_tokens } : {}),
		...(data.stream !== undefined ? { stream: data.stream } : {}),
		...(data.stop !== undefined ? { stop: data.stop } : {}),
	};
}
