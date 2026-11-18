import { ProviderError } from "./providers/errors";
import { sseResponse, transformSseStream } from "./providers/sse";
import {
	completionOutputCharacters,
	estimateTokensFromCharacters,
	isRecord,
	isValidTokenCount,
	parseCompletionTokenCounts,
} from "./token-estimates";

export function nativeTokenCounts(usage: unknown): {
	inputTokens: number | null;
	outputTokens: number | null;
	inputEstimated: boolean;
	outputEstimated: boolean;
} {
	if (!isRecord(usage))
		return {
			inputTokens: null,
			outputTokens: null,
			inputEstimated: true,
			outputEstimated: true,
		};
	const input = usage.input_tokens;
	const creation = usage.cache_creation_input_tokens ?? 0;
	const read = usage.cache_read_input_tokens ?? 0;
	const total =
		isValidTokenCount(input) &&
		isValidTokenCount(creation) &&
		isValidTokenCount(read)
			? input + creation + read
			: null;
	const provenance = isRecord(usage.shtora_estimated)
		? usage.shtora_estimated
		: {};
	return {
		inputTokens: total !== null && Number.isSafeInteger(total) ? total : null,
		outputTokens: isValidTokenCount(usage.output_tokens)
			? usage.output_tokens
			: null,
		inputEstimated: provenance.input_tokens === true,
		outputEstimated: provenance.output_tokens === true,
	};
}

export function nativeOutputCharacters(value: unknown): number {
	if (!isRecord(value) || !Array.isArray(value.content)) return 0;
	return value.content.reduce(
		(total, block) =>
			total +
			(isRecord(block)
				? typeof block.text === "string"
					? block.text.length
					: typeof block.thinking === "string"
						? block.thinking.length
						: block.type === "tool_use"
							? JSON.stringify(block.input ?? {}).length
							: 0
				: 0),
		0,
	);
}

function nativeStop(reason: unknown): string {
	if (reason === "stop") return "end_turn";
	if (reason === "length") return "max_tokens";
	if (reason === "tool_calls") return "tool_use";
	throw new ProviderError(
		"Upstream returned an unsupported completion reason",
		502,
		"server",
	);
}

function toolInput(raw: unknown): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : "");
		if (isRecord(parsed)) return parsed;
	} catch {
		/* Classified below. */
	}
	throw new ProviderError(
		"Upstream returned invalid tool input",
		502,
		"server",
	);
}

export function translateNativeResponse(
	data: unknown,
	model: string,
	estimatedInput: number,
): Response {
	if (
		!isRecord(data) ||
		!Array.isArray(data.choices) ||
		data.choices.length !== 1 ||
		!isRecord(data.choices[0]) ||
		!isRecord(data.choices[0].message)
	)
		throw new ProviderError("Invalid upstream completion", 502, "server");
	const choice = data.choices[0];
	const message = choice.message as Record<string, unknown>;
	if (
		Object.entries(message).some(
			([key, value]) =>
				!["role", "content", "tool_calls"].includes(key) &&
				value !== null &&
				value !== undefined,
		)
	)
		throw new ProviderError(
			"Unsupported upstream message fields",
			502,
			"server",
		);
	const content: Record<string, unknown>[] = [];
	if (typeof message.content === "string" && message.content)
		content.push({ type: "text", text: message.content, citations: null });
	else if (
		message.content !== null &&
		message.content !== undefined &&
		message.content !== ""
	)
		throw new ProviderError("Unsupported upstream content", 502, "server");
	if (Array.isArray(message.tool_calls)) {
		for (const call of message.tool_calls) {
			if (
				!isRecord(call) ||
				typeof call.id !== "string" ||
				!isRecord(call.function) ||
				typeof call.function.name !== "string"
			)
				throw new ProviderError("Invalid upstream tool call", 502, "server");
			content.push({
				type: "tool_use",
				id: call.id,
				name: call.function.name,
				input: toolInput(call.function.arguments),
			});
		}
	}
	const counts = parseCompletionTokenCounts(data);
	const outputChars = completionOutputCharacters(data);
	const realOutput =
		counts.outputTokens !== null &&
		!(counts.outputTokens === 0 && outputChars > 0);
	return Response.json({
		id: typeof data.id === "string" ? data.id : `msg_${crypto.randomUUID()}`,
		type: "message",
		role: "assistant",
		model,
		content,
		stop_reason: nativeStop(choice.finish_reason),
		stop_sequence: null,
		usage: {
			input_tokens: counts.inputTokens ?? estimatedInput,
			output_tokens: realOutput
				? counts.outputTokens
				: estimateTokensFromCharacters(outputChars),
			shtora_estimated: {
				input_tokens: counts.inputTokens === null || counts.estimated,
				output_tokens: !realOutput || counts.estimated,
			},
		},
	});
}

