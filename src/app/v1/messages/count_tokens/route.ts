import { handleNativeMessages } from "@/lib/anthropic-route";
import {
	anthropicMethodNotAllowed,
	methodNotAllowedHead,
	optionsResponse,
} from "@/lib/v1-http";

export async function POST(request: Request): Promise<Response> {
	return handleNativeMessages(request, "count_tokens");
}

export function GET(): Response {
	return anthropicMethodNotAllowed("POST", "OPTIONS, POST");
}

export function PUT(): Response {
	return anthropicMethodNotAllowed("POST", "OPTIONS, POST");
}

export function PATCH(): Response {
	return anthropicMethodNotAllowed("POST", "OPTIONS, POST");
}

export function DELETE(): Response {
	return anthropicMethodNotAllowed("POST", "OPTIONS, POST");
}

export function HEAD(): Response {
	return methodNotAllowedHead("OPTIONS, POST");
}

export function OPTIONS(): Response {
	return optionsResponse("OPTIONS, POST");
}
