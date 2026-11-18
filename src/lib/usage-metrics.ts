import type { D1Database, D1PreparedStatement } from "./types";

export interface UsageMetrics {
	requests: number;
	successfulRequests: number;
	successRate: number | null;
	inputTokens: number;
	outputTokens: number;
	estimatedSavingsUsd: number;
	averageLatencyMs: number | null;
	p95LatencyMs: number | null;
	averageTtftMs: number | null;
}

interface SummaryRow {
	requests: number;
	successful_requests: number;
	input_tokens: number;
	output_tokens: number;
	estimated_savings_usd: number;
	latency_sum_ms: number;
	latency_count: number;
	ttft_sum_ms: number;
	ttft_count: number;
}

interface PercentileRow {
	p95_latency_ms: number | null;
}

function toUsageMetrics(
	summary: SummaryRow | null,
	p95LatencyMs: number | null,
): UsageMetrics {
	const requests = summary?.requests ?? 0;
	const latencyCount = summary?.latency_count ?? 0;
	const ttftCount = summary?.ttft_count ?? 0;
	return {
		requests,
		successfulRequests: summary?.successful_requests ?? 0,
		successRate:
			requests === 0 ? null : (summary?.successful_requests ?? 0) / requests,
		inputTokens: summary?.input_tokens ?? 0,
		outputTokens: summary?.output_tokens ?? 0,
		estimatedSavingsUsd:
			Math.round((summary?.estimated_savings_usd ?? 0) * 100) / 100,
		averageLatencyMs:
			latencyCount === 0 ? null : (summary?.latency_sum_ms ?? 0) / latencyCount,
		p95LatencyMs,
		averageTtftMs:
			ttftCount === 0 ? null : (summary?.ttft_sum_ms ?? 0) / ttftCount,
	};
}

const USER_P95_SQL = `
WITH histogram AS (
  SELECT bucket_id, samples,
    SUM(samples) OVER (ORDER BY bucket_id) AS cumulative_samples,
    SUM(samples) OVER () AS total_samples
  FROM user_usage_latency_histogram
  WHERE user_id = ?
), percentile_bucket AS (
  SELECT bucket_id, total_samples
  FROM histogram
  WHERE cumulative_samples >= ((95 * total_samples + 99) / 100)
  ORDER BY bucket_id
  LIMIT 1
), p95_rank AS (
  SELECT ((95 * total_samples + 99) / 100) - 1 AS zero_based_rank
  FROM percentile_bucket
)
SELECT CASE
  WHEN bucket_id < 1000 THEN bucket_id
  WHEN bucket_id < 2191 THEN 1000 + (bucket_id - 1000) * 100 + 99
  ELSE (
    SELECT latency_ms
    FROM provider_requests
    WHERE user_id = ? AND latency_ms >= 0
    ORDER BY latency_ms
    LIMIT 1 OFFSET (SELECT zero_based_rank FROM p95_rank)
  )
END AS p95_latency_ms
FROM percentile_bucket`;

const GLOBAL_P95_SQL = `
WITH histogram AS (
  SELECT bucket_id, samples,
    SUM(samples) OVER (ORDER BY bucket_id) AS cumulative_samples,
    SUM(samples) OVER () AS total_samples
  FROM global_usage_latency_histogram
), percentile_bucket AS (
  SELECT bucket_id, total_samples
  FROM histogram
  WHERE cumulative_samples >= ((95 * total_samples + 99) / 100)
  ORDER BY bucket_id
  LIMIT 1
), p95_rank AS (
  SELECT ((95 * total_samples + 99) / 100) - 1 AS zero_based_rank
  FROM percentile_bucket
)
SELECT CASE
  WHEN bucket_id < 1000 THEN bucket_id
  WHEN bucket_id < 2191 THEN 1000 + (bucket_id - 1000) * 100 + 99
  ELSE (
    SELECT latency_ms
    FROM provider_requests
    WHERE latency_ms >= 0
    ORDER BY latency_ms
    LIMIT 1 OFFSET (SELECT zero_based_rank FROM p95_rank)
  )
END AS p95_latency_ms
FROM percentile_bucket`;

async function readUsageMetrics(
	db: D1Database,
	summaryStatement: D1PreparedStatement,
	p95Statement: D1PreparedStatement,
): Promise<UsageMetrics> {
	const [summaryResult, p95Result] = await db.batch<SummaryRow | PercentileRow>(
		[summaryStatement, p95Statement],
	);
	const summary = summaryResult.results[0] as SummaryRow | undefined;
	const p95 = p95Result.results[0] as PercentileRow | undefined;
	return toUsageMetrics(summary ?? null, p95?.p95_latency_ms ?? null);
}

export async function getUserUsageMetrics(
	db: D1Database,
	userId: string,
): Promise<UsageMetrics> {
	return readUsageMetrics(
		db,
		db
			.prepare(
				`SELECT requests, successful_requests, input_tokens, output_tokens,
				 estimated_savings_usd, latency_sum_ms, latency_count, ttft_sum_ms, ttft_count
				 FROM user_usage_metrics WHERE user_id = ?`,
			)
			.bind(userId),
		db.prepare(USER_P95_SQL).bind(userId, userId),
	);
}

export async function getGlobalUsageMetrics(
	db: D1Database,
): Promise<UsageMetrics> {
	return readUsageMetrics(
		db,
		db.prepare(
			`SELECT requests, successful_requests, input_tokens, output_tokens,
				 estimated_savings_usd, latency_sum_ms, latency_count, ttft_sum_ms, ttft_count
				 FROM global_usage_metrics WHERE singleton = 1`,
		),
		db.prepare(GLOBAL_P95_SQL),
	);
}
