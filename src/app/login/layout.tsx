import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentSessionUser } from "@/lib/server-session";

export default async function LoginLayout({
	children,
}: {
	children: ReactNode;
}) {
	const user = await getCurrentSessionUser();
	if (user) redirect("/dashboard");
	return <>{children}</>;
}
