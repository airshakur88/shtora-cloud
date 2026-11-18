import { hashAuthPassword, verifyAuthPassword } from "@/lib/auth-password";
import { getDb } from "@/lib/env";
import {
	clearedSessionCookie,
	createSession,
	deleteAllSessionsForUser,
	deleteSession,
	getSessionUser,
	sessionCookie,
} from "@/lib/session";
import type { AppUserRecord } from "@/lib/types";

const MAX_BODY_BYTES = 8192;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 32;
const AUTH_LIMIT = 5;
const AUTH_WINDOW_MS = 60_000;
/**
 * Registration attempts per IP, separate from the per-username bucket:
 * rotating usernames must not bypass the limit. 20/hour is deliberately
 * high — it stops bulk account creation, not humans.
 */
const REGISTER_IP_LIMIT = 20;
const REGISTER_IP_WINDOW_MS = 60 * 60 * 1000;
/**
 * Retention for the usage tables pruned by cleanupAuthState: rows older
 * than 90 days are deleted, 500 per cleanup run.
 */
const USAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class AuthRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly headers?: HeadersInit,
	) {
		super(code);
	}
}

function response(
	body: unknown,
	status = 200,
	headers?: HeadersInit,
): Response {
	const resultHeaders = new Headers(headers);
	resultHeaders.set("Cache-Control", "no-store");
	resultHeaders.set("Content-Type", "application/json; charset=utf-8");
	resultHeaders.set("X-Content-Type-Options", "nosniff");
	resultHeaders.set("Vary", "Cookie");
	return new Response(JSON.stringify(body), { status, headers: resultHeaders });
}

/**
 * Reads a JSON request body enforcing a byte cap even when the client
 * omits `content-length` (chunked bodies): the stream is read with a
 * running total and aborted past the cap. Throws AuthRequestError with
 * 413 `request_too_large` or 400 `invalid_request`. Shared by the key
 * routes, which need caps other than the auth 8 KB.
 */
export async function readLimitedJsonBody(
	request: Request,
	maxBytes: number,
): Promise<unknown> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null) {
		const length = Number(contentLength);
		if (!Number.isSafeInteger(length) || length < 0)
			throw new AuthRequestError(400, "invalid_request");
		if (length > maxBytes) throw new AuthRequestError(413, "request_too_large");
	}
	if (!request.body) throw new AuthRequestError(400, "invalid_request");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new AuthRequestError(413, "request_too_large");
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
		throw new AuthRequestError(400, "invalid_request");
	}
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	const contentType = request.headers
		.get("content-type")
		?.split(";", 1)[0]
		?.trim()
		.toLowerCase();
	if (contentType !== "application/json")
		throw new AuthRequestError(415, "unsupported_media_type");
	const parsed = await readLimitedJsonBody(request, MAX_BODY_BYTES);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new AuthRequestError(400, "invalid_request");
	}
	return parsed as Record<string, unknown>;
}

