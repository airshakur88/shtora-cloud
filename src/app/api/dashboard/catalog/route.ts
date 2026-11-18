import { getDb } from "@/lib/env";
import { canonicalModelId } from "@/lib/model-canonical";
import catalog from "@/lib/models-catalog.json";
import {
	ForbiddenError,
	requireUser,
	UnauthenticatedError,
} from "@/lib/session";

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

		const [globalRows, personalRows, modelRows] = await Promise.all([
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
		]);

		const globalByPlatform = new Map<string, number>(
			globalRows.results.map((row) => [row.platform, row.count]),
		);
		const personalByPlatform = new Map<string, number>(
			personalRows.results.map((row) => [row.platform, row.count]),
		);

		const providersCatalog = catalog.providers as Array<{
			id: string;
			name: string;
		}>;

		const providers = providersCatalog.map((provider) => ({
			id: provider.id,
			name: provider.name,
			globalKeys: globalByPlatform.get(provider.id) ?? 0,
			personalKeys: personalByPlatform.get(provider.id) ?? 0,
		}));

		const canonicalByModel = new Map<
			string,
			{ row: ModelRow; platforms: string[] }
		>();
		for (const row of modelRows.results) {
			const canonical = canonicalModelId(row.model_id);
			const entry = canonicalByModel.get(canonical);
			if (!entry) {
				canonicalByModel.set(canonical, { row, platforms: [row.platform] });
				continue;
			}
			if (!entry.platforms.includes(row.platform))
				entry.platforms.push(row.platform);
		}

		const models = [...canonicalByModel.values()].map(({ row, platforms }) => {
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
				name: row.name,
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
