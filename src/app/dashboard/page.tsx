"use client";

import { Activity, Clock, ShieldCheck, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Line,
	LineChart,
	Pie,
	PieChart,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	ChartContainer,
	ChartLegendContent,
	ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";

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

interface ByProvider {
	platform: string;
	providerName: string;
	requests: number;
	errors: number;
	avgLatencyMs: number | null;
	latencySumMs: number;
	latencyCount: number;
	ttftSumMs: number;
	ttftCount: number;
	p95LatencyMs: number | null;
	avgTtftMs: number | null;
	fallbackAttempts: number;
	tokensPerSec: number | null;
	inputTokens: number;
	outputTokens: number;
}

interface ErrorsByProvider {
	platform: string;
	providerName: string;
	errors: number;
}

interface RecentError {
	id: number;
	platform: string;
	providerName: string;
	model_routed: string;
	error_message: string;
	created_at: string;
}

interface ByModel {
	model_id: string;
	platform: string;
	providerName: string;
	requests: number;
	successes: number;
	latency_ms: number | null;
	input_tokens: number;
	output_tokens: number;
}

interface ByKey {
	keyId: number;
	key_mask: string;
	platform: string;
	providerName: string;
	requests: number;
	successes: number;
	latency_ms: number | null;
	input_tokens: number;
	output_tokens: number;
}

interface DashboardMetrics {
	requestsByDay: RequestsByDay[];
	tokensByDay: TokensByDay[];
	byProvider: ByProvider[];
	errorsByProvider: ErrorsByProvider[];
	recentErrors: RecentError[];
	byModel: ByModel[];
	byKey: ByKey[];
	overall?: {
		p95LatencyMs: number | null;
		averageTtftMs: number | null;
	};
}

function isDashboardMetrics(value: unknown): value is DashboardMetrics {
	if (!value || typeof value !== "object") return false;
	const obj = value as Record<string, unknown>;
	return (
		Array.isArray(obj.requestsByDay) &&
		Array.isArray(obj.tokensByDay) &&
		Array.isArray(obj.byProvider) &&
		Array.isArray(obj.errorsByProvider) &&
		Array.isArray(obj.recentErrors) &&
		Array.isArray(obj.byModel) &&
		Array.isArray(obj.byKey)
	);
}

interface UsageTotals {
	requests: number;
	successfulRequests: number;
	successRate: number | null;
	inputTokens: number;
	outputTokens: number;
	averageLatencyMs: number | null;
	p95LatencyMs: number | null;
	averageTtftMs: number | null;
}

function calculateTotals(metrics: DashboardMetrics | null): UsageTotals {
	if (!metrics || metrics.requestsByDay.length === 0) {
		return {
			requests: 0,
			successfulRequests: 0,
			successRate: null,
			inputTokens: 0,
			outputTokens: 0,
			averageLatencyMs: null,
			p95LatencyMs: null,
			averageTtftMs: null,
		};
	}

	const totals = metrics.requestsByDay.reduce(
		(acc, day) => ({
			requests: acc.requests + day.total,
			successfulRequests: acc.successfulRequests + day.success,
			inputTokens: acc.inputTokens,
			outputTokens: acc.outputTokens,
		}),
		{
			requests: 0,
			successfulRequests: 0,
			inputTokens: 0,
			outputTokens: 0,
		},
	);

	const totalInputTokens = metrics.tokensByDay.reduce(
		(sum, day) => sum + day.input,
		0,
	);
	const totalOutputTokens = metrics.tokensByDay.reduce(
		(sum, day) => sum + day.output,
		0,
	);
	// Averages weighted by the requests behind them: a provider with one
	// request must not weigh the same as one with ten thousand. The sums
	// come from the metrics route, so the weight is exact, not estimated
	// from the per-provider averages.
	const latencySumMs = metrics.byProvider.reduce(
		(sum, p) => sum + p.latencySumMs,
		0,
	);
	const latencyCount = metrics.byProvider.reduce(
		(sum, p) => sum + p.latencyCount,
		0,
	);
	const avgLatency = latencyCount > 0 ? latencySumMs / latencyCount : null;
	const ttftSumMs = metrics.byProvider.reduce((sum, p) => sum + p.ttftSumMs, 0);
	const ttftCount = metrics.byProvider.reduce((sum, p) => sum + p.ttftCount, 0);
	const avgTtft = ttftCount > 0 ? ttftSumMs / ttftCount : null;

	return {
		requests: totals.requests,
		successfulRequests: totals.successfulRequests,
		successRate:
			totals.requests > 0 ? totals.successfulRequests / totals.requests : null,
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		averageLatencyMs: avgLatency,
		p95LatencyMs: metrics.overall?.p95LatencyMs ?? null,
		averageTtftMs: avgTtft,
	};
}

/** "18 Nov" / "18 Nov 14:32:05", day first like the date-fns formats
 * these replaced ("d MMM", "d MMM HH:mm:ss"). Intl orders month first
 * in en-US, so the parts are reassembled by hand; hourCycle h23 keeps
 * midnight as 00, not 24. */
function dateParts(date: Date): Record<string, string> {
	const parts = new Intl.DateTimeFormat("en-US", {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatDateLabel(dateStr: string): string {
	const date = new Date(`${dateStr}T00:00:00`);
	const parts = dateParts(date);
	return `${parts.day} ${parts.month}`;
}

function formatDateTimeLabel(dateStr: string): string {
	const date = new Date(dateStr);
	const parts = dateParts(date);
	return `${parts.day} ${parts.month} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export default function DashboardOverviewPage() {
	const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		async function loadMetrics() {
			try {
				const response = await fetch("/api/dashboard/metrics", {
					cache: "no-store",
				});
				if (!response.ok) {
					throw new Error("Failed to load metrics");
				}
				const data = await response.json();
				if (!isDashboardMetrics(data)) {
					throw new Error("Invalid metrics response");
				}
				setMetrics(data);
			} catch (error) {
				toast.add({
					title: "Error",
					description:
						error instanceof Error ? error.message : "Failed to load metrics",
				});
			} finally {
				setIsLoading(false);
			}
		}
		loadMetrics();
	}, []);

	const totals = calculateTotals(metrics);
	const hasData =
		metrics && Object.values(metrics).some((arr) => arr.length > 0);

	const requestsChartConfig = {
		total: { label: "Total", color: "#3b82f6" },
		success: { label: "Success", color: "#22c55e" },
		error: { label: "Error", color: "#ef4444" },
	};

	const tokensChartConfig = {
		input: { label: "Input tokens", color: "#3b82f6" },
		output: { label: "Output tokens", color: "#8b5cf6" },
	};

	return (
		<div className="space-y-8 p-6">
			<header className="space-y-2">
				<h1 className="text-3xl font-bold tracking-tight">
					Dashboard overview
				</h1>
				<p className="text-muted-foreground">
					Your request activity and provider analytics.
				</p>
			</header>

			{isLoading ? (
				<div className="grid gap-4 md:grid-cols-4">
					<Card>
						<CardContent className="py-6">
							<Skeleton className="h-8 w-32" />
							<Skeleton className="mt-4 h-12 w-24" />
						</CardContent>
					</Card>
					<Card>
						<CardContent className="py-6">
							<Skeleton className="h-8 w-32" />
							<Skeleton className="mt-4 h-12 w-24" />
						</CardContent>
					</Card>
					<Card>
						<CardContent className="py-6">
							<Skeleton className="h-8 w-32" />
							<Skeleton className="mt-4 h-12 w-24" />
						</CardContent>
					</Card>
					<Card>
						<CardContent className="py-6">
							<Skeleton className="h-8 w-32" />
							<Skeleton className="mt-4 h-12 w-24" />
						</CardContent>
					</Card>
				</div>
			) : hasData ? (
				<>
					<div className="grid gap-4 md:grid-cols-4">
						<Card>
							<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
								<CardTitle className="text-sm font-medium">
									Total requests
								</CardTitle>
								<Activity className="h-4 w-4 text-muted-foreground" />
							</CardHeader>
							<CardContent>
								<div className="text-2xl font-bold">
									{totals.requests.toLocaleString()}
								</div>
								<p className="text-xs text-muted-foreground">
									{totals.successRate !== null
										? `${(totals.successRate * 100).toFixed(1)}% success rate`
										: "No requests"}
								</p>
							</CardContent>
						</Card>
						<Card>
							<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
								<CardTitle className="text-sm font-medium">
									Avg latency
								</CardTitle>
								<Timer className="h-4 w-4 text-muted-foreground" />
							</CardHeader>
							<CardContent>
								<div className="text-2xl font-bold">
									{totals.averageLatencyMs !== null
										? `${Math.round(totals.averageLatencyMs)} ms`
										: "—"}
								</div>
								<p className="text-xs text-muted-foreground">
									Average response time
								</p>
							</CardContent>
						</Card>
						<Card>
							<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
								<CardTitle className="text-sm font-medium">Tokens</CardTitle>
								<ShieldCheck className="h-4 w-4 text-muted-foreground" />
							</CardHeader>
							<CardContent>
								<div className="text-2xl font-bold">
									{(totals.inputTokens + totals.outputTokens).toLocaleString()}
								</div>
								<p className="text-xs text-muted-foreground">
									In: {totals.inputTokens.toLocaleString()} / Out:{" "}
									{totals.outputTokens.toLocaleString()}
								</p>
							</CardContent>
						</Card>
						<Card>
							<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
								<CardTitle className="text-sm font-medium">Avg TTFT</CardTitle>
								<Clock className="h-4 w-4 text-muted-foreground" />
							</CardHeader>
							<CardContent>
								<div className="text-2xl font-bold">
									{totals.averageTtftMs !== null
										? `${Math.round(totals.averageTtftMs)} ms`
										: "—"}
								</div>
								<p className="text-xs text-muted-foreground">
									Time to first token
								</p>
							</CardContent>
						</Card>
					</div>

					<div className="grid gap-6 lg:grid-cols-2">
						{/* Requests over time */}
						<Card>
							<CardHeader>
								<CardTitle>Requests over time</CardTitle>
								<CardDescription>
									Last 14 days: total, success, and error
								</CardDescription>
							</CardHeader>
							<CardContent>
								<ChartContainer
									config={requestsChartConfig}
									className="h-80 w-full"
								>
									<LineChart data={metrics.requestsByDay}>
										<XAxis
											dataKey="date"
											tickFormatter={formatDateLabel}
											tick={{ fontSize: 11 }}
										/>
										<YAxis tick={{ fontSize: 11 }} />
										<CartesianGrid strokeDasharray="3 3" />
										<Tooltip
											content={
												<ChartTooltipContent
													formatter={(value) => [
														(Number(value) || 0).toLocaleString(),

														"requests",
													]}
												/>
											}
										/>
										<ChartLegendContent />
										<Line
											type="monotone"
											dataKey="total"
											stroke="#3b82f6"
											dot={false}
											strokeWidth={2}
										/>
										<Line
											type="monotone"
											dataKey="success"
											stroke="#22c55e"
											dot={false}
											strokeWidth={2}
										/>
										<Line
											type="monotone"
											dataKey="error"
											stroke="#ef4444"
											dot={false}
											strokeWidth={2}
										/>
									</LineChart>
								</ChartContainer>
							</CardContent>
						</Card>

						{/* Tokens over time */}
						<Card>
							<CardHeader>
								<CardTitle>Tokens over time</CardTitle>
								<CardDescription>
									Last 14 days: input vs output tokens
								</CardDescription>
							</CardHeader>
							<CardContent>
								<ChartContainer
									config={tokensChartConfig}
									className="h-80 w-full"
								>
									<BarChart data={metrics.tokensByDay}>
										<XAxis
											dataKey="date"
											tickFormatter={formatDateLabel}
											tick={{ fontSize: 11 }}
										/>
										<YAxis tick={{ fontSize: 11 }} />
										<CartesianGrid strokeDasharray="3 3" />
										<Tooltip
											content={
												<ChartTooltipContent
													formatter={(value) => [
														(Number(value) || 0).toLocaleString(),

														"tokens",
													]}
												/>
											}
										/>
										<ChartLegendContent />
										<Bar dataKey="input" fill="#3b82f6" radius={[4, 4, 0, 0]} />
										<Bar
											dataKey="output"
											fill="#8b5cf6"
											radius={[4, 4, 0, 0]}
										/>
									</BarChart>
								</ChartContainer>
							</CardContent>
						</Card>
					</div>

					<div className="grid gap-6 lg:grid-cols-3">
						{/* Requests by provider */}
						<Card>
							<CardHeader>
								<CardTitle>Requests by provider</CardTitle>
								<CardDescription>Total requests per provider</CardDescription>
							</CardHeader>
							<CardContent>
								<ChartContainer
									config={requestsChartConfig}
									className="h-80 w-full"
								>
									<BarChart data={metrics.byProvider} layout="vertical">
										<YAxis
											type="category"
											dataKey="providerName"
											width={100}
											tick={{ fontSize: 11 }}
										/>
										<XAxis tick={{ fontSize: 11 }} />
										<CartesianGrid strokeDasharray="3 3" />
										<Tooltip
											content={
												<ChartTooltipContent
													formatter={(value) => [
														(Number(value) || 0).toLocaleString(),

														"requests",
													]}
												/>
											}
										/>
										<ChartLegendContent />
										<Bar
											dataKey="requests"
											fill="#3b82f6"
											radius={[0, 4, 4, 0]}
										/>
									</BarChart>
								</ChartContainer>
							</CardContent>
						</Card>

						{/* Avg latency by provider */}
						<Card>
							<CardHeader>
								<CardTitle>Avg latency by provider</CardTitle>
								<CardDescription>Average response time (ms)</CardDescription>
							</CardHeader>
							<CardContent>
								<ChartContainer
									config={requestsChartConfig}
									className="h-80 w-full"
								>
									<BarChart
										data={metrics.byProvider.filter(
											(p) => p.avgLatencyMs !== null,
										)}
										layout="vertical"
									>
										<YAxis
											type="category"
											dataKey="providerName"
											width={100}
											tick={{ fontSize: 11 }}
										/>
										<XAxis tick={{ fontSize: 11 }} />
										<CartesianGrid strokeDasharray="3 3" />
										<Tooltip
											content={
												<ChartTooltipContent
													formatter={(value) => [
														(Number(value) || 0).toLocaleString(),

														"ms",
													]}
												/>
											}
										/>
										<ChartLegendContent />
										<Bar
											dataKey="avgLatencyMs"
											fill="#f59e0b"
											radius={[0, 4, 4, 0]}
										/>
									</BarChart>
								</ChartContainer>
							</CardContent>
						</Card>

						{/* Error distribution */}
						<Card>
							<CardHeader>
								<CardTitle>Error distribution</CardTitle>
								<CardDescription>By status type</CardDescription>
							</CardHeader>
							<CardContent>
								<ChartContainer
									config={requestsChartConfig}
									className="h-80 w-full"
								>
									<PieChart>
										<Pie
											data={[
												{
													name: "Success",
													value: metrics.requestsByDay.reduce(
														(a, d) => a + d.success,
														0,
													),
													fill: "#22c55e",
												},
												{
													name: "Error",
													value: metrics.requestsByDay.reduce(
														(a, d) => a + d.error,
														0,
													),
													fill: "#ef4444",
												},
											].filter((s) => s.value > 0)}
											cx="50%"
											cy="50%"
											innerRadius={60}
											outerRadius={80}
											dataKey="value"
											nameKey="name"
											label={({ name, percent }) =>
												`${name} ${((percent ?? 0) * 100).toFixed(1)}%`
											}
											labelLine={false}
										/>
										<Tooltip
											content={
												<ChartTooltipContent
													formatter={(value) => [
														(Number(value) || 0).toLocaleString(),

														"requests",
													]}
												/>
											}
										/>
									</PieChart>
									<ChartLegendContent />
								</ChartContainer>
							</CardContent>
						</Card>
					</div>

					<div className="grid gap-6 lg:grid-cols-3">
						{/* Errors by provider */}
						<Card>
							<CardHeader>
								<CardTitle>Errors by provider</CardTitle>
								<CardDescription>Failed requests per provider</CardDescription>
							</CardHeader>
							<CardContent>
								<ChartContainer
									config={requestsChartConfig}
									className="h-80 w-full"
								>
									<BarChart
										data={metrics.errorsByProvider.filter((p) => p.errors > 0)}
										layout="vertical"
									>
										<YAxis
											type="category"
											dataKey="providerName"
											width={100}
											tick={{ fontSize: 11 }}
										/>
										<XAxis tick={{ fontSize: 11 }} />
										<CartesianGrid strokeDasharray="3 3" />
										<Tooltip
											content={
												<ChartTooltipContent
													formatter={(value) => [
														(Number(value) || 0).toLocaleString(),

														"errors",
													]}
												/>
											}
										/>
										<ChartLegendContent />
										<Bar
											dataKey="errors"
											fill="#ef4444"
											radius={[0, 4, 4, 0]}
										/>
									</BarChart>
								</ChartContainer>
							</CardContent>
						</Card>

						{/* Latency P95 by provider */}
						<Card>
							<CardHeader>
								<CardTitle>P95 latency by provider</CardTitle>
								<CardDescription>95th percentile latency (ms)</CardDescription>
							</CardHeader>
							<CardContent>
								<ChartContainer
									config={requestsChartConfig}
									className="h-80 w-full"
								>
									<BarChart
										data={metrics.byProvider.filter(
											(p) => p.p95LatencyMs !== null && p.p95LatencyMs > 0,
										)}
										layout="vertical"
									>
										<YAxis
											type="category"
											dataKey="providerName"
											width={100}
											tick={{ fontSize: 11 }}
										/>
										<XAxis tick={{ fontSize: 11 }} />
										<CartesianGrid strokeDasharray="3 3" />
										<Tooltip
											content={
												<ChartTooltipContent
													formatter={(value) => [
														(Number(value) || 0).toLocaleString(),

														"ms",
													]}
												/>
											}
										/>
										<ChartLegendContent />
										<Bar
											dataKey="p95LatencyMs"
											fill="#8b5cf6"
											radius={[0, 4, 4, 0]}
										/>
									</BarChart>
								</ChartContainer>
							</CardContent>
						</Card>

						{/* TTFT by provider */}
						<Card>
							<CardHeader>
								<CardTitle>Avg TTFT by provider</CardTitle>
								<CardDescription>Time to first token (ms)</CardDescription>
							</CardHeader>
							<CardContent>
								<ChartContainer
									config={requestsChartConfig}
									className="h-80 w-full"
								>
									<BarChart
										data={metrics.byProvider.filter(
											(p) => p.avgTtftMs !== null && p.avgTtftMs > 0,
										)}
										layout="vertical"
									>
										<YAxis
											type="category"
											dataKey="providerName"
											width={100}
											tick={{ fontSize: 11 }}
										/>
										<XAxis tick={{ fontSize: 11 }} />
										<CartesianGrid strokeDasharray="3 3" />
										<Tooltip
											content={
												<ChartTooltipContent
													formatter={(value) => [
														(Number(value) || 0).toLocaleString(),

														"ms",
													]}
												/>
											}
										/>
										<ChartLegendContent />
										<Bar
											dataKey="avgTtftMs"
											fill="#06b6d4"
											radius={[0, 4, 4, 0]}
										/>
									</BarChart>
								</ChartContainer>
							</CardContent>
						</Card>
					</div>

					<div className="grid gap-6">
						{/* Recent errors table */}
						<Card>
							<CardHeader>
								<CardTitle>Recent errors</CardTitle>
								<CardDescription>
									Most recent failed requests (max 50)
								</CardDescription>
							</CardHeader>
							<CardContent>
								{metrics.recentErrors.length === 0 ? (
									<div className="rounded-lg border bg-card px-4 py-12 text-center">
										<p className="font-medium">No errors recorded</p>
										<p className="mt-1 text-sm text-muted-foreground">
											All requests succeeded.
										</p>
									</div>
								) : (
									<div className="overflow-x-auto">
										<table className="w-full text-sm">
											<thead>
												<tr className="border-b text-left text-muted-foreground">
													{["Provider", "Model", "Error message", "Time"].map(
														(label) => (
															<th
																key={label}
																className="whitespace-nowrap px-4 py-3 font-medium"
															>
																{label}
															</th>
														),
													)}
												</tr>
											</thead>
											<tbody>
												{metrics.recentErrors.map((err) => (
													<tr key={err.id} className="border-b last:border-0">
														<td className="px-4 py-3">{err.providerName}</td>
														<td className="px-4 py-3 font-mono text-xs">
															{err.model_routed}
														</td>
														<td className="px-4 py-3 text-destructive max-w-xs truncate">
															{err.error_message}
														</td>
														<td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
															{formatDateTimeLabel(err.created_at)}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								)}
							</CardContent>
						</Card>

						{/* Routing detail by provider table */}
						<Card>
							<CardHeader>
								<CardTitle>Routing detail by provider</CardTitle>
								<CardDescription>
									Request statistics per provider
								</CardDescription>
							</CardHeader>
							<CardContent>
								<div className="overflow-x-auto">
									<table className="w-full text-sm">
										<thead>
											<tr className="border-b text-left text-muted-foreground">
												{[
													"Provider",
													"Requests",
													"Errors",
													"Fallbacks",
													"Avg latency (ms)",
													"P95 latency (ms)",
													"TTFT (ms)",
													"Tokens/s",
													"Input tokens",
													"Output tokens",
												].map((label) => (
													<th
														key={label}
														className="whitespace-nowrap px-4 py-3 font-medium"
													>
														{label}
													</th>
												))}
											</tr>
										</thead>
										<tbody>
											{metrics.byProvider.map((p) => (
												<tr key={p.platform} className="border-b last:border-0">
													<td className="px-4 py-3">{p.providerName}</td>
													<td className="px-4 py-3 tabular-nums">
														{p.requests.toLocaleString()}
													</td>
													<td className="px-4 py-3 tabular-nums text-destructive">
														{p.errors.toLocaleString()}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{p.fallbackAttempts.toLocaleString()}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{p.avgLatencyMs !== null
															? Math.round(p.avgLatencyMs).toLocaleString()
															: "—"}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{p.p95LatencyMs !== null
															? Math.round(p.p95LatencyMs).toLocaleString()
															: "—"}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{p.avgTtftMs !== null
															? Math.round(p.avgTtftMs).toLocaleString()
															: "—"}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{p.tokensPerSec !== null
															? Math.round(p.tokensPerSec).toLocaleString()
															: "—"}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{p.inputTokens.toLocaleString()}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{p.outputTokens.toLocaleString()}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</CardContent>
						</Card>

						{/* Detail by model table */}
						<Card>
							<CardHeader>
								<CardTitle>Detail by model</CardTitle>
								<CardDescription>Request statistics per model</CardDescription>
							</CardHeader>
							<CardContent>
								<div className="overflow-x-auto">
									<table className="w-full text-sm">
										<thead>
											<tr className="border-b text-left text-muted-foreground">
												{[
													"Model ID",
													"Provider",
													"Requests",
													"Successes",
													"Latency (ms)",
													"Input tokens",
													"Output tokens",
												].map((label) => (
													<th
														key={label}
														className="whitespace-nowrap px-4 py-3 font-medium"
													>
														{label}
													</th>
												))}
											</tr>
										</thead>
										<tbody>
											{metrics.byModel.map((m) => (
												<tr key={m.model_id} className="border-b last:border-0">
													<td className="px-4 py-3">{m.model_id}</td>
													<td className="px-4 py-3 text-muted-foreground">
														{m.providerName}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{m.requests.toLocaleString()}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{m.successes.toLocaleString()}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{m.latency_ms !== null
															? Math.round(m.latency_ms).toLocaleString()
															: "—"}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{m.input_tokens.toLocaleString()}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{m.output_tokens.toLocaleString()}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</CardContent>
						</Card>

						{/* Usage by key table */}
						<Card>
							<CardHeader>
								<CardTitle>Usage by key</CardTitle>
								<CardDescription>
									All-time usage per key that served your requests
								</CardDescription>
							</CardHeader>
							<CardContent>
								{metrics.byKey.length === 0 ? (
									<div className="rounded-lg border bg-card px-4 py-12 text-center">
										<p className="font-medium">No keys used</p>
										<p className="mt-1 text-sm text-muted-foreground">
											Requests will appear here when routing begins.
										</p>
									</div>
								) : (
									<div className="overflow-x-auto">
										<table className="w-full text-sm">
											<thead>
												<tr className="border-b text-left text-muted-foreground">
													{[
														"Key",
														"Provider",
														"Requests",
														"Successes",
														"Latency (ms)",
														"Input tokens",
														"Output tokens",
													].map((label) => (
														<th
															key={label}
															className="whitespace-nowrap px-4 py-3 font-medium"
														>
															{label}
														</th>
													))}
												</tr>
											</thead>
											<tbody>
												{metrics.byKey.map((k) => (
													<tr
														key={`${k.keyId}-${k.platform}`}
														className="border-b last:border-0"
													>
														<td className="px-4 py-3 font-mono text-xs">
															{k.key_mask || "—"}
														</td>
														<td className="px-4 py-3 text-muted-foreground">
															{k.providerName}
														</td>
														<td className="px-4 py-3 tabular-nums">
															{k.requests.toLocaleString()}
														</td>
														<td className="px-4 py-3 tabular-nums">
															{k.successes.toLocaleString()}
														</td>
														<td className="px-4 py-3 tabular-nums">
															{k.latency_ms !== null
																? Math.round(k.latency_ms).toLocaleString()
																: "—"}
														</td>
														<td className="px-4 py-3 tabular-nums">
															{k.input_tokens.toLocaleString()}
														</td>
														<td className="px-4 py-3 tabular-nums">
															{k.output_tokens.toLocaleString()}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								)}
							</CardContent>
						</Card>
					</div>
				</>
			) : (
				<div className="rounded-lg border bg-card px-4 py-12 text-center">
					<p className="font-medium">No data available</p>
					<p className="mt-1 text-sm text-muted-foreground">
						No request data found for your account.
					</p>
				</div>
			)}
		</div>
	);
}
