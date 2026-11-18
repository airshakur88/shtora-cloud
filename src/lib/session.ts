import { getDb } from "@/lib/env";
import type { AppUser, AppUserRecord, ShtoraSession } from "@/lib/types";

export const SESSION_COOKIE_NAME = "__Host-shtora.session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

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

function readCookie(request: Request): string | null {
	const header = request.headers.get("cookie");
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
	const token = readCookie(request);
	if (!token) return;
	await getDb()
		.prepare("DELETE FROM shtora_auth_sessions WHERE token_hash = ?")
		.bind(await hashToken(token))
		.run();
}

export async function getSession(
	request: Request,
): Promise<ShtoraSession | null> {
	const token = readCookie(request);
	if (!token) return null;
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
	const token = readCookie(request);
	if (!token) return null;
	const tokenHash = await hashToken(token);
	const now = Date.now();
	const row = await getDb()
		.prepare(
			`SELECT u.id, u.name, u.username, u.role, u.password_hash,
			        u.created_at, u.updated_at,
			        s.id AS session_id, s.created_at_ms, s.expires_at_ms
			 FROM shtora_auth_sessions s
			 JOIN user u ON u.id = s.user_id
			 WHERE s.token_hash = ?`,
		)
		.bind(tokenHash)
		.first<
			AppUserRecord & {
				session_id: string;
				created_at_ms: number;
				expires_at_ms: number;
			}
		>();
	if (!row || row.expires_at_ms <= now || row.created_at_ms > now) {
		if (row) {
			await getDb()
				.prepare("DELETE FROM shtora_auth_sessions WHERE token_hash = ?")
				.bind(tokenHash)
				.run();
		}
		return null;
	}
	return toAppUser(row);
}

export async function requireUser(request: Request): Promise<AppUser> {
	const user = await getSessionUser(request);
	if (!user) throw new UnauthenticatedError();
	return user;
}
