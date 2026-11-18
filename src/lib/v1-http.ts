// Shared responses for the public /v1 and /api/v1 route handlers: wrong-method
// (405) and preflight (OPTIONS). Each API family keeps its own error shape.
// Wrong-method used to come back as an empty 405 from the framework, with no
// body and no Allow header; API clients could not tell which method to use.
import { anthropicError } from "./inference-http";

export function openAiMethodNotAllowed(
	useMethod: string,
	allowed: string,
): Response {
	return Response.json(
		{
			error: {
				message: `Use ${useMethod} for this endpoint.`,
				type: "invalid_request_error",
				code: null,
			},
		},
		{ status: 405, headers: { Allow: allowed } },
	);
}

export function anthropicMethodNotAllowed(
	useMethod: string,
	allowed: string,
): Response {
	const response = anthropicError(
		`Use ${useMethod} for this endpoint.`,
		405,
		"invalid_request_error",
	);
	response.headers.set("Allow", allowed);
	return response;
}

export function methodNotAllowedHead(allowed: string): Response {
	return new Response(null, { status: 405, headers: { Allow: allowed } });
}

export function optionsResponse(allowed: string): Response {
	return new Response(null, { status: 204, headers: { Allow: allowed } });
}
