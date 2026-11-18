import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import {
	deleteSession,
	getSession,
	modelExists,
	updateSession,
} from "@/lib/playground-sessions";
import { requireUser } from "@/lib/session";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	try {
		const user = await requireUser(request);
		const { id } = await params;
		const db = getDb();

		const session = await getSession(db, id, user.id);
		if (!session) {
			return Response.json(
				{ error: { message: "Session not found", type: "not_found" } },
				{ status: 404 },
			);
		}

		return Response.json({ session });
	} catch (error) {
		return routeError(error, "/api/playground/sessions/[id]");
	}
}

export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	try {
		const user = await requireUser(request);
		const { id } = await params;
		const db = getDb();
		const deleted = await deleteSession(db, id, user.id);
		if (!deleted) {
			return Response.json(
				{ error: { message: "Session not found", type: "not_found" } },
				{ status: 404 },
			);
		}
		return Response.json(
			{ success: true },
			{
				headers: { "Cache-Control": "private, no-store" },
			},
		);
	} catch (error) {
		return routeError(error, "/api/playground/sessions/[id]");
	}
}

export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	try {
		const user = await requireUser(request);
		const { id } = await params;
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
		// An explicit empty string is a client bug, not "keep the old
		// value": it is rejected instead of silently keeping the name
		// or model. Omitting the field keeps the current value.
		if (typeof bodyObj.name === "string" && bodyObj.name.trim().length === 0) {
			return Response.json(
				{
					error: {
						message: "Session name must not be empty",
						type: "validation_error",
					},
				},
				{ status: 400 },
			);
		}
		if (
			typeof bodyObj.modelId === "string" &&
			bodyObj.modelId.trim().length === 0
		) {
			return Response.json(
				{
					error: {
						message: "modelId must not be empty",
						type: "validation_error",
					},
				},
				{ status: 400 },
			);
		}
		const updates: { name?: string; modelId?: string } = {};
		if (typeof bodyObj.name === "string") updates.name = bodyObj.name.trim();
		if (typeof bodyObj.modelId === "string")
			updates.modelId = bodyObj.modelId.trim();

		if (updates.modelId !== undefined) {
			const exists = await modelExists(db, updates.modelId);
			if (!exists) {
				return Response.json(
					{
						error: {
							message: `Unknown model: ${updates.modelId}`,
							type: "validation_error",
						},
					},
					{ status: 400 },
				);
			}
		}

		const session = await updateSession(db, id, user.id, updates);
		if (!session) {
			return Response.json(
				{ error: { message: "Session not found", type: "not_found" } },
				{ status: 404 },
			);
		}

		return Response.json(session);
	} catch (error) {
		return routeError(error, "/api/playground/sessions/[id]");
	}
}
