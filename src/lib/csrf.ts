/**
 * Origin check for cookie-authenticated dashboard mutations (M5). Same rule
 * src/lib/auth.ts already applies to register/login/logout: a request with
 * no Origin is allowed (same-origin fetches and non-browser clients send
 * none), a request whose Origin differs from the request origin is a
 * cross-site form/fetch and is rejected. Bearer-token API routes (/v1/*,
 * /api/v1/*) do not use cookies, so this does not apply to them.
 *
 * Apply at the top of each mutating dashboard route, before any state
 * change, answering 403 { error: "invalid_origin" } on failure.
 */
export function originAllowed(request: Request): boolean {
	const origin = request.headers.get("origin");
	if (!origin) return true;
	try {
		const parsed = new URL(origin);
		return (
			parsed.origin === origin && parsed.origin === new URL(request.url).origin
		);
	} catch {
		return false;
	}
}

export function invalidOriginResponse(): Response {
	return Response.json(
		{ error: { message: "Invalid origin", type: "invalid_origin" } },
		{
			status: 403,
			headers: { "Cache-Control": "no-store" },
		},
	);
}
