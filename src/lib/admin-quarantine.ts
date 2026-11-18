import { getDb } from "@/lib/env";
import { releaseQuarantine } from "@/lib/quarantine";
import {
	ForbiddenError,
	requireAdmin,
	UnauthenticatedError,
} from "@/lib/session";

export async function handleQuarantineRelease(
	request: Request,
): Promise<Response> {
	try {
		await requireAdmin(request);
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json(
				{ error: { message: "Invalid request", type: "validation_error" } },
				{ status: 400 },
			);
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return Response.json(
				{ error: { message: "Invalid request", type: "validation_error" } },
				{ status: 400 },
			);
		}
		const fields = body as Record<string, unknown>;
		if (
			typeof fields.platform !== "string" ||
			fields.platform.length === 0 ||
			fields.platform.length > 80 ||
			typeof fields.modelId !== "string" ||
			fields.modelId.length === 0 ||
			fields.modelId.length > 256 ||
			typeof fields.keyId !== "number" ||
			!Number.isSafeInteger(fields.keyId) ||
			fields.keyId < 1
		) {
			return Response.json(
				{ error: { message: "Invalid request", type: "validation_error" } },
				{ status: 400 },
			);
		}
		await releaseQuarantine(getDb(), {
			platform: fields.platform,
			modelId: fields.modelId,
			keyId: fields.keyId,
		});
		return new Response(null, { status: 204 });
	} catch (error) {
		if (error instanceof UnauthenticatedError) {
			return Response.json(
				{ error: { message: "Not authenticated", type: "auth_error" } },
				{ status: 401 },
			);
		}
		if (error instanceof ForbiddenError) {
			return Response.json(
				{ error: { message: "Forbidden", type: "auth_error" } },
				{ status: 403 },
			);
		}
		console.error(
			JSON.stringify({
				event: "api_error",
				path: "/api/admin/quarantine/release",
			}),
		);
		return Response.json(
			{ error: { message: "Internal error", type: "server_error" } },
			{ status: 500 },
		);
	}
}
