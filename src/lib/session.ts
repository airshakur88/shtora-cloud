import { getDb } from "@/lib/env";
import type { AppUser, AppUserRecord, ShtoraSession } from "@/lib/types";

export const SESSION_COOKIE_NAME = "__Host-shtora.session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
/**
 * Cap on concurrent sessions per user (M1). A new login past the cap
 * evicts the oldest sessions instead of locking the user out.
 */
export const MAX_SESSIONS_PER_USER = 20;

export class UnauthenticatedError extends Error {
	constructor() {
		super("Not authenticated");
		this.name = "UnauthenticatedError";
	}
}

export class ForbiddenError extends Error {
	constructor() {
		super("Forbidden");
		this.name = "ForbiddenError";
	}
}

function readCookie(cookieHeader: string | null): string | null {
	const header = cookieHeader;
	if (!header || header.length > 16_384) return null;
	let token: string | null = null;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (
			separator < 0 ||
			part.slice(0, separator).trim() !== SESSION_COOKIE_NAME
		)
			continue;
		if (token !== null) return null;
		const value = part.slice(separator + 1).trim();
		if (!/^[a-f0-9]{64}$/.test(value)) return null;
		token = value;
	}
	return token;
}

async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function toAppUser(row: AppUserRecord): AppUser {
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

export function publicUser(user: AppUser): Omit<AppUser, "passwordHash"> {
	const { passwordHash: _, ...safeUser } = user;
	return safeUser;
}

export async function createSession(
	userId: string,
): Promise<{ token: string; session: ShtoraSession }> {
	const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
	const token = Array.from(tokenBytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const now = Date.now();
	const session: ShtoraSession = {
		id: crypto.randomUUID(),
		tokenHash: await hashToken(token),
		userId,
		createdAtMs: now,
		expiresAtMs: now + SESSION_TTL_SECONDS * 1000,
	};
	await getDb()
		.prepare(
			"INSERT INTO shtora_auth_sessions (id, token_hash, user_id, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(
			session.id,
			session.tokenHash,
			session.userId,
			session.createdAtMs,
			session.expiresAtMs,
		)
		.run();
	try {
		await getDb()
			.prepare(
				`DELETE FROM shtora_auth_sessions WHERE user_id = ? AND id NOT IN
				 (SELECT id FROM shtora_auth_sessions WHERE user_id = ?
				  ORDER BY created_at_ms DESC, id DESC LIMIT ?)`,
			)
			.bind(userId, userId, MAX_SESSIONS_PER_USER)
			.run();
	} catch {
		// Best-effort eviction: a failed prune only leaves extra sessions,
		// which the next login retries. Login must not fail over this.
	}
	return { token, session };
}

export function sessionCookie(token: string, now = Date.now()): string {
	const expires = new Date(now + SESSION_TTL_SECONDS * 1000).toUTCString();
	return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Expires=${expires}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearedSessionCookie(): string {
	return `${SESSION_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export async function deleteSession(request: Request): Promise<void> {
	const token = readCookie(request.headers.get("cookie"));
	if (!token) return;
	await getDb()
		.prepare("DELETE FROM shtora_auth_sessions WHERE token_hash = ?")
		.bind(await hashToken(token))
		.run();
}

/**
 * Invalidates every session of a user, including the current one. Used by
 * "log out everywhere" (POST /api/auth/logout-all). Also the hook a
 * password-change flow must call — there is no such endpoint today, so
 * nothing else calls this yet. Login deliberately does NOT call it: that
 * would drop legitimate sessions on other devices without warning.
 */
export async function deleteAllSessionsForUser(userId: string): Promise<void> {
	await getDb()
		.prepare("DELETE FROM shtora_auth_sessions WHERE user_id = ?")
		.bind(userId)
		.run();
}

export async function getSession(
	request: Request,
): Promise<ShtoraSession | null> {
	const token = readCookie(request.headers.get("cookie"));
	if (!token) return null;
	return getSessionByToken(token);
}

async function getSessionByToken(token: string): Promise<ShtoraSession | null> {
	const tokenHash = await hashToken(token);
	const row = await getDb()
		.prepare(
			"SELECT id, token_hash, user_id, created_at_ms, expires_at_ms FROM shtora_auth_sessions WHERE token_hash = ?",
		)
		.bind(tokenHash)
		.first<{
			id: string;
			token_hash: string;
			user_id: string;
			created_at_ms: number;
			expires_at_ms: number;
		}>();
	if (
		!row ||
		row.expires_at_ms <= Date.now() ||
		row.created_at_ms > Date.now()
	) {
		if (row) {
			await getDb()
				.prepare("DELETE FROM shtora_auth_sessions WHERE token_hash = ?")
				.bind(tokenHash)
				.run();
		}
		return null;
	}
	return {
		id: row.id,
		tokenHash: row.token_hash,
		userId: row.user_id,
		createdAtMs: row.created_at_ms,
		expiresAtMs: row.expires_at_ms,
	};
}

export async function getSessionUser(
	request: Request,
): Promise<AppUser | null> {
	const session = await getSession(request);
	if (!session) return null;
	return getUserForSession(session);
}

async function getUserForSession(
	session: ShtoraSession,
): Promise<AppUser | null> {
	const row = await getDb()
		.prepare(
			"SELECT id, name, username, role, password_hash, created_at, updated_at FROM user WHERE id = ?",
		)
		.bind(session.userId)
		.first<AppUserRecord>();
	if (!row) {
		await getDb()
			.prepare("DELETE FROM shtora_auth_sessions WHERE id = ?")
			.bind(session.id)
			.run();
		return null;
	}
	return toAppUser(row);
}

/** The session user as server components see it (no password hash). */
export interface SessionUser {
	id: string;
	name: string | null;
	username: string;
	role: "user" | "admin";
	createdAt: string;
	updatedAt: string;
}

/**
 * The current user for server components (layouts, landing). Reads the
 * session cookie straight from `next/headers` — the old
 * `src/lib/server-session.ts` shim built a fake Request just to call
 * getSessionUser, which hid where the cookie came from (M26).
 *
 * The `next/headers` import is dynamic so modules that only need the
 * session helpers (routes, tests) never resolve it.
 */
export async function getCurrentSessionUser(): Promise<SessionUser | null> {
	const { headers } = await import("next/headers");
	const token = readCookie((await headers()).get("cookie"));
	if (!token) return null;
	const session = await getSessionByToken(token);
	if (!session) return null;
	const user = await getUserForSession(session);
	if (!user) return null;
	return {
		id: user.id,
		name: user.name || null,
		username: user.username,
		role: user.role,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
	};
}

export async function requireUser(request: Request): Promise<AppUser> {
	const user = await getSessionUser(request);
	if (!user) throw new UnauthenticatedError();
	return user;
}

export async function requireAdmin(request: Request): Promise<AppUser> {
	const user = await requireUser(request);
	if (user.role !== "admin") throw new ForbiddenError();
	return user;
}
