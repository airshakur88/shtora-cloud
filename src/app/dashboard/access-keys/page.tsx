"use client";

import { Copy, LoaderCircle, MoreVertical, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
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
import { toast } from "@/components/ui/toast";

interface AccessKeyResponse {
	id: number;
	name: string;
	enabled: boolean;
	createdAt: string;
	lastUsedAt: string | null;
	expiresAt: string | null;
	keyPrefix: string;
}

interface CreateAccessKeyResult extends AccessKeyResponse {
	apiKey: string;
}

const emptyForm = { name: "", expiresInDays: null as number | null };

export default function DashboardAccessKeysPage() {
	const [keys, setKeys] = useState<AccessKeyResponse[] | null>(null);
	const [form, setForm] = useState({ ...emptyForm });
	const [formOpen, setFormOpen] = useState(false);
	const [busyId, setBusyId] = useState<number | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [newKeyModal, setNewKeyModal] = useState<{
		open: boolean;
		apiKey: string;
	}>({ open: false, apiKey: "" });

	const loadKeys = useCallback(async (signal?: AbortSignal) => {
		try {
			const response = await fetch("/api/access-keys", {
				cache: "no-store",
				signal,
			});
			if (!response.ok) throw new Error("Could not load access keys.");
			const result: unknown = await response.json();
			if (
				!result ||
				typeof result !== "object" ||
				!("keys" in result) ||
				!Array.isArray(result.keys)
			)
				throw new Error("Invalid access key response.");
			if (!signal?.aborted) setKeys(result.keys as AccessKeyResponse[]);
		} catch (cause) {
			if (!signal?.aborted)
				toast.add({
					title: "Error",
					description:
						cause instanceof Error
							? cause.message
							: "Could not load access keys.",
				});
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void loadKeys(controller.signal);
		return () => controller.abort();
	}, [loadKeys]);

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting) return;
		setSubmitting(true);
		try {
			const response = await fetch("/api/access-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: form.name.trim(),
					expiresInDays: form.expiresInDays,
				}),
			});
			const result: unknown = await response.json().catch(() => null);
			if (!response.ok) {
				const msg =
					result &&
					typeof result === "object" &&
					"error" in result &&
					typeof result.error === "object" &&
					result.error &&
					"message" in result.error
						? String(result.error.message)
						: "Could not create access key.";
				toast.add({ title: "Error", description: msg, type: "error" });
				return;
			}
			if (
				!result ||
				typeof result !== "object" ||
				!("accessKey" in result) ||
				typeof result.accessKey !== "object"
			) {
				throw new Error("Invalid access key response.");
			}
			const created = result.accessKey as CreateAccessKeyResult;
			toast.add({
				title: "Access key created",
				description: "Copy your API key now. It won't be shown again.",
				type: "success",
			});
			setNewKeyModal({ open: true, apiKey: created.apiKey });
			setForm({ ...emptyForm });
			setFormOpen(false);
			await loadKeys();
		} catch (cause) {
			toast.add({
				title: "Error",
				description:
					cause instanceof Error
						? cause.message
						: "Network error. Check your connection.",
			});
		} finally {
			setSubmitting(false);
		}
	}

	async function handleDelete(id: number) {
		setBusyId(id);
		try {
			const response = await fetch(`/api/access-keys/${id}`, {
				method: "DELETE",
			});
			if (!response.ok) throw new Error("Could not delete access key.");
			toast.add({
				title: "Deleted",
				description: "Access key removed.",
				type: "success",
			});
			await loadKeys();
		} catch (cause) {
			toast.add({
				title: "Error",
				description:
					cause instanceof Error ? cause.message : "Could not delete.",
				type: "error",
			});
		} finally {
			setBusyId(null);
		}
	}

	function confirmDelete() {
		const id = deleteTarget;
		setDeleteTarget(null);
		if (id !== null) void handleDelete(id);
	}

	async function handleToggle(id: number, enabled: boolean) {
		setBusyId(id);
		try {
			const response = await fetch(`/api/access-keys/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!response.ok) throw new Error("Could not update access key.");
			toast.add({
				title: enabled ? "Enabled" : "Disabled",
				description: "Access key updated.",
				type: "success",
			});
			await loadKeys();
		} catch (cause) {
			toast.add({
				title: "Error",
				description:
					cause instanceof Error ? cause.message : "Could not update.",
				type: "error",
			});
		} finally {
			setBusyId(null);
		}
	}

	function copyToClipboard(text: string) {
		navigator.clipboard.writeText(text);
		toast.add({
			title: "Copied",
			description: "API key copied to clipboard.",
			type: "success",
		});
	}

	function formatDate(dateStr: string): string {
		const date = new Date(dateStr);
		return date.toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	}

	if (keys === null) {
		return (
			<div className="space-y-6 p-6">
				<div className="flex items-center justify-between">
					<h1 className="text-2xl font-bold">Access Keys</h1>
					<Button onClick={() => setFormOpen(true)}>New Access Key</Button>
				</div>
				<div className="space-y-4">
					{[
						"access-key-skeleton-1",
						"access-key-skeleton-2",
						"access-key-skeleton-3",
					].map((id) => (
						<div key={id} className="rounded-lg border bg-card p-6">
							<Skeleton className="h-6 w-48" />
							<Skeleton className="mt-4 h-4 w-64" />
						</div>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6 p-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">Access Keys</h1>
				<Button onClick={() => setFormOpen(true)}>New Access Key</Button>
			</div>

			<Dialog open={formOpen} onOpenChange={setFormOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Create Access Key</DialogTitle>
						<DialogDescription>
							Give your key a name and optional expiration. The full key will
							only be shown once.
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={submit}>
						<div className="grid gap-4 py-4">
							<div className="space-y-2">
								<Label htmlFor="name">Name</Label>
								<Input
									id="name"
									value={form.name}
									onChange={(e) => setForm({ ...form, name: e.target.value })}
									placeholder="e.g. Production API"
									required
									maxLength={100}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="expiresInDays">
									Expires in (days, optional)
								</Label>
								<InputNumber
									id="expiresInDays"
									minValue={1}
									maxValue={3650}
									value={form.expiresInDays ?? ""}
									onValueChange={(val) =>
										setForm({
											...form,
											expiresInDays: val ? Number(val) : null,
										})
									}
									placeholder="Leave empty for no expiration"
								/>
							</div>
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setFormOpen(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={submitting || !form.name.trim()}>
								{submitting ? (
									<LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
								) : null}
								Create
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog
				open={newKeyModal.open}
				onOpenChange={() => setNewKeyModal({ ...newKeyModal, open: false })}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Your New Access Key</DialogTitle>
						<DialogDescription>
							Copy this key now. It will never be shown again.
						</DialogDescription>
					</DialogHeader>
					<div className="py-4">
						<div className="flex gap-2">
							<Input
								readOnly
								value={newKeyModal.apiKey}
								className="flex-1 font-mono text-sm"
							/>
							<Button
								variant="outline"
								size="icon"
								onClick={() => copyToClipboard(newKeyModal.apiKey)}
							>
								<Copy className="h-4 w-4" />
							</Button>
						</div>
						<p className="mt-2 text-sm text-muted-foreground">
							Store this key securely. It provides access to your models via the
							API.
						</p>
					</div>
					<DialogFooter>
						<Button
							onClick={() => setNewKeyModal({ ...newKeyModal, open: false })}
						>
							Done
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{keys.length === 0 ? (
				<div className="rounded-lg border bg-card p-12 text-center">
					<p className="text-muted-foreground mb-4">No access keys yet.</p>
					<Button onClick={() => setFormOpen(true)}>
						Create your first key
					</Button>
				</div>
			) : (
				<div className="space-y-4">
					{keys.map((key) => (
						<div
							key={key.id}
							className="rounded-lg border bg-card p-4 flex items-center justify-between gap-4"
						>
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-3">
									<h3 className="font-medium truncate">{key.name}</h3>
									<span
										className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${key.enabled ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"}`}
									>
										{key.enabled ? "Active" : "Disabled"}
									</span>
								</div>
								<div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
									<span>
										Prefix:{" "}
										<code className="font-mono">{key.keyPrefix}...</code>
									</span>
									<span>Created: {formatDate(key.createdAt)}</span>
									{key.lastUsedAt && (
										<span>Last used: {formatDate(key.lastUsedAt)}</span>
									)}
									{key.expiresAt && (
										<span>Expires: {formatDate(key.expiresAt)}</span>
									)}
								</div>
							</div>
							<div className="flex items-center gap-2 shrink-0">
								<DropdownMenu>
									<DropdownMenuTrigger>
										<Button variant="ghost" size="icon">
											<MoreVertical className="h-4 w-4" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem
											onClick={() => handleToggle(key.id, !key.enabled)}
											disabled={busyId === key.id}
										>
											{key.enabled ? "Disable" : "Enable"}
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => setDeleteTarget(key.id)}
											disabled={busyId === key.id}
											className="text-destructive focus:text-destructive"
										>
											<Trash2 className="mr-2 h-4 w-4" />
											Delete
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</div>
					))}
				</div>
			)}
			<ConfirmDialog
				open={deleteTarget !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteTarget(null);
				}}
				title="Delete access key?"
				description="This action cannot be undone."
				onConfirm={confirmDelete}
			/>
		</div>
	);
}
