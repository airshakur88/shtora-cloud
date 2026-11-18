import type { UsageMetrics } from "./usage-metrics";
export interface AdminStats {
	totalRequests: number;
	successRate24h: number | null;
	p50LatencyMs: number | null;
	p95LatencyMs: number | null;
	keysTotal: number;
	keysQuarantined: number;
	usersTotal: number;
	lifetimeMetrics: UsageMetrics;
	byPlatform: { platform: string; requests: number; errors: number }[];
	topModels: {
		model: string;
		requests: number;
		successRate: number | null;
		p50Ms: number | null;
	}[];
}

function isNullableNumber(value: unknown): value is number | null {
	return value === null || typeof value === "number";
}

function isUsageMetrics(value: unknown): value is UsageMetrics {
	if (!value || typeof value !== "object") return false;
	return (
		"requests" in value &&
		typeof value.requests === "number" &&
		"successfulRequests" in value &&
		typeof value.successfulRequests === "number" &&
		"successRate" in value &&
		isNullableNumber(value.successRate) &&
		"inputTokens" in value &&
		typeof value.inputTokens === "number" &&
		"outputTokens" in value &&
		typeof value.outputTokens === "number" &&
		"estimatedSavingsUsd" in value &&
		typeof value.estimatedSavingsUsd === "number" &&
		"averageLatencyMs" in value &&
		isNullableNumber(value.averageLatencyMs) &&
		"p95LatencyMs" in value &&
		isNullableNumber(value.p95LatencyMs) &&
		"averageTtftMs" in value &&
		isNullableNumber(value.averageTtftMs)
	);
}

function isPlatformStats(
	value: unknown,
): value is AdminStats["byPlatform"][number] {
	if (!value || typeof value !== "object") return false;
	return (
		"platform" in value &&
		typeof value.platform === "string" &&
		"requests" in value &&
		typeof value.requests === "number" &&
		"errors" in value &&
		typeof value.errors === "number"
	);
}

function isModelStats(
	value: unknown,
): value is AdminStats["topModels"][number] {
	if (!value || typeof value !== "object") return false;
	return (
		"model" in value &&
		typeof value.model === "string" &&
		"requests" in value &&
		typeof value.requests === "number" &&
		"successRate" in value &&
		(value.successRate === null || typeof value.successRate === "number") &&
		"p50Ms" in value &&
		(value.p50Ms === null || typeof value.p50Ms === "number")
	);
}

export function isAdminStats(value: unknown): value is AdminStats {
	if (!value || typeof value !== "object") return false;
	return (
		"totalRequests" in value &&
		typeof value.totalRequests === "number" &&
		"successRate24h" in value &&
		(value.successRate24h === null ||
			typeof value.successRate24h === "number") &&
		"p50LatencyMs" in value &&
		(value.p50LatencyMs === null || typeof value.p50LatencyMs === "number") &&
		"p95LatencyMs" in value &&
		(value.p95LatencyMs === null || typeof value.p95LatencyMs === "number") &&
		"keysTotal" in value &&
		typeof value.keysTotal === "number" &&
		"keysQuarantined" in value &&
		typeof value.keysQuarantined === "number" &&
		"usersTotal" in value &&
		typeof value.usersTotal === "number" &&
		"byPlatform" in value &&
		Array.isArray(value.byPlatform) &&
		value.byPlatform.every(isPlatformStats) &&
		"lifetimeMetrics" in value &&
		isUsageMetrics(value.lifetimeMetrics) &&
		"topModels" in value &&
		Array.isArray(value.topModels) &&
		value.topModels.every(isModelStats)
	);
}

export function formatPercent(value: number): string {
	return `${(value > 1 ? value : value * 100).toFixed(1)}%`;
}
