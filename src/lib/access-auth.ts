import { updateAccessKeyLastUsed, validateAccessKey } from "./access-keys";
import { getDb } from "./env";

export interface AccessAuthResult {
	userId: string;
	accessKeyId: number;
}

export class AccessAuthError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "AccessAuthError";
	}
}

export async function authenticateAccessKey(
	request: Request,
): Promise<AccessAuthResult> {
	const authHeader = request.headers.get("authorization");
	if (!authHeader) {
		throw new AccessAuthError(
			401,
			"missing_authorization",
			"Authorization header required",
		);
	}

	const [scheme, token] = authHeader.split(" ");
	if (scheme.toLowerCase() !== "bearer" || !token) {
		throw new AccessAuthError(
			401,
			"invalid_authorization",
			"Invalid authorization format. Use: Bearer <api_key>",
		);
	}

	const db = getDb();
	const record = await validateAccessKey(db, token);

	if (!record) {
		throw new AccessAuthError(
			401,
			"invalid_api_key",
			"Invalid or expired API key",
		);
	}

	await updateAccessKeyLastUsed(db, record.id);

	return {
		userId: record.user_id,
		accessKeyId: record.id,
	};
}

export function createAuthErrorResponse(error: AccessAuthError): Response {
	return Response.json(
		{ error: { message: error.message, type: error.code } },
		{ status: error.status },
	);
}
