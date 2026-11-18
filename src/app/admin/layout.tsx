import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentSessionUser } from "@/lib/server-session";
import { AdminShell } from "./admin-shell";

export default async function AdminLayout({
	children,
}: {
	children: ReactNode;
}) {
	const user = await getCurrentSessionUser();
	if (!user) redirect("/login");
	if (user.role !== "admin") redirect("/dashboard");
	return <AdminShell user={user}>{children}</AdminShell>;
}
