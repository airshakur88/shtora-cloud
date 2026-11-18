import { parseChatCompletionRequest } from "@/lib/chat-request";
import { getDb, getEncryptionSecret } from "@/lib/env";
import {
	getInferenceUser,
	InferenceHttpError,
	readInferenceJson,
} from "@/lib/inference-http";
import { routeChatCompletion } from "@/lib/router";
import {
	methodNotAllowedHead,
	openAiMethodNotAllowed,
	optionsResponse,
} from "@/lib/v1-http";

function errorResponse(
	message: string,
	type: string,
	status: number,
): Response {
	return Response.json({ error: { message, type, code: null } }, { status });
}

export async function POST(request: Request): Promise<Response> {
	try {
		const db = getDb();
		const user = await getInferenceUser(request, db);
		let parsed: unknown;
		try {
			parsed = await readInferenceJson(request);
		} catch {
			return errorResponse(
				"Invalid request body",
				"invalid_request_error",
				400,
			);
		}
		const body = parseChatCompletionRequest(parsed);
		if (!body)
			return errorResponse(
				"Invalid request body",
				"invalid_request_error",
				400,
			);
		const result = await routeChatCompletion({
			db,
			secret: getEncryptionSecret(),
			user,
			request: body,
		});
		return result.response;
	} catch (error) {
		if (error instanceof InferenceHttpError)
			return errorResponse(error.message, error.type, error.status);
		console.error(
			JSON.stringify({ event: "v1_error", path: "/v1/chat/completions" }),
		);
		return errorResponse("Internal error", "server_error", 500);
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
