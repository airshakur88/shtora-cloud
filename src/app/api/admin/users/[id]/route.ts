import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import { requireAdmin } from "@/lib/session";
import type { UserRole } from "@/lib/types";

interface UserRow {
	id: string;
	name: string;
	username: string;
	role: string;
	created_at: string;
}

export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	try {
		await requireAdmin(request);
		const { id } = await params;
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json(
				{ error: { message: "Invalid request", type: "validation_error" } },
				{ status: 400 },
			);
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return Response.json(
				{ error: { message: "Invalid request", type: "validation_error" } },
				{ status: 400 },
			);
		}
		const roleValue = (body as Record<string, unknown>).role;
		if (roleValue !== "user" && roleValue !== "admin") {
			return Response.json(
				{ error: { message: "Invalid role", type: "validation_error" } },
				{ status: 400 },
			);
		}
		const role: UserRole = roleValue;
		const db = getDb();
		const updated = (
			await db
				.prepare(
					"UPDATE user SET role = ?, updated_at = datetime('now') WHERE id = ? RETURNING id",
				)
				.bind(role, id)
				.all<{ id: string }>()
		).results[0];
		if (!updated) {
			return Response.json(
				{ error: { message: "User not found", type: "not_found" } },
				{ status: 404 },
			);
		}
		const user = await db
			.prepare(
				"SELECT id, name, username, role, created_at FROM user WHERE id = ?",
			)
			.bind(id)
			.first<UserRow>();
		if (!user)
			return Response.json(
				{ error: { message: "User not found", type: "not_found" } },
				{ status: 404 },
			);
		return Response.json({
			user: {
				id: user.id,
				name: user.name,
				username: user.username,
				role: user.role,
				createdAt: user.created_at,
			},
		});
	} catch (error) {
		return routeError(error, "/api/admin/users/[id]");
	}
}
