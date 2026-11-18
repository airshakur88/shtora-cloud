import { nativeModels } from "@/lib/anthropic-models";
import { openAiMethodNotAllowed, optionsResponse } from "@/lib/v1-http";

export async function GET(
	request: Request,
	context: { params: Promise<{ model: string[] }> },
): Promise<Response> {
	const { model } = await context.params;
	return nativeModels(request, model.join("/"));
}

export function POST(): Response {
	return openAiMethodNotAllowed("GET", "GET, HEAD, OPTIONS");
}

export function PUT(): Response {
	return openAiMethodNotAllowed("GET", "GET, HEAD, OPTIONS");
}

export function PATCH(): Response {
	return openAiMethodNotAllowed("GET", "GET, HEAD, OPTIONS");
}

export function DELETE(): Response {
	return openAiMethodNotAllowed("GET", "GET, HEAD, OPTIONS");
}

export function OPTIONS(): Response {
	return optionsResponse("GET, HEAD, OPTIONS");
}
