import { beforeEach, expect, mock, test } from "bun:test";
import { hashAuthPassword } from "../src/lib/auth-password";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Auth HTTP routes (M29): register/login/logout/session over the real
// handleAuthRequest + session helpers, against the parity D1. Only the
// Cloudflare env binding is mocked; nothing else is stubbed.
let db: MemoryD1;

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => "auth-test-secret-0123456789-abcdefghij",
	getImagesBucket: () => {
		throw new Error("IMAGES_BUCKET is unavailable in this test");
	},
}));

const { handleAuthRequest } = await import("../src/lib/auth");
const sessionRoute = await import("../src/app/api/auth/session/route");

const PASSWORD = "correct-horse-battery";

function authRequest(action: string, init?: RequestInit): Request {
	return new Request(`http://localhost/api/auth/${action}`, init);
}

function jsonRequest(
	action: string,
	body: unknown,
	extraHeaders: Record<string, string> = {},
): Request {
	return authRequest(action, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...extraHeaders,
		},
		body: JSON.stringify(body),
	});
}

function sessionTokenFrom(response: Response): string | null {
	const cookie = response.headers.get("set-cookie") ?? "";
	const match = /__Host-shtora\.session=([a-f0-9]{64})/.exec(cookie);
	return match?.[1] ?? null;
}

async function insertUser(
	id: string,
	username: string,
	password = PASSWORD,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(id, username, username, await hashAuthPassword(password))
		.run();
}

async function login(username: string, password = PASSWORD): Promise<Response> {
	return handleAuthRequest(jsonRequest("login", { username, password }));
}

