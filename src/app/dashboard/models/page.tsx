"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";

interface ModelData {
	id: string;
	name: string;
	platform: string;
	enabled: boolean;
	supportsTools: boolean;
	supportsVision: boolean;
	contextWindow: number | null;
	globalKeyCount: number;
	personalKeyCount: number;
}

interface CatalogResponse {
	providers: unknown[];
	models: ModelData[];
}

function isModelData(value: unknown): value is ModelData {
	if (!value || typeof value !== "object") return false;
	return (
		"id" in value &&
		typeof value.id === "string" &&
		"name" in value &&
		typeof value.name === "string" &&
		"platform" in value &&
		typeof value.platform === "string" &&
		"enabled" in value &&
		typeof value.enabled === "boolean" &&
		"supportsTools" in value &&
		typeof value.supportsTools === "boolean" &&
		"supportsVision" in value &&
		typeof value.supportsVision === "boolean" &&
		"contextWindow" in value &&
		(typeof value.contextWindow === "number" || value.contextWindow === null) &&
		"globalKeyCount" in value &&
		"personalKeyCount" in value &&
		typeof value.personalKeyCount === "number"
	);
}

function isCatalogResponse(value: unknown): value is CatalogResponse {
	if (!value || typeof value !== "object") return false;
	if (!("models" in value) || !Array.isArray(value.models)) return false;
	if (!("providers" in value) || !Array.isArray(value.providers)) return false;
	return value.models.every(isModelData);
}

export default function DashboardModelsPage() {
	const [models, setModels] = useState<ModelData[] | null>(null);
	const [searchQuery, setSearchQuery] = useState("");

	const loadModels = useCallback(async (signal?: AbortSignal) => {
		try {
			const response = await fetch("/api/dashboard/catalog", {
				cache: "no-store",
				signal,
			});
			if (!response.ok) throw new Error("Could not load model catalog.");
			const result: unknown = await response.json();
			if (!isCatalogResponse(result))
				throw new Error("Invalid catalog response.");
			if (signal?.aborted) return;
			setModels(result.models);
		} catch (cause) {
			if (!signal?.aborted)
				toast.add({
					title: "Error",
					description:
						cause instanceof Error
							? cause.message
							: "Could not load model catalog.",
				});
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void loadModels(controller.signal);
		return () => controller.abort();
	}, [loadModels]);

	const filteredModels = useMemo(
		() =>
			models?.filter(
				(model) =>
					model.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
					model.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
					model.platform.toLowerCase().includes(searchQuery.toLowerCase()),
			) ?? [],
		[models, searchQuery],
	);

	return (
		<div className="space-y-6 p-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-3xl font-bold tracking-tight">Models</h1>
					<p className="text-muted-foreground">
						Available models from all providers with global keys configured.
					</p>
				</div>
			</div>
			<div className="flex items-center gap-4">
				<input
					type="text"
					placeholder="Search models..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
				/>
			</div>
			{models === null ? (
				<div className="space-y-6">
					<div className="rounded-lg border bg-card">
						<div className="border-b px-4 py-3">
							<Skeleton className="h-6 w-32 mb-2" />
							<Skeleton className="h-4 w-48" />
						</div>
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b text-left text-muted-foreground">
										<th className="px-4 py-3 font-medium">Model</th>
										<th className="px-4 py-3 font-medium text-right">
											Provider
										</th>
										<th className="px-4 py-3 font-medium text-right">
											Global keys
										</th>
										<th className="px-4 py-3 font-medium text-right">
											Personal keys
										</th>
										<th className="px-4 py-3 font-medium text-right">
											Context window
										</th>
										<th className="px-4 py-3 font-medium text-right">
											Features
										</th>
									</tr>
								</thead>
								<tbody>
									{[...Array(5)].map((_, i) => (
										<tr key={i} className="border-b last:border-0">
											<td className="px-4 py-3">
												<div className="font-medium">
													<Skeleton className="h-4 w-32 mb-1" />
												</div>
												<Skeleton className="h-3 w-20 text-muted-foreground" />
											</td>
											<td className="px-4 py-3 text-right text-muted-foreground">
												<Skeleton className="h-4 w-16" />
											</td>
											<td className="px-4 py-3 text-right tabular-nums">
												<Skeleton className="h-4 w-8" />
											</td>
											<td className="px-4 py-3 text-right tabular-nums">
												<Skeleton className="h-4 w-8" />
											</td>
											<td className="px-4 py-3 text-right tabular-nums">
												<Skeleton className="h-4 w-10" />
											</td>
											<td className="px-4 py-3 text-right">
												<Skeleton className="h-4 w-16" />
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				</div>
			) : filteredModels.length === 0 ? (
				<div className="rounded-lg border bg-card px-4 py-12 text-center">
					<p className="font-medium">
						{searchQuery ? "No matching models" : "No models available"}
					</p>
					<p className="mt-1 text-sm text-muted-foreground">
						{searchQuery
							? "Try a different search term."
							: "Add API keys to see available models."}
					</p>
				</div>
			) : (
				<div className="overflow-x-auto rounded-lg border bg-card">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b text-left text-muted-foreground">
								<th className="px-4 py-3 font-medium">Model</th>
								<th className="px-4 py-3 font-medium text-right">Provider</th>
								<th className="px-4 py-3 font-medium text-right">
									Global keys
								</th>
								<th className="px-4 py-3 font-medium text-right">
									Personal keys
								</th>
								<th className="px-4 py-3 font-medium text-right">
									Context window
								</th>
								<th className="px-4 py-3 font-medium text-right">Features</th>
							</tr>
						</thead>
						<tbody>
							{filteredModels.map((model) => (
								<tr key={model.id} className="border-b last:border-0">
									<td className="px-4 py-3">
										<div className="font-medium">{model.name}</div>
										<div className="text-xs text-muted-foreground">
											{model.id}
										</div>
									</td>
									<td className="px-4 py-3 text-right text-muted-foreground">
										{model.platform}
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{model.globalKeyCount.toLocaleString()}
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{model.personalKeyCount.toLocaleString()}
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{model.contextWindow
											? model.contextWindow.toLocaleString()
											: "—"}
									</td>
									<td className="px-4 py-3 text-right">
										<span className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
											{model.supportsTools && <span>tools</span>}
											{model.supportsVision && <span>vision</span>}
											{!model.supportsTools && !model.supportsVision && (
												<span className="text-muted-foreground">—</span>
											)}
										</span>
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
