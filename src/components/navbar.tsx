"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SessionUser {
	name: string | null;
	username: string;
}

export function Navbar() {
	const [user, setUser] = useState<SessionUser | null>(null);
	const router = useRouter();

	useEffect(() => {
		const controller = new AbortController();

		async function loadSession() {
			try {
				const response = await fetch("/api/auth/session", {
					signal: controller.signal,
				});
				if (!response.ok) return;
				const session = (await response.json()) as { user: SessionUser | null };
				setUser(session.user);
			} catch (cause) {
				if (!controller.signal.aborted) {
					console.error("Session request failed", cause);
				}
			}
		}

		void loadSession();
		return () => controller.abort();
	}, []);

	async function logout() {
		try {
			const response = await fetch("/api/auth/logout", { method: "DELETE" });
			if (!response.ok) throw new Error("Logout request failed");
		} catch (cause) {
			console.error("Logout request failed", cause);
		} finally {
			router.replace("/login");
			router.refresh();
		}
	}

	const displayName = user?.name || user?.username || "";

	return (
		<header className="flex items-center justify-between border-b border-border pb-5">
			<Link href="/" className="font-semibold tracking-tight text-foreground">
				Shtora Cloud
			</Link>
			{user ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								className="flex items-center gap-2 px-2"
							/>
						}
					>
						<Avatar className="h-8 w-8">
							<AvatarFallback>
								{displayName.slice(0, 2).toUpperCase()}
							</AvatarFallback>
						</Avatar>
						<ChevronDown className="h-4 w-4 text-muted-foreground" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem render={<Link href="/dashboard" />}>
							Dashboard
						</DropdownMenuItem>
						<DropdownMenuItem render={<Link href="/dashboard/keys" />}>
							API Keys
						</DropdownMenuItem>
						<DropdownMenuItem render={<Link href="/dashboard/providers" />}>
							Providers
						</DropdownMenuItem>
						<DropdownMenuItem render={<Link href="/dashboard/models" />}>
							Models
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={() => void logout()}>
							Log out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			) : (
				<nav className="flex items-center gap-5 text-sm">
					<Link
						href="/login"
						className="text-muted-foreground hover:text-foreground"
					>
						Sign in
					</Link>
					<Link
						href="/register"
						className="font-medium text-primary hover:text-accent-foreground"
					>
						Create account
					</Link>
				</nav>
			)}
		</header>
	);
}
