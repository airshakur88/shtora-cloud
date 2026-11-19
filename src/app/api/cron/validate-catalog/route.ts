import { routeError } from "@/lib/api-error";
import { checkCronAuth } from "@/lib/cron-auth";
import { getCronSecret } from "@/lib/cron-env";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { runCatalogValidation } from "@/lib/jobs/catalog-validation";

/**
 * POST /api/cron/validate-catalog — catalog validation job (audit §E
 * 2.2). Called by a scheduler with `Authorization: Bearer <CRON_SECRET>`;
 * answers 503 when no secret is configured, 401 on a wrong secret.
 */
export async function POST(request: Request): Promise<Response> {
	try {
		const unauthorized = await checkCronAuth(request, getCronSecret());
		if (unauthorized) return unauthorized;
		const summary = await runCatalogValidation(getDb(), {
			encryptionSecret: getEncryptionSecret(),
		});
		return Response.json(summary);
	} catch (error) {
		return routeError(error, "/api/cron/validate-catalog");
	}
}
