import type { CreateAccessKeyRequest } from "@/lib/access-keys";
import {
	AccessKeyLimitError,
	createAccessKey,
	listAccessKeys,
	MAX_ACCESS_KEYS_PER_USER,
} from "@/lib/access-keys";
import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import { requireUser } from "@/lib/session";

export async function GET(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		const db = getDb();

		const keys = await listAccessKeys(db, user.id);

		return Response.json({ keys });
	} catch (error) {
		return routeError(error, "/api/access-keys");
	}
}

export async function POST(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		const db = getDb();

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
		const name = typeof bodyObj.name === "string" ? bodyObj.name.trim() : "";
		const expiresInDays =
			typeof bodyObj.expiresInDays === "number" ? bodyObj.expiresInDays : null;

		if (!name) {
			return Response.json(
				{ error: { message: "Name is required", type: "validation_error" } },
				{ status: 400 },
			);
		}

		if (name.length > 100) {
			return Response.json(
				{
					error: {
						message: "Name too long (max 100 characters)",
						type: "validation_error",
					},
				},
				{ status: 400 },
			);
		}

		if (expiresInDays !== null && (expiresInDays < 1 || expiresInDays > 3650)) {
			return Response.json(
				{
					error: {
						message: "expiresInDays must be between 1 and 3650",
						type: "validation_error",
					},
				},
				{ status: 400 },
			);
		}

		const input: CreateAccessKeyRequest = { name, expiresInDays };
		const result = await createAccessKey(db, user.id, input);

		return Response.json({ accessKey: result }, { status: 201 });
	} catch (error) {
		if (error instanceof AccessKeyLimitError) {
			return Response.json(
				{
					error: {
						message: `Access key limit reached (${MAX_ACCESS_KEYS_PER_USER} keys per user)`,
						type: "limit_reached",
					},
				},
				{ status: 403 },
			);
		}
		return routeError(error, "/api/access-keys");
	}
}