export function translateNativeStream(
	upstream: ReadableStream<Uint8Array>,
	model: string,
	estimatedInput: number,
): Response {
	const encoder = new TextEncoder();
	const id = `msg_${crypto.randomUUID()}`;
	let started = false;
	let stopped = false;
	let finish: string | null = null;
	let nextIndex = 0;
	let textIndex: number | null = null;
	let outputChars = 0;
	let reportedInput: number | null = null;
	let reportedOutput: number | null = null;
	let estimated = false;
	let toolChars = 0;
	const tools = new Map<
		number,
		{ index: number; id: string; name: string; json: string; started: boolean }
	>();
	const emit = (
		controller: TransformStreamDefaultController<Uint8Array>,
		type: string,
		payload: Record<string, unknown> = {},
	) => {
		controller.enqueue(
			encoder.encode(
				`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`,
			),
		);
	};
	const start = (controller: TransformStreamDefaultController<Uint8Array>) => {
		if (started) return;
		started = true;
		emit(controller, "message_start", {
			message: {
				id,
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: estimatedInput,
					output_tokens: 0,
					shtora_estimated: { input_tokens: true, output_tokens: true },
				},
			},
		});
	};
	const fail = (controller: TransformStreamDefaultController<Uint8Array>) => {
		if (stopped) return;
		stopped = true;
		emit(controller, "error", {
			error: {
				type: "api_error",
				message: "Upstream stream ended without a valid complete message",
			},
		});
	};
	const body = transformSseStream(
		upstream,
		(event, controller) => {
			if (stopped) return;
			if (event.data === "[DONE]") {
				if (!finish) {
					fail(controller);
					return;
				}
				for (const tool of tools.values()) {
					if (!tool.started) {
						fail(controller);
						return;
					}
					toolInput(tool.json);
				}
				start(controller);
				if (textIndex !== null)
					emit(controller, "content_block_stop", { index: textIndex });
				for (const tool of tools.values())
					emit(controller, "content_block_stop", { index: tool.index });
				const realOutput =
					reportedOutput !== null && !(reportedOutput === 0 && outputChars > 0);
				emit(controller, "message_delta", {
					delta: { stop_reason: finish, stop_sequence: null },
					usage: {
						input_tokens: reportedInput ?? estimatedInput,
						output_tokens: realOutput
							? reportedOutput
							: estimateTokensFromCharacters(outputChars),
						shtora_estimated: {
							input_tokens: reportedInput === null || estimated,
							output_tokens: !realOutput || estimated,
						},
					},
				});
				emit(controller, "message_stop");
				stopped = true;
				return;
			}
			let value: unknown;
			try {
				value = JSON.parse(event.data);
			} catch {
				fail(controller);
				return;
			}
			if (!isRecord(value) || value.error) {
				fail(controller);
				return;
			}
			const counts = parseCompletionTokenCounts(value);
			if (counts.inputTokens !== null) reportedInput = counts.inputTokens;
			if (counts.outputTokens !== null) reportedOutput = counts.outputTokens;
			if (isRecord(value.usage)) estimated = counts.estimated;
			if (!Array.isArray(value.choices)) {
				fail(controller);
				return;
			}
			start(controller);
			for (const choice of value.choices) {
				if (!isRecord(choice) || choice.index !== 0) {
					fail(controller);
					return;
				}
				if (choice.finish_reason !== null && choice.finish_reason !== undefined)
					finish = nativeStop(choice.finish_reason);
				if (!isRecord(choice.delta)) continue;
				const delta = choice.delta;
				if (
					Object.entries(delta).some(
						([key, item]) =>
							!["role", "content", "tool_calls"].includes(key) &&
							item !== null &&
							item !== undefined,
					)
				) {
					fail(controller);
					return;
				}
				if (typeof delta.content === "string" && delta.content) {
					if (tools.size) {
						fail(controller);
						return;
					}
					if (textIndex === null) {
						textIndex = nextIndex++;
						emit(controller, "content_block_start", {
							index: textIndex,
							content_block: { type: "text", text: "", citations: null },
						});
					}
					outputChars += delta.content.length;
					emit(controller, "content_block_delta", {
						index: textIndex,
						delta: { type: "text_delta", text: delta.content },
					});
				}
				if (!Array.isArray(delta.tool_calls)) continue;
				if (textIndex !== null) {
					emit(controller, "content_block_stop", { index: textIndex });
					textIndex = null;
				}
				for (const call of delta.tool_calls) {
					if (
						!isRecord(call) ||
						!Number.isSafeInteger(call.index) ||
						!isRecord(call.function)
					) {
						fail(controller);
						return;
					}
					const key = call.index as number;
					let tool = tools.get(key);
					if (!tool) {
						if (tools.size >= 128) {
							fail(controller);
							return;
						}
						tool = {
							index: nextIndex++,
							id: "",
							name: "",
							json: "",
							started: false,
						};
						tools.set(key, tool);
					}
					if (typeof call.id === "string") tool.id += call.id;
					if (typeof call.function.name === "string") {
						if (tool.started) {
							fail(controller);
							return;
						}
						tool.name += call.function.name;
					}
					if (typeof call.function.arguments !== "string") continue;
					if (!tool.started) {
						if (!tool.id || !tool.name) {
							fail(controller);
							return;
						}
						tool.started = true;
						emit(controller, "content_block_start", {
							index: tool.index,
							content_block: {
								type: "tool_use",
								id: tool.id,
								name: tool.name,
								input: {},
							},
						});
					}
					tool.json += call.function.arguments;
					toolChars += call.function.arguments.length;
					outputChars += call.function.arguments.length;
					if (toolChars > 1_000_000) {
						fail(controller);
						return;
					}
					emit(controller, "content_block_delta", {
						index: tool.index,
						delta: {
							type: "input_json_delta",
							partial_json: call.function.arguments,
						},
					});
				}
			}
		},
		fail,
		1_000_000,
	);
	return sseResponse(body);
}
