import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import { releaseQuarantine } from "@/lib/quarantine";
import { requireUser } from "@/lib/session";

interface QuarantineLookupRow {
	id: number;
	platform: string;
	model_id: string;
	key_id: number;
}

/**
 * POST /api/quarantine/[id]/release — clears the cooldown for one of the
 * caller's own quarantines. A row whose key belongs to another user
 * answers 404, the same as a missing row, so ownership cannot be probed.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	try {
		const user = await requireUser(request);
		const { id } = await params;
		const quarantineId = Number.parseInt(id, 10);
		if (!Number.isSafeInteger(quarantineId) || quarantineId <= 0) {
			return Response.json(
				{
					error: {
						message: "Invalid quarantine id",
						type: "validation_error",
					},
				},
				{ status: 400 },
			);
		}
		const db = getDb();
		const row = await db
			.prepare(
				"SELECT id, platform, model_id, key_id FROM provider_rate_limit_cooldowns WHERE id = ?",
			)
			.bind(quarantineId)
			.first<QuarantineLookupRow>();
		if (!row) {
			return Response.json(
				{ error: { message: "Not found", type: "not_found" } },
				{ status: 404 },
			);
		}
		const owner = await db
			.prepare("SELECT user_id FROM api_keys WHERE id = ?")
			.bind(row.key_id)
			.first<{ user_id: string }>();
		if (!owner || owner.user_id !== user.id) {
			return Response.json(
				{ error: { message: "Not found", type: "not_found" } },
				{ status: 404 },
			);
		}
		await releaseQuarantine(db, {
			platform: row.platform,
			modelId: row.model_id,
			keyId: row.key_id,
		});
		return Response.json({ released: true });
	} catch (error) {
		return routeError(error, "/api/quarantine/[id]/release");
	}
}
