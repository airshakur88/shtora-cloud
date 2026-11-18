import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import {
	deleteSession,
	getSession,
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
		const updates: { name?: string | null; modelId?: string | null } = {};
		if (typeof bodyObj.name === "string")
			updates.name = bodyObj.name.trim() || null;
		if (typeof bodyObj.modelId === "string")
			updates.modelId = bodyObj.modelId.trim() || null;

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
