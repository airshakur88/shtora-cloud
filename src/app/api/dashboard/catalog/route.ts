import { getDb } from "@/lib/env";
import {
	canonicalModelId,
	comboboxModelLabel,
	displayModelName,
	EXCLUDED_CANONICAL_MODELS,
} from "@/lib/model-canonical";
import {
	ForbiddenError,
	requireUser,
	UnauthenticatedError,
} from "@/lib/session";
import {
	listingVirtualRouters,
	virtualRouterProviders,
} from "@/lib/virtual-routers";

interface CountRow {
	platform: string;
	count: number;
}

interface ModelRow {
	platform: string;
	model_id: string;
	name: string;
	enabled: number;
	supports_tools: number;
	supports_vision: number;
	context_window: number;
}

export async function GET(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		const db = getDb();

		const [globalRows, personalRows, modelRows, providerRows, modelCountRows] =
			await Promise.all([
				db
					.prepare(
						"SELECT platform, COUNT(*) AS count FROM api_keys GROUP BY platform",
					)
					.all<CountRow>(),
				db
					.prepare(
						"SELECT platform, COUNT(*) AS count FROM api_keys WHERE user_id = ? AND enabled = 1 GROUP BY platform",
					)
					.bind(user.id)
					.all<CountRow>(),
				db
					.prepare(
						`SELECT platform, model_id, name, enabled, supports_tools, supports_vision, context_window
					 FROM models WHERE enabled = 1 ORDER BY platform, name`,
					)
					.all<ModelRow>(),
				db
					.prepare("SELECT id, name FROM providers ORDER BY id")
					.all<{ id: string; name: string }>(),
				db
					.prepare(
						"SELECT platform, COUNT(*) AS count FROM models WHERE enabled = 1 GROUP BY platform",
					)
					.all<CountRow>(),
			]);

		const globalByPlatform = new Map<string, number>(
			globalRows.results.map((row) => [row.platform, row.count]),
		);
		const personalByPlatform = new Map<string, number>(
			personalRows.results.map((row) => [row.platform, row.count]),
		);
		// Enabled models per provider, so providers with no models read as 0
		// instead of looking the same as usable ones.
		const modelCountByPlatform = new Map<string, number>(
			modelCountRows.results.map((row) => [row.platform, row.count]),
		);

		const providersCatalog = providerRows.results;

		// Upstream display names end with the provider in parentheses
		// ("Cydonia 24B v4.3 (AI Horde)"); the provider already has its own
		// field, so names are served without that suffix. Rows already seeded
		// with the suffix are cleaned here too, not only at seed time.
		const providerNameById = new Map(
			providersCatalog.map((provider) => [provider.id, provider.name]),
		);

		const providers = providersCatalog.map((provider) => ({
			id: provider.id,
			name: provider.name,
			modelCount: modelCountByPlatform.get(provider.id) ?? 0,
			globalKeys: globalByPlatform.get(provider.id) ?? 0,
			personalKeys: personalByPlatform.get(provider.id) ?? 0,
		}));

		const canonicalByModel = new Map<
			string,
			{ row: ModelRow; platforms: string[] }
		>();
		for (const row of modelRows.results) {
			const canonical = canonicalModelId(row.model_id);
			// Excluded canonicals (e.g. "auto") are virtual routers, not
			// ordinary models — they are listed first below, once each.
			if (EXCLUDED_CANONICAL_MODELS.has(canonical)) continue;
			const entry = canonicalByModel.get(canonical);
			if (!entry) {
				canonicalByModel.set(canonical, { row, platforms: [row.platform] });
				continue;
			}
			if (!entry.platforms.includes(row.platform))
				entry.platforms.push(row.platform);
		}

		// Virtual-router entries carry description/members; ordinary entries do not.
		interface CatalogModelEntry {
			id: string;
			canonical: string;
			name: string;
			description?: string;
			members?: string[];
			memberNames?: string[];
			platform: string;
			enabled: boolean;
			supportsTools: boolean;
			supportsVision: boolean;
			contextWindow: number;
			globalKeyCount: number;
			personalKeyCount: number;
		}
		const ordinaryModels: CatalogModelEntry[] = [
			...canonicalByModel.values(),
		].map(({ row, platforms }) => {
			const globalKeys = platforms.reduce(
				(sum, p) => sum + (globalByPlatform.get(p) ?? 0),
				0,
			);
			const personalKeys = platforms.reduce(
				(sum, p) => sum + (personalByPlatform.get(p) ?? 0),
				0,
			);
			return {
				id: `shtora/${canonicalModelId(row.model_id)}`,
				canonical: canonicalModelId(row.model_id),
				name: displayModelName(
					row.name,
					row.platform,
					providerNameById.get(row.platform),
				),
				platform: platforms.join(", "),
				enabled: row.enabled === 1,
				supportsTools:
					platforms.some((p) => {
						const r = modelRows.results.find(
							(mr) => mr.platform === p && mr.model_id === row.model_id,
						);
						return r?.supports_tools === 1;
					}) || row.supports_tools === 1,
				supportsVision:
					platforms.some((p) => {
						const r = modelRows.results.find(
							(mr) => mr.platform === p && mr.model_id === row.model_id,
						);
						return r?.supports_vision === 1;
					}) || row.supports_vision === 1,
				contextWindow: row.context_window,
				globalKeyCount: globalKeys,
				personalKeyCount: personalKeys,
			};
		});

		// Curated virtual routers, aggregated over the member rows present
		// in this listing. A router with no member here is skipped. They
		// head the listing; ordinary models follow.
		const providersByCanonical = new Map<string, readonly string[]>(
			[...canonicalByModel.entries()].map(([canonical, entry]) => [
				canonical,
				entry.platforms,
			]),
		);
		const routerModels: CatalogModelEntry[] = [];
		for (const router of listingVirtualRouters()) {
			const members = router.members.filter((member) =>
				providersByCanonical.has(member),
			);
			if (members.length === 0) continue;
			const providers = virtualRouterProviders(
				router.members,
				providersByCanonical,
			);
			const memberRows = modelRows.results.filter((row) =>
				members.includes(canonicalModelId(row.model_id)),
			);
			const globalKeys = providers.reduce(
				(sum, p) => sum + (globalByPlatform.get(p) ?? 0),
				0,
			);
			const personalKeys = providers.reduce(
				(sum, p) => sum + (personalByPlatform.get(p) ?? 0),
				0,
			);
			// Display labels for the tooltip on /dashboard/models: display
			// name only, same as the playground combobox label — no
			// provider, no version date.
			const memberNames = members.map((member) => {
				const row = canonicalByModel.get(member)?.row;
				if (!row) return member;
				return comboboxModelLabel(
					displayModelName(
						row.name,
						row.platform,
						providerNameById.get(row.platform),
					),
				);
			});
			routerModels.push({
				id: router.id,
				canonical: router.id.slice("shtora/".length),
				name: router.name,
				description: router.description,
				members,
				memberNames,
				platform: providers.join(", "),
				enabled: true,
				supportsTools: memberRows.some((row) => row.supports_tools === 1),
				supportsVision: memberRows.some((row) => row.supports_vision === 1),
				contextWindow: Math.max(
					0,
					...memberRows.map((row) => row.context_window),
				),
				globalKeyCount: globalKeys,
				personalKeyCount: personalKeys,
			});
		}

		// Virtual routers head the listing; ordinary models follow.
		const models: CatalogModelEntry[] = [...routerModels, ...ordinaryModels];

		return Response.json(
			{ providers, models },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		if (error instanceof UnauthenticatedError) {
			return Response.json(
				{ error: { message: "Not authenticated", type: "auth_error" } },
				{ status: 401 },
			);
		}
		if (error instanceof ForbiddenError) {
			return Response.json(
				{ error: { message: "Forbidden", type: "auth_error" } },
				{ status: 403 },
			);
		}
		console.error(
			JSON.stringify({ event: "api_error", path: "/api/dashboard/catalog" }),
		);
		return Response.json(
			{ error: { message: "Internal error", type: "server_error" } },
			{ status: 500 },
		);
	}
}