async function sessionCount(userId: string): Promise<number> {
	const row = await db
		.prepare("SELECT COUNT(*) AS n FROM shtora_auth_sessions WHERE user_id = ?")
		.bind(userId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

beforeEach(async () => {
	db = await createParityDatabase();
});

test("register creates the user and sets a session cookie", async () => {
	const response = await handleAuthRequest(
		jsonRequest("register", { username: "alice", password: PASSWORD }),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		user: { username: string };
	};
	expect(body.user.username).toBe("alice");
	const cookie = response.headers.get("set-cookie") ?? "";
	expect(cookie).toContain("__Host-shtora.session=");
	expect(cookie).toContain("HttpOnly");
	expect(cookie).toContain("Secure");
	expect(cookie).toContain("SameSite=Lax");
	const token = sessionTokenFrom(response);
	expect(token).toHaveLength(64);
	const user = await db
		.prepare("SELECT id FROM user WHERE username = ?")
		.bind("alice")
		.first<{ id: string }>();
	expect(user).not.toBeNull();
	expect(await sessionCount(user?.id ?? "")).toBe(1);
});

test("register rejects a taken username with 409 and an invalid name with 400", async () => {
	await insertUser("u-alice", "alice");
	const taken = await handleAuthRequest(
		jsonRequest("register", { username: "alice", password: PASSWORD }),
	);
	expect(taken.status).toBe(409);
	expect(await taken.json()).toEqual({ error: "registration_failed" });

	const invalid = await handleAuthRequest(
		jsonRequest("register", { username: "al", password: PASSWORD }),
	);
	expect(invalid.status).toBe(400);
	const shortPassword = await handleAuthRequest(
		jsonRequest("register", { username: "bob", password: "short" }),
	);
	expect(shortPassword.status).toBe(400);
});

test("login with a wrong password or an unknown user answers 401", async () => {
	await insertUser("u-alice", "alice");
	const wrong = await login("alice", "not-the-password");
	expect(wrong.status).toBe(401);
	expect(await wrong.json()).toEqual({ error: "invalid_credentials" });
	const unknown = await login("nobody");
	expect(unknown.status).toBe(401);
	expect(await unknown.json()).toEqual({ error: "invalid_credentials" });
});

test("login sets a cookie that GET /api/auth/session accepts, without the password hash", async () => {
	await insertUser("u-alice", "alice");
	const response = await login("alice");
	expect(response.status).toBe(200);
	const token = sessionTokenFrom(response);
	expect(token).not.toBeNull();
	const session = await sessionRoute.GET(
		new Request("http://localhost/api/auth/session", {
			headers: { Cookie: `__Host-shtora.session=${token}` },
		}),
	);
	expect(session.status).toBe(200);
	const body = (await session.json()) as {
		user: { username: string; passwordHash?: string };
	};
	expect(body.user.username).toBe("alice");
	expect(body.user.passwordHash).toBeUndefined();
});

test("GET /api/auth/session without a cookie answers user null", async () => {
	const session = await sessionRoute.GET(
		new Request("http://localhost/api/auth/session"),
	);
	expect(session.status).toBe(200);
	expect(await session.json()).toEqual({ user: null });
});

test("logout deletes only the current session and clears the cookie", async () => {
	await insertUser("u-alice", "alice");
	const first = await login("alice");
	const second = await login("alice");
	expect(await sessionCount("u-alice")).toBe(2);
	const token = sessionTokenFrom(first);
	const response = await handleAuthRequest(
		authRequest("logout", {
			method: "POST",
			headers: { Cookie: `__Host-shtora.session=${token}` },
		}),
	);
	expect(response.status).toBe(204);
	expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
	expect(await sessionCount("u-alice")).toBe(1);
	const after = await sessionRoute.GET(
		new Request("http://localhost/api/auth/session", {
			headers: { Cookie: `__Host-shtora.session=${token}` },
		}),
	);
	expect(await after.json()).toEqual({ user: null });
	// The other session still works.
	const otherToken = sessionTokenFrom(second);
	const other = await sessionRoute.GET(
		new Request("http://localhost/api/auth/session", {
			headers: { Cookie: `__Host-shtora.session=${otherToken}` },
		}),
	);
	const otherBody = (await other.json()) as { user: { username: string } };
	expect(otherBody.user.username).toBe("alice");
});

test("logout-all invalidates every session of the user", async () => {
	await insertUser("u-alice", "alice");
	const first = await login("alice");
	await login("alice");
	expect(await sessionCount("u-alice")).toBe(2);
	const token = sessionTokenFrom(first);
	const response = await handleAuthRequest(
		authRequest("logout-all", {
			method: "POST",
			headers: { Cookie: `__Host-shtora.session=${token}` },
		}),
	);
	expect(response.status).toBe(204);
	expect(await sessionCount("u-alice")).toBe(0);
});

test("logout-all without a session answers 401", async () => {
	const response = await handleAuthRequest(
		authRequest("logout-all", { method: "POST" }),
	);
	expect(response.status).toBe(401);
});

test("six failed logins for one username and IP hit the 429 brute-force limit", async () => {
	await insertUser("u-alice", "alice");
	let last: Response | null = null;
	for (let attempt = 0; attempt < 6; attempt += 1) {
		last = await login("alice", "wrong-password");
	}
	expect(last?.status).toBe(429);
	expect(await last?.json()).toEqual({ error: "rate_limited" });
	expect(last?.headers.get("Retry-After")).not.toBeNull();
});

test("a cross-site Origin is rejected on login", async () => {
	await insertUser("u-alice", "alice");
	const response = await handleAuthRequest(
		jsonRequest(
			"login",
			{ username: "alice", password: PASSWORD },
			{ Origin: "https://evil.example" },
		),
	);
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({ error: "invalid_origin" });
});

test("GET on a POST-only auth action answers 405 and unknown actions answer 404", async () => {
	const get = await handleAuthRequest(authRequest("login", { method: "GET" }));
	expect(get.status).toBe(405);
	expect(get.headers.get("Allow")).toBe("POST");
	const unknown = await handleAuthRequest(jsonRequest("reset-password", {}));
	expect(unknown.status).toBe(404);
});

test("a body over the 8 KiB cap answers 413", async () => {
	const response = await handleAuthRequest(
		jsonRequest("login", {
			username: "a".repeat(9000),
			password: PASSWORD,
		}),
	);
	expect(response.status).toBe(413);
	expect(await response.json()).toEqual({ error: "request_too_large" });
});

test("an expired session is rejected and pruned", async () => {
	await insertUser("u-alice", "alice");
	const response = await login("alice");
	const token = sessionTokenFrom(response);
	const hash = await db
		.prepare("SELECT token_hash FROM shtora_auth_sessions WHERE user_id = ?")
		.bind("u-alice")
		.first<{ token_hash: string }>();
	expect(hash).not.toBeNull();
	await db
		.prepare(
			"UPDATE shtora_auth_sessions SET expires_at_ms = ? WHERE token_hash = ?",
		)
		.bind(Date.now() - 1000, hash?.token_hash ?? "")
		.run();
	const session = await sessionRoute.GET(
		new Request("http://localhost/api/auth/session", {
			headers: { Cookie: `__Host-shtora.session=${token}` },
		}),
	);
	expect(await session.json()).toEqual({ user: null });
	expect(await sessionCount("u-alice")).toBe(0);
});

test("more than 20 sessions evict the oldest ones", async () => {
	// Through the login route this cannot be reached: the 5/min login
	// limiter answers 429 first. The cap itself lives in createSession,
	// so it is exercised directly.
	const { createSession } = await import("../src/lib/session");
	await insertUser("u-alice", "alice");
	for (let i = 0; i < 21; i += 1) {
		await createSession("u-alice");
	}
	expect(await sessionCount("u-alice")).toBe(20);
});
