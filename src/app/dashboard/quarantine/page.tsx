"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";

interface QuarantineEntry {
	id: number;
	platform: string;
	modelId: string;
	keyId: number;
	keyLabel: string | null;
	maskedKey: string | null;
	failureCount: number;
	cooldownUntilMs: number;
	expiresAt: string;
	reason: string | null;
	source: string;
}

function formatExpiresAt(cooldownUntilMs: number): string {
	const ms = cooldownUntilMs - Date.now();
	if (ms <= 0) return "Expired";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "in under a minute";
	if (minutes < 60) return `in ${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `in ${hours}h ${minutes % 60}min`;
	const days = Math.floor(hours / 24);
	return `in ${days}d ${hours % 24}h`;
}

export default function DashboardQuarantinePage() {
	const [entries, setEntries] = useState<QuarantineEntry[] | null>(null);
	const [releaseTarget, setReleaseTarget] = useState<number | null>(null);
	const [busyId, setBusyId] = useState<number | null>(null);

	const loadEntries = useCallback(async (signal?: AbortSignal) => {
		try {
			const response = await fetch("/api/quarantine", {
				cache: "no-store",
				signal,
			});
			if (!response.ok) throw new Error("Could not load quarantines.");
			const result: unknown = await response.json();
			if (
				!result ||
				typeof result !== "object" ||
				!("quarantines" in result) ||
				!Array.isArray(result.quarantines)
			)
				throw new Error("Invalid quarantine response.");
			if (!signal?.aborted) setEntries(result.quarantines as QuarantineEntry[]);
		} catch (cause) {
			if (!signal?.aborted)
				toast.add({
					title: "Error",
					description:
						cause instanceof Error
							? cause.message
							: "Could not load quarantines.",
				});
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void loadEntries(controller.signal);
		return () => controller.abort();
	}, [loadEntries]);

	async function handleRelease(id: number) {
		setBusyId(id);
		try {
			const response = await fetch(`/api/quarantine/${id}/release`, {
				method: "POST",
			});
			if (!response.ok) throw new Error("Could not release quarantine.");
			toast.add({
				title: "Released",
				description: "The key can be tried again for this model immediately.",
				type: "success",
			});
			await loadEntries();
		} catch (cause) {
			toast.add({
				title: "Error",
				description:
					cause instanceof Error
						? cause.message
						: "Could not release quarantine.",
			});
		} finally {
			setBusyId(null);
		}
	}

	function confirmRelease() {
		const id = releaseTarget;
		setReleaseTarget(null);
		if (id !== null) void handleRelease(id);
	}

	return (
		<div className="space-y-6 p-6">
			<div className="space-y-1">
				<h1 className="text-3xl font-bold tracking-tight">Quarantine</h1>
				<p className="text-muted-foreground">
					Your provider keys temporarily blocked for a model after repeated
					upstream failures. A quarantined key is skipped until the cooldown
					expires, or release it here to try it again right away.
				</p>
			</div>

			{entries === null ? (
				<div className="rounded-lg border bg-card p-6">
					<Skeleton className="h-8 w-full" />
					<Skeleton className="mt-4 h-32 w-full" />
				</div>
			) : entries.length === 0 ? (
				<div className="rounded-lg border bg-card px-4 py-12 text-center">
					<p className="font-medium">No keys in quarantine</p>
					<p className="mt-1 text-sm text-muted-foreground">
						Keys appear here when repeated failures put them on cooldown for a
						model.
					</p>
				</div>
			) : (
				<div className="overflow-x-auto rounded-lg border bg-card">
					<table className="w-full min-w-[800px] text-sm">
						<thead>
							<tr className="border-b text-left text-muted-foreground">
								<th className="px-4 py-3 font-medium">Provider</th>
								<th className="px-4 py-3 font-medium">Model</th>
								<th className="px-4 py-3 font-medium">Key</th>
								<th className="px-4 py-3 font-medium text-right">Failures</th>
								<th className="px-4 py-3 font-medium">Expires</th>
								<th className="px-4 py-3 font-medium">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{entries.map((entry) => (
								<tr key={entry.id} className="border-b last:border-0">
									<td className="px-4 py-3 font-medium">{entry.platform}</td>
									<td className="px-4 py-3">
										<code className="break-all text-xs">{entry.modelId}</code>
										{entry.reason ? (
											<div className="mt-1 max-w-72 break-words text-xs text-muted-foreground">
												{entry.reason}
											</div>
										) : null}
									</td>
									<td className="px-4 py-3">
										<div className="max-w-56 break-words font-medium">
											{entry.keyLabel || "Unnamed key"}
										</div>
										<code className="mt-1 block text-xs text-muted-foreground">
											{entry.maskedKey || "••••••••"}
										</code>
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{entry.failureCount}
									</td>
									<td className="px-4 py-3 whitespace-nowrap">
										{formatExpiresAt(entry.cooldownUntilMs)}
									</td>
									<td className="px-4 py-3 text-right">
										<Button
											variant="outline"
											size="sm"
											disabled={busyId === entry.id}
											onClick={() => setReleaseTarget(entry.id)}
										>
											{busyId === entry.id ? "Releasing…" : "Release"}
										</Button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<ConfirmDialog
				open={releaseTarget !== null}
				onOpenChange={(open) => {
					if (!open) setReleaseTarget(null);
				}}
				title="Release this quarantine?"
				description="The key will be tried again for this model on the next request, even if the upstream is still failing."
				confirmLabel="Release"
				onConfirm={confirmRelease}
			/>
		</div>
	);
}
