import { parseChatCompletionRequest } from "@/lib/chat-request";
import { getDb, getEncryptionSecret } from "@/lib/env";
import {
	getInferenceUser,
	InferenceHttpError,
	readInferenceJson,
} from "@/lib/inference-http";
import { routeChatCompletion } from "@/lib/router";
import {
	enforceInvalidTokenLimit,
	enforcePublicInferenceLimit,
	methodNotAllowedHead,
	openAiError,
	openAiMethodNotAllowed,
	optionsResponse,
} from "@/lib/v1-http";

export async function POST(request: Request): Promise<Response> {
	try {
		const db = getDb();
		let user: Awaited<ReturnType<typeof getInferenceUser>>;
		try {
			user = await getInferenceUser(request, db);
		} catch (error) {
			// Invalid-token attempts are capped per IP (A2): once the
			// budget is gone the probe answers 429, not 401.
			if (error instanceof InferenceHttpError && error.status === 401) {
				const limited = await enforceInvalidTokenLimit(db, request, false);
				if (limited) return limited;
			}
			throw error;
		}
		// Per-token + per-IP cap, before any routing: a capped token never
		// reaches the shared pool (A2).
		const limited = await enforcePublicInferenceLimit(
			db,
			request,
			user.id,
			false,
		);
		if (limited) return limited;
		let parsed: unknown;
		try {
			parsed = await readInferenceJson(request);
		} catch {
			return openAiError("Invalid request body", "invalid_request_error", 400);
		}
		const body = parseChatCompletionRequest(parsed);
		if (!body)
			return openAiError("Invalid request body", "invalid_request_error", 400);
		const result = await routeChatCompletion({
			db,
			secret: getEncryptionSecret(),
			user,
			request: body,
			// Cancelling the client request cancels the upstream attempt too;
			// without this a closed tab left the stream running (M13).
			signal: request.signal,
		});
		return result.response;
	} catch (error) {
		if (error instanceof InferenceHttpError)
			return openAiError(error.message, error.type, error.status);
		console.error(
			JSON.stringify({ event: "v1_error", path: "/v1/chat/completions" }),
		);
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
