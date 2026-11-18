import {
	AccessAuthError,
	authenticateAccessKey,
	createAuthErrorResponse,
} from "@/lib/access-auth";
import { parseChatCompletionRequest } from "@/lib/chat-request";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { InferenceHttpError, readInferenceJson } from "@/lib/inference-http";
import { routeChatCompletion } from "@/lib/router";
import type { AppUser, AppUserRecord } from "@/lib/types";
import {
	enforceInvalidTokenLimit,
	enforcePublicInferenceLimit,
	methodNotAllowedHead,
	openAiError,
	openAiMethodNotAllowed,
	optionsResponse,
} from "@/lib/v1-http";

export async function POST(request: Request): Promise<Response> {
	let auth: Awaited<ReturnType<typeof authenticateAccessKey>> | null = null;
	try {
		auth = await authenticateAccessKey(request);
	} catch (error) {
		if (error instanceof AccessAuthError) {
			// Invalid-token attempts are capped per IP (A2): once the
			// budget is gone the probe answers 429, not 401.
			const limited = await enforceInvalidTokenLimit(getDb(), request, false);
			if (limited) return limited;
			return createAuthErrorResponse(error);
		}
		return openAiError("Authentication failed", "auth_error", 401);
	}

	const db = getDb();
	const secret = getEncryptionSecret();

	// The router only reads user.id, but it takes a full AppUser — load the
	// real owner of the access key instead of fabricating empty fields.
	// A key whose user row is gone authenticates no further.
	const userRow = await db
		.prepare(
			"SELECT id, name, username, role, password_hash, created_at, updated_at FROM user WHERE id = ?",
		)
		.bind(auth.userId)
		.first<AppUserRecord>();
	if (!userRow) return openAiError("Authentication failed", "auth_error", 401);
	const user: AppUser = {
		id: userRow.id,
		name: userRow.name,
		username: userRow.username,
		role: userRow.role === "admin" ? "admin" : "user",
		passwordHash: userRow.password_hash,
		createdAt: userRow.created_at,
		updatedAt: userRow.updated_at,
	};

	// Per-token + per-IP cap, before any routing: a capped token never
	// reaches the shared pool (A2).
	const limited = await enforcePublicInferenceLimit(
		db,
		request,
		user.id,
		false,
	);
	if (limited) return limited;

	// Same body handling as /v1/chat/completions: the 1 MB capped reader
	// and the same invalid-body envelope (`invalid_request_error`).
	let body: unknown;
	try {
		body = await readInferenceJson(request);
	} catch (error) {
		if (error instanceof InferenceHttpError)
			return openAiError(error.message, error.type, error.status);
		return openAiError("Invalid request body", "invalid_request_error", 400);
	}

	const parsed = parseChatCompletionRequest(body);
	if (!parsed) {
		return openAiError("Invalid request body", "invalid_request_error", 400);
	}

	try {
		const result = await routeChatCompletion({
			db,
			secret,
			user,
			request: parsed,
			// Same cancellation propagation as /v1/chat/completions (M13).
			signal: request.signal,
		});
		return result.response;
	} catch {
		console.error(
			JSON.stringify({ event: "api_error", path: "/api/v1/chat/completions" }),
		);
		// Never return the raw error message: D1 errors can name tables and
		// columns. Same generic 500 as /v1 and the playground (M2).
		return openAiError("Internal error", "server_error", 500);
	}
}

export function GET(): Response {
	return openAiMethodNotAllowed("POST", "OPTIONS, POST");
}

export function PUT(): Response {
	return openAiMethodNotAllowed("POST", "OPTIONS, POST");
}

export function PATCH(): Response {
	return openAiMethodNotAllowed("POST", "OPTIONS, POST");
}

export function DELETE(): Response {
	return openAiMethodNotAllowed("POST", "OPTIONS, POST");
}

export function HEAD(): Response {
	return methodNotAllowedHead("OPTIONS, POST");
}

export function OPTIONS(): Response {
	return optionsResponse("OPTIONS, POST");
}
