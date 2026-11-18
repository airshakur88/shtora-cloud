const API_ERROR_MESSAGES: Record<string, string> = {
	invalid_credentials: "Could not sign in. Check your username and password.",
	invalid_request: "Check the submitted values and try again.",
	rate_limited: "Too many attempts. Try again shortly.",
	internal_error: "The request could not be completed. Try again later.",
};

export function apiErrorMessage(payload: unknown, fallback: string): string {
	if (!payload || typeof payload !== "object" || !("error" in payload))
		return fallback;
	const error = payload.error;
	if (typeof error === "string") return API_ERROR_MESSAGES[error] ?? error;
	if (
		error &&
		typeof error === "object" &&
		"message" in error &&
		typeof error.message === "string"
	)
		return error.message;
	return fallback;
}

/**
 * Canonical `{ error: { message, type } }` envelope for route handlers
 * that answer a known error directly, instead of mapping a thrown error
 * through routeError. Extra headers are for callers that need them — a
 * 429 carries Retry-After, authenticated content carries no-store /
 * nosniff. The playground image routes used to build this same envelope
 * locally (M26).
 */
export function apiErrorResponse(
	message: string,
	type: string,
	status: number,
	headers?: Record<string, string>,
): Response {
	return Response.json({ error: { message, type } }, { status, headers });
}

/**
 * Standard API error envelope for server route handlers.
 * Session-auth failures map to 401/403; anything else is logged and
 * answered with a generic 500 so internals never leak to the client.
 *
 * Error classes are matched by name (not instanceof) to keep this module
 * importable from client components, which cannot resolve @/lib/env.
 */
export function routeError(error: unknown, path: string): Response {
	if (
		error instanceof Error &&
		(error.name === "UnauthenticatedError" || error.name === "ForbiddenError")
	) {
		return Response.json(
			{
				error: {
					message:
						error.name === "UnauthenticatedError"
							? "Not authenticated"
							: "Forbidden",
					type: "auth_error",
				},
			},
			{ status: error.name === "UnauthenticatedError" ? 401 : 403 },
		);
	}
	console.error(
		JSON.stringify({
			event: "api_error",
			path,
			error:
				error instanceof Error
					? `${error.name}: ${error.message}`
					: String(error),
		}),
	);
	return Response.json(
		{ error: { message: "Internal error", type: "server_error" } },
		{ status: 500 },
	);
}
