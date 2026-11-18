"use client";

import {
	BarChart3,
	Home,
	Key,
	LogOut,
	Scissors,
	Shield,
	Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarRail,
} from "@/components/ui/sidebar";
import type { SessionUser } from "@/lib/server-session";

const items = [
	{ title: "Overview", url: "/admin", icon: Home },
	{ title: "Statistics", url: "/admin/stats", icon: BarChart3 },
	{ title: "Users", url: "/admin/users", icon: Users },
	{ title: "API Keys", url: "/admin/keys", icon: Key },
	{ title: "Quarantine", url: "/admin/quarantine", icon: Scissors },
];

export function AdminShell({
	children,
	user,
}: {
	children: ReactNode;
	user: SessionUser;
}) {
	const pathname = usePathname();
	const router = useRouter();
	const displayName = user.name || user.username;

	async function logout() {
		try {
			const response = await fetch("/api/auth/logout", { method: "POST" });
			if (!response.ok) throw new Error("Logout request failed");
		} catch (cause) {
			console.error("Logout request failed", cause);
		} finally {
			router.replace("/login");
			router.refresh();
		}
	}

	return (
		<SidebarProvider className="flex min-h-screen bg-background">
			<Sidebar>
				<SidebarHeader>
					<div className="flex items-center gap-2 px-4 py-2">
						<Shield className="h-6 w-6 text-primary" />
						<span className="font-semibold">Shtora Admin</span>
					</div>
				</SidebarHeader>
				<SidebarRail />
				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupLabel>Administration</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{items.map(({ title, url, icon: Icon }) => (
									<SidebarMenuItem key={url}>
										<SidebarMenuButton
											render={<Link href={url} />}
											isActive={pathname === url}
										>
											<Icon className="h-4 w-4" />
											<span>{title}</span>
										</SidebarMenuButton>
									</SidebarMenuItem>
								))}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
				<SidebarFooter>
					<SidebarMenu>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										className="flex h-8 w-full items-center gap-2 px-2 py-1.5"
									/>
								}
							>
								<Avatar className="h-8 w-8">
									<AvatarFallback>
										{displayName.slice(0, 2).toUpperCase()}
									</AvatarFallback>
								</Avatar>
								<span className="flex-1 truncate text-left text-sm font-medium">
									{displayName}
								</span>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuGroup>
									<DropdownMenuLabel>{user.username}</DropdownMenuLabel>
									<DropdownMenuSeparator />
									<DropdownMenuItem onClick={() => void logout()}>
										<LogOut className="mr-2 h-4 w-4" />
										Log out
									</DropdownMenuItem>
								</DropdownMenuGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					</SidebarMenu>
				</SidebarFooter>
			</Sidebar>
			<main className="flex-1">{children}</main>
		</SidebarProvider>
	);
}
