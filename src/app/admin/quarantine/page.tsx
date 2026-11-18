"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

interface QuarantineEntry {
	platform: string;
	modelId: string;
	keyId: number;
	keyLabel: string | null;
	ownerUsername: string | null;
	failureCount: number;
	cooldownUntilMs: number;
	reason: string | null;
	source: string;
}

function isQuarantineEntry(value: unknown): value is QuarantineEntry {
	if (!value || typeof value !== "object") return false;
	return (
		"platform" in value &&
		typeof value.platform === "string" &&
		"modelId" in value &&
		typeof value.modelId === "string" &&
		"keyId" in value &&
		typeof value.keyId === "number" &&
		"keyLabel" in value &&
		(value.keyLabel === null || typeof value.keyLabel === "string") &&
		"ownerUsername" in value &&
		(value.ownerUsername === null || typeof value.ownerUsername === "string") &&
		"failureCount" in value &&
		typeof value.failureCount === "number" &&
		"cooldownUntilMs" in value &&
		typeof value.cooldownUntilMs === "number" &&
		"reason" in value &&
		(value.reason === null || typeof value.reason === "string") &&
		"source" in value &&
		typeof value.source === "string"
	);
}

function formatCooldown(untilMs: number) {
	const remaining = untilMs - Date.now();
	if (remaining <= 0) return "Expired";
	const minutes = Math.floor(remaining / 60_000);
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const rest = minutes % 60;
	if (days) return `${days}d ${hours}h`;
	if (hours) return `${hours}h ${rest}m`;
	return `${rest}m`;
}

export default function AdminQuarantinePage() {
	const [entries, setEntries] = useState<QuarantineEntry[] | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	const loadEntries = useCallback(async (signal?: AbortSignal) => {
		try {
			const response = await fetch("/api/admin/quarantine", {
				cache: "no-store",
				signal,
			});
			if (!response.ok) throw new Error("Could not load quarantined keys.");
			const result: unknown = await response.json();
			if (
				!result ||
				typeof result !== "object" ||
				!("quarantined" in result) ||
				!Array.isArray(result.quarantined)
			)
				throw new Error("Invalid quarantine response.");
			const parsedEntries = result.quarantined.filter(isQuarantineEntry);
			if (parsedEntries.length !== result.quarantined.length)
				throw new Error("Invalid quarantine response.");
			if (!signal?.aborted) setEntries(parsedEntries);
		} catch (cause) {
			if (!signal?.aborted)
				toast.add({
					title: "Error",
					description:
						cause instanceof Error
							? cause.message
							: "Could not load quarantined keys.",
					type: "error",
				});
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void loadEntries(controller.signal);
		return () => controller.abort();
	}, [loadEntries]);

	async function release(entry: QuarantineEntry) {
		const id = `${entry.platform}-${entry.modelId}-${entry.keyId}`;
		if (busyId !== null) return;
		setBusyId(id);
		try {
			const response = await fetch("/api/admin/quarantine/release", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					platform: entry.platform,
					modelId: entry.modelId,
					keyId: entry.keyId,
				}),
			});
			if (!response.ok)
				throw new Error("Could not release key from quarantine.");
			toast.add({ title: "Key released", type: "success" });
			await loadEntries();
		} catch (cause) {
			toast.add({
				title: "Error",
				description:
					cause instanceof Error
						? cause.message
						: "Could not release key from quarantine.",
				type: "error",
			});
		} finally {
			setBusyId(null);
		}
	}

	return (
		<div className="space-y-6 p-6">
			<header className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="text-3xl font-bold tracking-tight">Quarantine</h1>
					<p className="mt-1 text-muted-foreground">
						Provider keys paused after health failures.
					</p>
				</div>
				{entries && <Badge variant="secondary">{entries.length} active</Badge>}
			</header>
			{entries === null ? (
				<p role="status" className="text-sm text-muted-foreground">
					Loading quarantine…
				</p>
			) : entries.length === 0 ? (
				<div className="rounded-lg border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
					No keys in quarantine.
				</div>
			) : (
				<div className="overflow-x-auto rounded-lg border bg-card">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b text-left text-muted-foreground">
								<th className="px-4 py-3 font-medium">Platform</th>
								<th className="px-4 py-3 font-medium">Model</th>
								<th className="px-4 py-3 font-medium">Owner</th>
								<th className="px-4 py-3 font-medium">Label</th>
								<th className="px-4 py-3 font-medium">Reason</th>
								<th className="px-4 py-3 font-medium">Source</th>
								<th className="px-4 py-3 text-right font-medium">Failures</th>
								<th className="px-4 py-3 font-medium">Time left</th>
								<th className="px-4 py-3 text-right font-medium">Action</th>
							</tr>
						</thead>
						<tbody>
							{entries.map((entry) => {
								const id = `${entry.platform}-${entry.modelId}-${entry.keyId}`;
								return (
									<tr key={id} className="border-b last:border-0">
										<td className="px-4 py-3 font-medium">{entry.platform}</td>
										<td className="px-4 py-3 font-mono text-xs">
											{entry.modelId}
										</td>
										<td className="px-4 py-3">{entry.ownerUsername ?? "—"}</td>
										<td className="px-4 py-3">{entry.keyLabel ?? "—"}</td>
										<td className="max-w-48 px-4 py-3">
											{entry.reason ?? "—"}
										</td>
										<td className="px-4 py-3">
											<Badge variant="outline">{entry.source || "—"}</Badge>
										</td>
										<td className="px-4 py-3 text-right tabular-nums">
											{entry.failureCount}
										</td>
										<td className="px-4 py-3 tabular-nums">
											{formatCooldown(entry.cooldownUntilMs)}
										</td>
										<td className="px-4 py-3 text-right">
											<Button
												size="sm"
												variant="outline"
												disabled={busyId !== null}
												onClick={() => void release(entry)}
											>
												{busyId === id ? "Releasing…" : "Release"}
											</Button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
