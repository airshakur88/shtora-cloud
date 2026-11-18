import {
	AccessAuthError,
	authenticateAccessKey,
	createAuthErrorResponse,
} from "@/lib/access-auth";
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

export async function GET(request: Request): Promise<Response> {
	try {
		await authenticateAccessKey(request);
	} catch (error) {
		if (error instanceof AccessAuthError) {
			return createAuthErrorResponse(error);
		}
		return Response.json(
			{ error: { message: "Authentication failed", type: "auth_error" } },
			{ status: 401 },
		);
	}

	// One router-routed entry per logical model: shtora/<canonical>.
	const byCanonical = new Map<
		string,
		{ id: string; name: string; providers: string[] }
	>();
	for (const provider of catalog.providers) {
		for (const model of provider.models) {
			const canonical = canonicalModelId(model.id);
			// Excluded canonicals (e.g. "auto") are virtual routers, not
			// ordinary models — they are appended below, once each.
			if (EXCLUDED_CANONICAL_MODELS.has(canonical)) continue;
			const existing = byCanonical.get(canonical);
			if (existing) {
				if (!existing.providers.includes(provider.id))
					existing.providers.push(provider.id);
			} else {
				byCanonical.set(canonical, {
					id: `${ROUTER_MODEL_PREFIX}${canonical}`,
					name: displayModelName(model.name, provider.id, provider.name),
					providers: [provider.id],
				});
			}
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
		permission: unknown[];
		root: string;
		parent: string | null;
	}
	const models: ModelEntry[] = [...byCanonical.values()].map((entry) => ({
		id: entry.id,
		object: "model",
		created: Math.floor(Date.now() / 1000),
		owned_by: "shtora",
		name: entry.name,
		providers: entry.providers,
		permission: [],
		root: entry.id,
		parent: null,
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
			created: Math.floor(Date.now() / 1000),
			owned_by: "shtora",
			name: router.name,
			description: router.description,
			providers,
			members,
			permission: [],
			root: router.id,
			parent: null,
		});
	}

	return Response.json({
		object: "list",
		data: models,
	});
}
