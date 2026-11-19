// Shared helpers for the public /v1 and /api/v1 route handlers: wrong-method
// (405) and preflight (OPTIONS) responses, the canonical OpenAI error
// envelope, the shared model listing, and its pagination.
//
// The two families (/v1 and /api/v1) share this listing, the invalid-body
// envelope and the pagination rules below, plus one credential. What still
// differs, and why:
//
// - Authentication: /v1 and /api/v1 accept the same credential, the
//   `ska-...` API key (see authenticateAccessKey). One API key authenticates
//   both families.
// - Scope of GET /v1/models: the Anthropic branch (request with
//   `anthropic-version` or `x-api-key`) lists every enabled model in its
//   native shape and is kept as-is; the OpenAI branch and /api/v1/models
//   share the scope below (enabled models of providers with at least one
//   enabled key in the community pool).
// - Entry shape: /v1 entries carry `created: 0` and no
//   `permission`/`root`/`parent`; /api/v1 entries carry `created` as now and
//   `permission: []`, `root: <id>`, `parent: null`. Both shapes are kept for
//   contract compatibility with existing clients.
// - Wrong-method (405) responses keep `code: null` in the error object:
//   tests/v1-methods.test.ts pins that field. Every other error uses the
//   canonical envelope `{ error: { message, type } }` from
//   src/lib/api-error.ts (routeError), without `code`.
// - Anthropic-protocol routes (/v1/messages, /v1/messages/count_tokens and
//   the native branch of /v1/models) do not use the OpenAI envelope at all:
//   they answer with anthropicError, `{ type: "error", error: { type,
//   message }, request_id }`, because that is the shape Anthropic clients
//   parse.
// - Pagination: the OpenAI lists use limit/offset, default 100, max 500,
//   the same clamping rule as GET /api/usage. The native Anthropic branch
//   keeps its own cursor pagination (after_id/before_id, default 20, max
//   1000) because that is the Anthropic protocol.
import { anthropicError } from "./inference-http";
import {
	canonicalModelId,
	displayModelName,
	EXCLUDED_CANONICAL_MODELS,
	ROUTER_MODEL_PREFIX,
} from "./model-canonical";
import {
	checkInvalidTokenLimit,
	checkPublicInferenceLimit,
	getClientIp,
	type PublicLimitResult,
} from "./ratelimit";
import type { D1Database } from "./types";
import {
	listingVirtualRouters,
	virtualRouterProviders,
} from "./virtual-routers";

export function openAiMethodNotAllowed(
	useMethod: string,
	allowed: string,
): Response {
	return Response.json(
		{
			error: {
				message: `Use ${useMethod} for this endpoint.`,
				type: "invalid_request_error",
				code: null,
			},
		},
		{ status: 405, headers: { Allow: allowed } },
	);
}

export function anthropicMethodNotAllowed(
	useMethod: string,
	allowed: string,
): Response {
	const response = anthropicError(
		`Use ${useMethod} for this endpoint.`,
		405,
		"invalid_request_error",
	);
	response.headers.set("Allow", allowed);
	return response;
}

export function methodNotAllowedHead(allowed: string): Response {
	return new Response(null, { status: 405, headers: { Allow: allowed } });
}

export function optionsResponse(allowed: string): Response {
	return new Response(null, { status: 204, headers: { Allow: allowed } });
}

/**
 * 429 for the public inference caps (A2), in the caller's envelope, with
 * Retry-After. OpenAI clients parse `{ error: { message, type:
 * "rate_limit_error" } }`; Anthropic clients parse the native error shape
 * with the same type.
 */
export function publicRateLimitResponse(
	result: PublicLimitResult,
	native: boolean,
): Response {
	const retryAfter = String(result.retryAfterSeconds ?? 60);
	const message = "Rate limit exceeded. Try again shortly.";
	if (native) {
		const response = anthropicError(message, 429, "rate_limit_error");
		response.headers.set("Retry-After", retryAfter);
		return response;
	}
	return Response.json(
		{ error: { message, type: "rate_limit_error" } },
		{ status: 429, headers: { "Retry-After": retryAfter } },
	);
}

/**
 * Per-token + per-IP cap for one authenticated public inference request.
 * Returns the 429 response when the cap is hit, null when the request may
 * proceed. Call after auth, before routing: a capped token never reaches
 * the pool, so no router change is needed for A2 to hold.
 */
export async function enforcePublicInferenceLimit(
	db: D1Database,
	request: Request,
	userId: string,
	native: boolean,
): Promise<Response | null> {
	const result = await checkPublicInferenceLimit(db, {
		userId,
		ip: getClientIp(request),
	});
	return result.ok ? null : publicRateLimitResponse(result, native);
}

/**
 * Invalid-token cap: call when auth fails, before answering 401. Returns
 * the 429 response once the IP exhausted its invalid-attempt budget, null
 * when the caller should get the plain 401. A failure of the limiter
 * itself falls through to null — the cap is a protection, not a gate, so
 * a broken counter must not lock every client out.
 */
