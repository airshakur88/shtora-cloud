import {
	AccessAuthError,
	authenticateAccessKey,
	createAuthErrorResponse,
} from "@/lib/access-auth";
import { canonicalModelId, ROUTER_MODEL_PREFIX } from "@/lib/model-canonical";
import catalog from "@/lib/models-catalog.json";

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
			const existing = byCanonical.get(canonical);
			if (existing) {
				if (!existing.providers.includes(provider.id))
					existing.providers.push(provider.id);
			} else {
				byCanonical.set(canonical, {
					id: `${ROUTER_MODEL_PREFIX}${canonical}`,
					name: model.name,
					providers: [provider.id],
				});
			}
		}
	}
	const models = [...byCanonical.values()].map((entry) => ({
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

	return Response.json({
		object: "list",
		data: models,
	});
}
