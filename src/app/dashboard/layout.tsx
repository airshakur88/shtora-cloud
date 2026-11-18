import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentSessionUser } from "@/lib/session";
import { DashboardShell } from "./dashboard-shell";

export default async function DashboardLayout({
	children,
}: {
	children: ReactNode;
}) {
	const user = await getCurrentSessionUser();
	if (!user) redirect("/login");
	return <DashboardShell user={user}>{children}</DashboardShell>;
}
