import type { NativeMessagesRequest } from "../anthropic-request";
import { getProviderConfig } from "../provider-catalog";
import type { D1Database, ProviderCatalog } from "../types";
import { sendAiHorde } from "./ai-horde";
import { sendAnthropic } from "./anthropic";
import { sendCloudflare } from "./cloudflare";
import { ProviderError, toProviderError } from "./errors";
import { sendGoogle } from "./google";
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

/**
 * The vendor error response the router returns when a direct native
 * request fails: same status and body, but the upstream API key is
 * redacted wherever it appears in the message (a vendor can echo the
 * key back inside its validation text), and only the headers a caller
 * needs to correlate or retry are kept — the vendor request id and
 * retry-after — never auth or cookie material.
 */
function nativeErrorResponse(
	source: Response,
	bodyText: string,
	apiKey: string,
): Response {
	const headers = new Headers();
	const contentType = source.headers.get("content-type");
	if (contentType) headers.set("content-type", contentType);
	for (const name of ["request-id", "retry-after"]) {
		const value = source.headers.get(name);
		if (value) headers.set(name, value);
	}
	const redacted = apiKey
		? bodyText.split(apiKey).join("[redacted]")
		: bodyText;
	return new Response(redacted, { status: source.status, headers });
}

export async function sendNativeMessages(
	input: UpstreamChatInput,
	native: NativeMessagesRequest,
	signal?: AbortSignal,
	db?: D1Database,
): Promise<Response> {
	const provider = await getProviderConfig(input.platform, db);
	const baseUrl = await resolveBaseUrl(input, provider);
	const headers = new Headers({
		Authorization: `Bearer ${input.apiKey}`,
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
	});
	// The caller's anthropic-* headers are part of the native request
	// (betas, workspace id) and must reach the upstream verbatim. A
	// Headers object has no own enumerable properties, so spreading it
	// into the object above copies nothing — iterate it instead. Never
	// forward anthropic-version (pinned above), the browser-access
	// marker, or any credential header from the inbound request.
	for (const [name, value] of native.headers) {
		if (
			name.startsWith("anthropic-") &&
			name !== "anthropic-version" &&
			name !== "anthropic-dangerous-direct-browser-access"
		)
			headers.set(name, value);
	}
	headers.set(
		"Accept",
		input.stream ? "text/event-stream" : "application/json",
	);
	const response = await fetch(
		`${baseUrl}/messages${native.operation === "count_tokens" ? "/count_tokens" : ""}`,
		{
			method: "POST",
			headers,
			// The upstream gets the bare vendor model id (input.modelId),
			// not the gateway-namespaced id the caller used
			// ("anthropic/claude-opus-5-5") — everything else in the
			// native body passes through verbatim.
			body: JSON.stringify({ ...native.body, model: input.modelId }),
			signal,
		},
	);
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		const error = await toProviderError(
			new Response(text, { status: response.status }),
		);
		error.nativeResponse = nativeErrorResponse(response, text, input.apiKey);
		throw error;
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
		const lower = name.toLowerCase();
		if (
			lower === "content-type" ||
			lower === "cache-control" ||
			// The vendor request id is how a caller correlates an error with
			// the upstream; dropping it makes native 400s unanswerable.
			lower === "request-id"
		)
			h.set(name, value);
	}
	return h;
}

export async function sendChat(
	input: UpstreamChatInput,
	signal?: AbortSignal,
	db?: D1Database,
): Promise<Response> {
	const provider = await getProviderConfig(input.platform, db);
	// Resolved once: for a catalog platform this is always the catalog base
	// URL — a stored key baseUrl is never used for those (C1). Only an
	// off-catalog platform (e.g. `custom`) reaches the key baseUrl, and
	// resolveBaseUrl only accepts a public HTTPS endpoint for it.
	const baseUrl = await resolveBaseUrl(input, provider);

	// The dedicated senders used to be dead code: everything fell through
	// to the OpenAI-compatible path, so Gemini got a POST to a
	// /chat/completions endpoint that does not exist, AI Horde lost its
	// anonymous auth, and Anthropic got an OpenAI-shaped body.
	if (provider?.protocol === "google_gemini") {
		return sendGoogle(input, baseUrl, signal, provider);
	}

	if (provider?.protocol === "ai_horde") {
		return sendAiHorde(input, baseUrl, signal);
	}

	if (provider?.protocol === "anthropic_messages") {
		return sendAnthropic(input, baseUrl, signal, provider);
	}

	if (provider?.protocol === "cloudflare_openai") {
		return sendCloudflare(input, provider, signal);
	}

	if (provider?.protocol === "moondream") {
		return sendMoondream(input, provider, signal);
	}

	return sendOpenAICompatible(input, provider, baseUrl, signal);
}
