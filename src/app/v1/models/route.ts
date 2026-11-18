import { nativeModels } from "@/lib/anthropic-models";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { getApiKeyOwnerByToken } from "@/lib/key-store";
import {
	canonicalModelId,
	displayModelName,
	EXCLUDED_CANONICAL_MODELS,
	ROUTER_MODEL_PREFIX,
} from "@/lib/model-canonical";
import catalog from "@/lib/models-catalog.json";
import {
	listingVirtualRouters,
	virtualRouterProviders,
} from "@/lib/virtual-routers";

function unauthorized(): Response {
	return Response.json(
		{
			error: {
				message: "Missing or invalid API key",
				type: "authentication_error",
				code: null,
			},
		},
		{ status: 401 },
	);
}

export async function GET(request: Request): Promise<Response> {
	if (
		request.headers.has("anthropic-version") ||
		request.headers.has("x-api-key")
	)
		return nativeModels(request);
	try {
		const authorization = request.headers.get("authorization");
		if (!authorization?.startsWith("Bearer ")) return unauthorized();
		const token = authorization.slice(7).trim();
		if (!token) return unauthorized();
		getEncryptionSecret();
		if (!(await getApiKeyOwnerByToken(getDb(), token))) return unauthorized();
		const result = await getDb()
			.prepare(
				"SELECT platform, model_id, name FROM models WHERE enabled = 1 ORDER BY platform, model_id",
			)
			.all<{ platform: string; model_id: string; name: string }>();
		// One router-routed entry per logical model: shtora/<canonical>.
		const byCanonical = new Map<
			string,
			{ id: string; name: string; providers: string[] }
		>();
		const enabledRows = await getDb()
			.prepare("SELECT DISTINCT platform FROM api_keys WHERE enabled = 1")
			.all<{ platform: string }>();
		const enabledPlatforms = new Set(
			enabledRows.results.map((row) => row.platform),
		);
		// Only providers with at least one enabled key in the community pool are
		// routable, so list models only for those platforms.
		// Upstream display names end with the provider in parentheses; the
		// provider already has its own field, so names are served without it.
		const providerNameById = new Map(
			(catalog.providers as Array<{ id: string; name: string }>).map(
				(provider) => [provider.id, provider.name],
			),
		);
		for (const row of result.results) {
			if (!enabledPlatforms.has(row.platform)) continue;
			const canonical = canonicalModelId(row.model_id);
			// Excluded canonicals (e.g. "auto") are virtual routers, not
			// ordinary models — they are appended below, once each.
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
		// Virtual-router entries carry description/members; ordinary entries do not.
		interface ModelEntry {
			id: string;
			object: string;
			created: number;
			owned_by: string;
			name: string;
			description?: string;
			providers: string[];
			members?: string[];
		}
		const models: ModelEntry[] = [...byCanonical.values()].map((entry) => ({
			id: entry.id,
			object: "model",
			created: 0,
			owned_by: "shtora",
			name: entry.name,
			providers: entry.providers,
		}));
		// Curated virtual routers, with the providers of their members that
		// are present in this listing. A router with no member here is skipped.
		const providersByCanonical = new Map<string, readonly string[]>(
			[...byCanonical.entries()].map(([canonical, entry]) => [
				canonical,
				entry.providers,
			]),
		);
		for (const router of listingVirtualRouters()) {
			const providers = virtualRouterProviders(
				router.members,
				providersByCanonical,
			);
			const members = router.members.filter((member) =>
				providersByCanonical.has(member),
			);
			if (members.length === 0) continue;
			models.push({
				id: router.id,
				object: "model",
				created: 0,
				owned_by: "shtora",
				name: router.name,
				description: router.description,
				providers,
				members,
			});
		}
		return Response.json({
			object: "list",
			data: models,
		});
	} catch {
		return Response.json(
			{ error: { message: "Internal error", type: "server_error" } },
			{ status: 500 },
		);
	}
}
