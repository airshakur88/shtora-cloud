"use client";

import { LoaderCircle, MoreVertical, Search, Trash2 } from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/ui/combobox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { InputNumber } from "@/components/ui/input-number";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { apiErrorMessage } from "@/lib/api-error";
import type { CatalogProvider } from "@/lib/dashboard-catalog";
import { isCatalogResponse } from "@/lib/dashboard-catalog";
import type { ApiKeyResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

function isKeyResponse(value: unknown): value is ApiKeyResponse {
	if (!value || typeof value !== "object") return false;
	return (
		"id" in value &&
		typeof value.id === "number" &&
		"platform" in value &&
		typeof value.platform === "string" &&
		"unifiedToken" in value &&
		typeof value.unifiedToken === "string"
	);
}

interface KeyUsage {
	keyId: number;
	requestsMinute: number;
	tokensMinute: number;
	requestsDay: number;
	tokensDay: number;
}

interface KeyForm {
	platform: string;
	rawKey: string;
	keyLabel: string;
	baseUrl: string;
	keyless: boolean;
}

const emptyForm: KeyForm = {
	platform: "",
	rawKey: "",
	keyLabel: "",
	baseUrl: "",
	keyless: false,
};

interface ProviderForm {
	name: string;
	id: string;
	baseUrl: string;
	rpmLimit: string;
	tpmLimit: string;
	rpdLimit: string;
	tpdLimit: string;
}

const emptyProviderForm: ProviderForm = {
	name: "",
	id: "",
	baseUrl: "",
	rpmLimit: "",
	tpmLimit: "",
	rpdLimit: "",
	tpdLimit: "",
};

/** 200000 -> "200k", 5000000 -> "5M", anything smaller stays plain. */
function formatCompact(value: number): string {
	if (value >= 1_000_000 && value % 1_000_000 === 0)
		return `${value / 1_000_000}M`;
	if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}k`;
	return value.toLocaleString();
}

function formatLimitInput(value: string): number | null {
	if (!value.trim()) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

const LIMITS_SOURCE_LABEL: Record<string, string> = {
	key: "Set for this key",
	provider: "Provider default",
	gateway: "Gateway default",
};

export default function DashboardProvidersPage() {
	const [providers, setProviders] = useState<CatalogProvider[] | null>(null);
	// Provider id/name list comes from the same /api/dashboard/catalog
	// response as the stats above — the D1 `providers` table, not a bundle.
	const providersCatalog = useMemo(
		() => (providers ?? []).map((p) => ({ id: p.id, name: p.name })),
		[providers],
	);
	const [keys, setKeys] = useState<ApiKeyResponse[] | null>(null);
	const [keysLoading, setKeysLoading] = useState(false);
	const [keyUsage, setKeyUsage] = useState<Record<number, KeyUsage>>({});
	const [form, setForm] = useState<KeyForm>({
		...emptyForm,
		platform: "google",
	});
	const [formOpen, setFormOpen] = useState(false);
	const [busyId, setBusyId] = useState<number | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [activeTab, setActiveTab] = useState<"overview" | "keys">("overview");
	const [search, setSearch] = useState("");
	const [actionError, setActionError] = useState<string | null>(null);
	const [providerForm, setProviderForm] =
		useState<ProviderForm>(emptyProviderForm);
	const [providerFormOpen, setProviderFormOpen] = useState(false);
	const [providerSubmitting, setProviderSubmitting] = useState(false);

	const loadProviders = useCallback(async (signal?: AbortSignal) => {
		try {
			const response = await fetch("/api/dashboard/catalog", {
				cache: "no-store",
				signal,
			});
			if (!response.ok) throw new Error("Could not load provider catalog.");
			const result: unknown = await response.json();
			if (!isCatalogResponse(result))
				throw new Error("Invalid catalog response.");
			if (signal?.aborted) return;
			setProviders(result.providers);
		} catch (cause) {
			if (!signal?.aborted)
				toast.add({
					title: "Error",
					description:
						cause instanceof Error
							? cause.message
							: "Could not load provider catalog.",
				});
		}
	}, []);

	const loadKeys = useCallback(async (signal?: AbortSignal) => {
		setKeysLoading(true);
		try {
			const [keysResponse, usageResponse] = await Promise.all([
				fetch("/api/keys", { cache: "no-store", signal }),
				fetch("/api/keys/usage", { cache: "no-store", signal }),
			]);
			if (!keysResponse.ok) throw new Error("Could not load provider keys.");
			const result: unknown = await keysResponse.json();
			if (
				!result ||
				typeof result !== "object" ||
				!("keys" in result) ||
				!Array.isArray(result.keys)
			)
				throw new Error("Invalid provider key response.");
			const parsedKeys = result.keys.filter(isKeyResponse);
			if (parsedKeys.length !== result.keys.length)
				throw new Error("Invalid provider key response.");
			if (!signal?.aborted) setKeys(parsedKeys);
			// Usage is a best-effort extra: keys still render without it.
			try {
				const usageResult: unknown = await usageResponse.json();
				if (
					usageResponse.ok &&
					usageResult &&
					typeof usageResult === "object" &&
					"usage" in usageResult &&
					Array.isArray(usageResult.usage)
				) {
					const map: Record<number, KeyUsage> = {};
					for (const row of usageResult.usage) {
						if (
							row &&
							typeof row === "object" &&
							"keyId" in row &&
							typeof row.keyId === "number"
						)
							map[row.keyId] = row as KeyUsage;
					}
					if (!signal?.aborted) setKeyUsage(map);
				}
			} catch {
				// Keep the keys table; usage columns fall back to zeros.
			}
		} catch (cause) {
			if (!signal?.aborted)
				toast.add({
					title: "Error",
					description:
						cause instanceof Error
							? cause.message
							: "Could not load provider keys.",
				});
		} finally {
			if (!signal?.aborted) setKeysLoading(false);
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void loadProviders(controller.signal);
		return () => controller.abort();
	}, [loadProviders]);

	useEffect(() => {
		const controller = new AbortController();
		void loadKeys(controller.signal);
		return () => controller.abort();
	}, [loadKeys]);

	const filteredKeys = useMemo(() => {
		if (!keys || !search) return keys;
		const query = search.toLowerCase();
		return keys.filter(
			(key) =>
				key.platform.toLowerCase().includes(query) ||
				(key.keyLabel?.toLowerCase() ?? "").includes(query),
		);
	}, [keys, search]);

	async function submitKey(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting) return;
		setSubmitting(true);
		setActionError(null);
		const body: Record<string, string | number | boolean> = {
			platform: form.platform,
			keyless: form.keyless,
		};
		if (!form.keyless) body.rawKey = form.rawKey;
		if (form.keyLabel.trim()) body.keyLabel = form.keyLabel.trim();
		if (form.platform === "custom" && form.baseUrl.trim())
			body.baseUrl = form.baseUrl.trim();
		try {
			const response = await fetch("/api/keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const result: unknown = await response.json().catch(() => null);
			if (!response.ok) {
				setActionError(
					apiErrorMessage(result, "Could not add the provider key."),
				);
				return;
			}
			if (
				!result ||
				typeof result !== "object" ||
				!("unifiedToken" in result) ||
				typeof result.unifiedToken !== "string"
			)
				throw new Error("Invalid provider key response.");
			toast.add({
				title: "Token created",
				description: "Copy your unified token from the table below.",
				type: "success",
			});
			setForm({ ...emptyForm, platform: providersCatalog[0]?.id ?? "google" });
			setFormOpen(false);
			await loadKeys();
		} catch (cause) {
			setActionError(
				cause instanceof Error
					? cause.message
					: "Network error. Check your connection.",
			);
		} finally {
			setSubmitting(false);
		}
	}

	async function handleDeleteKey(id: number) {
		if (!confirm("Delete this provider key? This action cannot be undone."))
			return;
		setBusyId(id);
		setActionError(null);
		try {
			const response = await fetch(`/api/keys/${id}`, { method: "DELETE" });
			if (!response.ok) throw new Error("Could not delete provider key.");
			toast.add({
				title: "Deleted",
				description: "Provider key removed.",
				type: "success",
			});
			await loadKeys();
		} catch (cause) {
			setActionError(
				cause instanceof Error ? cause.message : "Could not delete.",
			);
		} finally {
			setBusyId(null);
		}
	}

	async function handleToggleKey(id: number, enabled: boolean) {
		setBusyId(id);
		setActionError(null);
		try {
			const response = await fetch(`/api/keys/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!response.ok) throw new Error("Could not update provider key.");
			toast.add({
				title: enabled ? "Enabled" : "Disabled",
				description: "Provider key updated.",
				type: "success",
			});
			await loadKeys();
		} catch (cause) {
			setActionError(
				cause instanceof Error ? cause.message : "Could not update.",
			);
		} finally {
			setBusyId(null);
		}
	}

	async function submitProvider(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (providerSubmitting) return;
		setProviderSubmitting(true);
		setActionError(null);
		const body: Record<string, string | number> = {
			name: providerForm.name.trim(),
			id: providerForm.id.trim(),
			baseUrl: providerForm.baseUrl.trim(),
		};
		// Blank limits stay unset for the provider; keys for it fall back
		// to the gateway default.
		for (const field of [
			"rpmLimit",
			"tpmLimit",
			"rpdLimit",
			"tpdLimit",
		] as const) {
			const parsed = formatLimitInput(providerForm[field]);
			if (parsed !== null) body[field] = parsed;
		}
		try {
			const response = await fetch("/api/providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const result: unknown = await response.json().catch(() => null);
			if (!response.ok) {
				setActionError(apiErrorMessage(result, "Could not add the provider."));
				return;
			}
			toast.add({
				title: "Provider added",
				description:
					"The provider is now in the list. Add a key for it under Provider Keys.",
				type: "success",
			});
			setProviderForm(emptyProviderForm);
			setProviderFormOpen(false);
			await loadProviders();
		} catch (cause) {
			setActionError(
				cause instanceof Error
					? cause.message
					: "Network error. Check your connection.",
			);
		} finally {
			setProviderSubmitting(false);
		}
	}

	return (
		<div className="space-y-6 p-6">
			<div className="space-y-1">
				<h1 className="text-3xl font-bold tracking-tight">Providers</h1>
				<p className="text-muted-foreground">
					Manage provider API keys and view statistics.
				</p>
			</div>

			<Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
				<TabsList>
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="keys">Provider Keys</TabsTrigger>
				</TabsList>

				<TabsContent value="overview" className="mt-6">
					<div className="mb-4 flex items-center justify-end">
						<Button onClick={() => setProviderFormOpen(true)}>
							Add Provider
						</Button>
					</div>
					{providers === null ? (
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{[1, 2, 3].map((row) => (
								<div key={row} className="rounded-lg border bg-card p-4">
									<Skeleton className="h-5 w-32" />
									<Skeleton className="mt-3 h-4 w-20" />
								</div>
							))}
						</div>
					) : providers.length === 0 ? (
						<div className="rounded-lg border bg-card px-4 py-12 text-center">
							<p className="font-medium">No providers in the catalog</p>
							<p className="mt-1 text-sm text-muted-foreground">
								The provider catalog is empty. Providers appear here when they
								are added to the catalog.
							</p>
						</div>
					) : (
						<div className="overflow-x-auto rounded-lg border bg-card">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b text-left text-muted-foreground">
										<th className="px-4 py-3 font-medium">Provider</th>
										<th className="px-4 py-3 font-medium text-right">Models</th>
										<th className="px-4 py-3 font-medium text-right">
											Global keys
										</th>
										<th className="px-4 py-3 font-medium text-right">
											Personal keys
										</th>
									</tr>
								</thead>
								<tbody>
									{providers.map((provider) => (
										<tr key={provider.id} className="border-b last:border-0">
											<td className="px-4 py-3">
												<div className="font-medium">{provider.name}</div>
												<div className="text-xs text-muted-foreground">
													{provider.id}
												</div>
											</td>
											<td className="px-4 py-3 text-right tabular-nums">
												{provider.modelCount.toLocaleString()}
											</td>
											<td className="px-4 py-3 text-right tabular-nums">
												{provider.globalKeys.toLocaleString()}
											</td>
											<td className="px-4 py-3 text-right tabular-nums">
												{provider.personalKeys.toLocaleString()}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</TabsContent>

				<TabsContent value="keys" className="mt-6">
					<div className="space-y-4">
						<div className="flex items-center justify-between">
							<h2 className="text-xl font-semibold">Provider API Keys</h2>
							<Button onClick={() => setFormOpen(true)}>
								Add Provider Key
							</Button>
						</div>
						<p className="text-sm text-muted-foreground">
							Usage below is summed across all models for each key. Limits still
							apply per model.
						</p>

						<Dialog open={formOpen} onOpenChange={setFormOpen}>
							<DialogContent className="sm:max-w-lg">
								<DialogHeader>
									<DialogTitle>Add Provider API Key</DialogTitle>
									<DialogDescription>
										Enter your provider API key to enable routing through that
										provider.
									</DialogDescription>
								</DialogHeader>
								<form onSubmit={submitKey}>
									<div className="grid gap-4 py-4">
										<div className="space-y-2">
											<Label htmlFor="platform">Provider</Label>
											<Combobox
												// The items prop is what Base UI filters:
												// without it the filtered list is always
												// empty. Value is the provider id; the
												// input shows the provider name.
												items={[...providersCatalog.map((p) => p.id), "custom"]}
												value={form.platform}
												itemToStringLabel={(value) =>
													value === "custom"
														? "Custom endpoint"
														: (providersCatalog.find((p) => p.id === value)
																?.name ?? String(value))
												}
												onValueChange={(value) => {
													if (typeof value !== "string") return;
													setForm({ ...form, platform: value });
												}}
											>
												<ComboboxInput
													id="platform"
													placeholder="Select provider"
													className="w-full"
												/>
												<ComboboxContent>
													<ComboboxList>
														{(id: string) => (
															<ComboboxItem key={id} value={id}>
																{id === "custom"
																	? "Custom endpoint"
																	: (providersCatalog.find((p) => p.id === id)
																			?.name ?? id)}
															</ComboboxItem>
														)}
													</ComboboxList>
													<ComboboxEmpty>No providers found</ComboboxEmpty>
												</ComboboxContent>
											</Combobox>
										</div>
										{!form.keyless && (
											<div className="space-y-2">
												<Label htmlFor="rawKey">API Key</Label>
												<Input
													id="rawKey"
													type="password"
													value={form.rawKey}
													onChange={(e) =>
														setForm({
															...form,
															rawKey: e.target.value,
														})
													}
													placeholder="Enter your API key"
													required
												/>
											</div>
										)}
										<div className="flex items-center justify-between rounded-lg border bg-card px-3 py-2.5">
											<div>
												<label
													htmlFor="keyless"
													className="block text-sm font-medium text-foreground"
												>
													Keyless provider
												</label>
												<p className="text-xs text-muted-foreground">
													No API key required for this provider
												</p>
											</div>
											<button
												id="keyless"
												type="button"
												role="switch"
												aria-checked={form.keyless}
												onClick={() =>
													setForm({
														...form,
														keyless: !form.keyless,
														rawKey: "",
													})
												}
												className={cn(
													"relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
													form.keyless ? "bg-primary" : "bg-muted",
												)}
											>
												<span
													className={cn(
														"pointer-events-none block h-5 w-5 rounded-full bg-background shadow transition-transform",
														form.keyless ? "translate-x-5" : "translate-x-0.5",
													)}
												/>
											</button>
										</div>
										<div className="space-y-2">
											<Label htmlFor="keyLabel">Key Label (optional)</Label>
											<Input
												id="keyLabel"
												value={form.keyLabel}
												onChange={(e) =>
													setForm({
														...form,
														keyLabel: e.target.value,
													})
												}
												placeholder="e.g. Production Key"
											/>
										</div>
										{form.platform === "custom" && (
											<div className="space-y-2">
												<Label htmlFor="baseUrl">Base URL</Label>
												<Input
													id="baseUrl"
													value={form.baseUrl}
													onChange={(e) =>
														setForm({
															...form,
															baseUrl: e.target.value,
														})
													}
													placeholder="https://api.example.com/v1"
												/>
											</div>
										)}
										{actionError && (
											<p className="text-sm text-destructive">{actionError}</p>
										)}
									</div>
									<DialogFooter>
										<Button
											type="button"
											variant="outline"
											onClick={() => setFormOpen(false)}
										>
											Cancel
										</Button>
										<Button
											type="submit"
											disabled={
												submitting ||
												!form.platform ||
												(!form.keyless && !form.rawKey)
											}
										>
											{submitting ? (
												<>
													<LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
													Saving...
												</>
											) : (
												"Add Key"
											)}
										</Button>
									</DialogFooter>
								</form>
							</DialogContent>
						</Dialog>

						<Dialog open={providerFormOpen} onOpenChange={setProviderFormOpen}>
							<DialogContent className="sm:max-w-lg">
								<DialogHeader>
									<DialogTitle>Add Provider</DialogTitle>
									<DialogDescription>
										Add a provider to the catalog with its base URL and optional
										limits. Keys for it use the provider limits.
									</DialogDescription>
								</DialogHeader>
								<form onSubmit={submitProvider}>
									<div className="grid gap-4 py-4">
										<div className="space-y-2">
											<Label htmlFor="provider-name">Name</Label>
											<Input
												id="provider-name"
												value={providerForm.name}
												onChange={(e) =>
													setProviderForm({
														...providerForm,
														name: e.target.value,
													})
												}
												placeholder="Acme AI"
												required
											/>
										</div>
										<div className="space-y-2">
											<Label htmlFor="provider-id">Provider ID</Label>
											<Input
												id="provider-id"
												value={providerForm.id}
												onChange={(e) =>
													setProviderForm({
														...providerForm,
														id: e.target.value,
													})
												}
												placeholder="acme"
												required
											/>
											<p className="text-xs text-muted-foreground">
												Lowercase letters, numbers, dots, dashes and
												underscores.
											</p>
										</div>
										<div className="space-y-2">
											<Label htmlFor="provider-base-url">Base URL</Label>
											<Input
												id="provider-base-url"
												value={providerForm.baseUrl}
												onChange={(e) =>
													setProviderForm({
														...providerForm,
														baseUrl: e.target.value,
													})
												}
												placeholder="https://api.example.com/v1"
												required
											/>
										</div>
										<div className="space-y-2">
											<p className="text-sm font-medium">Limits (optional)</p>
											<p className="text-xs text-muted-foreground">
												Blank leaves the limit unset for this provider. The
												limit applies per model using a key for this provider.
											</p>
											<div className="grid grid-cols-2 gap-3">
												{(
													[
														["rpmLimit", "Requests / minute"],
														["tpmLimit", "Tokens / minute"],
														["rpdLimit", "Requests / day"],
														["tpdLimit", "Tokens / day"],
													] as const
												).map(([field, label]) => (
													<div key={field} className="space-y-1">
														<Label htmlFor={`provider-${field}`}>{label}</Label>
														<InputNumber
															id={`provider-${field}`}
															value={providerForm[field]}
															onValueChange={(value) =>
																setProviderForm({
																	...providerForm,
																	[field]: value ?? "",
																})
															}
															minValue={0}
															maxValue={10_000_000}
															placeholder="No limit"
														/>
													</div>
												))}
											</div>
										</div>
										{actionError && (
											<p className="text-sm text-destructive">{actionError}</p>
										)}
									</div>
									<DialogFooter>
										<Button
											type="button"
											variant="outline"
											onClick={() => setProviderFormOpen(false)}
										>
											Cancel
										</Button>
										<Button
											type="submit"
											disabled={
												providerSubmitting ||
												!providerForm.name.trim() ||
												!providerForm.id.trim() ||
												!providerForm.baseUrl.trim()
											}
										>
											{providerSubmitting ? (
												<>
													<LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
													Saving...
												</>
											) : (
												"Add Provider"
											)}
										</Button>
									</DialogFooter>
								</form>
							</DialogContent>
						</Dialog>

						{keys === null && keysLoading ? (
							<div className="rounded-lg border bg-card p-6">
								<Skeleton className="h-8 w-full" />
								<Skeleton className="mt-4 h-32 w-full" />
							</div>
						) : keys === null ? (
							<div className="rounded-lg border bg-card px-4 py-12 text-center">
								<p className="font-medium">No API keys yet</p>
								<p className="mt-1 text-sm text-muted-foreground">
									Add an API key to connect a provider.
								</p>
							</div>
						) : (
							<div className="rounded-lg border bg-card">
								<div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
									<div className="relative w-full sm:max-w-xs">
										<Label htmlFor="key-search" className="sr-only">
											Search API keys by provider or name
										</Label>
										<Search
											aria-hidden="true"
											className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
										/>
										<Input
											id="key-search"
											type="search"
											value={search}
											onChange={(event) => setSearch(event.target.value)}
											placeholder="Search provider or name"
											className="pl-9"
										/>
									</div>
									<p role="status" className="text-sm text-muted-foreground">
										{keysLoading
											? "Refreshing API keys…"
											: search
												? `${filteredKeys?.length ?? 0} of ${keys?.length ?? 0} keys`
												: `${keys?.length ?? 0} API ${keys?.length === 1 ? "key" : "keys"}`}
									</p>
								</div>
								{keys.length === 0 ? (
									<div className="px-4 py-12 text-center">
										<h3 className="font-medium">No API keys yet</h3>
										<p className="mt-1 text-sm text-muted-foreground">
											Add an API key to connect a provider.
										</p>
									</div>
								) : filteredKeys?.length === 0 ? (
									<div className="px-4 py-12 text-center">
										<h3 className="font-medium">No matching API keys</h3>
										<p className="mt-1 text-sm text-muted-foreground">
											Try another provider or key name.
										</p>
										<Button
											variant="outline"
											className="mt-4"
											onClick={() => setSearch("")}
										>
											Clear search
										</Button>
									</div>
								) : (
									<div className="overflow-x-auto">
										<table className="w-full min-w-[1200px] text-sm">
											<thead>
												<tr className="border-b text-left text-muted-foreground">
													<th className="px-4 py-3 font-medium">Provider</th>
													<th className="px-4 py-3 font-medium">
														Name / API key
													</th>
													<th className="px-4 py-3 font-medium">Status</th>
													<th className="px-4 py-3 font-medium">Limits</th>
													<th className="px-4 py-3 font-medium">Usage</th>
													<th className="px-4 py-3 font-medium">
														Last health check
													</th>
													<th className="px-4 py-3 font-medium">
														<span className="sr-only">Actions</span>
													</th>
												</tr>
											</thead>
											<tbody>
												{filteredKeys?.map((key) => {
													const name = key.keyLabel || "Unnamed key";
													return (
														<tr key={key.id} className="border-b last:border-0">
															<td className="px-4 py-4 align-top">
																<div className="max-w-48 break-words font-medium">
																	{providersCatalog.find(
																		(provider) => provider.id === key.platform,
																	)?.name ?? key.platform}
																</div>
																<div className="mt-1 max-w-48 break-words text-xs text-muted-foreground">
																	{key.platform}
																</div>
															</td>
															<td className="px-4 py-4 align-top">
																<div className="max-w-56 break-words font-medium">
																	{name}
																</div>
																<code className="mt-1 block text-xs text-muted-foreground">
																	{key.maskedKey || "••••••••"}
																</code>
															</td>
															<td className="px-4 py-4 align-top">
																<span
																	className={cn(
																		"inline-flex rounded-md px-2 py-1 text-xs font-medium",
																		key.enabled
																			? "bg-primary/10 text-primary"
																			: "bg-muted text-muted-foreground",
																	)}
																>
																	{key.enabled ? "Enabled" : "Disabled"}
																</span>
																{busyId === key.id ? (
																	<span
																		role="status"
																		className="mt-1 block text-xs text-muted-foreground"
																	>
																		Updating…
																	</span>
																) : null}
															</td>
															<td className="px-4 py-4 align-top">
																{key.effectiveLimits ? (
																	<>
																		<div className="whitespace-nowrap tabular-nums">
																			{formatCompact(key.effectiveLimits.rpm)}
																			/min ·{" "}
																			{formatCompact(key.effectiveLimits.tpm)}
																			/min
																		</div>
																		<div className="mt-1 whitespace-nowrap tabular-nums">
																			{formatCompact(key.effectiveLimits.rpd)}
																			/day ·{" "}
																			{formatCompact(key.effectiveLimits.tpd)}
																			/day
																		</div>
																		<div className="mt-1 text-xs text-muted-foreground">
																			{key.limitsSource
																				? LIMITS_SOURCE_LABEL[key.limitsSource]
																				: "—"}
																		</div>
																	</>
																) : (
																	<span className="text-muted-foreground">
																		—
																	</span>
																)}
															</td>
															<td className="px-4 py-4 align-top">
																{(() => {
																	const usage = keyUsage[key.id];
																	if (!usage)
																		return (
																			<span className="text-muted-foreground">
																				—
																			</span>
																		);
																	if (
																		usage.requestsMinute === 0 &&
																		usage.tokensMinute === 0 &&
																		usage.requestsDay === 0 &&
																		usage.tokensDay === 0
																	)
																		return (
																			<span className="text-muted-foreground">
																				No usage yet
																			</span>
																		);
																	return (
																		<>
																			<div className="whitespace-nowrap tabular-nums">
																				Last minute:{" "}
																				{usage.requestsMinute.toLocaleString()}{" "}
																				req ·{" "}
																				{formatCompact(usage.tokensMinute)} tok
																			</div>
																			<div className="mt-1 whitespace-nowrap tabular-nums">
																				Today:{" "}
																				{usage.requestsDay.toLocaleString()} req
																				· {formatCompact(usage.tokensDay)} tok
																			</div>
																		</>
																	);
																})()}
															</td>
															<td className="px-4 py-4 align-top">
																{key.lastHealthCheckAt ? (
																	<time
																		dateTime={key.lastHealthCheckAt}
																		className="whitespace-nowrap"
																	>
																		{new Date(
																			key.lastHealthCheckAt,
																		).toLocaleString()}
																	</time>
																) : (
																	<span className="text-muted-foreground">
																		Not checked
																	</span>
																)}
																{key.lastHealthCheckStatus ? (
																	<div
																		className={cn(
																			"mt-1 text-xs",
																			key.lastHealthCheckStatus === "healthy"
																				? "text-primary"
																				: "text-muted-foreground",
																		)}
																	>
																		{key.lastHealthCheckStatus.replaceAll(
																			"_",
																			" ",
																		)}
																	</div>
																) : null}
															</td>
															<td className="px-4 py-3 text-right align-top">
																<DropdownMenu>
																	<DropdownMenuTrigger
																		disabled={busyId !== null || submitting}
																	>
																		<Button variant="ghost" size="icon">
																			<MoreVertical
																				aria-hidden="true"
																				className="h-4 w-4"
																			/>
																		</Button>
																	</DropdownMenuTrigger>
																	<DropdownMenuContent align="end">
																		<DropdownMenuItem
																			onClick={() =>
																				void handleToggleKey(
																					key.id,
																					!key.enabled,
																				)
																			}
																		>
																			{key.enabled
																				? "Disable API key"
																				: "Enable API key"}
																		</DropdownMenuItem>
																		<DropdownMenuItem
																			onClick={() =>
																				void handleDeleteKey(key.id)
																			}
																			variant="destructive"
																		>
																			<Trash2
																				aria-hidden="true"
																				className="h-4 w-4"
																			/>
																			Delete API key
																		</DropdownMenuItem>
																	</DropdownMenuContent>
																</DropdownMenu>
															</td>
														</tr>
													);
												})}
											</tbody>
										</table>
									</div>
								)}
							</div>
						)}
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);
}
