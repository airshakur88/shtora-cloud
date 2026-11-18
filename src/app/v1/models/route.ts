import { nativeModels } from "@/lib/anthropic-models";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { getApiKeyOwnerByToken } from "@/lib/key-store";
import { canonicalModelId, ROUTER_MODEL_PREFIX } from "@/lib/model-canonical";

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
		for (const row of result.results) {
			if (!enabledPlatforms.has(row.platform)) continue;
			const canonical = canonicalModelId(row.model_id);
			const existing = byCanonical.get(canonical);
			if (existing) {
				if (!existing.providers.includes(row.platform))
					existing.providers.push(row.platform);
			} else {
				byCanonical.set(canonical, {
					id: `${ROUTER_MODEL_PREFIX}${canonical}`,
					name: row.name,
					providers: [row.platform],
				});
			}
		}
		return Response.json({
			object: "list",
			data: [...byCanonical.values()].map((entry) => ({
				id: entry.id,
				object: "model",
				created: 0,
				owned_by: "shtora",
				name: entry.name,
				providers: entry.providers,
			})),
		});
	} catch {
		return Response.json(
			{ error: { message: "Internal error", type: "server_error" } },
			{ status: 500 },
		);
	}
}