export async function enforceInvalidTokenLimit(
	db: D1Database,
	request: Request,
	native: boolean,
): Promise<Response | null> {
	try {
		const result = await checkInvalidTokenLimit(db, {
			ip: getClientIp(request),
		});
		return result.ok ? null : publicRateLimitResponse(result, native);
	} catch {
		return null;
	}
}

/**
 * Canonical OpenAI error envelope, mirroring routeError in
 * src/lib/api-error.ts: `{ error: { message, type } }`. No `code` field:
 * the 405 helpers above are the only responses that carry one.
 */
export function openAiError(
	message: string,
	type: string,
	status: number,
): Response {
	return Response.json({ error: { message, type } }, { status });
}

export const MODELS_PAGE_LIMIT_DEFAULT = 100;
export const MODELS_PAGE_LIMIT_MAX = 500;

/**
 * limit/offset pagination for the OpenAI model lists, with the same
 * clamping rule as GET /api/usage: default 100, max 500, and any missing,
 * non-integer or non-positive value falls back to the default (offset falls
 * back to 0). Invalid values are clamped, never rejected, so callers that
 * pass no parameters keep getting the plain `{ object: "list", data }`
 * shape, now with a `has_more` flag.
 */
export function parseModelsPagination(searchParams: URLSearchParams): {
	limit: number;
	offset: number;
} {
	const rawLimit = Number(searchParams.get("limit") ?? "100");
	const limit =
		Number.isInteger(rawLimit) && rawLimit > 0
			? Math.min(rawLimit, MODELS_PAGE_LIMIT_MAX)
			: MODELS_PAGE_LIMIT_DEFAULT;
	const rawOffset = Number(searchParams.get("offset") ?? "0");
	const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
	return { limit, offset };
}

export interface ModelListEntry {
	id: string;
	name: string;
	providers: string[];
	description?: string;
	members?: string[];
}

export interface ModelListPage {
	entries: ModelListEntry[];
	hasMore: boolean;
}

/**
 * The one model listing both OpenAI families serve. Scope: enabled models
 * of providers with at least one enabled key in the community pool — the
 * same providers the router can actually serve. One entry per logical
 * model (`shtora/<canonical>`), plus the curated virtual routers whose
 * members are present in the listing. The three reads run in parallel.
 *
 * Deliberately not restricted to `platform IN (SELECT id FROM providers)`:
 * direct rows such as the Anthropic models from migration 0005 are
 * listable here as soon as a key for their platform is enabled.
 */
export async function buildModelList(
	db: D1Database,
	limit: number,
	offset: number,
): Promise<ModelListPage> {
	const [modelRows, enabledRows, providerRows] = await Promise.all([
		db
			.prepare(
				"SELECT platform, model_id, name FROM models WHERE enabled = 1 ORDER BY platform, model_id",
			)
			.all<{ platform: string; model_id: string; name: string }>(),
		db
			.prepare("SELECT DISTINCT platform FROM api_keys WHERE enabled = 1")
			.all<{ platform: string }>(),
		db
			.prepare("SELECT id, name FROM providers ORDER BY id")
			.all<{ id: string; name: string }>(),
	]);
	const providerNameById = new Map(
		providerRows.results.map((provider) => [provider.id, provider.name]),
	);
	const enabledPlatforms = new Set(
		enabledRows.results.map((row) => row.platform),
	);
	const byCanonical = new Map<
		string,
		{ id: string; name: string; providers: string[] }
	>();
	for (const row of modelRows.results) {
		if (!enabledPlatforms.has(row.platform)) continue;
		const canonical = canonicalModelId(row.model_id);
		// Excluded canonicals (e.g. "auto") are virtual routers, not
		// ordinary models — they are listed first below, once each.
		if (EXCLUDED_CANONICAL_MODELS.has(canonical)) continue;
		const existing = byCanonical.get(canonical);
		if (existing) {
			if (!existing.providers.includes(row.platform))
				existing.providers.push(row.platform);
		} else {
			byCanonical.set(canonical, {
				id: `${ROUTER_MODEL_PREFIX}${canonical}`,
				name: displayModelName(
					row.name,
					row.platform,
					providerNameById.get(row.platform),
				),
				providers: [row.platform],
			});
		}
	}
	// Curated virtual routers head the listing: they are the curated entry
	// points, so they come before the ordinary models. Pagination slices
	// this combined order, so routers count in the page like any entry.
	// A router with no member here is skipped.
	const providersByCanonical = new Map<string, readonly string[]>(
		[...byCanonical.entries()].map(([canonical, entry]) => [
			canonical,
			entry.providers,
		]),
	);
	const routerEntries: ModelListEntry[] = [];
	for (const router of listingVirtualRouters()) {
		const providers = virtualRouterProviders(
			router.members,
			providersByCanonical,
		);
		const members = router.members.filter((member) =>
			providersByCanonical.has(member),
		);
		if (members.length === 0) continue;
		routerEntries.push({
			id: router.id,
			name: router.name,
			description: router.description,
			providers,
			members,
		});
	}
	const entries: ModelListEntry[] = [...routerEntries, ...byCanonical.values()];
	const total = entries.length;
	const page = entries.slice(offset, offset + limit);
	return {
		entries: page,
		hasMore: offset + page.length < total,
	};
}
