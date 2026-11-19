import type { ProviderCatalog } from "../types";
import { imageParts, parseInlineImage } from "./content";
import { ProviderError, toProviderError } from "./errors";
import { validateStreamModelEcho } from "./model-identity";
import type { UpstreamChatInput } from "./types";

export async function sendMoondream(
	input: UpstreamChatInput,
	provider: ProviderCatalog,
	signal?: AbortSignal,
): Promise<Response> {
	if (input.tools?.length)
		throw new ProviderError(
			"Moondream does not support function calling",
			400,
			"bad_request",
		);
	if (input.stop !== undefined)
		throw new ProviderError(
			"Moondream does not support stop sequences",
			400,
			"bad_request",
		);
	for (const message of input.messages) {
		for (const image of imageParts(message.content)) {
			if (!parseInlineImage(image.image_url.url)) {
				throw new ProviderError(
					"Moondream requires base64 image data URLs",
					400,
					"bad_request",
				);
			}
		}
	}
	const body: Record<string, unknown> = {
		model: input.modelId,
		messages: input.messages,
		stream: input.stream,
	};
	if (input.temperature !== undefined) body.temperature = input.temperature;
	if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
	const response = await fetch(
		`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${input.apiKey}`,
			},
			body: JSON.stringify(body),
			redirect: "manual",
			signal,
		},
	);
	if (!response.ok) throw await toProviderError(response);
	if (!input.stream || !response.body) return response;
	const checkedBody = validateStreamModelEcho(
		response.body,
		provider,
		input.modelId,
	);
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return new Response(checkedBody, { status: response.status, headers });
}
