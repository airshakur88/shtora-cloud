import { routeError } from "@/lib/api-error";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { listApiKeys } from "@/lib/key-store";
import { listQuarantined } from "@/lib/quarantine";
import { requireUser } from "@/lib/session";

/**
 * GET /api/quarantine — the caller's own active quarantines. The table is
 * global per (platform, model, key), so rows are filtered to keys the
 * caller owns; a community key owned by someone else never appears here,
 * not even masked.
 */
export async function GET(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		const db = getDb();
		const ownKeys = await listApiKeys(db, user.id, getEncryptionSecret());
		const maskedById = new Map(ownKeys.map((key) => [key.id, key.maskedKey]));
		const rows = await listQuarantined(db);
		return Response.json({
			quarantines: rows
				.filter((row) => maskedById.has(row.keyId))
				.map((row) => ({
					id: row.id,
					platform: row.platform,
					modelId: row.modelId,
					keyId: row.keyId,
					keyLabel: row.keyLabel,
					maskedKey: maskedById.get(row.keyId) ?? null,
					failureCount: row.failureCount,
					cooldownUntilMs: row.cooldownUntilMs,
					expiresAt: new Date(row.cooldownUntilMs).toISOString(),
					reason: row.reason,
					source: row.source,
				})),
		});
	} catch (error) {
		return routeError(error, "/api/quarantine");
	}
}
