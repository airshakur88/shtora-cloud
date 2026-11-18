"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";

interface AdminKey {
	id: number;
	platform: string;
	keyLabel: string | null;
	ownerUsername: string;
	enabled: boolean;
	lastHealthCheckStatus: string | null;
	lastHealthCheckAt: string | null;
	unifiedTokenMasked: string;
}

function isAdminKey(value: unknown): value is AdminKey {
	if (!value || typeof value !== "object") return false;
	return (
		"id" in value &&
		typeof value.id === "number" &&
		"platform" in value &&
		typeof value.platform === "string" &&
		"keyLabel" in value &&
		(value.keyLabel === null || typeof value.keyLabel === "string") &&
		"ownerUsername" in value &&
		typeof value.ownerUsername === "string" &&
		"enabled" in value &&
		typeof value.enabled === "boolean" &&
		"lastHealthCheckStatus" in value &&
		(value.lastHealthCheckStatus === null ||
			typeof value.lastHealthCheckStatus === "string") &&
		"lastHealthCheckAt" in value &&
		(value.lastHealthCheckAt === null ||
			typeof value.lastHealthCheckAt === "string") &&
		"unifiedTokenMasked" in value &&
		typeof value.unifiedTokenMasked === "string"
	);
}

export default function AdminKeysPage() {
	const [keys, setKeys] = useState<AdminKey[] | null>(null);

	const loadKeys = useCallback(async (signal?: AbortSignal) => {
		try {
			const response = await fetch("/api/admin/keys", {
				cache: "no-store",
				signal,
			});
			if (!response.ok) throw new Error("Could not load provider keys.");
			const result: unknown = await response.json();
			if (
				!result ||
				typeof result !== "object" ||
				!("keys" in result) ||
				!Array.isArray(result.keys)
			)
				throw new Error("Invalid provider key response.");
			const parsedKeys = result.keys.filter(isAdminKey);
			if (parsedKeys.length !== result.keys.length)
				throw new Error("Invalid provider key response.");
			if (!signal?.aborted) setKeys(parsedKeys);
		} catch (cause) {
			if (!signal?.aborted)
				toast.add({
					title: "Error",
					description:
						cause instanceof Error
							? cause.message
							: "Could not load provider keys.",
					type: "error",
				});
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void loadKeys(controller.signal);
		return () => controller.abort();
	}, [loadKeys]);

	return (
		<div className="space-y-6 p-6">
			<header>
				<h1 className="text-3xl font-bold tracking-tight">Provider keys</h1>
				<p className="mt-1 text-muted-foreground">
					Provider credentials registered across user accounts.
				</p>
			</header>
			{keys === null ? (
				<p role="status" className="text-sm text-muted-foreground">
					Loading provider keys…
				</p>
			) : keys.length === 0 ? (
				<div className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
					No provider keys registered.
				</div>
			) : (
				<div className="overflow-x-auto rounded-lg border bg-card">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b text-left text-muted-foreground">
								<th className="px-4 py-3 font-medium">Platform</th>
								<th className="px-4 py-3 font-medium">Label</th>
								<th className="px-4 py-3 font-medium">Owner</th>
								<th className="px-4 py-3 font-medium">Token</th>
								<th className="px-4 py-3 font-medium">Enabled</th>
								<th className="px-4 py-3 font-medium">Health</th>
								<th className="px-4 py-3 font-medium">Last check</th>
							</tr>
						</thead>
						<tbody>
							{keys.map((key) => (
								<tr key={key.id} className="border-b last:border-0">
									<td className="px-4 py-3 font-medium">{key.platform}</td>
									<td className="px-4 py-3">{key.keyLabel ?? "—"}</td>
									<td className="px-4 py-3">{key.ownerUsername}</td>
									<td className="px-4 py-3 font-mono text-xs">
										{key.unifiedTokenMasked}
									</td>
									<td className="px-4 py-3">
										<Badge variant={key.enabled ? "default" : "secondary"}>
											{key.enabled ? "Yes" : "No"}
										</Badge>
									</td>
									<td className="px-4 py-3">
										{key.lastHealthCheckStatus ? (
											<Badge
												variant={
													key.lastHealthCheckStatus === "ok"
														? "default"
														: "destructive"
												}
											>
												{key.lastHealthCheckStatus}
											</Badge>
										) : (
											"Never"
										)}
									</td>
									<td className="px-4 py-3 text-muted-foreground">
										{key.lastHealthCheckAt
											? new Date(key.lastHealthCheckAt).toLocaleString()
											: "—"}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
