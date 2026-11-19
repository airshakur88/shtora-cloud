"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CatalogModel, CatalogProvider } from "@/lib/dashboard-catalog";
import { isCatalogResponse } from "@/lib/dashboard-catalog";
import { formatContextWindow } from "@/lib/model-canonical";

export default function DashboardModelsPage() {
	const [models, setModels] = useState<CatalogModel[] | null>(null);
	const [providers, setProviders] = useState<CatalogProvider[]>([]);
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
			setProviders(result.providers);
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

	// Provider ids come from the catalog as a comma-joined list; the names
	// come from the same response, straight from the providers table.
	const providerNameById = useMemo(
		() => new Map(providers.map((p) => [p.id, p.name])),
		[providers],
	);
	const providerNames = useCallback(
		(platform: string) =>
			platform
				.split(", ")
				.map((id) => providerNameById.get(id) ?? id)
				.join(", "),
		[providerNameById],
	);

	const filteredModels = useMemo(
		() =>
			models?.filter((model) => {
				const query = searchQuery.toLowerCase();
				return (
					model.id.toLowerCase().includes(query) ||
					model.name.toLowerCase().includes(query) ||
					model.platform.toLowerCase().includes(query) ||
					providerNames(model.platform).toLowerCase().includes(query) ||
					(model.suspectReason ?? "").toLowerCase().includes(query)
				);
			}) ?? [],
		[models, searchQuery, providerNames],
	);

	return (
		<div className="space-y-6 p-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-3xl font-bold tracking-tight">Models</h1>
					<p className="text-muted-foreground">Models listed in the catalog.</p>
				</div>
			</div>
			<div className="flex items-center gap-4">
				<Input
					type="search"
					placeholder="Search models..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					className="max-w-sm"
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
									{[
										"skeleton-1",
										"skeleton-2",
										"skeleton-3",
										"skeleton-4",
										"skeleton-5",
									].map((rowKey) => (
										<tr key={rowKey} className="border-b last:border-0">
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
						{searchQuery ? "No matching models" : "No models in the catalog"}
					</p>
					<p className="mt-1 text-sm text-muted-foreground">
						{searchQuery
							? "Try a different search term."
							: "The catalog is empty. Models appear here when they are added to the catalog."}
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
										<div className="font-medium">
											{model.name}
											{model.memberNames !== undefined &&
												model.memberNames.length > 0 && (
													<Tooltip>
														<TooltipTrigger
															render={
																<button
																	type="button"
																	aria-label={`Models in ${model.name}`}
																	className="ml-1.5 inline-flex size-4 items-center justify-center rounded-full border text-[10px] leading-none text-muted-foreground"
																>
																	?
																</button>
															}
														/>
														<TooltipContent side="right">
															<ul className="space-y-0.5">
																{model.memberNames.map((member) => (
																	<li key={member}>{member}</li>
																))}
															</ul>
														</TooltipContent>
													</Tooltip>
												)}
										</div>
										<div className="text-xs text-muted-foreground">
											{model.id}
										</div>
										{model.suspectReason && (
											<div className="text-xs font-medium text-amber-600 dark:text-amber-400">
												Suspect: {model.suspectReason}
											</div>
										)}
									</td>
									<td className="px-4 py-3 text-right text-muted-foreground">
										{providerNames(model.platform)}
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{model.globalKeyCount.toLocaleString()}
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{model.personalKeyCount.toLocaleString()}
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{formatContextWindow(model.contextWindow)}
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
