export interface SseEvent {
	event: string;
	data: string;
}

export interface OpenAiUsageChunk {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	estimated?: boolean;
}

export function transformSseStream(
	upstream: ReadableStream<Uint8Array>,
	handleEvent: (
		event: SseEvent,
		controller: TransformStreamDefaultController<Uint8Array>,
	) => void,
	onFlush?: (controller: TransformStreamDefaultController<Uint8Array>) => void,
	maxEventChars = Number.POSITIVE_INFINITY,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName = "";
	let dataLines: string[] = [];
	let eventChars = 0;
	const dispatch = (
		controller: TransformStreamDefaultController<Uint8Array>,
	) => {
		if (dataLines.length > 0) {
			handleEvent({ event: eventName, data: dataLines.join("\n") }, controller);
		}
		eventName = "";
		dataLines = [];
		eventChars = 0;
	};
	const processLine = (
		line: string,
		controller: TransformStreamDefaultController<Uint8Array>,
	) => {
		if (line === "") {
			dispatch(controller);
			return;
		}
		if (line.startsWith(":")) return;
		const separator = line.indexOf(":");
		const field = separator < 0 ? line : line.slice(0, separator);
		const value =
			separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
		if (field === "event") eventName = value;
		else if (field === "data") {
			eventChars += value.length;
			if (eventChars > maxEventChars)
				throw new Error("SSE event exceeds limit");
			dataLines.push(value);
		}
	};
	const processBuffer = (
		controller: TransformStreamDefaultController<Uint8Array>,
		final = false,
	) => {
		while (buffer.length > 0) {
			let delimiter = -1;
			let delimiterLength = 0;
			for (let index = 0; index < buffer.length; index += 1) {
				if (buffer[index] === "\n") {
					delimiter = index;
					delimiterLength = 1;
					break;
				}
				if (buffer[index] === "\r") {
					if (index === buffer.length - 1 && !final) break;
					delimiter = index;
					delimiterLength = buffer[index + 1] === "\n" ? 2 : 1;
					break;
				}
			}
			if (delimiter < 0) break;
			processLine(buffer.slice(0, delimiter), controller);
			buffer = buffer.slice(delimiter + delimiterLength);
		}
		if (buffer.length + eventChars > maxEventChars)
			throw new Error("SSE event exceeds limit");
		if (final) buffer = "";
	};
	return upstream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				processBuffer(controller);
			},
			flush(controller) {
				buffer += decoder.decode();
				processBuffer(controller, true);
				onFlush?.(controller);
			},
		}),
	);
}

export function openAiChunk(
	id: string,
	created: number,
	model: string,
	delta: Record<string, unknown>,
	finishReason: string | null,
): string {
	return `data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;
}
export function openAiUsageChunk(
	id: string,
	created: number,
	model: string,
	usage: OpenAiUsageChunk,
): string {
	return `data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [],
		usage,
	})}\n\n`;
}

export function sseResponse(body: ReadableStream<Uint8Array>): Response {
	return new Response(body, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
