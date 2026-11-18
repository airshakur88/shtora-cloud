import { deleteAccessKey, toggleAccessKeyEnabled } from "@/lib/access-keys";
import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import { requireUser } from "@/lib/session";
export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	try {
		const user = await requireUser(request);
		const db = getDb();
		const { id } = await params;
		const keyId = Number(id);

		if (!Number.isInteger(keyId) || keyId <= 0) {
			return Response.json(
				{ error: { message: "Invalid key ID", type: "validation_error" } },
				{ status: 400 },
			);
		}

		await deleteAccessKey(db, keyId, user.id);

		return Response.json({ success: true });
	} catch (error) {
		return routeError(error, "/api/access-keys/[id]");
	}
}

export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	try {
		const user = await requireUser(request);
		const db = getDb();
		const { id } = await params;
		const keyId = Number(id);

		if (!Number.isInteger(keyId) || keyId <= 0) {
			return Response.json(
				{ error: { message: "Invalid key ID", type: "validation_error" } },
				{ status: 400 },
			);
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json(
				{ error: { message: "Invalid request", type: "validation_error" } },
				{ status: 400 },
			);
		}

		const bodyObj = (body ?? {}) as Record<string, unknown>;
		const enabled =
			typeof bodyObj.enabled === "boolean" ? bodyObj.enabled : undefined;

		if (enabled === undefined) {
			return Response.json(
				{
					error: {
						message: "enabled field is required (boolean)",
						type: "validation_error",
					},
				},
				{ status: 400 },
			);
		}

		await toggleAccessKeyEnabled(db, keyId, user.id, enabled);

		return Response.json({ success: true });
	} catch (error) {
		return routeError(error, "/api/access-keys/[id]");
	}
}
