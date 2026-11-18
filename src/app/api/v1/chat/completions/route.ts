import {
	AccessAuthError,
	authenticateAccessKey,
	createAuthErrorResponse,
} from "@/lib/access-auth";
import { parseChatCompletionRequest } from "@/lib/chat-request";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { routeChatCompletion } from "@/lib/router";

export async function POST(request: Request): Promise<Response> {
	let auth: Awaited<ReturnType<typeof authenticateAccessKey>> | null = null;
	try {
		auth = await authenticateAccessKey(request);
	} catch (error) {
		if (error instanceof AccessAuthError) {
			return createAuthErrorResponse(error);
		}
		return Response.json(
			{ error: { message: "Authentication failed", type: "auth_error" } },
			{ status: 401 },
		);
	}

	const db = getDb();
	const secret = getEncryptionSecret();

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ error: { message: "Invalid request", type: "validation_error" } },
			{ status: 400 },
		);
	}

	const parsed = parseChatCompletionRequest(body);
	if (!parsed) {
		return Response.json(
			{
				error: { message: "Invalid request format", type: "validation_error" },
			},
			{ status: 400 },
		);
	}

	try {
		const result = await routeChatCompletion({
			db,
			secret,
			user: {
				id: auth.userId,
				name: "",
				username: "",
				role: "user",
				passwordHash: "",
				createdAt: "",
				updatedAt: "",
			},
			request: parsed,
		});

		if (
			result.response.headers.get("content-type")?.includes("text/event-stream")
		) {
			return result.response;
		}

		return Response.json(result.response);
	} catch (error) {
		console.error(
			JSON.stringify({ event: "api_error", path: "/api/v1/chat/completions" }),
		);
		const message = error instanceof Error ? error.message : "Internal error";
		return Response.json(
			{ error: { message, type: "server_error" } },
			{ status: 500 },
		);
	}
}
