import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import { requireAdmin } from "@/lib/session";

interface UserRow {
	id: string;
	name: string;
	username: string;
	role: string;
	created_at: string;
	key_count: number;
}

export async function GET(request: Request): Promise<Response> {
	try {
		await requireAdmin(request);
		const rows = await getDb()
			.prepare(
				`SELECT u.id, u.name, u.username, u.role, u.created_at,
				 (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS key_count
				 FROM user u ORDER BY u.created_at DESC`,
			)
			.all<UserRow>();
		return Response.json({
			users: rows.results.map((row) => ({
				id: row.id,
				name: row.name,
				username: row.username,
				role: row.role,
				createdAt: row.created_at,
				keyCount: row.key_count,
			})),
		});
	} catch (error) {
		return routeError(error, "/api/admin/users");
	}
}
