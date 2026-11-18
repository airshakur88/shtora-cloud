import { openAiMethodNotAllowed, optionsResponse } from "@/lib/v1-http";

// Index of the public API. GET /v1 used to fall through to the app 404 page
// and return HTML; API clients expect JSON here. The endpoints below are the
// routes that exist in src/app/v1, nothing more.
export function GET(): Response {
	return Response.json({
		object: "api",
		service: "shtora",
		endpoints: [
			{ method: "POST", path: "/v1/chat/completions" },
			{ method: "GET", path: "/v1/models" },
			{ method: "GET", path: "/v1/models/{model}" },
			{ method: "POST", path: "/v1/messages" },
			{ method: "POST", path: "/v1/messages/count_tokens" },
		],
	});
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
