import { transformSseStream } from "@/lib/providers/sse";

interface ChatResponse {
	error?: { message?: string } | string;
	choices?: {
		index?: number;
		delta?: { content?: string };
		message?: { content?: string };
		finish_reason?: string | null;
	}[];
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
			throw new Error(
				typeof data.error === "string"
					? data.error
					: data.error.message || "The model could not complete this request.",
			);
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
