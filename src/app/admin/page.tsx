"use client";

import {
	Activity,
	CircleDollarSign,
	Gauge,
	KeyRound,
	Percent,
	ShieldCheck,
	Timer,
	Users,
} from "lucide-react";
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

export default function AdminOverviewPage() {
	const [stats, setStats] = useState<AdminStats | null>(null);

	const loadStats = useCallback(async (signal?: AbortSignal) => {
		setStats(null);
		try {
			const response = await fetch("/api/admin/stats", {
				cache: "no-store",
				signal,
			});
			if (!response.ok) throw new Error("Could not load system statistics.");
			const result: unknown = await response.json();
			const statsData =
				result && typeof result === "object" && "stats" in result
					? result.stats
					: result;
			if (!isAdminStats(statsData))
				throw new Error("Invalid system statistics response.");
			if (!signal?.aborted) setStats(statsData);
		} catch (cause) {
			if (!signal?.aborted)
				toast.add({
					title: "Error",
					description:
						cause instanceof Error
							? cause.message
							: "Could not load system statistics.",
					type: "error",
				});
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void loadStats(controller.signal);
		return () => controller.abort();
	}, [loadStats]);

	const cards = stats
		? [
				{
					title: "Success rate (24h)",
					value:
						stats.successRate24h == null
							? "—"
							: formatPercent(stats.successRate24h),
					detail: "Successful provider attempts",
					icon: Activity,
				},
				{
					title: "Provider keys",
					value: stats.keysTotal.toLocaleString(),
					detail: `${stats.keysQuarantined} quarantined`,
					icon: KeyRound,
				},
				{
					title: "Users",
					value: stats.usersTotal.toLocaleString(),
					detail: "Registered accounts",
					icon: Users,
				},
			]
		: [];
	const lifetimeCards = stats
		? [
				{
					title: "Provider attempts",
					value: stats.lifetimeMetrics.requests.toLocaleString(),
					detail: "Includes failovers",
					icon: Activity,
				},
				{
					title: "Success rate",
					value:
						stats.lifetimeMetrics.successRate === null
							? "—"
							: formatPercent(stats.lifetimeMetrics.successRate),
					detail: `${stats.lifetimeMetrics.successfulRequests.toLocaleString()} successful attempts`,
					icon: Percent,
				},
				{
					title: "Tokens in",
					value: stats.lifetimeMetrics.inputTokens.toLocaleString(),
					detail: "Provider-reported or estimated",
					icon: ShieldCheck,
				},
				{
					title: "Tokens out",
					value: stats.lifetimeMetrics.outputTokens.toLocaleString(),
					detail: "Provider usage or visible-content estimate",
					icon: Activity,
				},
				{
					title: "Estimated savings",
					value: `$${stats.lifetimeMetrics.estimatedSavingsUsd.toFixed(2)}`,
					detail: "Paid-equivalent estimate",
					icon: CircleDollarSign,
				},
				{
					title: "Average latency",
					value:
						stats.lifetimeMetrics.averageLatencyMs === null
							? "—"
							: `${Math.round(stats.lifetimeMetrics.averageLatencyMs).toLocaleString()} ms`,
					detail: "Time to provider response headers",
					icon: Timer,
				},
				{
					title: "P95 latency (approx.)",
					value:
						stats.lifetimeMetrics.p95LatencyMs === null
							? "—"
							: `${stats.lifetimeMetrics.p95LatencyMs.toLocaleString()} ms`,
					detail: "From the latency histogram",
					icon: Gauge,
				},
				{
					title: "Average TTFT",
					value:
						stats.lifetimeMetrics.averageTtftMs === null
							? "—"
							: `${Math.round(stats.lifetimeMetrics.averageTtftMs).toLocaleString()} ms`,
					detail: "Successful streams with visible content",
					icon: Timer,
				},
			]
		: [];

	return (
		<div className="space-y-8 p-6">
			<header>
				<h1 className="text-3xl font-bold tracking-tight">Admin overview</h1>
				<p className="mt-2 text-muted-foreground">
					System-wide router and provider health.
				</p>
			</header>
			{!stats && (
				<p role="status" className="text-sm text-muted-foreground">
					Loading system overview…
				</p>
			)}
			{stats && (
				<>
					<section className="space-y-4">
						<div>
							<h2 className="text-lg font-semibold">Lifetime metrics</h2>
							<p className="text-sm text-muted-foreground">
								Attempts include provider failovers. Savings are estimates;
								token totals may be estimated when providers omit usage.
							</p>
						</div>
						<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
							{lifetimeCards.map(({ title, value, detail, icon: Icon }) => (
								<Card key={title}>
									<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
										<CardTitle className="text-sm font-medium">
											{title}
										</CardTitle>
										<Icon className="size-4 text-primary" />
									</CardHeader>
									<CardContent>
										<div className="text-2xl font-bold tabular-nums">
											{value}
										</div>
										<CardDescription>{detail}</CardDescription>
									</CardContent>
								</Card>
							))}
						</div>
					</section>
					<section className="space-y-4">
						<h2 className="text-lg font-semibold">Current diagnostics</h2>
						<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
							{cards.map(({ title, value, detail, icon: Icon }) => (
								<Card key={title}>
									<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
										<CardTitle className="text-sm font-medium">
											{title}
										</CardTitle>
										<Icon className="size-4 text-primary" />
									</CardHeader>
									<CardContent>
										<div className="text-2xl font-bold tabular-nums">
											{value}
										</div>
										<CardDescription>{detail}</CardDescription>
									</CardContent>
								</Card>
							))}
						</div>
						<div className="grid gap-6 lg:grid-cols-2">
							<Card>
								<CardHeader>
									<CardTitle>Requests by provider</CardTitle>
									<CardDescription>Attempts and errors (7d)</CardDescription>
								</CardHeader>
								<CardContent>
									{stats.byPlatform.length === 0 ? (
										<p className="text-sm text-muted-foreground">
											No provider request data yet.
										</p>
									) : (
										<div className="space-y-3">
											{stats.byPlatform.map((row) => (
												<div
													key={row.platform}
													className="flex items-center justify-between border-b pb-3 last:border-0"
												>
													<span className="font-medium">{row.platform}</span>
													<span className="text-sm text-muted-foreground">
														{row.requests.toLocaleString()} requests ·{" "}
														{row.errors.toLocaleString()} errors
													</span>
												</div>
											))}
										</div>
									)}
								</CardContent>
							</Card>
							<Card>
								<CardHeader>
									<CardTitle>Top models</CardTitle>
									<CardDescription>Most routed attempts (7d)</CardDescription>
								</CardHeader>
								<CardContent>
									{stats.topModels.length === 0 ? (
										<p className="text-sm text-muted-foreground">
											No model request data yet.
										</p>
									) : (
										<div className="space-y-3">
											{stats.topModels.slice(0, 6).map((row) => (
												<div
													key={row.model}
													className="flex items-center justify-between gap-4 border-b pb-3 last:border-0"
												>
													<span className="truncate font-mono text-sm">
														{row.model}
													</span>
													<span className="shrink-0 text-sm text-muted-foreground">
														{row.requests.toLocaleString()}
													</span>
												</div>
											))}
										</div>
									)}
								</CardContent>
							</Card>
						</div>
					</section>
				</>
			)}
		</div>
	);
}
