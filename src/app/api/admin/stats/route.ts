import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import { requireAdmin } from "@/lib/session";
import { getGlobalUsageMetrics } from "@/lib/usage-metrics";

interface CountRow {
	count: number;
}
interface Rate24hRow {
	total: number;
	successes: number;
}
interface LatencyRow {
	model_routed: string;
	latency_ms: number;
}
interface PlatformRow {
	platform: string;
	requests: number;
	errors: number;
}
interface TopModelRow {
	model_routed: string;
	requests: number;
	successes: number;
}

function percentile(sorted: number[], pct: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1),
	);
	return sorted[rank];
}

export async function GET(request: Request): Promise<Response> {
	try {
		await requireAdmin(request);
		const db = getDb();
		const now = Date.now();
		const [
			totalRequests,
			rate24h,
			latencies,
			keysTotal,
			keysQuarantined,
			usersTotal,
			platforms,
			topModels,
			lifetimeMetrics,
		] = await Promise.all([
			db
				.prepare("SELECT COUNT(*) AS count FROM provider_requests")
				.first<CountRow>(),
			db
				.prepare(
					`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successes
				 FROM provider_requests WHERE created_at >= datetime('now', '-1 day')`,
				)
				.first<Rate24hRow>(),
			db
				.prepare(
					`SELECT model_routed, latency_ms FROM provider_requests
				 WHERE created_at >= datetime('now', '-7 days') AND latency_ms IS NOT NULL`,
				)
				.all<LatencyRow>(),
			db.prepare("SELECT COUNT(*) AS count FROM api_keys").first<CountRow>(),
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM provider_rate_limit_cooldowns WHERE cooldown_until_ms > ?",
				)
				.bind(now)
				.first<CountRow>(),
			db.prepare("SELECT COUNT(*) AS count FROM user").first<CountRow>(),
			db
				.prepare(
					`SELECT platform, COUNT(*) AS requests,
				 COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS errors
				 FROM provider_requests WHERE created_at >= datetime('now', '-7 days')
				 GROUP BY platform ORDER BY requests DESC`,
				)
				.all<PlatformRow>(),
			db
				.prepare(
					`SELECT model_routed, COUNT(*) AS requests,
				 COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successes
				 FROM provider_requests WHERE created_at >= datetime('now', '-7 days')
				 GROUP BY model_routed ORDER BY requests DESC LIMIT 10`,
				)
				.all<TopModelRow>(),
			getGlobalUsageMetrics(db),
		]);
		const sortedLatencies = latencies.results
			.map((row) => row.latency_ms)
			.sort((a, b) => a - b);
		const latencyByModel = new Map<string, number[]>();
		for (const row of latencies.results) {
			const values = latencyByModel.get(row.model_routed) ?? [];
			values.push(row.latency_ms);
			latencyByModel.set(row.model_routed, values);
		}
		for (const values of latencyByModel.values()) values.sort((a, b) => a - b);
		const total24h = rate24h?.total ?? 0;
		return Response.json(
			{
				totalRequests: totalRequests?.count ?? 0,
				successRate24h: total24h ? (rate24h?.successes ?? 0) / total24h : null,
				p50LatencyMs: sortedLatencies.length
					? percentile(sortedLatencies, 50)
					: null,
				p95LatencyMs: sortedLatencies.length
					? percentile(sortedLatencies, 95)
					: null,
				keysTotal: keysTotal?.count ?? 0,
				keysQuarantined: keysQuarantined?.count ?? 0,
				usersTotal: usersTotal?.count ?? 0,
				lifetimeMetrics,
				byPlatform: platforms.results.map((row) => ({
					platform: row.platform,
					requests: row.requests,
					errors: row.errors,
				})),
				topModels: topModels.results.map((row) => {
					const modelLatencies = latencyByModel.get(row.model_routed) ?? [];
					return {
						model: row.model_routed,
						requests: row.requests,
						successRate: row.requests ? row.successes / row.requests : null,
						p50Ms: modelLatencies.length
							? percentile(modelLatencies, 50)
							: null,
					};
				}),
			},
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return routeError(error, "/api/admin/stats");
	}
}
