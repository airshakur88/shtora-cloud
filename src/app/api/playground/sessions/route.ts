import { routeError } from "@/lib/api-error";
import { getDb } from "@/lib/env";
import { createSession, listSessions } from "@/lib/playground-sessions";
import { requireUser } from "@/lib/session";

export async function GET(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		const sessions = await listSessions(getDb(), user.id);
		return Response.json(
			{ sessions },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return routeError(error, "/api/playground/sessions");
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
		const bodyObj = (body as Record<string, unknown>) ?? {};
		const modelId =
			typeof bodyObj.modelId === "string" && bodyObj.modelId.trim()
				? bodyObj.modelId.trim()
				: "google/gemini-2.5-flash";
		const session = await createSession(db, user.id, modelId);
		return Response.json(session, {
			headers: { "Cache-Control": "private, no-store" },
		});
	} catch (error) {
		return routeError(error, "/api/playground/sessions");
	}
}
