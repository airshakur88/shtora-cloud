import { MAX_BODY_BYTES } from "./chat-request";
import { getApiKeyOwnerByToken } from "./key-store";
import type { AppUser, AppUserRecord, D1Database } from "./types";

export class InferenceHttpError extends Error {
	constructor(
		message: string,
		readonly status = 400,
		readonly type = "invalid_request_error",
	) {
		super(message);
	}
}

export function anthropicError(
	message: string,
	status = 400,
	type = "invalid_request_error",
): Response {
	const requestId = `req_${crypto.randomUUID()}`;
	return Response.json(
		{ type: "error", error: { type, message }, request_id: requestId },
		{
			status,
			headers: { "request-id": requestId },
		},
	);
}

export async function readInferenceJson(
	request: Pick<Request, "headers" | "body">,
): Promise<unknown> {
	const length = request.headers.get("content-length");
	if (
		length !== null &&
		(!Number.isSafeInteger(Number(length)) || Number(length) < 0)
	)
		throw new InferenceHttpError("Invalid content-length");
	if (length !== null && Number(length) > MAX_BODY_BYTES)
		throw new InferenceHttpError(
			"Request exceeds Shtora's 1,000,000-byte limit",
			413,
			"request_too_large",
		);
	if (!request.body) throw new InferenceHttpError("Invalid request body");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				throw new InferenceHttpError(
					"Request exceeds Shtora's 1,000,000-byte limit",
					413,
					"request_too_large",
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new InferenceHttpError("Invalid JSON request body");
	}
}

export async function getInferenceUser(
	request: Request,
	db: D1Database,
	native = false,
): Promise<AppUser> {
	const authorization = request.headers.get("authorization");
	const bearer = authorization?.startsWith("Bearer ")
		? authorization.slice(7).trim()
		: null;
	const apiKey = native ? request.headers.get("x-api-key")?.trim() : null;
	const invalid = () =>
		new InferenceHttpError(
			"Missing or invalid API key",
			401,
			"authentication_error",
		);
	if ((authorization && !bearer) || (bearer && apiKey && bearer !== apiKey))
		throw invalid();
	const token = bearer || apiKey;
	if (!token || token.length > 256) throw invalid();
	const userId = await getApiKeyOwnerByToken(db, token);
	if (!userId) throw invalid();
	const row = await db
		.prepare(
			"SELECT id, name, username, role, password_hash, created_at, updated_at FROM user WHERE id = ?",
		)
		.bind(userId)
		.first<AppUserRecord>();
	if (!row) throw invalid();
	return {
		id: row.id,
		name: row.name,
		username: row.username,
		role: row.role === "admin" ? "admin" : "user",
		passwordHash: row.password_hash,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
