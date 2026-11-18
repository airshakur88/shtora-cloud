import { routeError } from "@/lib/api-error";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { listApiKeys, rotateUnifiedToken } from "@/lib/key-store";
import { requireUser } from "@/lib/session";

function parseId(raw: string): number | null {
	const id = Number(raw);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * POST /api/keys/[id]/rotate — issues a new unified token for the key.
 * The old token stops working immediately; the new plaintext is returned
 * once, in this response, and never served again (only its SHA-256 hash
 * is stored). No request body is read.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	try {
		const user = await requireUser(request);
		const id = parseId((await params).id);
		if (id === null)
			return Response.json(
				{ error: { message: "Invalid id", type: "validation_error" } },
				{ status: 400 },
			);
		const db = getDb();
		const newToken = await rotateUnifiedToken(db, id, user.id);
		if (newToken === null)
			return Response.json(
				{ error: { message: "Key not found", type: "not_found" } },
				{ status: 404 },
			);
		const key = (await listApiKeys(db, user.id, getEncryptionSecret())).find(
			(item) => item.id === id,
		);
		if (!key)
			return Response.json(
				{ error: { message: "Key not found", type: "not_found" } },
				{ status: 404 },
			);
		return Response.json({ key, unifiedToken: newToken });
	} catch (error) {
		return routeError(error, "/api/keys/[id]/rotate");
	}
}
