import { headers } from "next/headers";
import { getSessionUser } from "@/lib/session";

export interface SessionUser {
	id: string;
	name: string | null;
	username: string;
	role: "user" | "admin";
	createdAt: string;
	updatedAt: string;
}

export async function getCurrentSessionUser(): Promise<SessionUser | null> {
	const requestHeaders = await headers();
	const request = new Request("http://internal", {
		headers: { cookie: requestHeaders.get("cookie") ?? "" },
	});
	const user = await getSessionUser(request);
	if (!user) return null;

	return {
		id: user.id,
		name: user.name || null,
		username: user.username,
		role: user.role,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
	};
}
