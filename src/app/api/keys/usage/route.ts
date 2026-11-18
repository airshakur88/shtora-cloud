import { routeError } from "@/lib/api-error";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { getKeyUsageWindows } from "@/lib/key-limits";
import { listApiKeys } from "@/lib/key-store";
import { requireUser } from "@/lib/session";

/**
 * Current usage of the user's own keys in the rate-limit windows: the last
 * 60 seconds and today (UTC), from provider_rate_limit_usage. A key's rows
 * count every request it served, including requests from other users
 * borrowing it from the community pool, because that is what spends its
 * quota. Keys with no rows are returned as zeros.
 */
export async function GET(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		const db = getDb();
		const keys = await listApiKeys(db, user.id, getEncryptionSecret());
		const windows = await getKeyUsageWindows(
			db,
			keys.map((key) => key.id),
		);
		const byKey = new Map(windows.map((row) => [row.keyId, row]));
		return Response.json({
			usage: keys.map((key) => ({
				keyId: key.id,
				requestsMinute: byKey.get(key.id)?.requestsMinute ?? 0,
				tokensMinute: byKey.get(key.id)?.tokensMinute ?? 0,
				requestsDay: byKey.get(key.id)?.requestsDay ?? 0,
				tokensDay: byKey.get(key.id)?.tokensDay ?? 0,
			})),
		});
	} catch (error) {
		return routeError(error, "/api/keys/usage");
	}
}
