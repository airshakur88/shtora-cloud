import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import { requireUser } from "@/lib/session";
import { getUserUsageMetrics } from "@/lib/usage-metrics";

interface RequestRow {
	id: number;
	model_requested: string;
	model_routed: string;
	platform: string;
	status: string;
	input_tokens: number | null;
	output_tokens: number | null;
	latency_ms: number | null;
	created_at: string;
}

export async function GET(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		const rawLimit = Number(
			new URL(request.url).searchParams.get("limit") ?? "100",
		);
		const limit =
			Number.isInteger(rawLimit) && rawLimit > 0
				? Math.min(rawLimit, 500)
				: 100;
		const db = getDb();
		const [rows, totals] = await Promise.all([
			db
				.prepare(
					`SELECT id, model_requested, model_routed, platform, status, input_tokens,
				 output_tokens, latency_ms, created_at
				 FROM provider_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
				)
				.bind(user.id, limit)
				.all<RequestRow>(),
			getUserUsageMetrics(db, user.id),
		]);
		return Response.json(
			{
				requests: rows.results.map((row) => ({
					id: row.id,
					modelRequested: row.model_requested,
					modelRouted: row.model_routed,
					platform: row.platform,
					status: row.status,
					inputTokens: row.input_tokens,
					outputTokens: row.output_tokens,
					latencyMs: row.latency_ms,
					createdAt: row.created_at,
				})),
				totals,
			},
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return routeError(error, "/api/usage");
	}
}
