"use client";

import {
	Boxes,
	Home,
	KeyRound,
	LogOut,
	MessageSquare,
	Network,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
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
import type { SessionUser } from "@/lib/session";

const sidebarItems = [
	{ title: "Overview", url: "/dashboard", icon: Home },
	{ title: "Access Keys", url: "/dashboard/access-keys", icon: KeyRound },
	{ title: "Providers", url: "/dashboard/providers", icon: Network },
	{ title: "Models", url: "/dashboard/models", icon: Boxes },
	{ title: "Playground", url: "/dashboard/playground", icon: MessageSquare },
];

export function DashboardShell({
	children,
	user,
}: {
	children: ReactNode;
	user: SessionUser;
}) {
	const pathname = usePathname();
	const router = useRouter();
	const displayName = user.name || user.username;
	const initials = displayName.slice(0, 2).toUpperCase();

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
			<Sidebar collapsible="icon">
				<SidebarHeader>
					<Link
						href="/dashboard"
						className="flex items-center gap-2.5 px-2 py-1 text-[17px] font-semibold tracking-tight"
						aria-label="Shtora Cloud, painel"
					>
						<Logo decorative className="size-8 shrink-0" />
						<span className="text-[22px] leading-8 font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
							SHTORA<span className="text-primary">.</span>cloud
						</span>
					</Link>
				</SidebarHeader>
				<SidebarRail />
				<SidebarContent className="flex flex-col">
					<SidebarGroup>
						<SidebarGroupLabel>Dashboard</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{sidebarItems.map((item) => (
									<SidebarMenuItem key={item.url}>
										<SidebarMenuButton
											render={<Link href={item.url} />}
											isActive={
												pathname === item.url ||
												pathname.startsWith(`${item.url}/`)
											}
										>
											{item.icon ? (
												<>
													<item.icon
														className="h-4 w-4 shrink-0"
														aria-hidden="true"
													/>
													<span>{item.title}</span>
												</>
											) : (
												<span>{item.title}</span>
											)}
										</SidebarMenuButton>
									</SidebarMenuItem>
								))}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
					<SidebarFooter className="mt-auto border-t pt-4">
						<SidebarGroup>
							<SidebarGroupContent>
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												variant="ghost"
												className="h-auto w-full justify-start gap-2 px-2 py-1.5"
											/>
										}
									>
										<Avatar className="h-8 w-8">
											<AvatarFallback>{initials}</AvatarFallback>
										</Avatar>
										<div className="flex flex-col items-start">
											<span className="text-sm font-medium truncate">
												{displayName}
											</span>
											<span className="text-xs text-muted-foreground truncate">
												{user.username}
											</span>
										</div>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-48">
										<DropdownMenuGroup>
											<DropdownMenuLabel className="font-normal">
												Account
											</DropdownMenuLabel>
											<DropdownMenuSeparator />
											<DropdownMenuItem onClick={logout}>
												<LogOut className="h-4 w-4 mr-2" />
												Logout
											</DropdownMenuItem>
										</DropdownMenuGroup>
									</DropdownMenuContent>
								</DropdownMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					</SidebarFooter>
				</SidebarContent>
			</Sidebar>
			<main className="min-w-0 flex-1">{children}</main>
		</SidebarProvider>
	);
}
