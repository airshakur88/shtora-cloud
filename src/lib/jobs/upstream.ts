import type { ProviderCatalog } from "@/lib/types";

/**
 * Cheap upstream probes shared by the catalog-validation and key-probe
 * jobs. Both jobs only need to know whether an upstream answers and,
 * for list endpoints, which model ids it reports — never key material
 * or response bodies beyond the id list.
 */

export type FetchImpl = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

export interface UpstreamModelList {
	/** True when the upstream answered 2xx. */
	ok: boolean;
	/** HTTP status, or null when the request never reached the upstream. */
	status: number | null;
	/** Model ids from a list endpoint, when one was returned. */
	modelIds: Set<string>;
	/** The upstream has no list endpoint for this protocol. */
	listUnsupported?: boolean;
	/** The stored key cannot be split into the parts this upstream needs. */
	malformedKey?: boolean;
}

const UPSTREAM_TIMEOUT_MS = 15_000;

/** Anthropic API version the native sender targets (see providers/anthropic.ts). */
const ANTHROPIC_VERSION = "2026-10-21";

function stripTrailingSlash(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function bearerHeaders(apiKey: string | null): Record<string, string> {
	if (!apiKey || apiKey === "no-key") return {};
	return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Model ids from the shapes list endpoints actually return: OpenAI
 * `{data: [{id}]}`, Gemini `{models: [{name: "models/..."}]}` and
 * Cloudflare `{result: [{name}]}`. Unknown shapes yield an empty set —
 * callers treat an empty set on a 2xx as "nothing listed", not as an
 * error.
 */
function parseModelIds(body: unknown): Set<string> {
	const ids = new Set<string>();
	if (!body || typeof body !== "object") return ids;
	const record = body as Record<string, unknown>;
	for (const field of ["data", "models", "result"]) {
		const entries = record[field];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const id = (entry as { id?: unknown }).id;
			if (typeof id === "string" && id.length > 0) ids.add(id);
			const name = (entry as { name?: unknown }).name;
			if (typeof name === "string" && name.length > 0)
				ids.add(name.replace(/^models\//, ""));
		}
	}
	return ids;
}

async function getModelList(
	url: string,
	headers: Record<string, string>,
	fetchImpl: FetchImpl,
): Promise<UpstreamModelList> {
	try {
		const response = await fetchImpl(url, {
			headers,
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		});
		if (!response.ok)
			return { ok: false, status: response.status, modelIds: new Set() };
		const body: unknown = await response.json();
		return { ok: true, status: response.status, modelIds: parseModelIds(body) };
	} catch {
		return { ok: false, status: null, modelIds: new Set() };
	}
}

/**
 * GET the upstream's model list, per protocol. Anthropic has no list
 * endpoint, so it reports `listUnsupported` and the caller falls back
 * to a minimal chat probe. Cloudflare keys are `accountId:token` and
 * list through `/accounts/{id}/ai/v1/models/search`, mirroring the
 * sender in providers/cloudflare.ts.
 */
export async function fetchUpstreamModelList(
	provider: Pick<ProviderCatalog, "baseUrl" | "authType" | "protocol">,
	apiKey: string | null,
	fetchImpl: FetchImpl = globalThis.fetch,
): Promise<UpstreamModelList> {
	const base = stripTrailingSlash(provider.baseUrl);
	if (provider.protocol === "anthropic_messages")
		return {
			ok: false,
			status: null,
			modelIds: new Set(),
			listUnsupported: true,
		};
	if (provider.protocol === "cloudflare_openai") {
		const key = apiKey ?? "";
		const separator = key.indexOf(":");
		if (separator <= 0)
			return {
				ok: false,
				status: null,
				modelIds: new Set(),
				malformedKey: true,
			};
		const accountId = key.slice(0, separator);
		const token = key.slice(separator + 1);
		return getModelList(
			`${base}/accounts/${encodeURIComponent(accountId)}/ai/v1/models/search`,
			{ Authorization: `Bearer ${token}` },
			fetchImpl,
		);
	}
	if (provider.authType === "google_api_key") {
		return getModelList(
			`${base}/models?key=${encodeURIComponent(apiKey ?? "")}`,
			{},
			fetchImpl,
		);
	}
	return getModelList(`${base}/models`, bearerHeaders(apiKey), fetchImpl);
}

/**
 * Minimal Anthropic chat probe: one message, `max_tokens: 1`. Used
 * where there is no list endpoint. Any 2xx means the key
 * authenticates; the content is discarded.
 */
export async function probeAnthropicChat(
	provider: Pick<ProviderCatalog, "baseUrl">,
	apiKey: string,
	modelId: string,
	fetchImpl: FetchImpl = globalThis.fetch,
): Promise<{ status: number | null }> {
	try {
		const response = await fetchImpl(
			`${stripTrailingSlash(provider.baseUrl)}/messages`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
					"anthropic-version": ANTHROPIC_VERSION,
				},
				body: JSON.stringify({
					model: modelId,
					max_tokens: 1,
					messages: [{ role: "user", content: "OK" }],
				}),
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			},
		);
		return { status: response.status };
	} catch {
		return { status: null };
	}
}