function originAllowed(request: Request): boolean {
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

function validPassword(password: unknown): password is string {
	if (typeof password !== "string") return false;
	let length = 0;
	for (const _character of password) {
		length += 1;
		if (length > 4096) return false;
	}
	return length > 0;
}

function validUsername(username: unknown): username is string {
	return typeof username === "string" && /^[a-z0-9]{4,16}$/i.test(username);
}

async function digest(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function checkRateLimitKey(
	keyHash: string,
	limit: number,
	windowMs: number,
): Promise<Response | null> {
	const now = Date.now();
	const row = await getDb()
		.prepare(
			`INSERT INTO shtora_rate_limits (key_hash, window_start_ms, count)
			 VALUES (?, ?, 1)
			 ON CONFLICT(key_hash) DO UPDATE SET
			   window_start_ms = CASE WHEN excluded.window_start_ms - shtora_rate_limits.window_start_ms > ?
			     THEN excluded.window_start_ms ELSE shtora_rate_limits.window_start_ms END,
			   count = CASE WHEN excluded.window_start_ms - shtora_rate_limits.window_start_ms > ?
			     THEN 1 WHEN shtora_rate_limits.count < ? THEN shtora_rate_limits.count + 1
			     ELSE ? END
			 RETURNING window_start_ms, count`,
		)
		.bind(keyHash, now, windowMs, windowMs, limit, limit + 1)
		.first<{ window_start_ms: number; count: number }>();
	if (!row) throw new Error("Rate limit state unavailable");
	if (row.count <= limit) return null;
	const retry = Math.max(
		1,
		Math.ceil((row.window_start_ms + windowMs - now) / 1000),
	);
	return response({ error: "rate_limited" }, 429, {
		"Retry-After": String(retry),
	});
}

async function checkRateLimit(
	username: string,
	action: "register" | "login",
	request: Request,
): Promise<Response | null> {
	const ip = request.headers.get("cf-connecting-ip") || "127.0.0.1";
	const keyHash = await digest(`${username}:${ip}:${action}`);
	return checkRateLimitKey(keyHash, AUTH_LIMIT, AUTH_WINDOW_MS);
}

/** Registration attempts from one IP, regardless of username. */
async function checkRegisterIpLimit(
	request: Request,
): Promise<Response | null> {
	const ip = request.headers.get("cf-connecting-ip") || "127.0.0.1";
	const keyHash = await digest(`ip:${ip}:register`);
	return checkRateLimitKey(keyHash, REGISTER_IP_LIMIT, REGISTER_IP_WINDOW_MS);
}

async function register(request: Request): Promise<Response> {
	const body = await readJson(request);
	const { username, password } = body;
	if (!validUsername(username) || !validPassword(password))
		throw new AuthRequestError(400, "invalid_request");
	let points = 0;
	for (const _character of password) points += 1;
	if (points < PASSWORD_MIN || points > PASSWORD_MAX)
		throw new AuthRequestError(400, "invalid_request");
	const normalized = username.toLowerCase();
	const limited = await checkRateLimit(normalized, "register", request);
	if (limited) return limited;
	const ipLimited = await checkRegisterIpLimit(request);
	if (ipLimited) return ipLimited;
	const userId = crypto.randomUUID();
	const inserted = (
		await getDb()
			.prepare(
				"INSERT INTO user (id, name, username, role, password_hash) VALUES (?, ?, ?, 'user', ?) ON CONFLICT(username) DO NOTHING RETURNING id",
			)
			.bind(userId, normalized, normalized, await hashAuthPassword(password))
			.all<{ id: string }>()
	).results[0];
	if (!inserted) {
		// Username taken. The message stays the generic `registration_failed`
		// and a dummy hash is computed so the timing matches the success
		// path (as login does for unknown users). The 409 status itself
		// still tells the requester the name is taken — removing that signal
		// would require answering success for a failed registration, which
		// would mislead legitimate users; that is a product decision, not
		// taken here.
		await hashAuthPassword(password);
		return response({ error: "registration_failed" }, 409);
	}
	let token: string;
	try {
		token = (await createSession(inserted.id)).token;
	} catch {
		await getDb()
			.prepare("DELETE FROM user WHERE id = ?")
			.bind(inserted.id)
			.run();
		throw new Error("Session creation failed");
	}
	return response({ user: { id: inserted.id, username: normalized } }, 200, {
		"Set-Cookie": sessionCookie(token),
	});
}

async function login(request: Request): Promise<Response> {
	const body = await readJson(request);
	const { username, password } = body;
	if (!validUsername(username) || !validPassword(password))
		throw new AuthRequestError(400, "invalid_request");
	const normalized = username.toLowerCase();
	const limited = await checkRateLimit(normalized, "login", request);
	if (limited) return limited;
	const row = await getDb()
		.prepare("SELECT id, username, password_hash FROM user WHERE username = ?")
		.bind(normalized)
		.first<Pick<AppUserRecord, "id" | "username" | "password_hash">>();
	const valid = row
		? await verifyAuthPassword(password, row.password_hash)
		: false;
	if (!row || !valid) {
		if (!row) await hashAuthPassword(password);
		return response({ error: "invalid_credentials" }, 401);
	}
	const created = await createSession(row.id);
	// Opportunistic pruning of expired sessions and old usage rows. Never
	// blocks login: a failure here must not fail a valid sign-in.
	void cleanupAuthState().catch(() => undefined);
	return response({ user: { id: row.id, username: row.username } }, 200, {
		"Set-Cookie": sessionCookie(created.token),
	});
}

export async function handleAuthRequest(request: Request): Promise<Response> {
	const action = new URL(request.url).pathname.slice("/api/auth/".length);
	const method = request.method.toUpperCase();
	if (!["register", "login", "logout", "logout-all"].includes(action))
		return response({ error: "not_found" }, 404);
	if (!originAllowed(request))
		return response({ error: "invalid_origin" }, 403);
	if (action === "logout" && (method === "POST" || method === "DELETE")) {
		try {
			await deleteSession(request);
			return new Response(null, {
				status: 204,
				headers: {
					"Cache-Control": "no-store",
					"Set-Cookie": clearedSessionCookie(),
				},
			});
		} catch {
			return response({ error: "internal_error" }, 500);
		}
	}
	// "Log out everywhere": invalidates all of the user's sessions, current
	// one included. Plain logout above still removes only the current
	// session, and login never invalidates other sessions.
	if (action === "logout-all" && method === "POST") {
		try {
			const user = await getSessionUser(request);
			if (!user) return response({ error: "not_authenticated" }, 401);
			await deleteAllSessionsForUser(user.id);
			return new Response(null, {
				status: 204,
				headers: {
					"Cache-Control": "no-store",
					"Set-Cookie": clearedSessionCookie(),
				},
			});
		} catch {
			return response({ error: "internal_error" }, 500);
		}
	}
	if (method !== "POST")
		return response({ error: "method_not_allowed" }, 405, { Allow: "POST" });
	try {
		return action === "register"
			? await register(request)
			: await login(request);
	} catch (error) {
		if (error instanceof AuthRequestError)
			return response({ error: error.code }, error.status, error.headers);
		console.error(JSON.stringify({ event: "auth_error", operation: action }));
		return response({ error: "internal_error" }, 500);
	}
}

export async function cleanupAuthState(): Promise<void> {
	const nowMs = Date.now();
	const db = getDb();
	await db
		.prepare(
			"DELETE FROM shtora_auth_sessions WHERE id IN (SELECT id FROM shtora_auth_sessions WHERE expires_at_ms < ? LIMIT 500)",
		)
		.bind(nowMs)
		.run();
	await db
		.prepare(
			"DELETE FROM shtora_rate_limits WHERE key_hash IN (SELECT key_hash FROM shtora_rate_limits WHERE window_start_ms < ? LIMIT 500)",
		)
		.bind(nowMs - AUTH_WINDOW_MS)
		.run();
	// Usage retention: rows older than 90 days are deleted, 500 per run.
	// provider_rate_limit_usage carries created_at_ms (epoch ms);
	// provider_requests carries created_at as 'YYYY-MM-DD HH:MM:SS' text,
	// compared against datetime('now', '-90 days') in the same format.
	await db
		.prepare(
			"DELETE FROM provider_rate_limit_usage WHERE rowid IN (SELECT rowid FROM provider_rate_limit_usage WHERE created_at_ms < ? LIMIT 500)",
		)
		.bind(nowMs - USAGE_RETENTION_MS)
		.run();
	await db
		.prepare(
			"DELETE FROM provider_requests WHERE id IN (SELECT id FROM provider_requests WHERE created_at < datetime('now', '-90 days') LIMIT 500)",
		)
		.run();
}
