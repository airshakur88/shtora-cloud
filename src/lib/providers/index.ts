import type { NativeMessagesRequest } from "../anthropic-request";
import { getProviderConfig } from "../provider-catalog";
import type { ProviderCatalog } from "../types";
import { sendCloudflare } from "./cloudflare";
import { ProviderError, toProviderError } from "./errors";
import { sendMoondream } from "./moondream";
import { sendOpenAICompatible } from "./openai-compatible";
import { validatePublicHttpsUrl } from "./public-url";
import type { UpstreamChatInput } from "./types";

export type { FailureKind } from "./errors";
export { ProviderError, parseRetryAfterMs } from "./errors";
export type { UpstreamChatInput } from "./types";

async function resolveBaseUrl(
	input: UpstreamChatInput,
	provider: ProviderCatalog | undefined,
): Promise<string> {
	// Catalog baseUrl is trusted config (may intentionally be localhost for
	// self-hosted providers like Ollama); user-provided custom baseUrl must be
	// a public HTTPS endpoint to prevent SSRF.
	if (provider?.baseUrl) return provider.baseUrl;
	const candidate = input.baseUrl;
	if (!candidate)
		throw new ProviderError("Invalid upstream configuration", 0, "bad_request");
	const url = await validatePublicHttpsUrl(candidate);
	if (!url)
		throw new ProviderError("Invalid upstream configuration", 0, "bad_request");
	return url.toString();
}

export async function sendNativeMessages(
	input: UpstreamChatInput,
	native: NativeMessagesRequest,
	signal?: AbortSignal,
): Promise<Response> {
	const provider = getProviderConfig(input.platform);
	const baseUrl = await resolveBaseUrl(input, provider);
	const headers = new Headers({
		Authorization: `Bearer ${input.apiKey}`,
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
		...native.headers,
	});
	headers.set(
		"Accept",
		input.stream ? "text/event-stream" : "application/json",
	);
	const response = await fetch(
		`${baseUrl}/messages${native.operation === "count_tokens" ? "/count_tokens" : ""}`,
		{
			method: "POST",
			headers,
			body: JSON.stringify(native.body),
			signal,
		},
	);
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw await toProviderError(
			new Response(text, { status: response.status }),
		);
	}
	if (
		input.stream &&
		!response.headers.get("content-type")?.includes("text/event-stream")
	)
		throw new ProviderError(
			"Native upstream did not return SSE",
			502,
			"server",
		);
	return new Response(response.body, {
		headers: nativeResponseHeaders(response.headers),
	});
}

export function nativeResponseHeaders(source: Headers): Headers {
	const h = new Headers();
	for (const [name, value] of source) {
		if (
			name.toLowerCase() === "content-type" ||
			name.toLowerCase() === "cache-control"
		)
			h.set(name, value);
	}
	return h;
}

export async function sendChat(
	input: UpstreamChatInput,
	signal?: AbortSignal,
): Promise<Response> {
	const provider = getProviderConfig(input.platform);
	const baseUrl = await resolveBaseUrl(input, provider);

	if (provider?.protocol === "anthropic_messages") {
		throw new ProviderError(
			"Anthropic messages protocol not supported via sendChat",
			0,
			"bad_request",
		);
	}

	if (provider?.protocol === "cloudflare_openai") {
		return sendCloudflare(input, provider, signal);
	}

	if (provider?.protocol === "moondream") {
		return sendMoondream(input, provider, signal);
	}

	return sendOpenAICompatible(input, provider, baseUrl, signal);
}
