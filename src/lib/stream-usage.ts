import {
	nativeOutputCharacters,
	nativeTokenCounts,
} from "./anthropic-response";
import {
	deltaOutputCharacters,
	estimateTokensFromCharacters,
	isRecord,
	parseReportedTokenCounts,
} from "./token-estimates";

const MAX_EVENT_CHARS = 1_000_000;

export interface StreamUsageResult {
	inputTokens: number;
	outputTokens: number | null;
	inputTokensEstimated: boolean;
	outputTokensEstimated: boolean;
	ttftMs: number | null;
	completed: boolean;
	cancelled: boolean;
}

export function observeStreamUsage(
	body: ReadableStream<Uint8Array>,
	estimatedInputTokens: number,
	attemptStartedAt: number,
	onComplete: (usage: StreamUsageResult) => Promise<void> | void,
	protocol: "openai" | "anthropic" = "openai",
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let dataLines: string[] = [];
	let eventChars = 0;
	let observing = true;
	let finalized = false;
	let inputTokens: number | null = null;
	let outputTokens: number | null = null;
	let inputTokensEstimated = true;
	let outputTokensEstimated = true;
	let outputCharacters = 0;
	let ttftMs: number | null = null;
	let completed = protocol === "openai";
	let failed = false;
	let cancelled = false;
	const nativeUsage: Record<string, unknown> = {};

	const parseEvent = () => {
		if (dataLines.length === 0) return;
		const eventData = dataLines.join("\n");
		dataLines = [];
		eventChars = 0;
		if (eventData === "[DONE]") return;
		let event: unknown;
		try {
			event = JSON.parse(eventData);
		} catch {
			return;
		}
		if (!isRecord(event)) return;
		if (protocol === "anthropic") {
			if (event.type === "message_stop") completed = true;
			if (event.type === "error") failed = true;
			const incoming =
				event.type === "message_start" && isRecord(event.message)
					? event.message.usage
					: event.usage;
			if (isRecord(incoming)) {
				Object.assign(nativeUsage, incoming);
				const counts = nativeTokenCounts(nativeUsage);
				if (counts.inputTokens !== null) {
					inputTokens = counts.inputTokens;
					inputTokensEstimated = counts.inputEstimated;
				}
				if (counts.outputTokens !== null) {
					outputTokens = counts.outputTokens;
					outputTokensEstimated = counts.outputEstimated;
				}
			}
			let characters = 0;
			if (event.type === "content_block_delta" && isRecord(event.delta)) {
				const delta = event.delta;
				characters =
					typeof delta.text === "string"
						? delta.text.length
						: typeof delta.thinking === "string"
							? delta.thinking.length
							: typeof delta.partial_json === "string"
								? delta.partial_json.length
								: 0;
			} else if (
				event.type === "content_block_start" &&
				isRecord(event.content_block)
			) {
				const block = event.content_block;
				characters = nativeOutputCharacters({
					content: [
						block.type === "tool_use" &&
						isRecord(block.input) &&
						Object.keys(block.input).length === 0
							? {}
							: block,
					],
				});
			}
			outputCharacters += characters;
			if (characters > 0 && ttftMs === null)
				ttftMs = Math.max(0, Math.round(performance.now() - attemptStartedAt));
			return;
		}
		const usage = parseReportedTokenCounts(event.usage);
		if (usage.inputTokens !== null) {
			inputTokens = usage.inputTokens;
			inputTokensEstimated = usage.estimated;
		}
		if (usage.outputTokens !== null) {
			outputTokens = usage.outputTokens;
			outputTokensEstimated = usage.estimated;
		}
		if (!Array.isArray(event.choices)) return;
		for (const choice of event.choices) {
			if (!isRecord(choice) || !isRecord(choice.delta)) continue;
			const characters = deltaOutputCharacters(choice.delta);
			outputCharacters += characters;
			if (characters > 0 && ttftMs === null) {
				ttftMs = Math.max(0, Math.round(performance.now() - attemptStartedAt));
			}
		}
	};

	const processLine = (line: string) => {
		if (line === "") {
			parseEvent();
			return;
		}
		if (!line.startsWith("data:")) return;
		const value = line.slice(5).replace(/^ /, "");
		eventChars += value.length;
		if (eventChars > MAX_EVENT_CHARS) {
			if (protocol === "anthropic")
				throw new Error("Native stream event exceeds observation limit");
			observing = false;
			pending = "";
			dataLines = [];
			return;
		}
		dataLines.push(value);
	};

	const consume = (chunk: Uint8Array) => {
		if (!observing) return;
		pending += decoder.decode(chunk, { stream: true });
		while (pending.length > 0) {
			let delimiter = -1;
			let delimiterLength = 0;
			for (let index = 0; index < pending.length; index += 1) {
				if (pending[index] === "\n") {
					delimiter = index;
					delimiterLength = 1;
					break;
				}
				if (pending[index] === "\r") {
					if (index === pending.length - 1) break;
					delimiter = index;
					delimiterLength = pending[index + 1] === "\n" ? 2 : 1;
					break;
				}
			}
			if (delimiter < 0) break;
			processLine(pending.slice(0, delimiter));
			pending = pending.slice(delimiter + delimiterLength);
			if (!observing) return;
		}
		if (pending.length + eventChars > MAX_EVENT_CHARS) {
			if (protocol === "anthropic")
				throw new Error("Native stream event exceeds observation limit");
			observing = false;
			pending = "";
			dataLines = [];
		}
	};
	const flushParser = () => {
		if (!observing) return;
		pending += decoder.decode();
		if (pending.endsWith("\r")) {
			processLine(pending.slice(0, -1));
			pending = "";
		}
	};

	const finalize = async () => {
		if (finalized) return;
		finalized = true;
		const useReportedOutput =
			outputTokens !== null && !(outputTokens === 0 && outputCharacters > 0);
		const result: StreamUsageResult = {
			inputTokens: inputTokens ?? estimatedInputTokens,
			outputTokens: useReportedOutput
				? outputTokens
				: observing
					? estimateTokensFromCharacters(outputCharacters)
					: null,
			inputTokensEstimated: inputTokens === null || inputTokensEstimated,
			outputTokensEstimated: useReportedOutput ? outputTokensEstimated : true,
			ttftMs,
			completed: completed && !failed,
			cancelled,
		};
		try {
			await onComplete(result);
		} catch {
			console.error(JSON.stringify({ event: "usage_metrics_write_failed" }));
		}
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = reader.read();
				const idle = Promise.withResolvers<never>();
				const timer =
					protocol === "anthropic"
						? setTimeout(
								() =>
									idle.reject(
										new Error("Upstream stream idle for five minutes"),
									),
								300_000,
							)
						: undefined;
				const { done, value } = await (protocol === "anthropic"
					? Promise.race([next, idle.promise])
					: next
				).finally(() => clearTimeout(timer));
				if (done) {
					flushParser();
					await finalize();
					reader.releaseLock();
					controller.close();
					return;
				}
				consume(value);
				controller.enqueue(value);
			} catch (error) {
				failed = true;
				try {
					await reader.cancel(error);
				} catch {
					console.error(JSON.stringify({ event: "stream_cancel_failed" }));
				}
				await finalize();
				reader.releaseLock();
				controller.error(error);
			}
		},
		async cancel(reason) {
			failed = true;
			cancelled = true;
			try {
				await reader.cancel(reason);
			} catch {
				// Cancellation already reached the downstream consumer.
			}
			await finalize();
			reader.releaseLock();
		},
	});
}
