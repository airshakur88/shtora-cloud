import { routeError } from "@/lib/api-error";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { exportApiKeys } from "@/lib/key-store";
import { requireUser } from "@/lib/session";

/**
 * POST /api/keys/export — returns the user's provider keys in plaintext.
 * This used to be a GET, which a top-level navigation could trigger with
 * the session cookie attached (SameSite=Lax sends it on top-level GETs).
 * POST with the same session check keeps the export behind an explicit
 * fetch. No caller in the dashboard uses this endpoint today (verified by
 * grep: no fetch to /api/keys/export in src/), so nothing else changes.
 */
export async function POST(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		const keys = await exportApiKeys(getDb(), user.id, getEncryptionSecret());
		const response = {
			version: 1,
			exportedBy: user.id,
			exportedAt: new Date().toISOString(),
			source: "shtora-cloud",
			keys: keys.map((k) => ({
				platform: k.platform,
				key: k.key,
				label: k.label,
			})),
		};
		return Response.json(response, { status: 200 });
	} catch (error) {
		return routeError(error, "/api/keys/export");
	}
}

export async function GET(): Promise<Response> {
	return Response.json(
		{ error: { message: "Method not allowed", type: "method_not_allowed" } },
		{ status: 405, headers: { Allow: "POST" } },
	);
}
