/**
 * Shared-secret auth for the cron endpoints (`/api/cron/*`).
 *
 * The secret is `CRON_SECRET`, a Worker secret — never a user session:
 * these endpoints are called by a scheduler, not a browser. Comparison
 * is constant-time over SHA-256 digests so neither the secret's length
 * nor any prefix leaks through timing, and it uses WebCrypto so it
 * works in Workers, Bun tests and browsers alike.
 */

/** 503 when no secret is configured, 401 on a wrong one, null when authorized. */
export async function checkCronAuth(
	request: Request,
	secret: string | undefined,
): Promise<Response | null> {
	if (!secret) {
		return Response.json(
			{
				error: {
					message: "CRON_SECRET is not configured",
					type: "cron_not_configured",
				},
			},
			{ status: 503 },
		);
	}
	const header = request.headers.get("Authorization");
	const presented = header?.startsWith("Bearer ")
		? header.slice("Bearer ".length)
		: "";
	const [presentedHash, secretHash] = await Promise.all([
		sha256(presented),
		sha256(secret),
	]);
	let diff = 0;
	for (let i = 0; i < presentedHash.length; i++)
		diff |= presentedHash[i] ^ secretHash[i];
	if (diff !== 0) {
		return Response.json(
			{
				error: {
					message: "Invalid cron secret",
					type: "unauthorized",
				},
			},
			{ status: 401 },
		);
	}
	return null;
}

async function sha256(value: string): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return new Uint8Array(digest);
}
