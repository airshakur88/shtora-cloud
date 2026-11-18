import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentSessionUser } from "@/lib/session";

export default async function RegisterLayout({
	children,
}: {
	children: ReactNode;
}) {
	const user = await getCurrentSessionUser();
	if (user) redirect("/dashboard");
	return <>{children}</>;
}
