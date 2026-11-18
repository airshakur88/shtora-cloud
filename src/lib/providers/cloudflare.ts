import type { ProviderCatalog } from "../types";
import { ProviderError, toProviderError } from "./errors";
import type { UpstreamChatInput } from "./types";

export async function sendCloudflare(
	input: UpstreamChatInput,
	provider: ProviderCatalog,
	signal?: AbortSignal,
): Promise<Response> {
	const separator = input.apiKey.indexOf(":");
	const accountId = separator > 0 ? input.apiKey.slice(0, separator) : "";
	const token = separator > 0 ? input.apiKey.slice(separator + 1) : "";
	if (!accountId || !token)
		throw new ProviderError(
			"Invalid Cloudflare credential",
			400,
			"bad_request",
		);

	const baseUrl = provider.baseUrl.replace(/\/+$/, "");
	const url = `${baseUrl}/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
	const body: Record<string, unknown> = {
		model: input.modelId,
		messages: input.messages,
		stream: input.stream,
	};
	if (input.temperature !== undefined) body.temperature = input.temperature;
	if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
	if (input.stop !== undefined) body.stop = input.stop;
	if (input.tools?.length) body.tools = input.tools;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
		redirect: "manual",
		signal,
	});
	if (!response.ok) throw await toProviderError(response);
	return response;
}
