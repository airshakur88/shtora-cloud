import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import { requireUser } from "@/lib/session";

interface RequestsByDay {
	date: string;
	total: number;
	success: number;
	error: number;
}

interface TokensByDay {
	date: string;
	input: number;
	output: number;
}

export async function GET(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		const db = getDb();

		// Generate last 14 days
		const dayDates = Array.from({ length: 14 }, (_, i) => {
			const d = new Date();
			d.setDate(d.getDate() - (13 - i));
			return d.toISOString().split("T")[0];
		});

		// Fetch aggregated data
		const [
			requestsByDayResult,
			tokensByDayResult,
			byProviderResult,
			errorsByProviderResult,
			recentErrorsResult,
			byModelResult,
		] = await Promise.all([
			db
				.prepare(`
				SELECT DATE(created_at) as day,
					   COUNT(*) as total,
					   SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
					   SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as error
				FROM provider_requests
				WHERE user_id = ? AND created_at >= datetime('now', '-14 days')
				GROUP BY DATE(created_at)
				ORDER BY day
			`)
				.bind(user.id)
				.all<{ day: string; total: number; success: number; error: number }>(),

			db
				.prepare(`
				SELECT DATE(created_at) as day,
					   COALESCE(SUM(input_tokens), 0) as input,
					   COALESCE(SUM(output_tokens), 0) as output
				FROM provider_requests
				WHERE user_id = ? AND created_at >= datetime('now', '-14 days')
				GROUP BY DATE(created_at)
				ORDER BY day
			`)
				.bind(user.id)
				.all<{ day: string; input: number; output: number }>(),

			db
				.prepare(`
				SELECT platform,
					   COUNT(*) as requests,
					   SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as errors,
					   AVG(latency_ms) as avgLatencyMs,
					   COALESCE(SUM(input_tokens), 0) as inputTokens,
					   COALESCE(SUM(output_tokens), 0) as outputTokens
				FROM provider_requests
				WHERE user_id = ?
				GROUP BY platform
				ORDER BY requests DESC
			`)
				.bind(user.id)
				.all<{
					platform: string;
					requests: number;
					errors: number;
					avgLatencyMs: number | null;
					inputTokens: number;
					outputTokens: number;
				}>(),

			db
				.prepare(`
				SELECT platform, COUNT(*) as errors
				FROM provider_requests
				WHERE user_id = ? AND status != 'success'
				GROUP BY platform
				ORDER BY errors DESC
			`)
				.bind(user.id)
				.all<{ platform: string; errors: number }>(),

			db
				.prepare(`
				SELECT id, platform, model_routed, error_message, created_at
				FROM provider_requests
				WHERE user_id = ? AND status != 'success'
				ORDER BY created_at DESC
				LIMIT 50
			`)
				.bind(user.id)
				.all<{
					id: number;
					platform: string;
					model_routed: string;
					error_message: string;
					created_at: string;
				}>(),

			db
				.prepare(`
				SELECT model_routed as model_id, platform,
					   COUNT(*) as requests,
					   SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
					   AVG(latency_ms) as latency_ms,
					   COALESCE(SUM(input_tokens), 0) as input_tokens,
					   COALESCE(SUM(output_tokens), 0) as output_tokens
				FROM provider_requests
				WHERE user_id = ?
				GROUP BY model_id, platform
				ORDER BY requests DESC
			`)
				.bind(user.id)
				.all<{
					model_id: string;
					platform: string;
					requests: number;
					successes: number;
					latency_ms: number | null;
					input_tokens: number;
					output_tokens: number;
				}>(),
		]);

		// Build responses
		const requestsByDay: RequestsByDay[] = dayDates.map((d) => {
			const row = requestsByDayResult.results.find((r) => r.day === d);
			return {
				date: d,
				total: row?.total ?? 0,
				success: row?.success ?? 0,
				error: row?.error ?? 0,
			};
		});

		const tokensByDay: TokensByDay[] = dayDates.map((d) => {
			const row = tokensByDayResult.results.find((r) => r.day === d);
			return {
				date: d,
				input: row?.input ?? 0,
				output: row?.output ?? 0,
			};
		});

		const byProvider = byProviderResult.results.map((r) => ({
			platform: r.platform,
			requests: r.requests,
			errors: r.errors,
			avgLatencyMs: r.avgLatencyMs,
			p95LatencyMs: null, // Can add P95 calculation if needed
			avgTtftMs: null,
			tokensPerSec:
				r.avgLatencyMs && r.avgLatencyMs > 0
					? ((r.inputTokens + r.outputTokens) / r.avgLatencyMs) * 1000
					: null,
			inputTokens: r.inputTokens,
			outputTokens: r.outputTokens,
		}));

		const errorsByProvider = errorsByProviderResult.results;
		const recentErrors = recentErrorsResult.results;
		const byModel = byModelResult.results;

		return Response.json(
			{
				requestsByDay,
				tokensByDay,
				byProvider,
				errorsByProvider,
				recentErrors,
				byModel,
				byKey: [], // Placeholder for future implementation
			},
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return routeError(error, "/api/dashboard/metrics");
	}
}
