import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import { requireAdmin } from "@/lib/session";

interface KeyRow {
	id: number;
	platform: string;
	key_label: string | null;
	username: string;
	enabled: number;
	last_health_check_status: string | null;
	last_health_check_at: string | null;
	unified_token: string;
}

export async function GET(request: Request): Promise<Response> {
	try {
		await requireAdmin(request);
		const result = await getDb()
			.prepare(
				`SELECT k.id, k.platform, k.key_label, u.username, k.enabled,
				 k.last_health_check_status, k.last_health_check_at, k.unified_token
				 FROM api_keys k JOIN user u ON k.user_id = u.id ORDER BY k.platform, k.id`,
			)
			.all<KeyRow>();
		return Response.json({
			keys: result.results.map((row) => ({
				id: row.id,
				platform: row.platform,
				keyLabel: row.key_label,
				ownerUsername: row.username,
				enabled: row.enabled === 1,
				lastHealthCheckStatus: row.last_health_check_status,
				lastHealthCheckAt: row.last_health_check_at,
				unifiedTokenMasked:
					row.unified_token.length > 4
						? `flmr-…${row.unified_token.slice(-4)}`
						: "flmr-…",
			})),
		});
	} catch (error) {
		return routeError(error, "/api/admin/keys");
	}
}
