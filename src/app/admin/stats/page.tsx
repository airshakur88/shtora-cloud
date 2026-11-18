"use client";

import { useCallback, useEffect, useState } from "react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import {
	type AdminStats,
	formatPercent,
	isAdminStats,
} from "@/lib/admin-stats";

export default function AdminStatsPage() {
	const [stats, setStats] = useState<AdminStats | null>(null);

	const loadStats = useCallback(async (signal?: AbortSignal) => {
		setStats(null);
		try {
			const response = await fetch("/api/admin/stats", {
				cache: "no-store",
				signal,
			});
			if (!response.ok) throw new Error("Could not load statistics.");
			const result: unknown = await response.json();
			const statsData =
				result && typeof result === "object" && "stats" in result
					? result.stats
					: result;
			if (!isAdminStats(statsData))
				throw new Error("Invalid statistics response.");
			if (!signal?.aborted) setStats(statsData);
		} catch (cause) {
			if (!signal?.aborted)
				toast.add({
					title: "Error",
					description:
						cause instanceof Error
							? cause.message
							: "Could not load statistics.",
					type: "error",
				});
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void loadStats(controller.signal);
		return () => controller.abort();
	}, [loadStats]);

	return (
		<div className="space-y-8 p-6">
			<header>
				<h1 className="text-3xl font-bold tracking-tight">Statistics</h1>
				<p className="mt-2 text-muted-foreground">
					Requests, provider health, and account totals.
				</p>
			</header>
			{!stats && (
				<p role="status" className="text-sm text-muted-foreground">
					Loading statistics…
				</p>
			)}
			{stats && (
				<>
					<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
						{[
							{
								label: "Total requests",
								value: stats.totalRequests.toLocaleString(),
							},
							{
								label: "Success rate (24h)",
								value:
									stats.successRate24h == null
										? "—"
										: formatPercent(stats.successRate24h),
							},
							{
								label: "P50 latency (7d)",
								value:
									stats.p50LatencyMs == null
										? "—"
										: `${stats.p50LatencyMs.toLocaleString()} ms`,
							},
							{
								label: "P95 latency (7d)",
								value:
									stats.p95LatencyMs == null
										? "—"
										: `${stats.p95LatencyMs.toLocaleString()} ms`,
							},
							{
								label: "Provider keys",
								value: stats.keysTotal.toLocaleString(),
							},
							{
								label: "Quarantined",
								value: stats.keysQuarantined.toLocaleString(),
							},
							{ label: "Users", value: stats.usersTotal.toLocaleString() },
						].map((item) => (
							<Card key={item.label}>
								<CardHeader className="pb-2">
									<CardTitle className="text-sm font-medium">
										{item.label}
									</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="text-2xl font-bold tabular-nums">
										{item.value}
									</p>
								</CardContent>
							</Card>
						))}
					</div>
					<div className="grid gap-6 lg:grid-cols-2">
						<Card>
							<CardHeader>
								<CardTitle>By provider</CardTitle>
								<CardDescription>
									Requests and failures by provider
								</CardDescription>
							</CardHeader>
							<CardContent>
								{stats.byPlatform.length === 0 ? (
									<p className="text-sm text-muted-foreground">
										No provider data recorded yet.
									</p>
								) : (
									<div className="overflow-x-auto">
										<table className="w-full text-sm">
											<thead>
												<tr className="border-b text-left text-muted-foreground">
													<th className="py-2 font-medium">Provider</th>
													<th className="py-2 text-right font-medium">
														Requests
													</th>
													<th className="py-2 text-right font-medium">
														Errors
													</th>
												</tr>
											</thead>
											<tbody>
												{stats.byPlatform.map((row) => (
													<tr
														key={row.platform}
														className="border-b last:border-0"
													>
														<td className="py-3">{row.platform}</td>
														<td className="py-3 text-right tabular-nums">
															{row.requests.toLocaleString()}
														</td>
														<td className="py-3 text-right tabular-nums">
															{row.errors.toLocaleString()}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								)}
							</CardContent>
						</Card>
						<Card>
							<CardHeader>
								<CardTitle>Top models</CardTitle>
								<CardDescription>
									Request count, success rate, and median latency
								</CardDescription>
							</CardHeader>
							<CardContent>
								{stats.topModels.length === 0 ? (
									<p className="text-sm text-muted-foreground">
										No model data recorded yet.
									</p>
								) : (
									<div className="overflow-x-auto">
										<table className="w-full text-sm">
											<thead>
												<tr className="border-b text-left text-muted-foreground">
													<th className="py-2 font-medium">Model</th>
													<th className="py-2 text-right font-medium">
														Requests
													</th>
													<th className="py-2 text-right font-medium">
														Success
													</th>
													<th className="py-2 text-right font-medium">P50</th>
												</tr>
											</thead>
											<tbody>
												{stats.topModels.map((row) => (
													<tr
														key={row.model}
														className="border-b last:border-0"
													>
														<td className="py-3 font-mono text-xs">
															{row.model}
														</td>
														<td className="py-3 text-right tabular-nums">
															{row.requests.toLocaleString()}
														</td>
														<td className="py-3 text-right">
															{row.successRate == null
																? "—"
																: formatPercent(row.successRate)}
														</td>
														<td className="py-3 text-right tabular-nums">
															{row.p50Ms == null ? "—" : `${row.p50Ms} ms`}
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
			)}
		</div>
	);
}
