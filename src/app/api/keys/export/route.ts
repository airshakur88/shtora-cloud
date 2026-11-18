import { routeError } from "@/lib/api-error";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { exportApiKeys } from "@/lib/key-store";
import { requireUser } from "@/lib/session";

export async function GET(request: Request): Promise<Response> {
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
