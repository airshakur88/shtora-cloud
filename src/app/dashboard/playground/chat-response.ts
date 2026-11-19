import { transformSseStream } from "@/lib/providers/sse";

/** One failed upstream attempt, as reported by the playground route. */
export interface ChatAttempt {
	platform: string;
	modelId: string;
	status: number;
	kind: string;
	latencyMs: number;
	phase: "member" | "fallback";
}

/**
 * A failed non-streamed chat response that carries the attempt log.
 * Only the six attempt fields travel with it: no prompts, keys, or
 * upstream bodies.
 */
export class ChatResponseError extends Error {
	readonly attempts: ChatAttempt[];

	constructor(message: string, attempts: ChatAttempt[]) {
		super(message);
		this.name = "ChatResponseError";
		this.attempts = attempts;
	}
}

interface ChatResponse {
	error?: { message?: string } | string;
	debug?: { attempts?: unknown };
	choices?: {
		index?: number;
		delta?: { content?: string };
		message?: { content?: string };
		finish_reason?: string | null;
	}[];
}

/** Accept only attempt entries with the six expected fields. */
function parseAttempts(value: unknown): ChatAttempt[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const attempts: ChatAttempt[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") return null;
		const entry = item as Record<string, unknown>;
		if (
			typeof entry.platform !== "string" ||
			typeof entry.modelId !== "string" ||
			typeof entry.status !== "number" ||
			typeof entry.kind !== "string" ||
			typeof entry.latencyMs !== "number" ||
			(entry.phase !== "member" && entry.phase !== "fallback")
		)
			return null;
		attempts.push({
			platform: entry.platform,
			modelId: entry.modelId,
			status: entry.status,
			kind: entry.kind,
			latencyMs: entry.latencyMs,
			phase: entry.phase,
		});
	}
	return attempts;
}

export async function readChatResponse(
	response: Response,
	onText: (text: string) => void,
): Promise<string> {
	if (
		!response.ok ||
		!response.headers.get("content-type")?.includes("text/event-stream")
	) {
		const rawData = await response.json().catch(() => null);
		const data = rawData ? (rawData as ChatResponse) : null;
		if (data?.error) {
			const message =
				typeof data.error === "string"
					? data.error
					: data.error.message || "The model could not complete this request.";
			const attempts = parseAttempts(data.debug?.attempts);
			if (attempts) throw new ChatResponseError(message, attempts);
			throw new Error(message);
		}
		if (!response.ok)
			throw new Error(`Request failed (${response.status}). Please try again.`);
		const content = data?.choices?.[0]?.message?.content;
		if (!content)
			throw new Error("The model returned no text. Try another model.");
		onText(content);
		return content;
	}
	if (!response.body) throw new Error("The model returned an empty response.");
	let text = "";
	let completed = false;
	let finished = false;
	const stream = transformSseStream(response.body, (event, controller) => {
		if (completed) return;
		if (event.data === "[DONE]") {
			completed = true;
			controller.terminate();
			return;
		}
		let data: ChatResponse;
		try {
			data = JSON.parse(event.data);
		} catch {
			throw new Error("The model sent an invalid response. Please try again.");
		}
		if (data?.error || event.event === "error") {
			throw new Error(
				typeof data?.error === "string"
					? data.error
					: data?.error?.message ||
							"The model stopped responding. Please try again.",
			);
		}
		const choice = data?.choices?.find(
			(item) => item.index === 0 || item.index === undefined,
		);
		if (typeof choice?.delta?.content === "string") {
			text += choice.delta.content;
			onText(text);
		}
		if (choice?.finish_reason) finished = true;
	});
	const reader = stream.getReader();
	try {
		while (!(await reader.read()).done) {
			// The transform consumes events and publishes text through onText.
		}
	} finally {
		reader.releaseLock();
	}
	if (!completed && !finished)
		throw new Error(
			"The response ended before it completed. Please try again.",
		);
	if (!text) throw new Error("The model returned no text. Try another model.");
	return text;
}
