import { handleQuarantineRelease } from "@/lib/admin-quarantine";
import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import { listQuarantined } from "@/lib/quarantine";
import { requireAdmin } from "@/lib/session";

export async function GET(request: Request): Promise<Response> {
	try {
		await requireAdmin(request);
		return Response.json({ quarantined: await listQuarantined(getDb()) });
	} catch (error) {
		return routeError(error, "/api/admin/quarantine");
	}
}

export const POST = handleQuarantineRelease;
