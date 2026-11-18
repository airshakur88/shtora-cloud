"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";

interface AdminUser {
	id: string;
	name: string;
	username: string;
	role: "user" | "admin";
	createdAt: string;
	keyCount: number;
}

function isAdminUser(value: unknown): value is AdminUser {
	if (!value || typeof value !== "object") return false;
	return (
		"id" in value &&
		typeof value.id === "string" &&
		"name" in value &&
		typeof value.name === "string" &&
		"username" in value &&
		typeof value.username === "string" &&
		"role" in value &&
		(value.role === "user" || value.role === "admin") &&
		"createdAt" in value &&
		typeof value.createdAt === "string" &&
		"keyCount" in value &&
		typeof value.keyCount === "number"
	);
}

export default function AdminUsersPage() {
	const [users, setUsers] = useState<AdminUser[] | null>(null);
	const [busyUser, setBusyUser] = useState<string | null>(null);

	const loadUsers = useCallback(async (signal?: AbortSignal) => {
		try {
			const response = await fetch("/api/admin/users", {
				cache: "no-store",
				signal,
			});
			if (!response.ok) throw new Error("Could not load users.");
			const result: unknown = await response.json();
			if (
				!result ||
				typeof result !== "object" ||
				!("users" in result) ||
				!Array.isArray(result.users)
			)
				throw new Error("Invalid user list response.");
			const parsedUsers = result.users.filter(isAdminUser);
			if (parsedUsers.length !== result.users.length)
				throw new Error("Invalid user list response.");
			if (!signal?.aborted) setUsers(parsedUsers);
		} catch (cause) {
			if (!signal?.aborted)
				toast.add({
					title: "Error",
					description:
						cause instanceof Error ? cause.message : "Could not load users.",
					type: "error",
				});
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void loadUsers(controller.signal);
		return () => controller.abort();
	}, [loadUsers]);

	async function changeRole(user: AdminUser) {
		if (busyUser !== null) return;
		setBusyUser(user.id);
		try {
			const response = await fetch(`/api/admin/users/${user.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					role: user.role === "admin" ? "user" : "admin",
				}),
			});
			if (!response.ok) throw new Error("Could not update user role.");
			await loadUsers();
		} catch (cause) {
			toast.add({
				title: "Error",
				description:
					cause instanceof Error
						? cause.message
						: "Could not update user role.",
				type: "error",
			});
		} finally {
			setBusyUser(null);
		}
	}

	return (
		<div className="space-y-6 p-6">
			<header>
				<h1 className="text-3xl font-bold tracking-tight">Users</h1>
				<p className="mt-1 text-muted-foreground">
					Manage registered accounts and administrator access.
				</p>
			</header>
			{users === null ? (
				<p role="status" className="text-sm text-muted-foreground">
					Loading users…
				</p>
			) : users.length === 0 ? (
				<div className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
					No users found.
				</div>
			) : (
				<div className="overflow-x-auto rounded-lg border bg-card">
					<div className="border-b px-4 py-3 text-sm text-muted-foreground">
						{users.length} user{users.length === 1 ? "" : "s"}
					</div>
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b text-left text-muted-foreground">
								<th className="px-4 py-3 font-medium">Name</th>
								<th className="px-4 py-3 font-medium">Username</th>
								<th className="px-4 py-3 font-medium">Role</th>
								<th className="px-4 py-3 text-right font-medium">Keys</th>
								<th className="px-4 py-3 font-medium">Joined</th>
								<th className="px-4 py-3 text-right font-medium">Actions</th>
							</tr>
						</thead>
						<tbody>
							{users.map((user) => (
								<tr key={user.id} className="border-b last:border-0">
									<td className="px-4 py-3 font-medium">
										{user.name || user.username}
									</td>
									<td className="px-4 py-3 text-muted-foreground">
										{user.username}
									</td>
									<td className="px-4 py-3">
										<Badge
											variant={user.role === "admin" ? "default" : "secondary"}
										>
											{user.role}
										</Badge>
									</td>
									<td className="px-4 py-3 text-right tabular-nums">
										{user.keyCount}
									</td>
									<td className="px-4 py-3 text-muted-foreground">
										{user.createdAt
											? new Date(user.createdAt).toLocaleDateString()
											: "—"}
									</td>
									<td className="px-4 py-3 text-right">
										<button
											type="button"
											className="text-sm underline disabled:opacity-50"
											disabled={busyUser !== null}
											onClick={() => void changeRole(user)}
										>
											{busyUser === user.id
												? "Saving…"
												: user.role === "admin"
													? "Demote"
													: "Promote"}
										</button>
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
